import { computeAvailability } from './monitor-state';

export type RangeKey = '24h' | '7d' | '30d';

export const RANGE_MS: Record<RangeKey, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Bucket width per range: 15 min / 90 min / 6 h. Tuned for ~96–120 chart points. */
export const RANGE_BUCKET_MS: Record<RangeKey, number> = {
  '24h': 15 * 60 * 1000,
  '7d': 90 * 60 * 1000,
  '30d': 6 * 60 * 60 * 1000,
};

export function parseRange(value: string | null): RangeKey {
  return value === '7d' || value === '30d' ? value : '24h';
}

export interface CheckPoint {
  t: number;
  ok: boolean;
  ms: number | null;
}

export interface SeriesBucket {
  /** bucket start, epoch ms */
  t: number;
  /** number of probes in the bucket — 0 means no data, rendered as a gap */
  total: number;
  failed: number;
  avgMs: number | null;
  /** availability in percent, null when the bucket is empty */
  availability: number | null;
}

export interface WindowStats {
  range: RangeKey;
  since: number;
  until: number;
  totalChecks: number;
  failedChecks: number;
  availability: number | null;
  avgResponseMs: number | null;
  minResponseMs: number | null;
  maxResponseMs: number | null;
  p95ResponseMs: number | null;
  downtimeSeconds: number;
  buckets: SeriesBucket[];
  hasData: boolean;
  retentionLimited: boolean;
}

/**
 * Builds the response-time / availability series for a window.
 * Empty buckets stay in the array with `total: 0` so the chart can draw real
 * gaps instead of interpolating fake data.
 */
export function buildSeries(
  rows: Array<{ checked_at: number; ok: number; response_ms: number | null }>,
  since: number,
  until: number,
  bucketMs: number
): { buckets: SeriesBucket[]; stats: Omit<WindowStats, 'range' | 'since' | 'until' | 'buckets' | 'hasData' | 'retentionLimited'> } {
  const bucketCount = Math.max(1, Math.ceil((until - since) / bucketMs));
  type Acc = { total: number; failed: number; sum: number; count: number; durations: number[] };
  const acc = new Map<number, Acc>();
  for (let i = 0; i < bucketCount; i += 1) {
    acc.set(since + i * bucketMs, { total: 0, failed: 0, sum: 0, count: 0, durations: [] });
  }

  let total = 0;
  let failed = 0;
  let sum = 0;
  let count = 0;
  let min: number | null = null;
  let max: number | null = null;
  const allDurations: number[] = [];

  for (const row of rows) {
    total += 1;
    if (!row.ok) failed += 1;
    const bucketIndex = Math.floor((row.checked_at - since) / bucketMs);
    const bucketKey = since + bucketIndex * bucketMs;
    const bucket = acc.get(bucketKey);
    if (!bucket) continue;
    bucket.total += 1;
    if (!row.ok) bucket.failed += 1;
    if (row.response_ms !== null && row.response_ms !== undefined) {
      bucket.sum += row.response_ms;
      bucket.count += 1;
      bucket.durations.push(row.response_ms);
      sum += row.response_ms;
      count += 1;
      allDurations.push(row.response_ms);
      min = min === null ? row.response_ms : Math.min(min, row.response_ms);
      max = max === null ? row.response_ms : Math.max(max, row.response_ms);
    }
  }

  const buckets: SeriesBucket[] = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, value]) => ({
      t,
      total: value.total,
      failed: value.failed,
      avgMs: value.count === 0 ? null : Math.round(value.sum / value.count),
      availability: computeAvailability(value.total, value.failed),
    }));

  allDurations.sort((a, b) => a - b);
  const p95 =
    allDurations.length === 0
      ? null
      : allDurations[Math.min(allDurations.length - 1, Math.floor(allDurations.length * 0.95))];

  return {
    buckets,
    stats: {
      totalChecks: total,
      failedChecks: failed,
      availability: computeAvailability(total, failed),
      avgResponseMs: count === 0 ? null : Math.round(sum / count),
      minResponseMs: min,
      maxResponseMs: max,
      p95ResponseMs: p95,
      downtimeSeconds: 0, // filled in by the caller from incident durations
    },
  };
}

/** Sums downtime inside the window from incident rows (authoritative source). */
export function downtimeWithinWindow(
  incidents: Array<{ started_at: number; resolved_at: number | null }>,
  since: number,
  until: number
): number {
  let seconds = 0;
  for (const incident of incidents) {
    const start = Math.max(incident.started_at, since);
    const end = Math.min(incident.resolved_at ?? until, until);
    if (end > start) seconds += Math.round((end - start) / 1000);
  }
  return seconds;
}

/** Daily rollup used by the 7d/30d heatmap strip on the dashboard. */
export function dailyRollup(
  rows: Array<{ checked_at: number; ok: number }>,
  since: number,
  until: number
): Array<{ day: number; total: number; failed: number; availability: number | null }> {
  const dayMs = 86400000;
  const days = Math.max(1, Math.ceil((until - since) / dayMs));
  const buckets = new Map<number, { total: number; failed: number }>();
  for (let i = 0; i < days; i += 1) buckets.set(since + i * dayMs, { total: 0, failed: 0 });
  for (const row of rows) {
    const key = since + Math.floor((row.checked_at - since) / dayMs) * dayMs;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.total += 1;
    if (!row.ok) bucket.failed += 1;
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, value]) => ({
      day,
      total: value.total,
      failed: value.failed,
      availability: computeAvailability(value.total, value.failed),
    }));
}
