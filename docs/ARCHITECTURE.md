# Architecture

## Module map

```
worker/
├── index.ts              Worker entry: routing, SPA fallback, cron handler
├── schema.sql            Full D1 DDL (9 tables + indexes)
├── lib/
│   ├── urlguard.ts       SSRF guard — no HTTP, no DB, pure validation (+ DoH)
│   ├── probe.ts          HTTP probing — no DB, injected fetch for tests
│   ├── monitor-state.ts  Pure state machine: thresholds → up/down/recovering
│   ├── stats.ts          Bucket aggregation, p95, downtime clipping
│   ├── scheduler.ts      The only module that touches D1 during a probe
│   ├── notify.ts         Webhook (HMAC) + email dispatch, dedup, delivery log
│   ├── crypto.ts         PBKDF2, AES-GCM envelope, HMAC, tokens
│   ├── auth.ts           Users, sessions, plan limits
│   ├── http.ts           JSON helpers, cookies, rate limiting, validation
│   └── types.ts          Shared row/domain types
└── routes/
    ├── auth.ts           /api/auth/*
    ├── monitors.ts       /api/monitors/*
    ├── notifications.ts  /api/notifications/*
    ├── maintenance.ts    /api/maintenance/*
    └── statuspage.ts     /status/:slug (server-rendered HTML + JSON)
```

The dependency direction is strictly one-way:

```
index → routes → lib/{scheduler,auth,...} → lib/{probe,urlguard,monitor-state,stats,crypto}
```

`urlguard`, `probe`, `monitor-state` and `stats` never import D1 or the router,
which is why they can be unit-tested with no bindings at all.

## Request lifecycle (API)

```
Request
  → index.fetch
      → /api/? → routeApi
          → public: /api/health, /api/status/:slug, /api/auth/*
          → requireUser (cookie or bearer) → 401 if no session
          → handler (monitors | notifications | maintenance | account)
      → withSecurityHeaders(response)
```

Every handler throws `ApiError(status, message, code)`; `index.ts` converts it
into `{ error: { message, code } }`. Unhandled errors become a generic 500 —
internal messages never reach the client.

## Cron lifecycle

```
scheduled(* * * * *)
  → ctx.waitUntil(
      runDueMonitors(env, origin)
        SELECT * FROM monitors WHERE enabled=1 AND next_check_at <= now LIMIT PROBES_PER_RUN
        for each:
          claimMonitor()            conditional UPDATE → dedupes overlapping runs
          probe()                   guard → fetch → classify
          INSERT checks
          applyProbeOutcome()       pure state transition
          open/close incident       INSERT or UPDATE incidents
          UPDATE monitors
          dispatchEvent()           dedupe by (channel, incident, event)
      pruneOldChecks()              retention per plan
      pruneEphemeral()              sessions, rate limits, old deliveries
    )
```

## Availability mathematics

```
availability = (totalProbes - failedProbes) / totalProbes * 100
```

- Probes are counted from `checks` rows inside the window — the real stored
  samples, not an inferred "expected" count.
- `null` (rendered as **No data**) when a window has zero probes.
- Downtime comes from `incidents`, clipped to the window boundaries, so it can
  never exceed the window length.
- Chart buckets with no probes render as **gaps**, never as 0 ms or 100 %.

## Incident model

```
        failure × N                         success × M
up ───────────────────► down ──────────────────────────► up
 │                       │                                │
 │ opens incident        │ recovering (derived)           │ closes incident
 │                       │  (success < M)                 │ sets resolved_at + duration_seconds
```

`recovering` is **derived**, not stored: the monitor row stays `down` with an
open incident, and the API reports `recovering` while
`0 < consecutive_successes < recovery_threshold`. This keeps the DB as the
single source of truth.

## Why a conditional UPDATE instead of a lock table

```sql
UPDATE monitors SET next_check_at = :next
WHERE id = :id AND next_check_at = :expected AND enabled = 1
```

If two cron invocations overlap, only one matches `next_check_at = :expected`;
the other gets `changes = 0` and skips the monitor. There is no lock row to
expire, no lease to renew, and no chance of a stale lock wedging the scheduler.

Writing `next_check_at` **before** probing also means a probe that kills the
isolate cannot cause a hot retry loop — the monitor simply waits for its next
slot.

## Privacy boundary

| Data | Dashboard (owner) | Public status page |
| --- | --- | --- |
| Display name | ✅ | ✅ |
| Hostname | ✅ | ✅ |
| Full path + query | ✅ | ❌ |
| HTTP status codes | ✅ | last code only in JSON |
| Error messages | ✅ | ❌ |
| Incident durations | ✅ | ✅ durational only, labelled by cause |
| Email / account id | ✅ (own) | ❌ |
| Notification config | ✅ | ❌ |
| Signing secrets | masked | ❌ |
