# Deployment guide

SitePulse is a single Cloudflare Worker that serves the SPA, the JSON API, the
public status pages and the cron-driven probe scheduler. Everything below was
executed to produce the live deployment at
<https://sitepulse.changyuansex.workers.dev>.

## Prerequisites

- Node.js 20+ (verified on Node 24)
- A Cloudflare account (free plan is enough)
- An API token with at least: `Workers Scripts:Edit`, `D1:Edit`,
  `Account Settings:Read`

```bash
export CLOUDFLARE_API_TOKEN=...        # PowerShell: $env:CLOUDFLARE_API_TOKEN='...'
export CLOUDFLARE_ACCOUNT_ID=...
```

## 1. Install and build

```bash
npm install
npm run build      # tsc --noEmit for src/ + vite build -> dist/
npm test           # 138 tests must pass
```

## 2. Create the D1 database

```bash
npx wrangler d1 create sitepulse-db
```

Copy the returned `database_id` into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "sitepulse-db", "database_id": "<paste here>" }
]
```

Apply the schema:

```bash
npx wrangler d1 execute sitepulse-db --remote --file=worker/schema.sql --yes
```

Expected output: `num_tables: 9`.

## 3. Set secrets

```bash
# 32 random bytes, base64 — AES-256-GCM key for webhook signing secrets
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put ENCRYPTION_KEY

# 24 random bytes, base64 — PBKDF2 pepper (set ONCE; changing it locks users out)
node -e "console.log(require('crypto').randomBytes(24).toString('base64'))"
npx wrangler secret put AUTH_PEPPER

# Public base URL used inside notification bodies
npx wrangler secret put PUBLIC_BASE_URL      # e.g. https://sitepulse.<subdomain>.workers.dev

# Optional, only for email alerts
npx wrangler secret put EMAIL_API_KEY
npx wrangler secret put EMAIL_FROM
```

`npx wrangler secret list` should show `AUTH_PEPPER`, `ENCRYPTION_KEY` and
`PUBLIC_BASE_URL` (names only — values are write-only).

## 4. Deploy

```bash
npx wrangler deploy
```

Expected tail of the output:

```
Uploaded sitepulse (…sec)
Deployed sitepulse triggers (…sec)
  https://sitepulse.<subdomain>.workers.dev
  schedule: * * * * *
Current Version ID: …
```

The `schedule:` line is the proof that the cron trigger was installed. Without
it, probes never run.

## 5. Verify

```bash
curl https://<your-worker>/healthz
# {"ok":true,"service":"sitepulse","time":"…"}

curl https://<your-worker>/api/health
```

Then run the full production suite:

```bash
node e2e/production-check.mjs https://<your-worker>
node e2e/recovery-check.mjs  https://<your-worker>
```

## 6. First account

Open the site, register. On a fresh database the **first** account is
automatically set to the `pro` plan (50 monitors, 90-day retention). All later
accounts start on `free` (10 monitors, 30-day retention).

## Updating a deployment

```bash
git pull
npm install
npm run build && npm test
npx wrangler deploy
```

Schema changes are additive in this project; apply them with
`npx wrangler d1 execute sitepulse-db --remote --file=worker/schema.sql --yes`
(the DDL uses `CREATE TABLE IF NOT EXISTS`, so re-running is safe).

## Local development

```bash
cp .env.example .dev.vars      # fill ENCRYPTION_KEY + AUTH_PEPPER
npx wrangler d1 execute sitepulse-db --local --file=worker/schema.sql
npx wrangler dev --port 8788   # API + assets + cron on :8788
npm run dev                    # Vite on :5173 with /api proxied to :8788
```

Typical loop: edit `src/` → Vite hot-reloads; edit `worker/` → `wrangler dev`
reloads the Worker.

## Custom domain

1. Add the zone to Cloudflare.
2. In `wrangler.jsonc` add:

```jsonc
"routes": [{ "pattern": "status.yourdomain.com", "custom_domain": true }]
```

3. `npx wrangler deploy`, then update `PUBLIC_BASE_URL`:
   `npx wrangler secret put PUBLIC_BASE_URL`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `num_tables: 0` after schema apply | wrong database id in `wrangler.jsonc` | re-copy `database_id` and redeploy |
| Monitors stay `unknown` | cron trigger missing (no `schedule:` line at deploy) | check the `triggers.crons` array and redeploy |
| `PBKDF2` registration error 500 | iteration count above the Workers cap (100 000) | keep `PBKDF2_ITERATIONS = 100_000` in `worker/lib/crypto.ts` |
| Webhook test says "ENCRYPTION_KEY not configured" | secret not set | `npx wrangler secret put ENCRYPTION_KEY` |
| Email test says `skipped` | no `EMAIL_API_KEY`/`EMAIL_FROM` | set both, or accept that email is disabled |
| `429` on sign-up | 20 registrations/hour/IP | wait, or clear `rate_limits` in D1 |
| Status page 404 | monitor is not public | toggle "Publish" on the monitor detail page |
| `Too many redirects` errors on a monitor | chain longer than 5 hops | monitor the final URL directly |

## Language

The deployment is bilingual out of the box; nothing needs to be configured.

| Where | Behaviour |
| --- | --- |
| Dashboard | Toggle in the top bar (`中` / `EN`). Persisted in `localStorage` and mirrored into `?lang=`. |
| Public status page | `?lang=zh` / `?lang=en`, otherwise `Accept-Language`. Renders a plain switch link, no JS required. |
| Email / webhook bodies | English (alert text is generated in the Worker). |

To add a third language: extend `Lang` and the `DICTS` table in
`src/lib/i18n.ts` (TypeScript will point at every missing key), then add a
matching table in `STRINGS` inside `worker/routes/statuspage.ts` and widen
`resolveStatusLang`.
