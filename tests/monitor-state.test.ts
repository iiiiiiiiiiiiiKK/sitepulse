import { describe, expect, it } from 'vitest';
import {
  applyProbeOutcome,
  computeAvailability,
  deriveDisplayStatus,
  incidentDurationSeconds,
  summariseChecks,
} from '../worker/lib/monitor-state';

/**
 * State-machine tests. These encode the product rules that users rely on:
 * one failure must not page anyone, N failures must, and recovery must also be
 * confirmed before an incident is closed.
 */

const base = {
  status: 'up' as const,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  failureThreshold: 3,
  recoveryThreshold: 2,
  currentIncidentId: null,
};

describe('applyProbeOutcome — failures', () => {
  it('does not open an incident below the threshold', () => {
    let state = applyProbeOutcome(base, 'failure');
    expect(state.status).toBe('up');
    expect(state.consecutiveFailures).toBe(1);
    expect(state.openIncident).toBe(false);

    state = applyProbeOutcome({ ...base, consecutiveFailures: 1 }, 'failure');
    expect(state.status).toBe('up');
    expect(state.consecutiveFailures).toBe(2);
    expect(state.openIncident).toBe(false);
  });

  it('opens an incident exactly at the threshold', () => {
    const state = applyProbeOutcome({ ...base, consecutiveFailures: 2 }, 'failure');
    expect(state.status).toBe('down');
    expect(state.consecutiveFailures).toBe(3);
    expect(state.openIncident).toBe(true);
  });

  it('does not open a second incident while already down', () => {
    const state = applyProbeOutcome(
      { ...base, status: 'down', consecutiveFailures: 5, currentIncidentId: 'inc_1' },
      'failure'
    );
    expect(state.status).toBe('down');
    expect(state.consecutiveFailures).toBe(6);
    expect(state.openIncident).toBe(false);
  });

  it('respects a threshold of 1 (alert on first failure)', () => {
    const state = applyProbeOutcome(
      { ...base, failureThreshold: 1 },
      'failure'
    );
    expect(state.status).toBe('down');
    expect(state.openIncident).toBe(true);
  });
});

describe('applyProbeOutcome — recovery', () => {
  it('requires the recovery threshold before closing', () => {
    const down = {
      ...base,
      status: 'down' as const,
      consecutiveFailures: 4,
      consecutiveSuccesses: 0,
      currentIncidentId: 'inc_1',
    };
    const first = applyProbeOutcome(down, 'success');
    expect(first.status).toBe('down');
    expect(first.closeIncident).toBe(false);
    expect(first.consecutiveSuccesses).toBe(1);

    const second = applyProbeOutcome(
      { ...down, consecutiveSuccesses: 1 },
      'success'
    );
    expect(second.status).toBe('up');
    expect(second.closeIncident).toBe(true);
    expect(second.consecutiveFailures).toBe(0);
  });

  it('recovers immediately when recoveryThreshold is 1', () => {
    const state = applyProbeOutcome(
      {
        ...base,
        status: 'down',
        failureThreshold: 1,
        recoveryThreshold: 1,
        consecutiveFailures: 2,
        currentIncidentId: 'inc_1',
      },
      'success'
    );
    expect(state.status).toBe('up');
    expect(state.closeIncident).toBe(true);
  });

  it('resets the failure counter on any success', () => {
    const state = applyProbeOutcome({ ...base, consecutiveFailures: 2 }, 'success');
    expect(state.consecutiveFailures).toBe(0);
    expect(state.status).toBe('up');
  });

  it('flaps: alternating results never open an incident with threshold 3', () => {
    let state = {
      status: 'up' as const,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      failureThreshold: 3,
      recoveryThreshold: 1,
      currentIncidentId: null as string | null,
    };
    let opened = 0;
    for (const outcome of ['failure', 'success', 'failure', 'success', 'failure', 'success'] as const) {
      const next = applyProbeOutcome(state, outcome);
      if (next.openIncident) opened += 1;
      state = {
        status: next.status === 'paused' ? 'up' : (next.status as 'up' | 'down'),
        consecutiveFailures: next.consecutiveFailures,
        consecutiveSuccesses: next.consecutiveSuccesses,
        failureThreshold: 3,
        recoveryThreshold: 1,
        currentIncidentId: next.openIncident ? 'inc' : state.currentIncidentId,
      };
    }
    expect(opened).toBe(0);
  });
});

describe('applyProbeOutcome — paused monitors', () => {
  it('ignores probe results while paused', () => {
    const state = applyProbeOutcome({ ...base, status: 'paused' }, 'failure');
    expect(state.status).toBe('paused');
    expect(state.openIncident).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
  });
});

describe('deriveDisplayStatus', () => {
  it('shows recovering when down but a success has landed', () => {
    expect(deriveDisplayStatus('down', 1, 3, 'inc_1')).toBe('recovering');
  });

  it('shows down when there were no successes', () => {
    expect(deriveDisplayStatus('down', 0, 3, 'inc_1')).toBe('down');
  });

  it('shows down when the recovery threshold is already reached', () => {
    expect(deriveDisplayStatus('down', 3, 3, 'inc_1')).toBe('down');
  });

  it('keeps paused and unknown distinct', () => {
    expect(deriveDisplayStatus('paused', 0, 1, null)).toBe('paused');
    expect(deriveDisplayStatus('unknown', 0, 1, null)).toBe('unknown');
    expect(deriveDisplayStatus('up', 0, 1, null)).toBe('up');
  });
});

describe('computeAvailability', () => {
  it('returns null with no samples instead of faking 100%', () => {
    expect(computeAvailability(0, 0)).toBeNull();
  });

  it('computes a percentage', () => {
    expect(computeAvailability(100, 1)).toBeCloseTo(99, 5);
    expect(computeAvailability(3, 1)).toBeCloseTo((2 / 3) * 100, 5);
    expect(computeAvailability(10, 10)).toBe(0);
  });

  it('clamps impossible inputs', () => {
    expect(computeAvailability(5, 9)).toBe(0);
    expect(computeAvailability(5, -1)).toBe(100);
  });
});

describe('summariseChecks', () => {
  it('aggregates counts and latency percentiles', () => {
    const rows = [
      { ok: 1, response_ms: 100 },
      { ok: 1, response_ms: 200 },
      { ok: 0, response_ms: null },
      { ok: 1, response_ms: 300 },
    ];
    const summary = summariseChecks(rows, 0, 3600_000, 60);
    expect(summary.total).toBe(4);
    expect(summary.failed).toBe(1);
    expect(summary.availability).toBeCloseTo(75, 5);
    expect(summary.avgResponseMs).toBe(200);
    expect(summary.p95ResponseMs).toBe(300);
    expect(summary.downtimeSeconds).toBe(60);
  });

  it('reports no data for an empty window', () => {
    const summary = summariseChecks([], 0, 3600_000, 60);
    expect(summary.total).toBe(0);
    expect(summary.availability).toBeNull();
    expect(summary.avgResponseMs).toBeNull();
    expect(summary.p95ResponseMs).toBeNull();
  });

  it('never claims more downtime than the window length', () => {
    const rows = Array.from({ length: 100 }, () => ({ ok: 0, response_ms: null }));
    const summary = summariseChecks(rows, 0, 60_000, 3600);
    expect(summary.downtimeSeconds).toBeLessThanOrEqual(60);
  });
});

describe('incidentDurationSeconds', () => {
  it('uses resolved_at when present', () => {
    expect(incidentDurationSeconds({ started_at: 1000, resolved_at: 61_000 }, 999_999)).toBe(60);
  });

  it('uses now for an open incident', () => {
    expect(incidentDurationSeconds({ started_at: 1000, resolved_at: null }, 31_000)).toBe(30);
  });

  it('never returns a negative duration', () => {
    expect(incidentDurationSeconds({ started_at: 5000, resolved_at: 1000 }, 0)).toBe(0);
  });
});
