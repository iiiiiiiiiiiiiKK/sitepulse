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
| History retention | 30 days (free) / 90 days (pro), pruned hourly |

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
