import type { Bindings, IncidentRow, MonitorRow } from '../lib/types';
import { deriveDisplayStatus, incidentDurationSeconds, computeAvailability } from '../lib/monitor-state';
import { ERROR_LABELS } from '../lib/probe';
import { buildSeries, downtimeWithinWindow, RANGE_BUCKET_MS, RANGE_MS } from '../lib/stats';

/**
 * Public status page.
 *
 * Privacy rules enforced here:
 *  - only monitors with `is_public = 1` are ever queried;
 *  - no internal error stacks, request headers, incident summaries that contain
 *    raw diagnostics, or notification config are exposed;
 *  - the owner's email/account id never appears in the HTML;
 *  - the page is server-rendered so it works with JS disabled and is crawlable.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Status-page strings.
 *
 * The public page is server-rendered and must work with JavaScript disabled, so
 * it cannot reuse the React dictionary. Instead it picks one of two literal
 * tables from `?lang=` (or `Accept-Language`) and renders a plain link to the
 * other language — a server-side language switch that needs no JS either.
 */
type StatusLang = 'en' | 'zh';

const STRINGS = {
  en: {
    docTitle: (title: string) => `${title} · SitePulse status`,
    description: (title: string) => `Live availability status for ${title}.`,
    brand: 'SitePulse status',
    statusWord: 'status',
    noServicesOverall: 'No services yet',
    allOperational: 'All systems operational',
    degraded: (down: number, total: number) => `${down} of ${total} services degraded`,
    stripAria: 'Last 24 hours uptime',
    noDataTitle: (when: string) => `No data (${when})`,
    availability: '24h availability',
    avgResponse: 'Avg response',
    probes: 'Probes',
    lastCheck: 'Last check',
    noData: 'No data',
    noIncidents: 'No incidents recorded in the retained history.',
    incident: 'incident',
    incidents: 'incidents',
    ongoing: 'ongoing',
    probeFailure: 'Probe failure',
    maintenance: 'Scheduled maintenance',
    empty: 'No public services are configured for this status page.',
    rendered: (when: string) => `Rendered ${when} · all times UTC`,
    poweredBy: 'Powered by SitePulse',
    switchLabel: '中文',
    switchTitle: '切换为中文',
    lang: 'en',
    never: 'never',
    justNow: 'just now',
    secAgo: (n: number) => `${n}s ago`,
    minAgo: (n: number) => `${n}m ago`,
    hourAgo: (n: number) => `${n}h ago`,
    dayAgo: (n: number) => `${n}d ago`,
    status: {
      up: { label: 'Operational', note: 'All probes succeeding.' },
      down: { label: 'Outage', note: 'Consecutive probe failures detected.' },
      recovering: { label: 'Recovering', note: 'Probe succeeded, confirming recovery.' },
      paused: { label: 'Paused', note: 'Monitoring is paused by the owner.' },
      unknown: { label: 'Unknown', note: 'No probe has completed yet.' },
    } as Record<string, { label: string; note: string }>,
  },
  zh: {
    docTitle: (title: string) => `${title} · SitePulse 状态页`,
    description: (title: string) => `${title} 的实时可用性状态。`,
    brand: 'SitePulse 状态页',
    statusWord: '状态',
    noServicesOverall: '暂无服务',
    allOperational: '所有系统运行正常',
    degraded: (down: number, total: number) => `${total} 个服务中有 ${down} 个异常`,
    stripAria: '最近 24 小时可用率',
    noDataTitle: (when: string) => `无数据（${when}）`,
    availability: '24 小时可用率',
    avgResponse: '平均响应',
    probes: '探测次数',
    lastCheck: '最近检测',
    noData: '暂无数据',
    noIncidents: '保留的历史中没有故障记录。',
    incident: '个事件',
    incidents: '个事件',
    ongoing: '进行中',
    probeFailure: '探测失败',
    maintenance: '计划维护',
    empty: '该状态页还没有配置公开的服务。',
    rendered: (when: string) => `生成于 ${when} · 所有时间为 UTC`,
    poweredBy: '由 SitePulse 提供',
    switchLabel: 'EN',
    switchTitle: 'Switch to English',
    lang: 'zh',
    never: '从未',
    justNow: '刚刚',
    secAgo: (n: number) => `${n} 秒前`,
    minAgo: (n: number) => `${n} 分钟前`,
    hourAgo: (n: number) => `${n} 小时前`,
    dayAgo: (n: number) => `${n} 天前`,
    status: {
      up: { label: '运行正常', note: '所有探测均成功。' },
      down: { label: '故障', note: '检测到连续探测失败。' },
      recovering: { label: '恢复中', note: '探测已成功，正在确认恢复。' },
      paused: { label: '已暂停', note: '监控已被所有者暂停。' },
      unknown: { label: '未知', note: '尚未完成第一次探测。' },
    } as Record<string, { label: string; note: string }>,
  },
} as const;

/** Picks the render language from `?lang=` then `Accept-Language`. */
export function resolveStatusLang(url: URL, acceptLanguage: string | null): StatusLang {
  const fromQuery = url.searchParams.get('lang');
  if (fromQuery === 'zh' || fromQuery === 'en') return fromQuery;
  if (acceptLanguage && /^zh\b|[,;]\s*zh\b/i.test(acceptLanguage)) return 'zh';
  return 'en';
}

function humanDuration(seconds: number, lang: StatusLang): string {
  const zh = lang === 'zh';
  if (seconds < 60) return zh ? `${seconds} 秒` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return zh ? `${minutes} 分钟` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时 ${minutes % 60} 分` : `${hours}h ${minutes % 60}m`;
  return zh ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function relativeTime(from: number | null, now: number, lang: StatusLang): string {
  const s = STRINGS[lang];
  if (!from) return s.never;
  const diff = Math.max(0, Math.round((now - from) / 1000));
  if (diff < 60) return diff < 5 ? s.justNow : s.secAgo(diff);
  if (diff < 3600) return s.minAgo(Math.floor(diff / 60));
  if (diff < 86400) return s.hourAgo(Math.floor(diff / 3600));
  return s.dayAgo(Math.floor(diff / 86400));
}

const STATUS_COLORS: Record<string, string> = {
  up: '#2ea043',
  down: '#f85149',
  recovering: '#d29922',
  paused: '#6e7681',
  unknown: '#6e7681',
};

export interface PublicMonitorView {
  id: string;
  name: string;
  url: string;
  status: string;
  availability: number | null;
  totalChecks: number;
  failedChecks: number;
  avgResponseMs: number | null;
  lastCheckAt: number | null;
  lastSuccessAt: number | null;
  lastStatusCode: number | null;
  lastResponseMs: number | null;
  incidents: Array<{
    startedAt: number;
    resolvedAt: number | null;
    durationSeconds: number;
    cause: string | null;
  }>;
  /** compact 90-bucket uptime strip for the last 24h */
  strip: Array<{ t: number; availability: number | null; total: number }>;
}

export async function loadPublicMonitor(
  env: Bindings,
  slug: string,
  now = Date.now()
): Promise<{ monitor: MonitorRow; view: PublicMonitorView } | null> {
  const monitor = await env.DB.prepare(
    'SELECT * FROM monitors WHERE public_slug = ? AND is_public = 1'
  )
    .bind(slug)
    .first<MonitorRow>();
  if (!monitor) return null;

  const since = now - RANGE_MS['24h'];
  const checks = await env.DB.prepare(
    `SELECT checked_at, ok, response_ms FROM checks WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at ASC LIMIT 10000`
  )
    .bind(monitor.id, since)
    .all<{ checked_at: number; ok: number; response_ms: number | null }>();

  const incidents = await env.DB.prepare(
    'SELECT started_at, resolved_at, cause, duration_seconds FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 10'
  )
    .bind(monitor.id)
    .all<Pick<IncidentRow, 'started_at' | 'resolved_at' | 'cause' | 'duration_seconds'>>();

  const series = buildSeries(checks.results ?? [], since, now, RANGE_BUCKET_MS['24h']);

  return {
    monitor,
    view: {
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      status: deriveDisplayStatus(
        monitor.status,
        monitor.consecutive_successes,
        monitor.recovery_threshold,
        monitor.current_incident_id
      ),
      availability: series.stats.availability,
      totalChecks: series.stats.totalChecks,
      failedChecks: series.stats.failedChecks,
      avgResponseMs: series.stats.avgResponseMs,
      lastCheckAt: monitor.last_check_at,
      lastSuccessAt: monitor.last_success_at,
      lastStatusCode: monitor.last_status_code,
      lastResponseMs: monitor.last_response_ms,
      incidents: (incidents.results ?? []).map((incident) => ({
        startedAt: incident.started_at,
        resolvedAt: incident.resolved_at,
        durationSeconds: incidentDurationSeconds(
          { started_at: incident.started_at, resolved_at: incident.resolved_at },
          now
        ),
        cause: incident.cause ? ERROR_LABELS[incident.cause as keyof typeof ERROR_LABELS] ?? 'Probe failure' : null,
      })),
      strip: series.buckets.map((bucket) => ({
        t: bucket.t,
        availability: bucket.availability,
        total: bucket.total,
      })),
    },
  };
}

export interface StatusPageInput {
  title: string;
  monitors: PublicMonitorView[];
  maintenance: Array<{ title: string; body: string; startsAt: number; endsAt: number }>;
  now: number;
  /** Render language; defaults to English. */
  lang?: StatusLang;
  /** Query string suffix used by the language switch link (e.g. `?lang=zh`). */
  switchHref?: string;
}

export function renderStatusPage(input: StatusPageInput): string {
  const { title, monitors, maintenance, now } = input;
  const lang: StatusLang = input.lang ?? 'en';
  const s = STRINGS[lang];
  const switchHref = input.switchHref ?? (lang === 'en' ? '?lang=zh' : '?lang=en');
  // The switch shows the *target* language in its own script; each table stores
  // the label/tooltip for switching away from that language.
  const switchLabel = s.switchLabel;
  const switchTitle = s.switchTitle;

  const down = monitors.filter((m) => m.status === 'down' || m.status === 'recovering');
  const overall =
    monitors.length === 0
      ? { label: s.noServicesOverall, color: '#6e7681' }
      : down.length === 0
        ? { label: s.allOperational, color: '#2ea043' }
        : { label: s.degraded(down.length, monitors.length), color: '#f85149' };

  const renderStrip = (m: PublicMonitorView) => {
    const cells = m.strip
      .map((bucket) => {
        if (bucket.total === 0) {
          return `<span class="cell empty" title="${escapeHtml(
            s.noDataTitle(new Date(bucket.t).toUTCString())
          )}"></span>`;
        }
        const avail = bucket.availability ?? 0;
        const cls = avail >= 99.5 ? 'ok' : avail >= 90 ? 'warn' : 'bad';
        return `<span class="cell ${cls}" title="${avail.toFixed(1)}% · ${bucket.total} · ${new Date(
          bucket.t
        ).toUTCString()}"></span>`;
      })
      .join('');
    return `<div class="strip" role="img" aria-label="${escapeHtml(s.stripAria)}">${cells}</div>`;
  };

  const serviceCards = monitors
    .map((m) => {
      const meta = s.status[m.status] ?? s.status.unknown;
      const color = STATUS_COLORS[m.status] ?? STATUS_COLORS.unknown;
      const availabilityText =
        m.availability === null ? s.noData : `${m.availability.toFixed(2)}%`;
      return `
      <article class="card" data-status="${m.status}">
        <header class="card-head">
          <div>
            <h2>${escapeHtml(m.name)}</h2>
            <p class="url">${escapeHtml(hostOf(m.url))}</p>
          </div>
          <span class="pill" style="--pill:${color}">${escapeHtml(meta.label)}</span>
        </header>
        ${renderStrip(m)}
        <div class="metrics">
          <div><span class="k">${escapeHtml(s.availability)}</span><span class="v">${availabilityText}</span></div>
          <div><span class="k">${escapeHtml(s.avgResponse)}</span><span class="v">${
            m.avgResponseMs === null ? '—' : `${m.avgResponseMs} ms`
          }</span></div>
          <div><span class="k">${escapeHtml(s.probes)}</span><span class="v">${m.totalChecks}</span></div>
          <div><span class="k">${escapeHtml(s.lastCheck)}</span><span class="v">${relativeTime(
            m.lastCheckAt,
            now,
            lang
          )}</span></div>
        </div>
        ${
          m.incidents.length === 0
            ? `<p class="fine">${escapeHtml(s.noIncidents)}</p>`
            : `<details class="incidents"><summary>${m.incidents.length} ${
                m.incidents.length === 1 ? s.incident : s.incidents
              }</summary><ul>${m.incidents
                .map(
                  (incident) =>
                    `<li><span class="dot ${incident.resolvedAt ? 'resolved' : 'open'}"></span><strong>${escapeHtml(
                      incident.cause ?? s.probeFailure
                    )}</strong> · ${humanDuration(incident.durationSeconds, lang)} · ${new Date(
                      incident.startedAt
                    ).toUTCString()}${incident.resolvedAt ? '' : ` · ${escapeHtml(s.ongoing)}`}</li>`
                )
                .join('')}</ul></details>`
        }
        <p class="fine">${escapeHtml(meta.note)}</p>
      </article>`;
    })
    .join('');

  const maintenanceBlock =
    maintenance.length === 0
      ? ''
      : `<section class="maintenance"><h2>${escapeHtml(s.maintenance)}</h2><ul>${maintenance
          .map(
            (item) =>
              `<li><strong>${escapeHtml(item.title)}</strong><br><span class="fine">${new Date(
                item.startsAt
              ).toUTCString()} → ${new Date(item.endsAt).toUTCString()}</span>${
                item.body ? `<p>${escapeHtml(item.body)}</p>` : ''
              }</li>`
          )
          .join('')}</ul></section>`;

  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(s.docTitle(title))}</title>
<meta name="description" content="${escapeHtml(s.description(title))}">
<meta name="robots" content="index,follow">
<style>
  :root{color-scheme:dark light;--bg:#0b0f14;--panel:#111821;--panel2:#0f1620;--line:#1f2a37;--text:#e6edf3;--muted:#8b98a9;--accent:#2f81f7}
  @media (prefers-color-scheme: light){:root{--bg:#f6f8fa;--panel:#fff;--panel2:#f0f3f6;--line:#d8dee4;--text:#1f2328;--muted:#5d6b7d}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;padding:32px 20px 64px}
  .wrap{max-width:880px;margin:0 auto}
  a{color:var(--accent)}
  .top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:24px}
  .brand{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
  .lang-switch{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel2);color:var(--muted);font-size:13px;font-weight:600;line-height:1;text-decoration:none}
  .lang-switch:hover{color:var(--text);border-color:var(--muted);text-decoration:none}
  h1{margin:6px 0 0;font-size:26px;line-height:1.25}
  .banner{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:20px}
  .banner .lamp{width:12px;height:12px;border-radius:50%;background:${overall.color};box-shadow:0 0 0 4px ${overall.color}22;flex:none}
  .banner strong{font-size:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
  .card-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap}
  .card h2{margin:0;font-size:17px}
  .url{margin:2px 0 0;color:var(--muted);font-size:13px;word-break:break-all}
  .pill{font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;color:var(--pill);border:1px solid var(--pill);background:color-mix(in srgb,var(--pill) 14%,transparent);white-space:nowrap}
  .strip{display:flex;gap:2px;margin:16px 0 12px;height:34px;align-items:stretch;overflow:hidden;width:100%}
  .cell{flex:1 1 0;border-radius:2px;min-width:0;background:var(--panel2)}
  .cell.ok{background:#2ea043}
  .cell.warn{background:#d29922}
  .cell.bad{background:#f85149}
  .cell.empty{background:repeating-linear-gradient(45deg,var(--panel2),var(--panel2) 3px,transparent 3px,transparent 6px);border:1px solid var(--line)}
  .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:12px 0}
  .metrics div{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
  .metrics .k{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
  .metrics .v{font-size:15px;font-weight:600}
  .fine{color:var(--muted);font-size:12px;margin:8px 0 0}
  .incidents{margin-top:10px;font-size:13px}
  .incidents summary{cursor:pointer;color:var(--accent)}
  .incidents ul{margin:8px 0 0;padding-left:0;list-style:none}
  .incidents li{display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line);flex-wrap:wrap}
  .dot{width:8px;height:8px;border-radius:50%;flex:none}
  .dot.resolved{background:#2ea043}.dot.open{background:#f85149}
  .maintenance{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:8px}
  .maintenance h2{font-size:15px;margin:0 0 10px}
  .maintenance ul{list-style:none;margin:0;padding:0;font-size:13px}
  .maintenance li{padding:8px 0;border-top:1px solid var(--line)}
  footer{margin-top:28px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  @media (max-width:560px){
    body{padding:20px 14px 48px}
    h1{font-size:21px}
    .card{padding:14px}
    .strip{height:26px;gap:1px}
    .metrics{grid-template-columns:repeat(2,1fr)}
    .banner{padding:14px}
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <div class="brand">${escapeHtml(s.brand)}</div>
      <h1>${escapeHtml(title)}</h1>
    </div>
    <a class="lang-switch" href="${escapeHtml(switchHref)}" title="${escapeHtml(
      switchTitle
    )}" rel="alternate" hreflang="${lang === 'en' ? 'zh-CN' : 'en'}">${escapeHtml(switchLabel)}</a>
  </div>
  <div class="banner"><span class="lamp"></span><strong>${escapeHtml(overall.label)}</strong></div>
  ${serviceCards || `<p class="fine">${escapeHtml(s.empty)}</p>`}
  ${maintenanceBlock}
  <footer>
    <span>${escapeHtml(s.rendered(new Date(now).toUTCString()))}</span>
    <span>${escapeHtml(
      s.poweredBy
    )} · <a href="https://x.com/0xkillcoin" rel="me noopener" target="_blank">𝕏 @0xkillcoin</a></span>
  </footer>
</div>
</body>
</html>`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** JSON view of the same data, for embedding or external consumers. */
export function renderStatusJson(
  title: string,
  monitors: PublicMonitorView[],
  now: number
): string {
  const payload = {
    page: title,
    generatedAt: new Date(now).toISOString(),
    overall:
      monitors.length === 0
        ? 'empty'
        : monitors.every((m) => m.status === 'up')
          ? 'operational'
          : monitors.some((m) => m.status === 'down' || m.status === 'recovering')
            ? 'degraded'
            : 'partial',
    services: monitors.map((m) => ({
      name: m.name,
      // Only the hostname is public, never the full internal path/query.
      host: hostOf(m.url),
      status: m.status,
      availability24h: m.availability,
      probes24h: m.totalChecks,
      failed24h: m.failedChecks,
      avgResponseMs: m.avgResponseMs,
      lastCheckAt: m.lastCheckAt ? new Date(m.lastCheckAt).toISOString() : null,
      lastStatusCode: m.lastStatusCode,
      incidents: m.incidents.map((incident) => ({
        startedAt: new Date(incident.startedAt).toISOString(),
        resolvedAt: incident.resolvedAt ? new Date(incident.resolvedAt).toISOString() : null,
        durationSeconds: incident.durationSeconds,
        cause: incident.cause,
      })),
    })),
  };
  return JSON.stringify(payload, null, 2);
}
export async function loadStatusPage(
  env: Bindings,
  slug: string,
  now = Date.now()
): Promise<{ title: string; monitors: PublicMonitorView[]; maintenance: Array<{ title: string; body: string; startsAt: number; endsAt: number }> } | null> {
  const single = await loadPublicMonitor(env, slug, now);
  if (!single) return null;
  const { results } = await env.DB.prepare(
    'SELECT * FROM maintenance_windows WHERE user_id = ? AND ends_at >= ? ORDER BY starts_at ASC LIMIT 10'
  )
    .bind(single.monitor.user_id, now)
    .all<{ title: string; body: string; starts_at: number; ends_at: number }>();
  return {
    title: single.monitor.name,
    monitors: [single.view],
    maintenance: (results ?? []).map((row) => ({
      title: row.title,
      body: row.body,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    })),
  };
}

export { computeAvailability, downtimeWithinWindow };
