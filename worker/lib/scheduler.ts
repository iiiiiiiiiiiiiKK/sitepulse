import type { Bindings, IncidentRow, MonitorRow } from './types';
import { probe } from './probe';
import { applyProbeOutcome } from './monitor-state';
import { dispatchEvent } from './notify';
import { randomHex } from './crypto';

/**
 * Scheduler / probe executor.
 *
 * Each cron tick:
 *   1. Claims due monitors one at a time with a conditional UPDATE
 *      (`WHERE id = ? AND next_check_at = ?`). A second overlapping cron run
 *      loses the race and skips the row, so a monitor is never probed twice for
 *      the same slot — this is the dedupe mechanism, and it needs no lock table.
 *   2. Claims are re-armed by writing `next_check_at = now + interval` BEFORE
 *      the probe, so a probe that crashes the isolate cannot cause a hot loop.
 *   3. Runs the probe, writes the `checks` row, applies the state machine and
 *      opens/resolves the incident.
 *   4. Dispatches notifications once per (channel, incident, event).
 */

export interface RunSummary {
  considered: number;
  claimed: number;
  probed: number;
  failed: number;
  incidentsOpened: number;
  incidentsResolved: number;
  notifications: number;
  pruned: number;
  errors: string[];
}

const CHECK_RETENTION_SAFETY_LIMIT = 20_000;

/** Atomically claims one due monitor slot. Returns null if another run won. */export async function claimMonitor(
  env: Bindings,
  monitor: MonitorRow,
  nowMs: number
): Promise<boolean> {
  const nextCheckAt = nowMs + Math.max(30, monitor.interval_seconds) * 1000;
  const result = await env.DB.prepare(
    `UPDATE monitors SET next_check_at = ?
     WHERE id = ? AND next_check_at = ? AND enabled = 1`
  )
    .bind(nextCheckAt, monitor.id, monitor.next_check_at)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function runDueMonitors(
  env: Bindings,
  origin: string,
  options: { maxProbes?: number; nowMs?: number } = {}
): Promise<RunSummary> {
  const summary: RunSummary = {
    considered: 0,
    claimed: 0,
    probed: 0,
    failed: 0,
    incidentsOpened: 0,
    incidentsResolved: 0,
    notifications: 0,
    pruned: 0,
    errors: [],
  };

  const now = options.nowMs ?? Date.now();
  const configured = Number(env.PROBES_PER_RUN ?? '20');
  const maxProbes = Math.max(1, Math.min(options.maxProbes ?? configured, 50));

  const due = await env.DB.prepare(
    `SELECT * FROM monitors WHERE enabled = 1 AND next_check_at <= ? ORDER BY next_check_at ASC LIMIT ?`
  )
    .bind(now, maxProbes)
    .all<MonitorRow>();
  const monitors = due.results ?? [];
  summary.considered = monitors.length;

  for (const monitor of monitors) {
    const claimed = await claimMonitor(env, monitor, now);
    if (!claimed) continue;
    summary.claimed += 1;

    try {
      const result = await probe({
        url: monitor.url,
        method: monitor.method,
        timeoutMs: monitor.timeout_ms,
        expectedStatus: monitor.expected_status,
      });
      summary.probed += 1;
      if (!result.ok) summary.failed += 1;

      const checkedAt = Date.now();
      // A `resolver` failure means OUR DNS-over-HTTPS lookup failed, not that
      // the monitored site is down. It is surfaced on the monitor row (so the
      // user can see why the last probe did not produce a sample) but it is not
      // written as a failed check and cannot open an incident: otherwise our own
      // infrastructure blip would fan out into a fake outage on every monitor.
      if (!result.ok && result.errorKind === 'resolver') {
        await env.DB.prepare(
          `UPDATE monitors SET last_check_at = ?, last_error = ?, last_error_kind = ?, updated_at = ?
           WHERE id = ?`
        )
          .bind(checkedAt, result.errorMessage, result.errorKind, checkedAt, monitor.id)
          .run();
        continue;
      }

      await env.DB.prepare(
        `INSERT INTO checks (monitor_id, checked_at, ok, status_code, response_ms, error_kind, error_message, redirects, final_url, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
        .bind(
          monitor.id,
          checkedAt,
          result.ok ? 1 : 0,
          result.statusCode,
          result.responseMs,
          result.errorKind,
          result.errorMessage,
          result.redirects,
          result.finalUrl
        )
        .run();

      const transition = applyProbeOutcome(
        {
          status: monitor.status,
          consecutiveFailures: monitor.consecutive_failures,
          consecutiveSuccesses: monitor.consecutive_successes,
          failureThreshold: monitor.failure_threshold,
          recoveryThreshold: monitor.recovery_threshold,
          currentIncidentId: monitor.current_incident_id,
        },
        result.ok ? 'success' : 'failure'
      );

      let incidentId = monitor.current_incident_id;

      if (transition.openIncident) {
        const newIncidentId = `inc_${randomHex(8)}`;
        await env.DB.prepare(
          `INSERT INTO incidents (id, monitor_id, started_at, cause, summary, last_status_code, peak_response_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            newIncidentId,
            monitor.id,
            checkedAt,
            result.errorKind ?? 'unknown',
            result.errorMessage ?? 'Probe failed.',
            result.statusCode,
            result.responseMs
          )
          .run();
        incidentId = newIncidentId;
        summary.incidentsOpened += 1;
      } else if (monitor.current_incident_id) {
        // Keep the running incident's summary fresh while it is still open.
        await env.DB.prepare(
          `UPDATE incidents SET summary = COALESCE(?, summary),
             last_status_code = COALESCE(?, last_status_code),
             peak_response_ms = MAX(COALESCE(peak_response_ms, 0), COALESCE(?, 0))
           WHERE id = ? AND resolved_at IS NULL`
        )
          .bind(result.errorMessage, result.statusCode, result.responseMs, monitor.current_incident_id)
          .run();
      }

      if (transition.closeIncident && monitor.current_incident_id) {
        const started = await env.DB.prepare('SELECT started_at FROM incidents WHERE id = ?')
          .bind(monitor.current_incident_id)
          .first<{ started_at: number }>();
        const duration = started ? Math.max(0, Math.round((checkedAt - started.started_at) / 1000)) : 0;
        await env.DB.prepare(
          `UPDATE incidents SET resolved_at = ?, duration_seconds = ?, peak_response_ms = MAX(COALESCE(peak_response_ms,0), COALESCE(?,0))
           WHERE id = ? AND resolved_at IS NULL`
        )
          .bind(checkedAt, duration, result.responseMs, monitor.current_incident_id)
          .run();
        incidentId = null;
        summary.incidentsResolved += 1;
      }

      await env.DB.prepare(
        `UPDATE monitors SET
           status = ?, consecutive_failures = ?, consecutive_successes = ?,
           last_check_at = ?, last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
           last_status_code = ?, last_response_ms = ?, last_error = ?, last_error_kind = ?,
           current_incident_id = ?, updated_at = ?
         WHERE id = ?`
      )
        .bind(
          transition.status,
          transition.consecutiveFailures,
          transition.consecutiveSuccesses,
          checkedAt,
          result.ok ? 1 : 0,
          checkedAt,
          result.statusCode,
          result.responseMs,
          result.ok ? null : result.errorMessage,
          result.ok ? null : result.errorKind,
          incidentId,
          checkedAt,
          monitor.id
        )
        .run();

      // Re-read so notification payloads carry post-transition truth.
      const fresh = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?')
        .bind(monitor.id)
        .first<MonitorRow>();
      if (!fresh) continue;

      const event = transition.openIncident ? 'down' : transition.closeIncident ? 'recover' : null;
      if (event) {
        const incident = incidentId
          ? await env.DB.prepare('SELECT * FROM incidents WHERE id = ?')
              .bind(incidentId)
              .first<IncidentRow>()
          : monitor.current_incident_id
            ? await env.DB.prepare('SELECT * FROM incidents WHERE id = ?')
                .bind(monitor.current_incident_id)
                .first<IncidentRow>()
            : null;
        const outcomes = await dispatchEvent(env, { event, monitor: fresh, incident, origin });
        summary.notifications += outcomes.filter((o) => o.status === 'sent').length;
      }
    } catch (error) {
      // One broken monitor must not stop the rest of the batch.
      summary.errors.push(
        `${monitor.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return summary;
}

/**
 * Retention pruning.
 *
 * This used to be the single most expensive statement in the product: a
 * three-table join (`checks → monitors → users`) with a `CASE` on the plan,
 * run on EVERY cron tick. Nothing indexed `checked_at` on its own, so SQLite
 * fell back to a covering-index full scan:
 *
 *   EXPLAIN QUERY PLAN ... -> SCAN c USING COVERING INDEX idx_checks_monitor_time
 *
 * At 6.7k stored checks that was ~12k rows read per call, ~850 calls/day, and
 * it grows linearly with history — measured at 10.2M of the 10.2M total daily
 * reads (Cloudflare `d1QueriesAdaptiveGroups`, attributed by query text).
 *
 * Now: two cheap, index-backed statements, and only every `PRUNE_EVERY_MINUTES`
 * instead of every minute.
 *   1. a global floor delete at the longest retention any plan allows (90d);
 *   2. per-monitor deletes only for monitors on a shorter window (30d).
 * Both are seeks on `idx_checks_checked_at` / `idx_checks_monitor_time`, so a
 * tick with nothing to delete reads 0 rows instead of the whole table.
 */

/** Minutes between pruning passes. 15 → 4 passes/hour instead of 60. */
export const PRUNE_EVERY_MINUTES = 15;

export function shouldPruneNow(nowMs: number): boolean {
  return new Date(nowMs).getUTCMinutes() % PRUNE_EVERY_MINUTES === 0;
}

/** Longest retention offered by any plan; the safe global delete floor. */
const MAX_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

export async function pruneOldChecks(env: Bindings, nowMs = Date.now()): Promise<number> {
  let deleted = 0;

  // 1. Anything older than the maximum retention is expired for every plan.
  const floor = await env.DB.prepare(
    `DELETE FROM checks WHERE id IN (
       SELECT id FROM checks WHERE checked_at < ? LIMIT ?
     )`
  )
    .bind(nowMs - MAX_RETENTION_DAYS * DAY_MS, CHECK_RETENTION_SAFETY_LIMIT)
    .run();
  deleted += floor.meta?.changes ?? 0;

  // 2. Monitors on a shorter window than the floor. This reads the monitor list
  //    (tens of rows), never the checks table, and each delete is a seek.
  const monitors = await env.DB.prepare(
    `SELECT m.id AS id,
            CASE WHEN u.plan = 'pro' THEN 90 ELSE 30 END AS retention_days
     FROM monitors m JOIN users u ON u.id = m.user_id`
  ).all<{ id: string; retention_days: number }>();

  for (const monitor of monitors.results ?? []) {
    if (monitor.retention_days >= MAX_RETENTION_DAYS) continue;
    const cutoff = nowMs - monitor.retention_days * DAY_MS;
    const result = await env.DB.prepare(
      `DELETE FROM checks WHERE id IN (
         SELECT id FROM checks WHERE monitor_id = ? AND checked_at < ? LIMIT 2000
       )`
    )
      .bind(monitor.id, cutoff)
      .run();
    deleted += result.meta?.changes ?? 0;
  }

  return deleted;
}

/** Expired sessions and stale rate-limit rows housekeeping. */
export async function pruneEphemeral(env: Bindings, nowMs = Date.now()): Promise<void> {
  // Both statements are seeks on idx_sessions_expires / idx_deliveries_created.
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowMs).run();
  await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(Math.floor(nowMs / 1000) - 3600)
    .run();
  await env.DB.prepare(
    `DELETE FROM deliveries WHERE id IN (
       SELECT id FROM deliveries WHERE created_at < ? LIMIT 5000
     )`
  )
    .bind(nowMs - 60 * DAY_MS)
    .run();
}
