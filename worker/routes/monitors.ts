import type { Bindings, IncidentRow, MonitorRow } from '../lib/types';
import {
  ApiError,
  asBoolean,
  asIntInRange,
  asString,
  clientIp,
  fail,
  json,
  optionalString,
  rateLimit,
  readJson,
} from '../lib/http';
import { planFor, type AuthContext } from '../lib/auth';
import { assertProbeableUrl } from '../lib/urlguard';
import { validateExpectedStatus } from '../lib/probe';
import { claimMonitor } from '../lib/scheduler';
import { dispatchEvent } from '../lib/notify';
import {
  deriveDisplayStatus,
  incidentDurationSeconds,
  DISPLAY_STATUS_LABEL,
} from '../lib/monitor-state';
import {
  RANGE_BUCKET_MS,
  RANGE_MS,
  buildSeries,
  dailyRollup,
  downtimeWithinWindow,
  parseRange,
  type RangeKey,
} from '../lib/stats';
import { randomHex } from '../lib/crypto';

const INTERVAL_ALLOWED = [60, 300, 600, 900, 1800, 3600] as const;

export function origin(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function serializeMonitor(monitor: MonitorRow, request: Request) {
  const display = deriveDisplayStatus(
    monitor.status,
    monitor.consecutive_successes,
    monitor.recovery_threshold,
    monitor.current_incident_id
  );
  const base = origin(request);
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    intervalSeconds: monitor.interval_seconds,
    timeoutMs: monitor.timeout_ms,
    expectedStatus: monitor.expected_status,
    failureThreshold: monitor.failure_threshold,
    recoveryThreshold: monitor.recovery_threshold,
    status: display,
    statusLabel: DISPLAY_STATUS_LABEL[display],
    rawStatus: monitor.status,
    enabled: monitor.enabled === 1,
    isPublic: monitor.is_public === 1,
    publicSlug: monitor.public_slug,
    publicUrl: monitor.is_public === 1 ? `${base}/status/${monitor.public_slug}` : null,
    consecutiveFailures: monitor.consecutive_failures,
    consecutiveSuccesses: monitor.consecutive_successes,
    nextCheckAt: monitor.next_check_at,
    lastCheckAt: monitor.last_check_at,
    lastSuccessAt: monitor.last_success_at,
    lastStatusCode: monitor.last_status_code,
    lastResponseMs: monitor.last_response_ms,
    lastError: monitor.last_error,
    lastErrorKind: monitor.last_error_kind,
    currentIncidentId: monitor.current_incident_id,
    createdAt: monitor.created_at,
    updatedAt: monitor.updated_at,
  };
}

async function loadOwnedMonitor(
  env: Bindings,
  id: string,
  auth: AuthContext
): Promise<MonitorRow> {
  const monitor = await env.DB.prepare('SELECT * FROM monitors WHERE id = ? AND user_id = ?')
    .bind(id, auth.user.id)
    .first<MonitorRow>();
  if (!monitor) throw new ApiError(404, 'Monitor not found.', 'not_found');
  return monitor;
}

interface MonitorPayload {
  name?: unknown;
  url?: unknown;
  method?: unknown;
  intervalSeconds?: unknown;
  timeoutMs?: unknown;
  expectedStatus?: unknown;
  failureThreshold?: unknown;
  recoveryThreshold?: unknown;
}

async function validatePayload(
  body: MonitorPayload,
  options: { partial: boolean }
): Promise<Partial<Record<string, string | number>>> {
  const patch: Partial<Record<string, string | number>> = {};

  if (body.name !== undefined || !options.partial) {
    patch.name = asString(body.name, 'Name', 80);
  }
  if (body.url !== undefined || !options.partial) {
    const raw = asString(body.url, 'URL', 2048);
    // Normalise: bare "example.com" is upgraded to https://example.com
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const guard = await assertProbeableUrl(withScheme, { resolver: null });
    if (!guard.ok) {
      throw new ApiError(400, guard.reason, guard.code === 'dns' ? 'dns' : 'blocked_target');
    }
    patch.url = guard.url.toString();
  }
  if (body.method !== undefined) {
    const method = asString(body.method, 'Method', 8).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      throw new ApiError(400, 'Method must be GET or HEAD.', 'validation');
    }
    patch.method = method;
  } else if (!options.partial) {
    patch.method = 'GET';
  }
  if (body.intervalSeconds !== undefined || !options.partial) {
    const interval = asIntInRange(body.intervalSeconds ?? 300, 'Interval', 60, 3600);
    if (!INTERVAL_ALLOWED.includes(interval as (typeof INTERVAL_ALLOWED)[number])) {
      throw new ApiError(
        400,
        `Interval must be one of ${INTERVAL_ALLOWED.join(', ')} seconds.`,
        'validation'
      );
    }
    patch.interval_seconds = interval;
  }
  if (body.timeoutMs !== undefined || !options.partial) {
    patch.timeout_ms = asIntInRange(body.timeoutMs ?? 10000, 'Timeout', 1000, 30000);
  }
  if (body.expectedStatus !== undefined) {
    const spec = asString(body.expectedStatus, 'Expected status', 120);
    const problem = validateExpectedStatus(spec);
    if (problem) throw new ApiError(400, problem, 'validation');
    patch.expected_status = spec;
  } else if (!options.partial) {
    patch.expected_status = '200-299';
  }
  if (body.failureThreshold !== undefined || !options.partial) {
    patch.failure_threshold = asIntInRange(body.failureThreshold ?? 3, 'Failure threshold', 1, 10);
  }
  if (body.recoveryThreshold !== undefined) {
    patch.recovery_threshold = asIntInRange(body.recoveryThreshold, 'Recovery threshold', 1, 10);
  }
  return patch;
}

export async function handleMonitors(
  env: Bindings,
  request: Request,
  auth: AuthContext,
  segments: string[]
): Promise<Response> {
  const userId = auth.user.id;
  const limits = planFor(auth.user);

  // ---- collection routes ---------------------------------------------------
  if (segments.length === 2) {
    if (request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM monitors WHERE user_id = ? ORDER BY created_at ASC'
      )
        .bind(userId)
        .all<MonitorRow>();
      const monitors = results ?? [];

      const since = Date.now() - RANGE_MS['24h'];
      const stats = new Map<string, { total: number; failed: number; avgMs: number | null }>();
      if (monitors.length > 0) {
        const placeholders = monitors.map(() => '?').join(',');
        const agg = await env.DB.prepare(
          `SELECT monitor_id, COUNT(*) AS total, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
                  AVG(CASE WHEN response_ms IS NOT NULL THEN response_ms END) AS avg_ms
           FROM checks WHERE checked_at >= ? AND monitor_id IN (${placeholders}) GROUP BY monitor_id`
        )
          .bind(since, ...monitors.map((m) => m.id))
          .all<{ monitor_id: string; total: number; failed: number; avg_ms: number | null }>();
        for (const row of agg.results ?? []) {
          stats.set(row.monitor_id, {
            total: row.total,
            failed: row.failed,
            avgMs: row.avg_ms === null ? null : Math.round(row.avg_ms),
          });
        }
      }

      return json({
        monitors: monitors.map((monitor) => {
          const stat = stats.get(monitor.id);
          return {
            ...serializeMonitor(monitor, request),
            stats24h: {
              total: stat?.total ?? 0,
              failed: stat?.failed ?? 0,
              availability:
                stat && stat.total > 0 ? ((stat.total - stat.failed) / stat.total) * 100 : null,
              avgResponseMs: stat?.avgMs ?? null,
            },
          };
        }),
        quota: { used: monitors.length, max: limits.maxMonitors, plan: limits.id },
      });
    }

    if (request.method === 'POST') {
      const limit = await rateLimit(env.DB, `monitor-create:${userId}`, 60, 3600);
      if (!limit.allowed) {
        return fail(429, 'You are creating monitors too quickly. Try again shortly.', 'rate_limited');
      }
      const count = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM monitors WHERE user_id = ?'
      )
        .bind(userId)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= limits.maxMonitors) {
        throw new ApiError(
          403,
          `Your ${limits.id} plan allows ${limits.maxMonitors} monitors. Delete one or upgrade.`,
          'quota_exceeded'
        );
      }

      const body = await readJson<MonitorPayload>(request);
      const patch = await validatePayload(body, { partial: false });
      const now = Date.now();
      const id = `mon_${randomHex(8)}`;
      const slug = `m-${randomHex(6)}`;
      await env.DB.prepare(
        `INSERT INTO monitors (
           id, user_id, name, url, method, interval_seconds, timeout_ms, expected_status,
           failure_threshold, recovery_threshold, status, enabled, is_public, public_slug,
           consecutive_failures, consecutive_successes, next_check_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 1, 0, ?, 0, 0, ?, ?, ?)`
      )
        .bind(
          id,
          userId,
          patch.name as string,
          patch.url as string,
          patch.method as string,
          patch.interval_seconds as number,
          patch.timeout_ms as number,
          patch.expected_status as string,
          patch.failure_threshold as number,
          (patch.recovery_threshold as number) ?? 1,
          slug,
          // First probe happens almost immediately (5s) so the user sees a result.
          now + 5000,
          now,
          now
        )
        .run();

      const created = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?')
        .bind(id)
        .first<MonitorRow>();
      return json({ monitor: serializeMonitor(created as MonitorRow, request) }, { status: 201 });
    }

    throw new ApiError(405, 'Method not allowed.', 'method_not_allowed');
  }

  const monitorId = segments[2];
  const action = segments[3];

  // ---- single monitor ------------------------------------------------------
  if (segments.length === 3) {
    const monitor = await loadOwnedMonitor(env, monitorId, auth);

    if (request.method === 'GET') {
      const range = parseRange(new URL(request.url).searchParams.get('range'));
      const now = Date.now();
      const since = now - RANGE_MS[range];
      const bucketMs = RANGE_BUCKET_MS[range];

      const checks = await env.DB.prepare(
        `SELECT checked_at, ok, response_ms FROM checks
         WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at ASC LIMIT 20000`
      )
        .bind(monitorId, since)
        .all<{ checked_at: number; ok: number; response_ms: number | null }>();

      const incidents = await env.DB.prepare(
        'SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 50'
      )
        .bind(monitorId)
        .all<IncidentRow>();

      const series = buildSeries(checks.results ?? [], since, now, bucketMs);
      const incidentRows = incidents.results ?? [];
      const retentionDays = limits.retentionDays;

      return json({
        monitor: serializeMonitor(monitor, request),
        range,
        stats: {
          ...series.stats,
          downtimeSeconds: downtimeWithinWindow(
            incidentRows.filter((i) => i.resolved_at === null || i.resolved_at >= since),
            since,
            now
          ),
          retentionDays,
          // True when the requested window reaches past the retention horizon.
          retentionLimited: now - since > retentionDays * 86400000,
        },
        buckets: series.buckets,
        daily: dailyRollup(
          (checks.results ?? []).map((c) => ({ checked_at: c.checked_at, ok: c.ok })),
          since,
          now
        ),
        incidents: incidentRows.map((incident) => ({
          id: incident.id,
          startedAt: incident.started_at,
          resolvedAt: incident.resolved_at,
          durationSeconds: incidentDurationSeconds(incident, now),
          cause: incident.cause,
          summary: incident.summary,
          lastStatusCode: incident.last_status_code,
        })),
        recentChecks: (checks.results ?? []).slice(-60).map((c) => ({
          checkedAt: c.checked_at,
          ok: c.ok === 1,
          responseMs: c.response_ms,
        })),
      });
    }

    if (request.method === 'PATCH') {
      const body = await readJson<MonitorPayload & { isPublic?: unknown; enabled?: unknown }>(
        request
      );
      const patch = await validatePayload(body, { partial: true });

      if (body.isPublic !== undefined) {
        patch.is_public = asBoolean(body.isPublic) ? 1 : 0;
      }
      if (body.enabled !== undefined) {
        const enabled = asBoolean(body.enabled);
        patch.enabled = enabled ? 1 : 0;
        patch.status = enabled ? (monitor.status === 'paused' ? 'unknown' : monitor.status) : 'paused';
        if (!enabled) {
          patch.next_check_at = Date.now() + 365 * 86400000;
          patch.enabled_clear_next = 1;
        } else {
          patch.next_check_at = Date.now() + 3000;
        }
      }

      const columns = Object.keys(patch).filter((key) => key !== 'enabled_clear_next');
      if (columns.length === 0) {
        throw new ApiError(400, 'Nothing to update.', 'validation');
      }
      const assignments = columns.map((column) => `${column} = ?`).join(', ');
      const values = columns.map((column) => patch[column] as string | number);
      await env.DB.prepare(
        `UPDATE monitors SET ${assignments}, updated_at = ? WHERE id = ? AND user_id = ?`
      )
        .bind(...values, Date.now(), monitorId, userId)
        .run();

      const updated = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?')
        .bind(monitorId)
        .first<MonitorRow>();
      return json({ monitor: serializeMonitor(updated as MonitorRow, request) });
    }

    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM monitors WHERE id = ? AND user_id = ?')
        .bind(monitorId, userId)
        .run();
      return json({ ok: true, deleted: monitorId });
    }

    throw new ApiError(405, 'Method not allowed.', 'method_not_allowed');
  }

  // ---- monitor actions -----------------------------------------------------
  if (segments.length === 4 && request.method === 'POST') {
    const monitor = await loadOwnedMonitor(env, monitorId, auth);

    if (action === 'pause') {
      await env.DB.prepare(
        `UPDATE monitors SET enabled = 0, status = 'paused', next_check_at = ?, updated_at = ? WHERE id = ?`
      )
        .bind(Date.now() + 365 * 86400000, Date.now(), monitorId)
        .run();
      const updated = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?')
        .bind(monitorId)
        .first<MonitorRow>();
      return json({ monitor: serializeMonitor(updated as MonitorRow, request) });
    }

    if (action === 'resume') {
      await env.DB.prepare(
        `UPDATE monitors SET enabled = 1, status = 'unknown', consecutive_failures = 0,
           consecutive_successes = 0, next_check_at = ?, updated_at = ? WHERE id = ?`
      )
        .bind(Date.now() + 3000, Date.now(), monitorId)
        .run();
      const updated = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?')
        .bind(monitorId)
        .first<MonitorRow>();
      return json({ monitor: serializeMonitor(updated as MonitorRow, request) });
    }

    if (action === 'check-now') {
      const limit = await rateLimit(env.DB, `check-now:${userId}`, 60, 600);
      if (!limit.allowed) {
        return fail(
          429,
          'Manual checks are limited to 60 per 10 minutes. The scheduler keeps probing automatically.',
          'rate_limited'
        );
      }
      if (monitor.enabled !== 1) {
        throw new ApiError(400, 'Resume this monitor before running a manual check.', 'paused');
      }
      // Per-monitor de-duplication: only one manual request may be pending in a
      // 20-second window, so double-clicking cannot burn two probe slots.
      const dedupe = await rateLimit(env.DB, `check-now:${monitor.id}`, 1, 20);
      if (!dedupe.allowed) {
        throw new ApiError(
          409,
          'A check for this monitor is already queued. Try again in a few seconds.',
          'already_queued'
        );
      }
      const claimed = await claimMonitor(env, monitor, Date.now());
      if (!claimed) {
        throw new ApiError(
          409,
          'A check for this monitor is already queued. Try again in a few seconds.',
          'already_queued'
        );
      }
      return json({
        ok: true,
        queued: true,
        message: 'Check queued — the next scheduler tick (≤60s) runs it.',
      });
    }

    if (action === 'test-notification') {
      const outcomes = await dispatchEvent(env, {
        event: 'test',
        monitor,
        origin: origin(request),
      });
      const sent = outcomes.filter((o) => o.status === 'sent').length;
      const failed = outcomes.filter((o) => o.status === 'failed').length;
      const skipped = outcomes.filter((o) => o.status === 'skipped').length;
      return json({
        outcomes,
        summary: {
          sent,
          failed,
          skipped,
          message:
            outcomes.length === 0
              ? 'No notification channels are configured for this monitor yet.'
              : `${sent} sent, ${failed} failed, ${skipped} skipped.`,
        },
      });
    }

    throw new ApiError(404, 'Unknown monitor action.', 'not_found');
  }

  // ---- export --------------------------------------------------------------
  if (segments.length === 4 && action === 'export' && request.method === 'GET') {
    const monitor = await loadOwnedMonitor(env, monitorId, auth);
    const url = new URL(request.url);
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
    const range: RangeKey = parseRange(url.searchParams.get('range'));
    const since = Date.now() - RANGE_MS[range];

    const { results } = await env.DB.prepare(
      `SELECT checked_at, ok, status_code, response_ms, error_kind, error_message, redirects, final_url
       FROM checks WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at ASC LIMIT 50000`
    )
      .bind(monitorId, since)
      .all<{
        checked_at: number;
        ok: number;
        status_code: number | null;
        response_ms: number | null;
        error_kind: string | null;
        error_message: string | null;
        redirects: number;
        final_url: string | null;
      }>();

    const incidents = await env.DB.prepare(
      'SELECT * FROM incidents WHERE monitor_id = ? AND started_at >= ? ORDER BY started_at ASC'
    )
      .bind(monitorId, since)
      .all<IncidentRow>();

    if (format === 'json') {
      return json(
        {
          monitor: { id: monitor.id, name: monitor.name, url: monitor.url },
          range,
          exportedAt: new Date().toISOString(),
          checks: (results ?? []).map((row) => ({
            checkedAt: new Date(row.checked_at).toISOString(),
            ok: row.ok === 1,
            statusCode: row.status_code,
            responseMs: row.response_ms,
            errorKind: row.error_kind,
            errorMessage: row.error_message,
            redirects: row.redirects,
            finalUrl: row.final_url,
          })),
          incidents: (incidents.results ?? []).map((incident) => ({
            startedAt: new Date(incident.started_at).toISOString(),
            resolvedAt: incident.resolved_at ? new Date(incident.resolved_at).toISOString() : null,
            durationSeconds: incident.duration_seconds,
            cause: incident.cause,
            summary: incident.summary,
          })),
        },
        { headers: { 'content-disposition': `attachment; filename="${safeFilename(monitor.name)}-${range}.json"` } }
      );
    }

    const header = [
      'checked_at_iso',
      'ok',
      'status_code',
      'response_ms',
      'error_kind',
      'error_message',
      'redirects',
      'final_url',
    ].join(',');
    const lines = (results ?? []).map((row) =>
      [
        new Date(row.checked_at).toISOString(),
        row.ok === 1 ? 'up' : 'down',
        row.status_code ?? '',
        row.response_ms ?? '',
        row.error_kind ?? '',
        csvCell(row.error_message ?? ''),
        row.redirects,
        csvCell(row.final_url ?? ''),
      ].join(',')
    );
    return new Response([header, ...lines].join('\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${safeFilename(monitor.name)}-${range}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  // ---- incident timeline ---------------------------------------------------
  if (segments.length === 4 && action === 'incidents' && request.method === 'GET') {
    await loadOwnedMonitor(env, monitorId, auth);
    const { results } = await env.DB.prepare(
      'SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 100'
    )
      .bind(monitorId)
      .all<IncidentRow>();
    const now = Date.now();
    return json({
      incidents: (results ?? []).map((incident) => ({
        id: incident.id,
        startedAt: incident.started_at,
        resolvedAt: incident.resolved_at,
        durationSeconds: incidentDurationSeconds(incident, now),
        cause: incident.cause,
        summary: incident.summary,
        lastStatusCode: incident.last_status_code,
        peakResponseMs: incident.peak_response_ms,
      })),
    });
  }

  throw new ApiError(404, 'Unknown monitor endpoint.', 'not_found');
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function safeFilename(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'monitor';
}

export { optionalString };
