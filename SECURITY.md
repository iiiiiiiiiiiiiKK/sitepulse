# Security policy

## Supported versions

SitePulse is a single-branch project; only the latest commit on `main` is supported.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

- Open a private security advisory on GitHub:
  <https://github.com/iiiiiiiiiiiiiKK/sitepulse/security/advisories/new>
- Or reach the maintainer on X: [@0xkillcoin](https://x.com/0xkillcoin)

Please include: affected endpoint, reproduction steps, expected vs. actual
behaviour, and any proof-of-concept code. You can expect an initial reply
within 72 hours.

## Threat model

SitePulse fetches user-supplied URLs from a Cloudflare Worker. The main threats
and the mitigations that exist in the codebase are listed below. Anything not
listed here is not claimed to be protected.

### 1. SSRF (server-side request forgery)

**Risk:** a user registers `http://169.254.169.254/latest/meta-data/` and reads
cloud metadata through our Worker.

**Mitigations** (`worker/lib/urlguard.ts`):

| Control | Implementation |
| --- | --- |
| Scheme allow-list | only `http:` / `https:` |
| Credential rejection | URLs containing `user:pass@` are refused |
| Port allow-list | only 80, 443, 8080, 8443 — no port scanning |
| Hostname block-list | `localhost`, `*.local`, `*.internal`, `*.lan`, `metadata.google.internal`, `kubernetes.default`, … |
| Literal IP validation | every IPv4 / IPv6 form is range-checked, including decimal, octal-ish and IPv4-mapped encodings |
| DNS resolution check | each hostname is resolved over DNS-over-HTTPS and **every** returned A/AAAA address must be public |
| Redirect re-validation | redirects are followed manually (max 5) and every hop passes the same guard again |
| Fail closed | a DoH failure blocks the probe rather than allowing it |

Blocked ranges include loopback, RFC1918, CGNAT, link-local (incl. the metadata
address), multicast, reserved, documentation, benchmark, ULA and link-local
IPv6, plus NAT64/6to4 embeddings of private IPv4 space.

**Residual risk (documented, not hidden):** Workers cannot pin the IP that
`fetch` connects to, so a DNS answer that differs between our DoH lookup and
the edge resolver (a true DNS-rebinding attack) could still reach an address we
did not see. The DoH pre-check plus the name/IP block-lists close the practical
attack surface, but the Worker never exposes a "connect to an arbitrary IP and
port" primitive, which is what makes classic SSRF exploitable.

### 2. Webhook delivery

Webhook URLs are user-supplied too. SitePulse sends a single `POST` to the exact
stored URL and does **not** follow redirects (`redirect: 'manual'`), so the
sender cannot be turned into an SSRF relay. Responses are cancelled immediately
and never stored in full.

### 3. Credentials and secrets

- Passwords: PBKDF2-HMAC-SHA256, 100 000 iterations (the Workers maximum),
  per-user random salt, optional server-side pepper. Comparisons are
  constant-time.
- Sessions: 256-bit random tokens; only the SHA-256 hash is persisted.
  Cookies are `HttpOnly; Secure; SameSite=Lax`.
- Webhook signing secrets: AES-256-GCM encrypted at rest with `ENCRYPTION_KEY`.
  The API returns only `hasSecret` and a mask — never the value.
- Secrets are never written to logs. The cron logger emits counts only.

### 4. Data isolation

Every query against `monitors`, `notifications`, `maintenance_windows` and
`deliveries` is scoped by `user_id`. Cross-account reads and deletes return
404 (not 403) so the existence of another tenant's monitor is not disclosed.
This is covered by the E2E suite.

### 5. Abuse / resource exhaustion

| Control | Value |
| --- | --- |
| Monitors per account | 10 (free) / 50 (pro) |
| Minimum interval | 60 s |
| Probes per cron tick | 12 by default (configurable, hard cap 50) — sized to the 50-subrequest free-plan budget |
| Manual checks | 60 / 10 min per account, 1 / 20 s per monitor |
| Sign-ups | 20 / hour per IP |
| Sign-ins | 40 / 10 min per IP, 10 / 10 min per account |
| Response body | never read — cancelled as soon as headers arrive |
| Probe timeout | ≤ 30 s hard deadline for the whole redirect chain |
| History retention | 30 days (free) / 90 days (pro), pruned every 15 min via index seeks |
| Dashboard refresh | 120 detail reads / 10 min per account |
| Exports | 20 / hour per account (each can read 50k rows) |
| Public status page | edge-cached 30 s; served stale (marked) when the DB is unavailable |

### 6. Public status pages

Only monitors explicitly marked `is_public` are rendered. The page shows the
display name, **hostname only** (never the path or query string), availability,
response-time averages and incident durations. It never shows full URLs,
headers, error stack traces, email addresses or notification configuration.
Public pages are server-rendered, so they work without JavaScript.

## Operational hygiene

- All production secrets are set with `wrangler secret put`; nothing sensitive
  lives in the repository or in `wrangler.jsonc`.
- `.dev.vars` and `.env` are git-ignored.
- If a credential is ever committed, treat it as burned: rotate it first, then
  rewrite history.

## Out of scope

SitePulse is a low-frequency availability checker. It does not perform port
scans, vulnerability scanning, load testing, or any request that changes state
on the target. Requests are non-destructive `GET`/`HEAD` only.

## Resource-exhaustion follow-up (measured, 2026-10-26)

A real incident, kept here because it is the kind of bug that only shows up in
production and is easy to reintroduce:

**Symptom.** Cloudflare analytics showed 5.24M D1 row reads/day on
`sitepulse-db`, against a 5M/day free-tier limit. The account got throttled and
every status page started returning 500.

**Attribution** (`d1QueriesAdaptiveGroups`, grouped by query, last 24h):

| rows_read | calls | avg/call | statement |
| --- | --- | --- | --- |
| 10,168,687 | 844 | 12,048 | retention pruner (3-table join, every minute) |
| 16,485 | 785 | 21 | session expiry sweep |
| 12,606 | 1,387 | 9 | due-monitor selection |

**Root cause.** The pruner filtered on `checks.checked_at`, but the only index
on that table was `(monitor_id, checked_at DESC)`. With no way to seek by date
alone, SQLite fell back to a covering-index scan of the whole table —
`EXPLAIN QUERY PLAN` confirmed `SCAN c USING COVERING INDEX
idx_checks_monitor_time` — 60 times an hour. Cost therefore grew with retained
history: at 30 days it would have exceeded the limit on its own.

**Fixes.** `worker/migrations/0002_efficiency.sql` +
`worker/lib/scheduler.ts`:

1. `CREATE INDEX checks(checked_at)` — the floor delete is now a range seek.
2. Per-monitor deletes use the existing `(monitor_id, checked_at)` index; the
   plan list is read once instead of joining inside the delete.
3. Housekeeping runs every 15 minutes (`PRUNE_EVERY_MINUTES`), not every minute.
4. `sessions(expires_at)` and `deliveries(created_at)` indexes so the sweeps
   seek too.

**Guardrails added at the same time**

- The public status page is edge-cached for 30s and, if D1 is unavailable,
  serves the last render with `X-SitePulse-Cache: stale` plus its age — a status
  page must not answer 500. With no cached copy it returns 503 with a message
  saying the *status database* is out of quota, not that the monitored sites are
  down.
- Dashboard detail reads: 120 / 10 min per account. Exports: 20 / hour.
- `tests/budget.test.ts` pins the pruning cadence and the budget-error detector;
  `scripts/verify-prune.mjs` proves the retention semantics and that both
  statements seek rather than scan.
- `scripts/d1-usage.mjs` prints the daily total against the free-tier limit plus
  per-statement attribution, and flags any single statement above 50% of the
  volume. `scripts/bench-prune.mjs` benchmarks the old and new pruner on a
  200k-row table.

**Result (measured after the fix)**

| | before | after |
| --- | --- | --- |
| pruner rows/read per call | ~12,000 | 0 (index seek, nothing expired) |
| housekeeping runs/day | 1,440 | 96 |
| pruner work/day (200k-row bench) | 33.1 s | 0.32 s (~103× less) |
| app rows_read/day (projected) | 5.2–5.5M | ~15k |
| status page on DB outage | HTTP 500 | last render (marked stale) or an honest 503 |

The old three-table-join pruner no longer appears in the query log at all
(`d1QueriesAdaptiveGroups`, last 40 minutes).
