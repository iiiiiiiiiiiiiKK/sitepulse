import type { Bindings } from './lib/types';
import { ApiError, fail, json, withSecurityHeaders } from './lib/http';
import { handleAuth, requireUser } from './routes/auth';
import { handleMonitors } from './routes/monitors';
import { handleNotifications } from './routes/notifications';
import { handleMaintenance } from './routes/maintenance';
import { loadStatusPage, renderStatusJson, renderStatusPage } from './routes/statuspage';
import { pruneEphemeral, pruneOldChecks, runDueMonitors } from './lib/scheduler';
import { planFor } from './lib/auth';

/**
 * SitePulse Worker entry point.
 *
 * Routing
 *   /api/*            JSON API (session cookie or bearer token)
 *   /status/:slug     server-rendered public status page (HTML or JSON)
 *   /api/status/:slug JSON status payload (CORS-open, read-only)
 *   everything else   static SPA asset from ./dist
 *
 * Cron
 *   every minute ("* every-minute trigger") → probe due monitors, dispatch
 *   notifications, prune old data. See wrangler.jsonc for the exact expression.
 */
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith('/api/')) {
        return withSecurityHeaders(await routeApi(request, env, url));
      }

      if (path.startsWith('/status/')) {
        const slug = path.slice('/status/'.length).replace(/\/+$/, '');
        const wantsJson =
          url.searchParams.get('format') === 'json' ||
          (request.headers.get('accept') ?? '').includes('application/json');
        const page = await loadStatusPage(env, slug);
        if (!page) {
          return new Response(notFoundHtml(), {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
        if (wantsJson) {
          return new Response(renderStatusJson(page.title, page.monitors, Date.now()), {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'public, max-age=30',
              'access-control-allow-origin': '*',
            },
          });
        }
        return new Response(
          renderStatusPage({
            title: page.title,
            monitors: page.monitors,
            maintenance: page.maintenance,
            now: Date.now(),
          }),
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              // Short cache so a fresh incident shows up quickly, but crawlers
              // and repeated mobile loads still get a cached copy.
              'cache-control': 'public, max-age=20, stale-while-revalidate=40',
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'strict-origin-when-cross-origin',
            },
          }
        );
      }

      if (path === '/healthz') {
        const dbOk = await env.DB.prepare('SELECT 1 AS ok')
          .first<{ ok: number }>()
          .then(() => true)
          .catch(() => false);
        return json({ ok: dbOk, service: 'sitepulse', time: new Date().toISOString() }, {
          status: dbOk ? 200 : 503,
        });
      }

      // Static assets (single-page app fallback is configured in wrangler.jsonc).
      if (env.ASSETS) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404 || !path.startsWith('/app')) {
          return withSecurityHeaders(asset);
        }
        const index = await env.ASSETS.fetch(new Request(new URL('/', url), request));
        return withSecurityHeaders(index);
      }
      void ctx;
      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof ApiError) {
        return fail(error.status, error.message, error.code);
      }
      console.error('Unhandled error', error instanceof Error ? error.message : error);
      return fail(500, 'Something went wrong on our side. Please retry.', 'internal');
    }
  },

  async scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const origin = env.PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? 'https://sitepulse.workers.dev';
    ctx.waitUntil(
      (async () => {
        const summary = await runDueMonitors(env, origin);
        const pruned = await pruneOldChecks(env);
        await pruneEphemeral(env);
        console.log(
          JSON.stringify({
            cron: event.cron,
            claimed: summary.claimed,
            probed: summary.probed,
            failed: summary.failed,
            opened: summary.incidentsOpened,
            resolved: summary.incidentsResolved,
            notifications: summary.notifications,
            pruned,
            errors: summary.errors.slice(0, 5),
          })
        );
      })().catch((error) => {
        console.error('cron failed', error instanceof Error ? error.message : error);
      })
    );
  },
};

async function routeApi(request: Request, env: Bindings, url: URL): Promise<Response> {
  const path = url.pathname;
  const segments = path.split('/').filter(Boolean); // ['api', ...]

  // --- public, unauthenticated ------------------------------------------------
  if (path === '/api/health') {
    return json({ ok: true, service: 'sitepulse', time: new Date().toISOString() });
  }

  if (segments[1] === 'status' && segments[2] && request.method === 'GET') {
    const page = await loadStatusPage(env, segments[2]);
    if (!page) return fail(404, 'Status page not found.', 'not_found');
    return new Response(renderStatusJson(page.title, page.monitors, Date.now()), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=30',
        'access-control-allow-origin': '*',
      },
    });
  }

  if (segments[1] === 'auth') {
    return handleAuth(env, request, path);
  }

  // --- authenticated ---------------------------------------------------------
  const auth = await requireUser(env, request);

  if (segments[1] === 'monitors') {
    return handleMonitors(env, request, auth, segments);
  }
  if (segments[1] === 'notifications') {
    return handleNotifications(env, request, auth, segments);
  }
  if (segments[1] === 'maintenance') {
    return handleMaintenance(env, request, auth, segments);
  }
  if (segments[1] === 'account' && segments[2] === 'summary' && request.method === 'GET') {
    const plan = planFor(auth.user);
    const monitors = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down,
              SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up,
              SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
              SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown
       FROM monitors WHERE user_id = ?`
    )
      .bind(auth.user.id)
      .first<{ total: number; down: number; up: number; paused: number; unknown: number }>();
    const incidents = await env.DB.prepare(
      `SELECT COUNT(*) AS open FROM incidents i JOIN monitors m ON m.id = i.monitor_id
       WHERE m.user_id = ? AND i.resolved_at IS NULL`
    )
      .bind(auth.user.id)
      .first<{ open: number }>();
    return json({
      plan: plan.id,
      monitors: {
        total: monitors?.total ?? 0,
        up: monitors?.up ?? 0,
        down: monitors?.down ?? 0,
        paused: monitors?.paused ?? 0,
        unknown: monitors?.unknown ?? 0,
      },
      openIncidents: incidents?.open ?? 0,
      limits: {
        maxMonitors: plan.maxMonitors,
        minIntervalSeconds: plan.minIntervalSeconds,
        retentionDays: plan.retentionDays,
      },
    });
  }

  throw new ApiError(404, 'Unknown API endpoint.', 'not_found');
}

function notFoundHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status page not found</title>
<style>body{background:#0b0f14;color:#e6edf3;font:16px/1.6 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}
h1{font-size:20px;margin:0 0 8px}p{color:#8b98a9;margin:0 0 18px}a{color:#2f81f7;text-decoration:none}</style></head>
<body><div><h1>Status page not found</h1><p>This status page does not exist or its owner made it private.</p><a href="/">Go to SitePulse</a></div></body></html>`;
}
