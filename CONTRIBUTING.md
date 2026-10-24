# Contributing to SitePulse

Thanks for taking the time to contribute.

## Before you start

- Open an issue first for anything larger than a bug fix, so we can agree on the
  approach before you write code.
- Never commit real credentials. `.dev.vars` and `.env` are git-ignored; keep it
  that way.

## Local setup

```bash
npm install
cp .env.example .dev.vars         # fill ENCRYPTION_KEY + AUTH_PEPPER
npx wrangler d1 execute sitepulse-db --local --file=worker/schema.sql
npx wrangler dev --port 8788      # API + assets + cron
npm run dev                       # Vite dev server with /api proxy
```

## Rules of the road

1. **`npm run typecheck && npm test` must pass.** CI runs both on every PR.
2. **The SSRF guard and the state machine stay pure.** `worker/lib/urlguard.ts`
   and `worker/lib/monitor-state.ts` must not import D1, `fetch`, or the router.
   New behaviour there needs new tests.
3. **Do not weaken safety checks for convenience.** Removing an IP range, a port
   restriction, a rate limit or an ownership filter will get a PR rejected.
4. **No fake data.** Any screenshot, demo, or seed script must come from a real
   running instance. Do not add mocked dashboards to the docs.
5. **Honest error handling.** Never convert a failed request into a success
   message. If something is not configured, say so — see how email channels
   report `skipped` rather than pretending to send.

## Code style

- TypeScript strict mode, no `any` unless unavoidable (and commented).
- Comments explain *why*, not *what*. The code already says what it does.
- Prefer a small pure function plus a test over a clever abstraction.
- Keep the Worker under the free-plan size limit; no heavy dependencies.

## Commit messages

Conventional-ish and descriptive:

```
fix(probe): re-validate DNS on every redirect hop
feat(stats): expose p95 latency in the monitor detail API
docs(readme): document the retention limits per plan
```

## Pull requests

Include:

- what changed and why
- how you verified it (commands, and the actual output summary)
- any user-visible behaviour change, including error messages

## Reporting security issues

Do **not** open a public issue. See [SECURITY.md](../SECURITY.md).
