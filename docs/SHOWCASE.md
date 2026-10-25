# Showcase material

Ready-to-post copy and the assets to attach. Everything below describes the
shipped product only — no roadmap items are presented as features.

## Assets

| File | What it shows |
| --- | --- |
| `docs/screenshots/09-landing-en.png` | Landing page (English), 1440×900 |
| `docs/screenshots/10-landing-zh.png` | Landing page (简体中文) |
| `docs/screenshots/02-new-monitor.png` | Create-monitor dialog |
| `docs/screenshots/03-dashboard.png` | Dashboard with a live monitor (English) |
| `docs/screenshots/11-dashboard-zh.png` | Dashboard (简体中文) |
| `docs/screenshots/04-monitor-detail.png` | Charts, config, incident timeline |
| `docs/screenshots/12-monitor-zh.png` | Monitor detail (简体中文) |
| `docs/screenshots/05-settings.png` | Webhook / email channel management |
| `docs/screenshots/13-settings-zh.png` | Alerts page (简体中文) |
| `docs/screenshots/06-status-page.png` | Public status page, English |
| `docs/screenshots/14-status-zh.png` | Public status page, `?lang=zh` |
| `docs/screenshots/07-mobile-landing.png` | iPhone 13, landing (English) |
| `docs/screenshots/15-mobile-zh.png` | iPhone 13, landing (简体中文) |
| `docs/screenshots/08-mobile-dashboard.png` | iPhone 13, dashboard |

All screenshots were captured by `e2e/ui-check.mjs` from the live deployment at
<https://sitepulse.changyuansex.workers.dev>, against a real account and real
probe data.

## Short post (X / Twitter)

> I built SitePulse — an uptime monitor that keeps probing after you close the tab.
>
> ⏱ probes every 60s from Cloudflare's edge
> 🚨 only alerts after N consecutive failures, so one dropped packet doesn't wake you
> 📉 incidents with real durations, not just "it's down"
> 🌐 shareable status pages that work without JS
> 🛡 SSRF-hardened: no localhost, no private ranges, no cloud metadata
>
> Open source, MIT, runs entirely on Workers + D1.
>
> Live: https://sitepulse.changyuansex.workers.dev
> Code: https://github.com/iiiiiiiiiiiiiKK/sitepulse
>
> Built by @0xkillcoin

## Longer post (blog / Reddit / Hacker News)

> **SitePulse: a 60-second uptime monitor that costs nothing to run**
>
> Most free uptime checkers either ping you every 5 minutes or hide the raw
> data behind a paywall. I wanted three things they don't give you:
>
> 1. **A real failure threshold.** SitePulse only opens an incident after N
>    consecutive failures (default 3). A single timeout never pages anyone.
> 2. **Real incident durations.** Every incident stores started_at, resolved_at
>    and duration_seconds, and recovery itself can require N consecutive
>    successes before the incident closes.
> 3. **Honest numbers.** Availability is failed ÷ actual stored probes. Empty
>    buckets render as gaps in the chart. With no samples the UI says "No data"
>    instead of showing a reassuring 100%.
>
> Architecturally it's one Cloudflare Worker: static assets, JSON API,
> server-rendered status pages, and a `* * * * *` cron trigger that claims due
> monitors with a conditional `UPDATE` so overlapping runs can't double-probe.
> Storage is D1 (SQLite); the schema is nine tables.
>
> The part I spent the most time on is the SSRF guard, because a URL monitor is
> literally "fetch this URL a stranger gave you". It validates scheme, port,
> hostname, IP range (including encoded IPv4 and IPv4-mapped IPv6), resolves the
> host over DNS-over-HTTPS and requires *every* answer to be public, then
> re-validates on every redirect hop — and fails closed if resolution errors.
> `SECURITY.md` documents the residual DNS-rebinding risk instead of pretending
> it doesn't exist.
>
> 137 unit tests, 70 production E2E checks against the live deployment, 12
> recovery-lifecycle checks, 17 browser checks across desktop / iPhone 13 /
> 320 px. MIT licensed.

## One-liners

- "Uptime monitoring that tells you how long it's been down, not just that it is."
- "A heartbeat monitor for your site that doesn't stop when your laptop does."
- "Because 'is it down?' is a worse question than 'how long has it been down?'"

## What not to claim

- It is **not** multi-region: probes run from one Cloudflare location.
- It does **not** send email out of the box: an email provider key is required,
  and unconfigured channels report `skipped`.
- The `pro` plan is a flag, not a billing integration.
