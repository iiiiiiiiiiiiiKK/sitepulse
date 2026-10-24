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

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function relativeTime(from: number | null, now: number): string {
  if (!from) return 'never';
  const diff = Math.max(0, Math.round((now - from) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const STATUS_META: Record<string, { label: string; color: string; note: string }> = {
  up: { label: 'Operational', color: '#2ea043', note: 'All probes succeeding.' },
  down: { label: 'Outage', color: '#f85149', note: 'Consecutive probe failures detected.' },
  recovering: { label: 'Recovering', color: '#d29922', note: 'Probe succeeded, confirming recovery.' },
  paused: { label: 'Paused', color: '#6e7681', note: 'Monitoring is paused by the owner.' },
  unknown: { label: 'Unknown', color: '#6e7681', note: 'No probe has completed yet.' },
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
}

export function renderStatusPage(input: StatusPageInput): string {
  const { title, monitors, maintenance, now } = input;
  const down = monitors.filter((m) => m.status === 'down' || m.status === 'recovering');
  const overall =
    monitors.length === 0
      ? { label: 'No services yet', color: '#6e7681' }
      : down.length === 0
        ? { label: 'All systems operational', color: '#2ea043' }
        : { label: `${down.length} of ${monitors.length} services degraded`, color: '#f85149' };

  const totalDowntime = monitors.reduce((sum, m) => sum + (m.availability === null ? 0 : 0), 0);
  void totalDowntime;
  void overall;

  const renderStrip = (m: PublicMonitorView) => {
    const cells = m.strip
      .map((bucket) => {
        if (bucket.total === 0) {
          return `<span class="cell empty" title="No data (${new Date(bucket.t).toUTCString()})"></span>`;
        }
        const avail = bucket.availability ?? 0;
        const cls = avail >= 99.5 ? 'ok' : avail >= 90 ? 'warn' : 'bad';
        return `<span class="cell ${cls}" title="${avail.toFixed(1)}% · ${bucket.total} probes · ${new Date(bucket.t).toUTCString()}"></span>`;
      })
      .join('');
    return `<div class="strip" role="img" aria-label="Last 24 hours uptime">${cells}</div>`;
  };

  const serviceCards = monitors
    .map((m) => {
      const meta = STATUS_META[m.status] ?? STATUS_META.unknown;
      const availabilityText =
        m.availability === null ? 'No data' : `${m.availability.toFixed(2)}%`;
      return `
      <article class="card" data-status="${m.status}">
        <header class="card-head">
          <div>
            <h2>${escapeHtml(m.name)}</h2>
            <p class="url">${escapeHtml(hostOf(m.url))}</p>
          </div>
          <span class="pill" style="--pill:${meta.color}">${meta.label}</span>
        </header>
        ${renderStrip(m)}
        <div class="metrics">
          <div><span class="k">24h availability</span><span class="v">${availabilityText}</span></div>
          <div><span class="k">Avg response</span><span class="v">${m.avgResponseMs === null ? '—' : `${m.avgResponseMs} ms`}</span></div>
          <div><span class="k">Probes</span><span class="v">${m.totalChecks}</span></div>
          <div><span class="k">Last check</span><span class="v">${relativeTime(m.lastCheckAt, now)}</span></div>
        </div>
        ${
          m.incidents.length === 0
            ? '<p class="fine">No incidents recorded in the retained history.</p>'
            : `<details class="incidents"><summary>${m.incidents.length} incident${m.incidents.length === 1 ? '' : 's'}</summary><ul>${m.incidents
                .map(
                  (incident) =>
                    `<li><span class="dot ${incident.resolvedAt ? 'resolved' : 'open'}"></span><strong>${incident.cause ?? 'Probe failure'}</strong> · ${humanDuration(incident.durationSeconds)} · ${new Date(incident.startedAt).toUTCString()}${incident.resolvedAt ? '' : ' · ongoing'}</li>`
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
      : `<section class="maintenance"><h2>Scheduled maintenance</h2><ul>${maintenance
          .map(
            (item) =>
              `<li><strong>${escapeHtml(item.title)}</strong><br><span class="fine">${new Date(item.startsAt).toUTCString()} → ${new Date(item.endsAt).toUTCString()}</span>${
                item.body ? `<p>${escapeHtml(item.body)}</p>` : ''
              }</li>`
          )
          .join('')}</ul></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · SitePulse status</title>
<meta name="description" content="Live availability status for ${escapeHtml(title)}.">
<meta name="robots" content="index,follow">
<style>
  :root{color-scheme:dark light;--bg:#0b0f14;--panel:#111821;--panel2:#0f1620;--line:#1f2a37;--text:#e6edf3;--muted:#8b98a9;--accent:#2f81f7}
  @media (prefers-color-scheme: light){:root{--bg:#f6f8fa;--panel:#fff;--panel2:#f0f3f6;--line:#d8dee4;--text:#1f2328;--muted:#5d6b7d}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:32px 20px 64px}
  .wrap{max-width:880px;margin:0 auto}
  a{color:var(--accent)}
  .top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:24px}
  .brand{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
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
      <div class="brand">SitePulse status</div>
      <h1>${escapeHtml(title)}</h1>
    </div>
  </div>
  <div class="banner"><span class="lamp"></span><strong>${escapeHtml(overall.label)}</strong></div>
  ${serviceCards || '<p class="fine">No public services are configured for this status page.</p>'}
  ${maintenanceBlock}
  <footer>
    <span>Rendered ${new Date(now).toUTCString()} · all times UTC</span>
    <span>Powered by SitePulse · <a href="https://x.com/0xkillcoin" rel="me noopener" target="_blank">𝕏 @0xkillcoin</a></span>
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
