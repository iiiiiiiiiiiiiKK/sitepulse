import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError, NetworkError } from '../api';
import type { MonitorDetail as Detail } from '../types';
import {
  ConfirmDialog,
  ErrorState,
  LoadingPanel,
  Modal,
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
import { useI18n } from '../lib/i18n';
import { MonitorForm, type MonitorFormValues } from '../components/MonitorForm';

type RangeKey = '24h' | '7d' | '30d';

export function MonitorDetailPage({ monitorId }: { monitorId: string }) {
  const { t } = useI18n();
  const [range, setRange] = useState<RangeKey>('24h');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const toast = useToast();

  const ranges: Array<{ key: RangeKey; label: string }> = [
    { key: '24h', label: t('detail.range24h') },
    { key: '7d', label: t('detail.range7d') },
    { key: '30d', label: t('detail.range30d') },
  ];

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
              : t('common.couldNotLoad')
          );
        }
      } finally {
        setLoading(false);
      }
    },
    [monitorId, range, t]
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
    toast.push(t('dash.updated'), 'ok');
    await load(true);
  };

  const togglePause = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      if (detail.monitor.status === 'paused') {
        await api.resumeMonitor(monitorId);
        toast.push(t('detail.resumed'), 'ok');
      } else {
        await api.pauseMonitor(monitorId);
        toast.push(t('detail.pausedToast'), 'ok');
      }
      await load(true);
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('detail.actionFailed'),
        'err'
      );
    } finally {
      setBusy(false);
    }
  };

  const checkNow = async () => {
    setBusy(true);
    try {
      await api.checkNow(monitorId);
      toast.push(t('dash.checkQueued'), 'ok');
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('detail.checkFailed'),
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
      toast.push(detail.monitor.isPublic ? t('detail.unpublished') : t('detail.published'), 'ok');
      await load(true);
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('detail.visibilityFailed'),
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
      const { sent, failed, skipped } = result.summary;
      // The server's summary sentence is English; rebuild it from counts so the
      // toast follows the active language, and keep its "no channels" special case.
      const message =
        result.outcomes.length === 0
          ? t('detail.noChannels')
          : t('detail.testSummary', { sent, failed, skipped });
      toast.push(message, failed > 0 ? 'err' : 'ok');
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('detail.testFailed'),
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
      toast.push(t('detail.deleted'), 'ok');
      window.history.pushState({}, '', '/app');
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('dash.deleteFailed'),
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
          {t('detail.back')}
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
            {t('dash.checkNow')}
          </button>
          <button className="btn btn-sm" onClick={togglePause} disabled={busy}>
            {monitor.status === 'paused' ? t('dash.resume') : t('dash.pause')}
          </button>
          <button className="btn btn-sm" onClick={() => setEditing(true)} disabled={busy}>
            {t('common.edit')}
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={() => setDeleting(true)}
            disabled={busy}
          >
            {t('common.delete')}
          </button>
        </div>
      </div>

      {openIncident ? (
        <div className="panel panel-pad" style={{ borderColor: 'var(--down)' }}>
          <div className="row" style={{ gap: 10 }}>
            <StatusPill status="down" />
            <div>
              <div style={{ fontWeight: 620, fontSize: 14 }}>
                {t('detail.ongoing', { duration: formatDuration(openIncident.durationSeconds) })}
              </div>
              <div className="small muted">
                {t('detail.started', {
                  when: formatDateTime(openIncident.startedAt),
                  summary: openIncident.summary ?? 'Probe failure',
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row" role="tablist" aria-label={t('detail.period')}>
          {ranges.map((item) => (
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
          <a className="btn btn-sm" href={api.exportUrl(monitorId, 'csv', range)} download>
            {t('detail.exportCsv')}
          </a>
          <a className="btn btn-sm" href={api.exportUrl(monitorId, 'json', range)} download>
            {t('detail.exportJson')}
          </a>
        </div>
      </div>

      <div className="stat-grid">
        <div
          className={`stat ${
            stats.availability === null
              ? ''
              : (stats.availability ?? 0) >= 99
                ? 'stat-accent-up'
                : 'stat-accent-down'
          }`}
        >
          <div className="stat-label">{t('detail.availability')}</div>
          <div className="stat-value">{formatPercent(stats.availability)}</div>
          <div className="stat-sub">
            {t('detail.probesFailed', {
              total: stats.totalChecks,
              failed: stats.failedChecks,
            })}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">{t('detail.downtime')}</div>
          <div className="stat-value">{formatDuration(stats.downtimeSeconds)}</div>
          <div className="stat-sub">{t('detail.fromIncidents')}</div>
        </div>
        <div className="stat">
          <div className="stat-label">{t('detail.avgResponse')}</div>
          <div className="stat-value">{formatMs(stats.avgResponseMs)}</div>
          <div className="stat-sub">
            {t('detail.p95', { value: formatMs(stats.p95ResponseMs) })}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">{t('detail.lastSuccess')}</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {monitor.lastSuccessAt ? formatRelative(monitor.lastSuccessAt) : t('common.never')}
          </div>
          <div className="stat-sub">
            {monitor.lastStatusCode ? `HTTP ${monitor.lastStatusCode}` : t('detail.noProbeYet')}
          </div>
        </div>
      </div>

      {stats.retentionLimited ? (
        <p className="small muted" style={{ margin: 0 }}>
          {t('detail.retentionNote', { days: stats.retentionDays })}
        </p>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('detail.responseTitle')}</h2>
            <p>{t('detail.responseSub')}</p>
          </div>
        </div>
        <div className="panel-pad">
          <ResponseChart buckets={detail.buckets} range={range} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('detail.availabilityTitle')}</h2>
            <p>{t('detail.availabilitySub')}</p>
          </div>
        </div>
        <div className="panel-pad">
          <AvailabilityChart buckets={detail.buckets} />
          <div style={{ marginTop: 14 }}>
            <div className="small muted" style={{ marginBottom: 5 }}>
              {t('detail.dailyRollup')}
            </div>
            <UptimeStrip daily={detail.daily} />
          </div>
        </div>
      </section>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('detail.incidentTitle')}</h2>
              <p>{t('detail.incidentCount', { n: detail.incidents.length })}</p>
            </div>
          </div>
          <div className="panel-pad">
            {detail.incidents.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                {t('detail.noIncidents', { n: monitor.failureThreshold })}
              </p>
            ) : (
              <ul className="timeline">
                {detail.incidents.map((incident) => (
                  <li key={incident.id} className={incident.resolvedAt ? 'resolved' : ''}>
                    <div className="tl-title">
                      {incident.resolvedAt ? t('detail.resolved') : t('detail.ongoingWord')} ·{' '}
                      {formatDuration(incident.durationSeconds)}
                    </div>
                    <div className="tl-meta">
                      {formatDateTime(incident.startedAt)}
                      {incident.resolvedAt
                        ? ` → ${formatDateTime(incident.resolvedAt)}`
                        : t('detail.toNow')}
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
                <h2>{t('detail.configTitle')}</h2>
                <p>{t('detail.configSub')}</p>
              </div>
            </div>
            <div className="panel-pad stack" style={{ gap: 9 }}>
              <ConfigRow label={t('detail.method')} value={monitor.method} />
              <ConfigRow label={t('detail.interval')} value={formatInterval(monitor.intervalSeconds)} />
              <ConfigRow label={t('detail.timeout')} value={formatMs(monitor.timeoutMs)} />
              <ConfigRow label={t('detail.expected')} value={monitor.expectedStatus} />
              <ConfigRow
                label={t('detail.alertAfter')}
                value={t('detail.alertAfterValue', { n: monitor.failureThreshold })}
              />
              <ConfigRow
                label={t('detail.recoverAfter')}
                value={t('detail.recoverAfterValue', { n: monitor.recoveryThreshold })}
              />
              <ConfigRow label={t('detail.nextCheck')} value={formatRelative(monitor.nextCheckAt)} />
              <ConfigRow label={t('detail.created')} value={formatDateTime(monitor.createdAt)} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>{t('detail.publicTitle')}</h2>
                <p>{t('detail.publicSub')}</p>
              </div>
              <button className="btn btn-sm" onClick={togglePublic} disabled={busy}>
                {monitor.isPublic ? t('detail.unpublish') : t('detail.publish')}
              </button>
            </div>
            <div className="panel-pad stack" style={{ gap: 10 }}>
              {monitor.isPublic && monitor.publicUrl ? (
                <>
                  <div className="field">
                    <label>{t('detail.publicUrl')}</label>
                    <input className="input mono" readOnly value={monitor.publicUrl} />
                  </div>
                  <div className="row">
                    <a
                      className="btn btn-sm"
                      href={monitor.publicUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('detail.openPage')}
                    </a>
                    <a
                      className="btn btn-sm"
                      href={`${monitor.publicUrl}?format=json`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('detail.jsonFeed')}
                    </a>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(monitor.publicUrl ?? '')
                          .then(() => toast.push(t('detail.copied'), 'ok'))
                          .catch(() => toast.push(t('detail.clipboardFailed'), 'err'));
                      }}
                    >
                      {t('detail.copyLink')}
                    </button>
                  </div>
                </>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  {t('detail.privateNote')}
                </p>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>{t('detail.alertsTitle')}</h2>
                <p>{t('detail.alertsSub')}</p>
              </div>
              <button className="btn btn-sm" onClick={testNotification} disabled={testing}>
                {testing ? <span className="spinner" /> : t('detail.sendTest')}
              </button>
            </div>
            <div className="panel-pad">
              <p className="small muted" style={{ margin: '0 0 10px' }}>
                {t('detail.alertsNotePre')}
                <a href="/app/settings">{t('detail.alertsLink')}</a>
                {t('detail.alertsNotePost')}
              </p>
              <a className="btn btn-sm" href="/app/settings">
                {t('detail.manageChannels')}
              </a>
            </div>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('detail.recentTitle')}</h2>
            <p>{t('detail.recentSub', { n: detail.recentChecks.length })}</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('detail.colTime')}</th>
                <th>{t('detail.colResult')}</th>
                <th>{t('detail.colResponse')}</th>
              </tr>
            </thead>
            <tbody>
              {[...detail.recentChecks].reverse().map((check) => (
                <tr key={check.checkedAt}>
                  <td className="mono">{formatDateTime(check.checkedAt)}</td>
                  <td>
                    <span className={`pill ${check.ok ? 'up' : 'down'}`}>
                      {check.ok ? t('detail.ok') : t('detail.failed')}
                    </span>
                  </td>
                  <td>{formatMs(check.responseMs)}</td>
                </tr>
              ))}
              {detail.recentChecks.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    {t('detail.noProbes')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {editing ? (
        <Modal title={t('detail.editTitle', { name: monitor.name })} onClose={() => setEditing(false)}>
          <MonitorForm
            initial={monitor}
            submitLabel={t('form.save')}
            onSubmit={handleUpdate}
            onCancel={() => setEditing(false)}
          />
        </Modal>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={t('detail.deleteTitle', { name: monitor.name })}
          message={t('detail.deleteBody')}
          confirmLabel={t('detail.deleteConfirm')}
          danger
          busy={busy}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleting(false)}
        />
      ) : null}

      <p className="small muted" style={{ margin: 0 }}>
        {t('detail.monitoring', {
          host: hostOf(monitor.url),
          days: stats.retentionDays,
        })}
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
