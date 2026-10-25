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
import { useI18n } from '../lib/i18n';
import { MonitorForm, type MonitorFormValues } from '../components/MonitorForm';

const AUTO_REFRESH_MS = 30000;

export function DashboardPage() {
  const { t } = useI18n();
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

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setError(null);
      try {
        const [monitorResult, summaryResult] = await Promise.all([
          api.listMonitors(),
          api.summary(),
        ]);
        setMonitors(monitorResult.monitors);
        setQuota(monitorResult.quota);
        setSummary(summaryResult);
      } catch (caught) {
        if (!silent) {
          setError(
            caught instanceof ApiClientError || caught instanceof NetworkError
              ? caught.message
              : t('common.couldNotLoad')
          );
        }
      }
    },
    [t]
  );

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
      toast.push(t('dash.created'), 'ok');
      void load(true);
    },
    [load, toast, t]
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
      toast.push(t('dash.updated'), 'ok');
      void load(true);
    },
    [editing, load, toast, t]
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
          toast.push(t('dash.pausedToast', { name: monitor.name }), 'ok');
        } else if (action === 'resume') {
          const result = await api.resumeMonitor(monitor.id);
          setMonitors((prev) =>
            prev ? prev.map((item) => (item.id === monitor.id ? result.monitor : item)) : prev
          );
          toast.push(t('dash.resumedToast', { name: monitor.name }), 'ok');
        } else {
          await api.checkNow(monitor.id);
          toast.push(t('dash.checkQueued'), 'ok');
        }
        void load(true);
      } catch (caught) {
        toast.push(
          caught instanceof ApiClientError || caught instanceof NetworkError
            ? caught.message
            : t('dash.actionFailed'),
          'err'
        );
      } finally {
        setBusyId(null);
      }
    },
    [load, toast, t]
  );

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    setConfirmDeleteBusy(true);
    const name = deleting.name;
    try {
      await api.deleteMonitor(deleting.id);
      setMonitors((prev) => (prev ? prev.filter((item) => item.id !== deleting.id) : prev));
      toast.push(t('dash.deletedToast', { name }), 'ok');
      setDeleting(null);
      void load(true);
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('dash.deleteFailed'),
        'err'
      );
    } finally {
      setConfirmDeleteBusy(false);
    }
  }, [deleting, load, toast, t]);

  const totals = useMemo(() => {
    if (!monitors) return null;
    const up = monitors.filter((monitor) => monitor.status === 'up').length;
    const down = monitors.filter(
      (monitor) => monitor.status === 'down' || monitor.status === 'recovering'
    ).length;
    const paused = monitors.filter((monitor) => monitor.status === 'paused').length;
    return { up, down, paused, total: monitors.length };
  }, [monitors]);

  const planLabel = (plan: string) =>
    plan === 'pro' ? t('nav.planPro') : t('nav.planFree');

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="spread">
        <div>
          <h1 className="page-title">{t('dash.title')}</h1>
          <p className="page-sub">
            {totals
              ? t('dash.summary', {
                  total: totals.total,
                  up: totals.up,
                  down: totals.down,
                  paused: totals.paused,
                })
              : t('dash.loading')}
          </p>
        </div>
        <div className="row">
          <button className="btn btn-sm" onClick={() => void load()} disabled={!monitors}>
            {t('common.refresh')}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setCreating(true)}
            disabled={Boolean(quota && quota.used >= quota.max)}
            title={
              quota && quota.used >= quota.max
                ? `${planLabel(quota.plan)} · ${quota.used}/${quota.max}`
                : t('dash.newTitle')
            }
          >
            {t('dash.new')}
          </button>
        </div>
      </div>

      {summary ? (
        <div className="stat-grid">
          <div className="stat stat-accent-up">
            <div className="stat-label">{t('dash.operational')}</div>
            <div className="stat-value">{summary.monitors.up}</div>
            <div className="stat-sub">{t('dash.ofMonitors', { n: summary.monitors.total })}</div>
          </div>
          <div className={`stat ${summary.monitors.down > 0 ? 'stat-accent-down' : ''}`}>
            <div className="stat-label">{t('dash.downNow')}</div>
            <div className="stat-value">{summary.monitors.down}</div>
            <div className="stat-sub">{t('dash.openIncidents', { n: summary.openIncidents })}</div>
          </div>
          <div className="stat">
            <div className="stat-label">{t('dash.unknown')}</div>
            <div className="stat-value">{summary.monitors.unknown}</div>
            <div className="stat-sub">{t('dash.awaitingProbe')}</div>
          </div>
          <div className="stat">
            <div className="stat-label">{t('dash.quota')}</div>
            <div className="stat-value">{quota ? `${quota.used}/${quota.max}` : '—'}</div>
            <div className="stat-sub">
              {t('dash.planHistory', {
                plan: planLabel(summary.plan),
                days: summary.limits.retentionDays,
              })}
            </div>
          </div>
        </div>
      ) : null}

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {!monitors && !error ? <LoadingPanel rows={3} /> : null}

      {monitors && monitors.length === 0 ? (
        <div className="panel">
          <EmptyState
            title={t('dash.emptyTitle')}
            description={t('dash.emptyBody')}
            action={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                {t('dash.emptyCta')}
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
          title={t('dash.newMonitorTitle')}
          subtitle={t('dash.newMonitorSub')}
          onClose={() => setCreating(false)}
        >
          <MonitorForm
            submitLabel={t('form.create')}
            onSubmit={handleCreate}
            onCancel={() => setCreating(false)}
          />
        </Modal>
      ) : null}

      {editing ? (
        <Modal title={t('detail.editTitle', { name: editing.name })} onClose={() => setEditing(null)}>
          <MonitorForm
            initial={editing}
            submitLabel={t('form.save')}
            onSubmit={handleUpdate}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={t('dash.deleteTitle', { name: deleting.name })}
          message={t('dash.deleteBody')}
          confirmLabel={t('dash.deleteConfirm')}
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
  const { t } = useI18n();
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
              title={t('dash.openStatusPage')}
            >
              {t('dash.statusTag')}
            </a>
          ) : null}
        </div>
      </div>

      <div className="monitor-metrics">
        <div className="mm">
          <div className="mm-k">{t('dash.uptime24h')}</div>
          <div className="mm-v">{formatPercent(availability)}</div>
        </div>
        <div className="mm">
          <div className="mm-k">{t('dash.response')}</div>
          <div className="mm-v">{formatMs(monitor.lastResponseMs)}</div>
        </div>
        <div className="mm">
          <div className="mm-k">{t('dash.lastCheck')}</div>
          <div className="mm-v">{formatRelative(monitor.lastCheckAt)}</div>
        </div>
        <div className="mm">
          <div className="mm-k">{t('dash.interval')}</div>
          <div className="mm-v">{formatInterval(monitor.intervalSeconds)}</div>
        </div>
      </div>

      {monitor.lastError ? (
        <div className="form-error" style={{ fontSize: 12.5 }}>
          <span aria-hidden="true">⚠</span>
          <span>
            {monitor.status === 'recovering' ? t('dash.recoveringPrefix') : t('dash.lastFailure')}
            {monitor.lastError}
            {monitor.consecutiveFailures > 0
              ? t('dash.beforeAlerting', {
                  n: monitor.consecutiveFailures,
                  max: monitor.failureThreshold,
                })
              : ''}
          </span>
        </div>
      ) : null}

      <div className="monitor-foot">
        <span>{t('dash.lastSuccess', { value: formatRelative(monitor.lastSuccessAt) })}</span>
        <span aria-hidden="true">·</span>
        <span>{monitor.lastStatusCode ? `HTTP ${monitor.lastStatusCode}` : t('dash.noStatusYet')}</span>
        <span style={{ flex: 1 }} />
        <div className="row" style={{ gap: 6 }}>
          <a className="btn btn-sm" href={`/app/monitors/${monitor.id}`}>
            {t('dash.details')}
          </a>
          <button className="btn btn-sm" onClick={onCheckNow} disabled={busy || !monitor.enabled}>
            {t('dash.checkNow')}
          </button>
          {monitor.status === 'paused' ? (
            <button className="btn btn-sm" onClick={onResume} disabled={busy}>
              {t('dash.resume')}
            </button>
          ) : (
            <button className="btn btn-sm" onClick={onPause} disabled={busy}>
              {t('dash.pause')}
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={onEdit} disabled={busy}>
            {t('common.edit')}
          </button>
          <button className="btn btn-sm btn-danger" onClick={onDelete} disabled={busy}>
            {t('common.delete')}
          </button>
        </div>
      </div>

      {monitor.currentIncidentId ? (
        <p className="small" style={{ margin: 0, color: 'var(--down)' }}>
          {t('dash.ongoingIncident')}
          <a href={`/app/monitors/${monitor.id}`}>{t('dash.viewTimeline')}</a>
        </p>
      ) : null}
    </article>
  );
}
