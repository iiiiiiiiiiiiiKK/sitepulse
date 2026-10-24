import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiClientError, NetworkError } from '../api';
import type { AccountSummary, Monitor } from '../types';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingPanel,
  Modal,
  StatusPill,
  useToast,
} from '../components/ui';
import { formatInterval, formatMs, formatPercent, formatRelative, hostOf } from '../lib/format';
import { MonitorForm, type MonitorFormValues } from '../components/MonitorForm';

const AUTO_REFRESH_MS = 30000;

export function DashboardPage() {
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [quota, setQuota] = useState<{ used: number; max: number; plan: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Monitor | null>(null);
  const [deleting, setDeleting] = useState<Monitor | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteBusy, setConfirmDeleteBusy] = useState(false);
  const [, setTick] = useState(0);
  const toast = useToast();

  const load = useCallback(async (silent = false) => {
    if (!silent) setError(null);
    try {
      const [monitorResult, summaryResult] = await Promise.all([api.listMonitors(), api.summary()]);
      setMonitors(monitorResult.monitors);
      setQuota(monitorResult.quota);
      setSummary(summaryResult);
    } catch (caught) {
      if (!silent) {
        setError(
          caught instanceof ApiClientError || caught instanceof NetworkError
            ? caught.message
            : 'Could not load your monitors.'
        );
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(true), AUTO_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  // Re-render relative timestamps every 15s without re-fetching.
  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), 15000);
    return () => window.clearInterval(interval);
  }, []);

  const handleCreate = useCallback(
    async (values: MonitorFormValues) => {
      const result = await api.createMonitor({
        name: values.name,
        url: values.url,
        method: values.method,
        intervalSeconds: values.intervalSeconds,
        timeoutMs: values.timeoutMs,
        expectedStatus: values.expectedStatus,
        failureThreshold: values.failureThreshold,
        recoveryThreshold: values.recoveryThreshold,
      });
      setMonitors((prev) => (prev ? [...prev, result.monitor] : [result.monitor]));
      setCreating(false);
      toast.push('Monitor created. The first probe runs within a minute.', 'ok');
      void load(true);
    },
    [load, toast]
  );

  const handleUpdate = useCallback(
    async (values: MonitorFormValues) => {
      if (!editing) return;
      const result = await api.updateMonitor(editing.id, {
        name: values.name,
        url: values.url,
        method: values.method,
        intervalSeconds: values.intervalSeconds,
        timeoutMs: values.timeoutMs,
        expectedStatus: values.expectedStatus,
        failureThreshold: values.failureThreshold,
        recoveryThreshold: values.recoveryThreshold,
      });
      setMonitors((prev) =>
        prev
          ? prev.map((monitor) => (monitor.id === result.monitor.id ? result.monitor : monitor))
          : prev
      );
      setEditing(null);
      toast.push('Monitor updated.', 'ok');
      void load(true);
    },
    [editing, load, toast]
  );

  const doAction = useCallback(
    async (monitor: Monitor, action: 'pause' | 'resume' | 'check') => {
      setBusyId(monitor.id);
      try {
        if (action === 'pause') {
          const result = await api.pauseMonitor(monitor.id);
          setMonitors((prev) =>
            prev ? prev.map((item) => (item.id === monitor.id ? result.monitor : item)) : prev
          );
          toast.push(`${monitor.name} paused. No probes will run until you resume.`, 'ok');
        } else if (action === 'resume') {
          const result = await api.resumeMonitor(monitor.id);
          setMonitors((prev) =>
            prev ? prev.map((item) => (item.id === monitor.id ? result.monitor : item)) : prev
          );
          toast.push(`${monitor.name} resumed. Probing again shortly.`, 'ok');
        } else {
          const result = await api.checkNow(monitor.id);
          toast.push(result.message, 'ok');
        }
        void load(true);
      } catch (caught) {
        toast.push(
          caught instanceof ApiClientError || caught instanceof NetworkError
            ? caught.message
            : 'That action failed.',
          'err'
        );
      } finally {
        setBusyId(null);
      }
    },
    [load, toast]
  );

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    setConfirmDeleteBusy(true);
    try {
      await api.deleteMonitor(deleting.id);
      setMonitors((prev) => (prev ? prev.filter((item) => item.id !== deleting.id) : prev));
      toast.push(`${deleting.name} deleted, including its history.`, 'ok');
      setDeleting(null);
      void load(true);
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Delete failed.',
        'err'
      );
    } finally {
      setConfirmDeleteBusy(false);
    }
  }, [deleting, load, toast]);

  const totals = useMemo(() => {
    if (!monitors) return null;
    const up = monitors.filter((monitor) => monitor.status === 'up').length;
    const down = monitors.filter(
      (monitor) => monitor.status === 'down' || monitor.status === 'recovering'
    ).length;
    const paused = monitors.filter((monitor) => monitor.status === 'paused').length;
    return { up, down, paused, total: monitors.length };
  }, [monitors]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="spread">
        <div>
          <h1 className="page-title">Monitors</h1>
          <p className="page-sub">
            {totals
              ? `${totals.total} monitor${totals.total === 1 ? '' : 's'} · ${totals.up} operational · ${totals.down} down · ${totals.paused} paused`
              : 'Loading your monitors…'}
          </p>
        </div>
        <div className="row">
          <button className="btn btn-sm" onClick={() => void load()} disabled={!monitors}>
            Refresh
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setCreating(true)}
            disabled={Boolean(quota && quota.used >= quota.max)}
            title={
              quota && quota.used >= quota.max
                ? `Your ${quota.plan} plan allows ${quota.max} monitors`
                : 'Create a new monitor'
            }
          >
            + New monitor
          </button>
        </div>
      </div>

      {summary ? (
        <div className="stat-grid">
          <div className="stat stat-accent-up">
            <div className="stat-label">Operational</div>
            <div className="stat-value">{summary.monitors.up}</div>
            <div className="stat-sub">of {summary.monitors.total} monitors</div>
          </div>
          <div className={`stat ${summary.monitors.down > 0 ? 'stat-accent-down' : ''}`}>
            <div className="stat-label">Down now</div>
            <div className="stat-value">{summary.monitors.down}</div>
            <div className="stat-sub">{summary.openIncidents} open incident(s)</div>
          </div>
          <div className="stat">
            <div className="stat-label">Unknown</div>
            <div className="stat-value">{summary.monitors.unknown}</div>
            <div className="stat-sub">awaiting first probe</div>
          </div>
          <div className="stat">
            <div className="stat-label">Quota</div>
            <div className="stat-value">{quota ? `${quota.used}/${quota.max}` : '—'}</div>
            <div className="stat-sub">
              {summary.plan} plan · {summary.limits.retentionDays}d history
            </div>
          </div>
        </div>
      ) : null}

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {!monitors && !error ? <LoadingPanel rows={3} /> : null}

      {monitors && monitors.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No monitors yet"
            description="Add the first URL you want to keep an eye on. SitePulse starts probing within a minute and keeps going while you are offline."
            action={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                Create your first monitor
              </button>
            }
          />
        </div>
      ) : null}

      {monitors && monitors.length > 0 ? (
        <div className="stack" style={{ gap: 12 }}>
          {monitors.map((monitor) => (
            <MonitorCard
              key={monitor.id}
              monitor={monitor}
              busy={busyId === monitor.id}
              onPause={() => void doAction(monitor, 'pause')}
              onResume={() => void doAction(monitor, 'resume')}
              onCheckNow={() => void doAction(monitor, 'check')}
              onEdit={() => setEditing(monitor)}
              onDelete={() => setDeleting(monitor)}
            />
          ))}
        </div>
      ) : null}

      {creating ? (
        <Modal
          title="New monitor"
          subtitle="SitePulse will probe this URL on the interval you choose."
          onClose={() => setCreating(false)}
        >
          <MonitorForm
            submitLabel="Create monitor"
            onSubmit={handleCreate}
            onCancel={() => setCreating(false)}
          />
        </Modal>
      ) : null}

      {editing ? (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <MonitorForm
            initial={editing}
            submitLabel="Save changes"
            onSubmit={handleUpdate}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="This permanently deletes the monitor, all of its probe history and incident records. This cannot be undone."
          confirmLabel="Delete monitor"
          danger
          busy={confirmDeleteBusy}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

function MonitorCard({
  monitor,
  busy,
  onPause,
  onResume,
  onCheckNow,
  onEdit,
  onDelete,
}: {
  monitor: Monitor;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onCheckNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const availability = monitor.stats24h?.availability ?? null;
  return (
    <article className={`monitor-card is-${monitor.status}`}>
      <div className="monitor-top">
        <div style={{ minWidth: 0 }}>
          <a className="monitor-name" href={`/app/monitors/${monitor.id}`}>
            {monitor.name}
          </a>
          <div className="monitor-url">{hostOf(monitor.url)}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <StatusPill status={monitor.status} live />
          {monitor.isPublic && monitor.publicUrl ? (
            <a
              className="tag"
              href={monitor.publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open public status page"
            >
              status ↗
            </a>
          ) : null}
        </div>
      </div>

      <div className="monitor-metrics">
        <div className="mm">
          <div className="mm-k">24h uptime</div>
          <div className="mm-v">{formatPercent(availability)}</div>
        </div>
        <div className="mm">
          <div className="mm-k">Response</div>
          <div className="mm-v">{formatMs(monitor.lastResponseMs)}</div>
        </div>
        <div className="mm">
          <div className="mm-k">Last check</div>
          <div className="mm-v">{formatRelative(monitor.lastCheckAt)}</div>
        </div>
        <div className="mm">
          <div className="mm-k">Interval</div>
          <div className="mm-v">{formatInterval(monitor.intervalSeconds)}</div>
        </div>
      </div>

      {monitor.lastError ? (
        <div className="form-error" style={{ fontSize: 12.5 }}>
          <span aria-hidden="true">⚠</span>
          <span>
            {monitor.status === 'recovering' ? 'Recovering — last failure: ' : 'Last failure: '}
            {monitor.lastError}
            {monitor.consecutiveFailures > 0
              ? ` (${monitor.consecutiveFailures}/${monitor.failureThreshold} before alerting)`
              : ''}
          </span>
        </div>
      ) : null}

      <div className="monitor-foot">
        <span>
          Last success: {monitor.lastSuccessAt ? formatRelative(monitor.lastSuccessAt) : 'never'}
        </span>
        <span aria-hidden="true">·</span>
        <span>{monitor.lastStatusCode ? `HTTP ${monitor.lastStatusCode}` : 'no status yet'}</span>
        <span style={{ flex: 1 }} />
        <div className="row" style={{ gap: 6 }}>
          <a className="btn btn-sm" href={`/app/monitors/${monitor.id}`}>
            Details
          </a>
          <button className="btn btn-sm" onClick={onCheckNow} disabled={busy || !monitor.enabled}>
            Check now
          </button>
          {monitor.status === 'paused' ? (
            <button className="btn btn-sm" onClick={onResume} disabled={busy}>
              Resume
            </button>
          ) : (
            <button className="btn btn-sm" onClick={onPause} disabled={busy}>
              Pause
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={onEdit} disabled={busy}>
            Edit
          </button>
          <button className="btn btn-sm btn-danger" onClick={onDelete} disabled={busy}>
            Delete
          </button>
        </div>
      </div>

      {monitor.currentIncidentId ? (
        <p className="small" style={{ margin: 0, color: 'var(--down)' }}>
          Ongoing incident — <a href={`/app/monitors/${monitor.id}`}>view timeline</a>
        </p>
      ) : null}
    </article>
  );
}
