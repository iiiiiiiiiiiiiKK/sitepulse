import type { Bucket, DayRollup } from '../types';
import { formatDate, formatMs, formatTime } from '../lib/format';
import { useI18n } from '../lib/i18n';

/**
 * Hand-rolled SVG charts (no chart dependency).
 *
 * Honesty rules baked in:
 *  - buckets with `total === 0` are drawn as gaps, not as 0 ms or 100% up;
 *  - the y-axis is labelled with real values;
 *  - the x-axis labels real timestamps from the bucket array.
 */

interface ResponseChartProps {
  buckets: Bucket[];
  range: '24h' | '7d' | '30d';
  height?: number;
}

export function ResponseChart({ buckets, range, height = 180 }: ResponseChartProps) {
  const { t } = useI18n();
  const width = 720;
  const padLeft = 44;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 26;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  const points = buckets.filter((bucket) => bucket.avgMs !== null);
  const maxValue = points.reduce((max, bucket) => Math.max(max, bucket.avgMs ?? 0), 0);
  const yMax = Math.max(50, Math.ceil((maxValue * 1.15) / 50) * 50);

  const xFor = (index: number) =>
    padLeft + (buckets.length <= 1 ? innerW / 2 : (index / (buckets.length - 1)) * innerW);
  const yFor = (value: number) => padTop + innerH - (value / yMax) * innerH;

  // Build a path that breaks on missing buckets so gaps remain visible.
  const segments: string[] = [];
  let current = '';
  buckets.forEach((bucket, index) => {
    if (bucket.avgMs === null) {
      if (current) {
        segments.push(current);
        current = '';
      }
      return;
    }
    const command = current ? 'L' : 'M';
    current += `${command}${xFor(index).toFixed(1)},${yFor(bucket.avgMs).toFixed(1)} `;
  });
  if (current) segments.push(current);

  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.max(1, Math.floor(buckets.length / 6));

  if (points.length === 0) {
    return (
      <div
        className="chart-wrap"
        style={{
          height,
          display: 'grid',
          placeItems: 'center',
          border: '1px dashed var(--line)',
          borderRadius: 12,
          color: 'var(--text-faint)',
          fontSize: 13,
          textAlign: 'center',
          padding: 12,
        }}
      >
        {t('chart.noResponse')}
      </div>
    );
  }

  return (
    <div className="chart-wrap">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('chart.responseAria', { range })}
        preserveAspectRatio="none"
        style={{ height }}
      >
        {gridLines.map((ratio) => {
          const y = padTop + innerH - ratio * innerH;
          return (
            <g key={ratio}>
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={y}
                y2={y}
                stroke="var(--line)"
                strokeWidth="1"
                strokeDasharray={ratio === 0 ? undefined : '3 4'}
              />
              <text
                x={padLeft - 8}
                y={y + 3.5}
                textAnchor="end"
                fontSize="10"
                fill="var(--text-faint)"
                fontFamily="var(--mono)"
              >
                {Math.round(yMax * ratio)}
              </text>
            </g>
          );
        })}

        {segments.map((segment, index) => (
          <path
            key={index}
            d={segment}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.8"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {buckets.map((bucket, index) =>
          bucket.avgMs === null ? null : (
            <circle
              key={bucket.t}
              cx={xFor(index)}
              cy={yFor(bucket.avgMs)}
              r={buckets.length > 120 ? 1.4 : 2.2}
              fill="var(--accent)"
            >
              <title>
                {t('chart.tooltip', {
                  time: formatTime(bucket.t),
                  ms: formatMs(bucket.avgMs),
                  probes: bucket.total,
                })}
                {bucket.failed > 0 ? t('chart.tooltipFailed', { failed: bucket.failed }) : ''}
              </title>
            </circle>
          )
        )}

        {buckets.map((bucket, index) =>
          index % labelEvery === 0 ? (
            <text
              key={`lbl-${bucket.t}`}
              x={xFor(index)}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="var(--text-faint)"
            >
              {formatTime(bucket.t)}
            </text>
          ) : null
        )}
      </svg>
      <div className="chart-legend">
        <span>
          <span className="legend-dot" style={{ background: 'var(--accent)' }} />
          {t('chart.avgLabel')}
        </span>
        <span className="muted">
          {t('chart.buckets', {
            buckets: buckets.length,
            probes: buckets.reduce((sum, bucket) => sum + bucket.total, 0),
          })}
        </span>
      </div>
    </div>
  );
}

/** Availability bar chart: each bucket is a real measurement or a gap. */
export function AvailabilityChart({ buckets, height = 96 }: { buckets: Bucket[]; height?: number }) {
  const { t } = useI18n();
  const width = 720;
  const padBottom = 20;
  const padTop = 8;
  const innerH = height - padTop - padBottom;
  const barWidth = Math.max(2, (width / Math.max(1, buckets.length)) * 0.72);
  const step = width / Math.max(1, buckets.length);

  if (buckets.every((bucket) => bucket.total === 0)) {
    return (
      <div
        style={{
          height,
          display: 'grid',
          placeItems: 'center',
          border: '1px dashed var(--line)',
          borderRadius: 12,
          color: 'var(--text-faint)',
          fontSize: 13,
        }}
      >
        {t('chart.noProbesWindow')}
      </div>
    );
  }

  return (
    <div className="chart-wrap">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('chart.availabilityAria')}
        preserveAspectRatio="none"
        style={{ height }}
      >
        <line
          x1={0}
          x2={width}
          y1={padTop + innerH}
          y2={padTop + innerH}
          stroke="var(--line)"
          strokeWidth="1"
        />
        {buckets.map((bucket, index) => {
          if (bucket.total === 0) {
            return (
              <rect
                key={bucket.t}
                x={index * step + (step - barWidth) / 2}
                y={padTop + innerH - 2}
                width={barWidth}
                height={2}
                fill="var(--line)"
              >
                <title>{t('chart.noDataAt', { time: formatTime(bucket.t) })}</title>
              </rect>
            );
          }
          const availability = bucket.availability ?? 0;
          const barHeight = Math.max(2, (availability / 100) * innerH);
          const fill =
            availability >= 99.5 ? 'var(--up)' : availability >= 90 ? 'var(--warn)' : 'var(--down)';
          return (
            <rect
              key={bucket.t}
              x={index * step + (step - barWidth) / 2}
              y={padTop + innerH - barHeight}
              width={barWidth}
              height={barHeight}
              fill={fill}
            >
              <title>
                {formatTime(bucket.t)} · {availability.toFixed(1)}% · {bucket.total}
                {bucket.failed > 0 ? ` (${bucket.failed})` : ''}
              </title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

/** Compact 24h/7d/30d strip used on the monitor detail page. */
export function UptimeStrip({ daily }: { daily: DayRollup[] }) {
  const { t } = useI18n();
  if (daily.length === 0) {
    return <div className="uptime-strip" aria-label={t('chart.stripAria')} />;
  }
  return (
    <div className="uptime-strip" role="img" aria-label={t('chart.stripAria')}>
      {daily.map((day) => {
        const cls =
          day.total === 0
            ? 'empty'
            : (day.availability ?? 0) >= 99.5
              ? 'ok'
              : (day.availability ?? 0) >= 95
                ? 'warn'
                : 'bad';
        const label =
          day.total === 0
            ? t('chart.stripNoData', { date: formatDate(day.day) })
            : t('chart.stripValue', {
                date: formatDate(day.day),
                availability: (day.availability ?? 0).toFixed(2),
                probes: day.total,
              });
        return <span key={day.day} className={`strip-cell ${cls}`} title={label} />;
      })}
    </div>
  );
}
