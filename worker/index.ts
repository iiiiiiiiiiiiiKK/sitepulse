import type { Bindings } from './lib/types';
import { ApiError, fail, json, withSecurityHeaders } from './lib/http';
import { handleAuth, requireUser } from './routes/auth';
import { handleMonitors } from './routes/monitors';
import { handleNotifications } from './routes/notifications';
import { handleMaintenance } from './routes/maintenance';
import {
  loadStatusPage,
  renderStatusJson,
  renderStatusPage,
  resolveStatusLang,
} from './routes/statuspage';
import {
  pruneEphemeral,
  pruneOldChecks,
  runDueMonitors,
  shouldPruneNow,
} from './lib/scheduler';
import { planFor } from './lib/auth';
import {
  isBudgetError,
  readCachedStatus,
  writeCachedStatus,
  type CacheEntry,
} from './lib/cache';

/** How long a rendered status page may be served from cache without a refresh. */
const STATUS_CACHE_TTL_MS = 30_000;

/**
 * Serialises a cached (or freshly rendered) status page.
 *
 * `X-SitePulse-Cache` is honest about what happened: `hit` (fresh from cache),
 * `miss` (just rendered), or `stale` (the database was unavailable, so a saved
 * copy is being served — the page says so too, so nobody mistakes it for live).
 */
function respondStatus(
  entry: CacheEntry,
  options: { wantsJson: boolean; lang: 'en' | 'zh'; cacheState: 'hit' | 'miss' | 'stale' }
): Response {
  const staleFor = Math.max(0, Math.round((Date.now() - entry.storedAt) / 1000));
  const headers: Record<string, string> = {
    vary: 'accept-language',
    'content-language': options.lang === 'zh' ? 'zh-CN' : 'en',
    'x-sitepulse-cache': options.cacheState,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-sitepulse-data-age': String(staleFor),
  };
  if (options.wantsJson) {
    return new Response(entry.json, {
      headers: {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': options.cacheState === 'stale' ? 'no-store' : 'public, max-age=30',
        'access-control-allow-origin': '*',
      },
    });
  }
  return new Response(entry.html, {
    headers: {
      ...headers,
      'content-type': 'text/html; charset=utf-8',
      'cache-control':
        options.cacheState === 'stale'
          ? 'no-store'
          : 'public, max-age=20, stale-while-revalidate=40',
    },
  });
}

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
        const lang = resolveStatusLang(url, request.headers.get('accept-language'));

        // Serve from the edge cache when the render is fresh. A status page is
        // read far more often than it changes, and every miss costs D1 rows.
        const cacheKeyVariant = `${lang}:render`;
        const fresh = await readCachedStatus(`${slug}/${cacheKeyVariant}`, STATUS_CACHE_TTL_MS);

        if (fresh && !('stale' in fresh && fresh.stale)) {
          return respondStatus(fresh, { wantsJson, lang, cacheState: 'hit' });
        }

        let page: Awaited<ReturnType<typeof loadStatusPage>> = null;
        try {
          page = await loadStatusPage(env, slug);
        } catch (error) {
          // A status page must never answer with a bare 500. If the database is
          // out of budget we serve the last render (marked stale), and if there
          // has never been one we say exactly what is wrong.
          if (isBudgetError(error)) {
            if (fresh) {
              return respondStatus(fresh, { wantsJson, lang, cacheState: 'stale' });
            }
            return budgetUnavailable(lang, wantsJson);
          }
          throw error;
        }

        if (!page) {
          return new Response(notFoundHtml(), {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
        }

        const now = Date.now();
        const entry = {
          html: renderStatusPage({
            title: page.title,
            monitors: page.monitors,
            maintenance: page.maintenance,
            now,
            lang,
            switchHref: lang === 'en' ? '?lang=zh' : '?lang=en',
          }),
          json: renderStatusJson(page.title, page.monitors, now),
          storedAt: now,
        };
        await writeCachedStatus(`${slug}/${cacheKeyVariant}`, entry);
        return respondStatus(entry, { wantsJson, lang, cacheState: 'miss' });
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
    const origin = env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || 'https://sitepulse.workers.dev';
    ctx.waitUntil(
      (async () => {
        const startedAt = Date.now();
        const summary = await runDueMonitors(env, origin);

        // Housekeeping is throttled: the pruning statements are index-backed
        // now, but there is no reason to pay for them 60 times an hour. See
        // PRUNE_EVERY_MINUTES in lib/scheduler.ts for the cost history.
        let pruned = 0;
        if (shouldPruneNow(startedAt)) {
          pruned = await pruneOldChecks(env);
          await pruneEphemeral(env);
        }

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
            prunedThisTick: shouldPruneNow(startedAt),
            errors: summary.errors.slice(0, 5),
          })
        );
      })().catch((error) => {
        console.error('cron failed', error instanceof Error ? error.message : error);
      })
    );
  },
};

/**
 * Honest response for "the database is out of read budget".
 *
 * A status page that returns a generic 500 tells the visitor nothing and looks
 * like the monitored service is broken. This page says what actually happened,
 * and it does not pretend the data is live.
 */
function budgetUnavailable(lang: 'en' | 'zh', wantsJson: boolean): Response {
  const message =
    lang === 'zh'
      ? '状态数据库已达当日读取配额，暂时无法获取最新数据。这不是被监控服务本身的故障。'
      : 'The status database has reached its daily read quota, so live data is temporarily unavailable. This is not a failure of the monitored services.';
  if (wantsJson) {
    return new Response(
      JSON.stringify({ error: { message, code: 'budget_exhausted' }, stale: true, live: false }, null, 2),
      {
        status: 503,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
          'x-sitepulse-cache': 'unavailable',
        },
      }
    );
  }
  const title = lang === 'zh' ? '状态数据暂时不可用' : 'Status data temporarily unavailable';
  return new Response(
    `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · SitePulse</title>
<style>body{background:#0b0f14;color:#e6edf3;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
.c{max-width:520px;background:#111821;border:1px solid #2b3a4d;border-radius:14px;padding:26px}
h1{font-size:19px;margin:0 0 10px}p{color:#9aabbf;margin:0 0 10px;font-size:14px}
code{background:#182231;padding:1px 5px;border-radius:5px;font-size:12.5px}a{color:#4c8dff;text-decoration:none}</style>
</head><body><div class="c"><h1>${title}</h1><p>${message}</p>
<p style="font-size:12.5px;color:#6b7c90">${lang === 'zh' ? '配额每日 UTC 00:00 重置。' : 'The quota resets daily at 00:00 UTC.'}</p>
<p><a href="https://x.com/0xkillcoin" rel="me noopener">𝕏 @0xkillcoin</a></p></div></body></html>`,
    {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-sitepulse-cache': 'unavailable',
      },
    }
  );
}

async function routeApi(request: Request, env: Bindings, url: URL): Promise<Response> {
  const path = url.pathname;
  const segments = path.split('/').filter(Boolean); // ['api', ...]

  // --- public, unauthenticated ------------------------------------------------
  if (path === '/api/health') {
    return json({ ok: true, service: 'sitepulse', time: new Date().toISOString() });
  }

  if (segments[1] === 'status' && segments[2] && request.method === 'GET') {
    const slug = segments[2];
    // Same edge cache as the HTML page: this endpoint is public and CORS-open,
    // so it is the cheapest thing for a scraper to hammer.
    const cached = await readCachedStatus(`${slug}/en:render`, STATUS_CACHE_TTL_MS);
    if (cached && !('stale' in cached && cached.stale)) {
      return new Response(cached.json, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=30',
          'access-control-allow-origin': '*',
          'x-sitepulse-cache': 'hit',
        },
      });
    }
    try {
      const page = await loadStatusPage(env, slug);
      if (!page) return fail(404, 'Status page not found.', 'not_found');
      return new Response(renderStatusJson(page.title, page.monitors, Date.now()), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=30',
          'access-control-allow-origin': '*',
          'x-sitepulse-cache': 'miss',
        },
      });
    } catch (error) {
      if (isBudgetError(error) && cached) {
        return new Response(cached.json, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
            'x-sitepulse-cache': 'stale',
          },
        });
      }
      if (isBudgetError(error)) {
        return new Response(
          JSON.stringify(
            {
              error: {
                message:
                  'The status database has reached its daily read quota, so live data is temporarily unavailable.',
                code: 'budget_exhausted',
              },
              stale: true,
              live: false,
            },
            null,
            2
          ),
          {
            status: 503,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'access-control-allow-origin': '*',
              'x-sitepulse-cache': 'unavailable',
            },
          }
        );
      }
      throw error;
    }
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
