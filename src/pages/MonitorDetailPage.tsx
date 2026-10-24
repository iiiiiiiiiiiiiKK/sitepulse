import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError, NetworkError } from '../api';
import type { MonitorDetail as Detail } from '../types';
import {
  ConfirmDialog,
  ErrorState,
  LoadingPanel,
  StatusPill,
  useToast,
} from '../components/ui';
import { AvailabilityChart, ResponseChart, UptimeStrip } from '../components/charts';
import {
  formatDateTime,
  formatDuration,
  formatInterval,
  formatMs,
  formatPercent,
  formatRelative,
  hostOf,
} from '../lib/format';
import { MonitorForm, type MonitorFormValues } from '../components/MonitorForm';

const RANGES: Array<{ key: '24h' | '7d' | '30d'; label: string }> = [
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

export function MonitorDetailPage({ monitorId }: { monitorId: string }) {
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const toast = useToast();

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const result = await api.getMonitor(monitorId, range);
        setDetail(result);
        setError(null);
      } catch (caught) {
        if (!silent) {
          setError(
            caught instanceof ApiClientError || caught instanceof NetworkError
              ? caught.message
              : 'Could not load this monitor.'
          );
        }
      } finally {
        setLoading(false);
      }
    },
    [monitorId, range]
  );

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(true), 30000);
    return () => window.clearInterval(interval);
  }, [load]);

  const handleUpdate = async (values: MonitorFormValues) => {
    await api.updateMonitor(monitorId, {
      name: values.name,
      url: values.url,
      method: values.method,
      intervalSeconds: values.intervalSeconds,
      timeoutMs: values.timeoutMs,
      expectedStatus: values.expectedStatus,
      failureThreshold: values.failureThreshold,
      recoveryThreshold: values.recoveryThreshold,
    });
    setEditing(false);
    toast.push('Monitor updated.', 'ok');
    await load(true);
  };

  const togglePause = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      if (detail.monitor.status === 'paused') {
        await api.resumeMonitor(monitorId);
        toast.push('Monitor resumed.', 'ok');
      } else {
        await api.pauseMonitor(monitorId);
        toast.push('Monitor paused. No probes will run.', 'ok');
      }
      await load(true);
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Action failed.',
        'err'
      );
    } finally {
      setBusy(false);
    }
  };

  const checkNow = async () => {
    setBusy(true);
    try {
      const result = await api.checkNow(monitorId);
      toast.push(result.message, 'ok');
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Could not queue a check.',
        'err'
      );
    } finally {
      setBusy(false);
    }
  };

  const togglePublic = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await api.updateMonitor(monitorId, { isPublic: !detail.monitor.isPublic });
      toast.push(
        detail.monitor.isPublic
          ? 'Status page is now private.'
          : 'Public status page enabled.',
        'ok'
      );
      await load(true);
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Could not change visibility.',
        'err'
      );
    } finally {
      setBusy(false);
    }
  };

  const testNotification = async () => {
    setTesting(true);
    try {
      const result = await api.testMonitorNotifications(monitorId);
      toast.push(result.summary.message, result.summary.failed > 0 ? 'err' : 'ok');
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Test notification failed.',
        'err'
      );
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await api.deleteMonitor(monitorId);
      toast.push('Monitor deleted.', 'ok');
      window.history.pushState({}, '', '/app');
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Delete failed.',
        'err'
      );
      setBusy(false);
    }
  };

  if (loading && !detail) return <LoadingPanel rows={4} />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!detail) return null;

  const { monitor, stats } = detail;
  const openIncident = detail.incidents.find((incident) => incident.resolvedAt === null);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 8 }}>
        <a className="btn btn-sm btn-ghost" href="/app">
          ← Monitors
        </a>
      </div>

      <div className="spread">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 10 }}>
            <h1 className="page-title">{monitor.name}</h1>
            <StatusPill status={monitor.status} live />
          </div>
          <p className="page-sub mono">{monitor.url}</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-sm" onClick={checkNow} disabled={busy || !monitor.enabled}>
            Check now
          </button>
          <button className="btn btn-sm" onClick={togglePause} disabled={busy}>
            {monitor.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button className="btn btn-sm" onClick={() => setEditing(true)} disabled={busy}>
            Edit
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => setDeleting(true)} disabled={busy}>
            Delete
          </button>
        </div>
      </div>

      {openIncident ? (
        <div className="panel panel-pad" style={{ borderColor: 'var(--down)' }}>
          <div className="row" style={{ gap: 10 }}>
            <StatusPill status="down" />
            <div>
              <div style={{ fontWeight: 620, fontSize: 14 }}>
                Ongoing incident · {formatDuration(openIncident.durationSeconds)}
              </div>
              <div className="small muted">
                Started {formatDateTime(openIncident.startedAt)} · {openIncident.summary ?? 'Probe failure'}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row" role="tablist" aria-label="Statistics period">
          {RANGES.map((item) => (
            <button
              key={item.key}
              role="tab"
              aria-selected={range === item.key}
              className={`btn btn-sm ${range === item.key ? 'btn-primary' : ''}`}
              onClick={() => setRange(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <a
            className="btn btn-sm"
            href={api.exportUrl(monitorId, 'csv', range)}
            download
            title="Download raw checks as CSV"
          >
            Export CSV
          </a>
          <a
            className="btn btn-sm"
            href={api.exportUrl(monitorId, 'json', range)}
            download
            title="Download checks and incidents as JSON"
          >
            Export JSON
          </a>
        </div>
      </div>

      <div className="stat-grid">
        <div className={`stat ${stats.availability === null ? '' : (stats.availability ?? 0) >= 99 ? 'stat-accent-up' : 'stat-accent-down'}`}>
          <div className="stat-label">Availability</div>
          <div className="stat-value">{formatPercent(stats.availability)}</div>
          <div className="stat-sub">{stats.totalChecks} probes · {stats.failedChecks} failed</div>
        </div>
        <div className="stat">
          <div className="stat-label">Downtime</div>
          <div className="stat-value">{formatDuration(stats.downtimeSeconds)}</div>
          <div className="stat-sub">from incident records</div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg response</div>
          <div className="stat-value">{formatMs(stats.avgResponseMs)}</div>
          <div className="stat-sub">
            p95 {formatMs(stats.p95ResponseMs)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Last success</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {monitor.lastSuccessAt ? formatRelative(monitor.lastSuccessAt) : 'never'}
          </div>
          <div className="stat-sub">
            {monitor.lastStatusCode ? `HTTP ${monitor.lastStatusCode}` : 'no probe yet'}
          </div>
        </div>
      </div>

      {stats.retentionLimited ? (
        <p className="small muted" style={{ margin: 0 }}>
          Note: your plan keeps {stats.retentionDays} days of probe history, so older samples in this
          window have already been pruned. Sample counts above reflect stored data only.
        </p>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Response time</h2>
            <p>Average per bucket · empty buckets are real gaps, not zeroes</p>
          </div>
        </div>
        <div className="panel-pad">
          <ResponseChart buckets={detail.buckets} range={range} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Availability per bucket</h2>
            <p>Green ≥ 99.5% · amber ≥ 90% · red below that</p>
          </div>
        </div>
        <div className="panel-pad">
          <AvailabilityChart buckets={detail.buckets} />
          <div style={{ marginTop: 14 }}>
            <div className="small muted" style={{ marginBottom: 5 }}>
              Daily rollup
            </div>
            <UptimeStrip daily={detail.daily} />
          </div>
        </div>
      </section>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Incident timeline</h2>
              <p>{detail.incidents.length} incident(s) in retained history</p>
            </div>
          </div>
          <div className="panel-pad">
            {detail.incidents.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                No incidents recorded. Probes have either all succeeded, or the failures stayed below
                your threshold of {monitor.failureThreshold}.
              </p>
            ) : (
              <ul className="timeline">
                {detail.incidents.map((incident) => (
                  <li key={incident.id} className={incident.resolvedAt ? 'resolved' : ''}>
                    <div className="tl-title">
                      {incident.resolvedAt ? 'Resolved' : 'Ongoing'} ·{' '}
                      {formatDuration(incident.durationSeconds)}
                    </div>
                    <div className="tl-meta">
                      {formatDateTime(incident.startedAt)}
                      {incident.resolvedAt ? ` → ${formatDateTime(incident.resolvedAt)}` : ' → now'}
                    </div>
                    <div className="tl-meta" style={{ color: 'var(--text-dim)' }}>
                      {incident.summary ?? incident.cause ?? 'Probe failure'}
                      {incident.lastStatusCode ? ` · HTTP ${incident.lastStatusCode}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="stack" style={{ gap: 16 }}>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Configuration</h2>
                <p>What this monitor actually does</p>
              </div>
            </div>
            <div className="panel-pad stack" style={{ gap: 9 }}>
              <ConfigRow label="Method" value={monitor.method} />
              <ConfigRow label="Interval" value={formatInterval(monitor.intervalSeconds)} />
              <ConfigRow label="Timeout" value={formatMs(monitor.timeoutMs)} />
              <ConfigRow label="Expected status" value={monitor.expectedStatus} />
              <ConfigRow
                label="Alert after"
                value={`${monitor.failureThreshold} consecutive failure(s)`}
              />
              <ConfigRow
                label="Recover after"
                value={`${monitor.recoveryThreshold} consecutive success(es)`}
              />
              <ConfigRow label="Next check" value={formatRelative(monitor.nextCheckAt)} />
              <ConfigRow label="Created" value={formatDateTime(monitor.createdAt)} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Public status page</h2>
                <p>Only the hostname and status are published</p>
              </div>
              <button className="btn btn-sm" onClick={togglePublic} disabled={busy}>
                {monitor.isPublic ? 'Make private' : 'Publish'}
              </button>
            </div>
            <div className="panel-pad stack" style={{ gap: 10 }}>
              {monitor.isPublic && monitor.publicUrl ? (
                <>
                  <div className="field">
                    <label>Public URL</label>
                    <input className="input mono" readOnly value={monitor.publicUrl} />
                  </div>
                  <div className="row">
                    <a
                      className="btn btn-sm"
                      href={monitor.publicUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open page ↗
                    </a>
                    <a
                      className="btn btn-sm"
                      href={`${monitor.publicUrl}?format=json`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      JSON feed ↗
                    </a>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(monitor.publicUrl ?? '')
                          .then(() => toast.push('Status page URL copied.', 'ok'))
                          .catch(() => toast.push('Could not access the clipboard.', 'err'));
                      }}
                    >
                      Copy link
                    </button>
                  </div>
                </>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  This monitor's status is private. Publishing exposes the display name, hostname,
                  availability and incident durations to anyone with the link — never the full URL
                  path, headers or error stack traces.
                </p>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Alerts</h2>
                <p>Channels configured for this monitor</p>
              </div>
              <button className="btn btn-sm" onClick={testNotification} disabled={testing}>
                {testing ? <span className="spinner" /> : 'Send test'}
              </button>
            </div>
            <div className="panel-pad">
              <p className="small muted" style={{ margin: '0 0 10px' }}>
                Manage webhook and email destinations on the{' '}
                <a href="/app/settings">alerts page</a>. Test deliveries are logged with their real
                result.
              </p>
              <a className="btn btn-sm" href="/app/settings">
                Manage alert channels
              </a>
            </div>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Recent probes</h2>
            <p>Last {detail.recentChecks.length} samples, newest first</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Result</th>
                <th>Response</th>
              </tr>
            </thead>
            <tbody>
              {[...detail.recentChecks].reverse().map((check) => (
                <tr key={check.checkedAt}>
                  <td className="mono">{formatDateTime(check.checkedAt)}</td>
                  <td>
                    <span className={`pill ${check.ok ? 'up' : 'down'}`}>
                      {check.ok ? 'OK' : 'Failed'}
                    </span>
                  </td>
                  <td>{formatMs(check.responseMs)}</td>
                </tr>
              ))}
              {detail.recentChecks.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No probes stored yet for this window.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {editing ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label="Edit monitor">
            <div className="modal-head">
              <h2 style={{ fontSize: 16 }}>Edit {monitor.name}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <MonitorForm
                initial={monitor}
                submitLabel="Save changes"
                onSubmit={handleUpdate}
                onCancel={() => setEditing(false)}
              />
            </div>
          </div>
        </div>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Delete ${monitor.name}?`}
          message="All probe history and incidents for this monitor are permanently deleted."
          confirmLabel="Delete monitor"
          danger
          busy={busy}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleting(false)}
        />
      ) : null}

      <p className="small muted" style={{ margin: 0 }}>
        Monitoring {hostOf(monitor.url)} · data retained for {stats.retentionDays} days on your plan.
      </p>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="spread" style={{ fontSize: 13 }}>
      <span className="muted">{label}</span>
      <span className="mono" style={{ textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}
