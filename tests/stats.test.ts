import { describe, expect, it } from 'vitest';
import {
  buildSeries,
  dailyRollup,
  downtimeWithinWindow,
  parseRange,
  RANGE_BUCKET_MS,
} from '../worker/lib/stats';

/**
 * Statistics tests: availability must be derived from real samples, downtime
 * must come from incidents, and gaps must stay gaps.
 */

const HOUR = 3600_000;

describe('buildSeries', () => {
  it('keeps empty buckets as gaps rather than zeroes', () => {
    const since = 0;
    const until = 4 * HOUR;
    const bucketMs = HOUR;
    const series = buildSeries(
      [
        { checked_at: HOUR / 2, ok: 1, response_ms: 120 },
        { checked_at: HOUR * 2 + 10, ok: 0, response_ms: null },
      ],
      since,
      until,
      bucketMs
    );
    expect(series.buckets).toHaveLength(4);
    expect(series.buckets[0].avgMs).toBe(120);
    expect(series.buckets[1].total).toBe(0);
    expect(series.buckets[1].avgMs).toBeNull();
    expect(series.buckets[1].availability).toBeNull();
    expect(series.buckets[2].failed).toBe(1);
    expect(series.buckets[2].availability).toBe(0);
  });

  it('computes window stats over the samples', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      checked_at: index * 1000,
      ok: index === 0 ? 0 : 1,
      response_ms: 100 + index * 10,
    }));
    const series = buildSeries(rows, 0, 10_000, 10_000);
    expect(series.stats.totalChecks).toBe(10);
    expect(series.stats.failedChecks).toBe(1);
    expect(series.stats.availability).toBeCloseTo(90, 5);
    expect(series.stats.minResponseMs).toBe(100);
    expect(series.stats.maxResponseMs).toBe(190);
  });

  it('returns null availability with no samples', () => {
    const series = buildSeries([], 0, HOUR, 60_000);
    expect(series.stats.availability).toBeNull();
    expect(series.stats.totalChecks).toBe(0);
  });
});

describe('downtimeWithinWindow', () => {
  it('sums incidents clipped to the window', () => {
    const incidents = [
      { started_at: 10_000, resolved_at: 70_000 }, // 60s
      { started_at: 100_000, resolved_at: null }, // open, clipped at 130_000 → 30s
    ];
    expect(downtimeWithinWindow(incidents, 0, 130_000)).toBe(90);
  });

  it('ignores incidents entirely outside the window', () => {
    expect(downtimeWithinWindow([{ started_at: 0, resolved_at: 1000 }], 5000, 9000)).toBe(0);
  });

  it('clips an incident that starts before the window', () => {
    expect(downtimeWithinWindow([{ started_at: 0, resolved_at: 10_000 }], 5000, 10_000)).toBe(5);
  });

  it('returns zero for no incidents', () => {
    expect(downtimeWithinWindow([], 0, 100_000)).toBe(0);
  });
});

describe('dailyRollup', () => {
  it('groups by day and keeps empty days', () => {
    const day = 86400_000;
    const rows = [
      { checked_at: 0, ok: 1 },
      { checked_at: 1000, ok: 0 },
      { checked_at: day * 2 + 500, ok: 1 },
    ];
    const rollup = dailyRollup(rows, 0, day * 3);
    expect(rollup).toHaveLength(3);
    expect(rollup[0].total).toBe(2);
    expect(rollup[0].failed).toBe(1);
    expect(rollup[1].total).toBe(0);
    expect(rollup[1].availability).toBeNull();
    expect(rollup[2].total).toBe(1);
  });
});

describe('parseRange', () => {
  it('defaults to 24h', () => {
    expect(parseRange(null)).toBe('24h');
    expect(parseRange('nonsense')).toBe('24h');
  });

  it('accepts 7d and 30d', () => {
    expect(parseRange('7d')).toBe('7d');
    expect(parseRange('30d')).toBe('30d');
  });
});

describe('bucket sizes', () => {
  it('keeps the chart at a readable number of points', () => {
    for (const range of ['24h', '7d', '30d'] as const) {
      const windowMs =
        range === '24h' ? 24 * HOUR : range === '7d' ? 7 * 24 * HOUR : 30 * 24 * HOUR;
      const points = windowMs / RANGE_BUCKET_MS[range];
      expect(points).toBeGreaterThanOrEqual(90);
      expect(points).toBeLessThanOrEqual(130);
    }
  });
});
