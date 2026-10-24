import type { IncidentRow, MonitorRow, MonitorStatus } from './types';

/**
 * Pure monitor state machine.
 *
 * Rules
 * -----
 * - A monitor becomes DOWN only after `failure_threshold` consecutive failures.
 *   A single failed probe therefore never fires an alert (jitter protection).
 * - A DOWN monitor becomes UP after `recovery_threshold` consecutive successes.
 * - The `paused` state is manual and is never overridden by probe results.
 * - "Recovering" is a derived, read-only state: the monitor is DOWN but the last
 *   probe succeeded and it has not yet reached `recovery_threshold`.
 */

export type ProbeOutcome = 'success' | 'failure';

export interface TransitionInput {
  status: MonitorStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  failureThreshold: number;
  recoveryThreshold: number;
  currentIncidentId: string | null;
}

export interface TransitionResult {
  status: MonitorStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** true when this probe opened a new incident */
  openIncident: boolean;
  /** true when this probe resolved the running incident */
  closeIncident: boolean;
}

export function applyProbeOutcome(
  current: TransitionInput,
  outcome: ProbeOutcome
): TransitionResult {
  const failureThreshold = Math.max(1, current.failureThreshold);
  const recoveryThreshold = Math.max(1, current.recoveryThreshold);

  if (current.status === 'paused') {
    return {
      status: 'paused',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      openIncident: false,
      closeIncident: false,
    };
  }

  if (outcome === 'failure') {
    const failures = current.consecutiveFailures + 1;
    const shouldOpen =
      current.status !== 'down' &&
      !current.currentIncidentId &&
      failures >= failureThreshold;
    return {
      status: shouldOpen || current.status === 'down' ? 'down' : current.status,
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
      openIncident: shouldOpen,
      closeIncident: false,
    };
  }

  const successes = current.consecutiveSuccesses + 1;
  const wasDown = current.status === 'down' || current.currentIncidentId !== null;
  const shouldClose = wasDown && successes >= recoveryThreshold;
  return {
    // A monitor that has never been probed is 'unknown'; the first successful
    // probe promotes it to 'up'. Without this the dashboard would show
    // "Unknown" forever even though probes keep succeeding.
    status: shouldClose ? 'up' : current.status === 'unknown' ? 'up' : current.status,
    consecutiveFailures: 0,
    consecutiveSuccesses: successes,
    openIncident: false,
    closeIncident: shouldClose,
  };
}

/** Presentation state that also accounts for "down but recovering". */
export type DisplayStatus = 'unknown' | 'up' | 'down' | 'recovering' | 'paused';

export function deriveDisplayStatus(
  status: MonitorStatus,
  consecutiveSuccesses: number,
  recoveryThreshold: number,
  currentIncidentId: string | null
): DisplayStatus {
  if (status === 'paused') return 'paused';
  if (status === 'down' || currentIncidentId) {
    if (consecutiveSuccesses > 0 && consecutiveSuccesses < Math.max(1, recoveryThreshold)) {
      return 'recovering';
    }
    return 'down';
  }
  return status;
}

export const DISPLAY_STATUS_LABEL: Record<DisplayStatus, string> = {
  unknown: 'Unknown',
  up: 'Operational',
  down: 'Down',
  recovering: 'Recovering',
  paused: 'Paused',
};

/**
 * Availability percentage for a window.
 *
 * `totalChecks` counts real probes only (paused periods produce no probes, so
 * they cannot dilute or inflate the number). When a window contains no probes
 * at all we return `null` — the UI then prints "No data" rather than 100%.
 */
export function computeAvailability(
  totalChecks: number,
  failedChecks: number
): number | null {
  if (totalChecks <= 0) return null;
  const failed = Math.min(Math.max(0, failedChecks), totalChecks);
  return ((totalChecks - failed) / totalChecks) * 100;
}

export interface UptimeWindowStats {
  total: number;
  failed: number;
  availability: number | null;
  avgResponseMs: number | null;
  p95ResponseMs: number | null;
  downtimeSeconds: number;
}

/** Aggregate of probe rows used by the dashboard charts. */
export function summariseChecks(
  rows: Array<{ ok: number; response_ms: number | null }>,
  sinceMs: number,
  nowMs: number,
  intervalSeconds: number
): UptimeWindowStats {
  let failed = 0;
  let responseSum = 0;
  let responseCount = 0;
  const durations: number[] = [];
  for (const row of rows) {
    if (!row.ok) failed += 1;
    if (row.response_ms !== null && row.response_ms !== undefined) {
      responseSum += row.response_ms;
      responseCount += 1;
      durations.push(row.response_ms);
    }
  }
  durations.sort((a, b) => a - b);
  const p95 =
    durations.length === 0
      ? null
      : durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];

  const availability = computeAvailability(rows.length, failed);
  const measuredSeconds = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  // Downtime is estimated from failed probes × interval, capped at the window,
  // and never allowed to exceed the window itself. Sample counts are reported
  // as-is instead of inventing an "expected" number that would drift whenever
  // the scheduler restarted or the deployment was redeployed.
  const downtimeSeconds = Math.min(measuredSeconds, Math.round(failed * intervalSeconds));

  return {
    total: rows.length,
    failed,
    availability,
    avgResponseMs: responseCount === 0 ? null : Math.round(responseSum / responseCount),
    p95ResponseMs: p95,
    downtimeSeconds,
  };
}

export function incidentDurationSeconds(
  incident: Pick<IncidentRow, 'started_at' | 'resolved_at'>,
  nowMs: number
): number {
  const end = incident.resolved_at ?? nowMs;
  return Math.max(0, Math.round((end - incident.started_at) / 1000));
}

/** Orders incidents newest-first for the timeline view. */
export function sortIncidentsDesc<T extends { started_at: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.started_at - a.started_at);
}

export function isMonitorDue(monitor: Pick<MonitorRow, 'enabled' | 'next_check_at'>, nowMs: number): boolean {
  return monitor.enabled === 1 && monitor.next_check_at <= nowMs;
}
