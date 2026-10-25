import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError, NetworkError } from '../api';
import type { Channel, Delivery, Maintenance, Monitor } from '../types';
import { ConfirmDialog, ErrorState, Field, LoadingPanel, useToast } from '../components/ui';
import { formatDateTime, formatRelative } from '../lib/format';
import { useI18n } from '../lib/i18n';

export function SettingsPage() {
  const { t, lang } = useI18n();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [maintenance, setMaintenance] = useState<Maintenance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [deletingMaintenance, setDeletingMaintenance] = useState<Maintenance | null>(null);
  const toast = useToast();

  // new channel form
  const [kind, setKind] = useState<'webhook' | 'email'>('webhook');
  const [target, setTarget] = useState('');
  const [secret, setSecret] = useState('');
  const [monitorId, setMonitorId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // maintenance form
  const [mTitle, setMTitle] = useState('');
  const [mBody, setMBody] = useState('');
  const [mStart, setMStart] = useState('');
  const [mEnd, setMEnd] = useState('');
  const [mError, setMError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [channelResult, monitorResult, maintenanceResult] = await Promise.all([
        api.listChannels(),
        api.listMonitors(),
        api.listMaintenance(),
      ]);
      setChannels(channelResult.channels);
      setDeliveries(channelResult.recentDeliveries);
      setEmailConfigured(channelResult.emailConfigured);
      setMonitors(monitorResult.monitors);
      setMaintenance(maintenanceResult.maintenance);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('common.couldNotLoad')
      );
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const createChannel = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!target.trim()) {
      setFormError(kind === 'webhook' ? t('settings.errTargetWebhook') : t('settings.errTargetEmail'));
      return;
    }
    setBusy(true);
    try {
      const result = await api.createChannel({
        kind,
        target: target.trim(),
        monitorId: monitorId || null,
        secret: secret.trim() || undefined,
      });
      setChannels((prev) => (prev ? [...prev, result.channel] : [result.channel]));
      setTarget('');
      setSecret('');
      if (result.warning) toast.push(result.warning, 'err');
      else toast.push(t('settings.created'), 'ok');
      void load();
    } catch (caught) {
      setFormError(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('settings.createFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleChannel = async (channel: Channel, patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await api.updateChannel(channel.id, patch);
      setChannels((prev) =>
        prev ? prev.map((item) => (item.id === channel.id ? result.channel : item)) : prev
      );
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('settings.updateFailed'),
        'err'
      );
    } finally {
      setBusy(false);
    }
  };

  const testChannel = async (channel: Channel) => {
    setBusy(true);
    try {
      const result = await api.testChannel(channel.id);
      const outcome = result.outcomes[0];
      if (!outcome) {
        toast.push(t('settings.noDeliveryAttempt'), 'err');
      } else if (outcome.status === 'sent') {
        toast.push(t('settings.testDelivered', { detail: outcome.detail }), 'ok');
      } else {
        toast.push(
          t('settings.testResult', { status: outcome.status, detail: outcome.detail }),
          'err'
        );
      }
      void load();
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('settings.testFailed'),
        'err'
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteChannel = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteChannel(deleting.id);
      setChannels((prev) => (prev ? prev.filter((item) => item.id !== deleting.id) : prev));
      setDeleting(null);
      toast.push(t('settings.deleted'), 'ok');
      void load();
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('dash.deleteFailed'),
        'err'
      );
    } finally {
      setBusy(false);
    }
  };

  const createMaintenance = async (event: React.FormEvent) => {
    event.preventDefault();
    setMError(null);
    if (!mTitle.trim()) {
      setMError(t('settings.mErrTitle'));
      return;
    }
    const startsAt = new Date(mStart).getTime();
    const endsAt = new Date(mEnd).getTime();
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
      setMError(t('settings.mErrTime'));
      return;
    }
    if (endsAt <= startsAt) {
      setMError(t('settings.mErrOrder'));
      return;
    }
    setBusy(true);
    try {
      const result = await api.createMaintenance({
        title: mTitle.trim(),
        body: mBody.trim(),
        startsAt,
        endsAt,
      });
      setMaintenance((prev) => [result.maintenance, ...prev]);
      setMTitle('');
      setMBody('');
      setMStart('');
      setMEnd('');
      toast.push(t('settings.mCreated'), 'ok');
    } catch (caught) {
      setMError(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('settings.mFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteMaintenance = async () => {
    if (!deletingMaintenance) return;
    setBusy(true);
    try {
      await api.deleteMaintenance(deletingMaintenance.id);
      setMaintenance((prev) => prev.filter((item) => item.id !== deletingMaintenance.id));
      setDeletingMaintenance(null);
      toast.push(t('settings.mDeleted'), 'ok');
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('dash.deleteFailed'),
        'err'
      );
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!channels) return <LoadingPanel rows={4} />;

  const isZh = lang === 'zh';

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1 className="page-title">{t('settings.title')}</h1>
        <p className="page-sub">{t('settings.sub')}</p>
      </div>

      {!emailConfigured ? (
        <div className="panel panel-pad">
          <div className="form-error" style={{ margin: 0 }}>
            <span aria-hidden="true">ℹ</span>
            <span>{t('settings.emailMissing')}</span>
          </div>
        </div>
      ) : null}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('settings.newChannel')}</h2>
              <p>{t('settings.newChannelSub')}</p>
            </div>
          </div>
          <form className="panel-pad stack" onSubmit={createChannel} noValidate>
            {formError ? (
              <div className="form-error" role="alert">
                <span aria-hidden="true">⚠</span>
                <span>{formError}</span>
              </div>
            ) : null}

            <Field label={t('settings.kind')} htmlFor="channel-kind">
              <select
                id="channel-kind"
                className="select"
                value={kind}
                onChange={(event) => setKind(event.target.value as 'webhook' | 'email')}
              >
                <option value="webhook">{t('settings.kindWebhook')}</option>
                <option value="email">{t('settings.kindEmail')}</option>
              </select>
            </Field>

            <Field
              label={kind === 'webhook' ? t('settings.webhookUrl') : t('settings.emailAddress')}
              hint={kind === 'webhook' ? t('settings.webhookHint') : t('settings.emailHint')}
              htmlFor="channel-target"
            >
              <input
                id="channel-target"
                className="input"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder={
                  kind === 'webhook' ? 'https://hooks.example.com/sitepulse' : 'oncall@example.com'
                }
                inputMode={kind === 'webhook' ? 'url' : 'email'}
                spellCheck={false}
              />
            </Field>

            {kind === 'webhook' ? (
              <Field label={t('settings.secret')} hint={t('settings.secretHint')} htmlFor="channel-secret">
                <input
                  id="channel-secret"
                  className="input"
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder="whsec_…"
                  autoComplete="new-password"
                />
              </Field>
            ) : null}

            <Field label={t('settings.appliesTo')} hint={t('settings.appliesHint')} htmlFor="channel-monitor">
              <select
                id="channel-monitor"
                className="select"
                value={monitorId}
                onChange={(event) => setMonitorId(event.target.value)}
              >
                <option value="">{t('settings.allMonitors')}</option>
                {monitors.map((monitor) => (
                  <option key={monitor.id} value={monitor.id}>
                    {monitor.name}
                  </option>
                ))}
              </select>
            </Field>

            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              {busy ? t('common.saving') : t('settings.addChannel')}
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('settings.channels')}</h2>
              <p>{t('settings.channelCount', { n: channels.length })}</p>
            </div>
          </div>
          <div className="panel-pad stack" style={{ gap: 10 }}>
            {channels.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                {t('settings.noChannels')}
              </p>
            ) : null}
            {channels.map((channel) => (
              <div
                key={channel.id}
                className="panel"
                style={{ padding: 12, background: 'var(--panel-2)' }}
              >
                <div className="spread" style={{ gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 7 }}>
                      <span className="tag">{channel.kind}</span>
                      <span className="small mono" style={{ wordBreak: 'break-all' }}>
                        {channel.target}
                      </span>
                    </div>
                    <div className="small muted" style={{ marginTop: 4 }}>
                      {channel.monitorId
                        ? (monitors.find((monitor) => monitor.id === channel.monitorId)?.name ??
                          t('settings.specificMonitor'))
                        : t('settings.allMonitors')}
                      {' · '}
                      {channel.onDown ? t('settings.alertsOnDown') : ''}
                      {channel.onDown && channel.onRecover ? ' + ' : ''}
                      {channel.onRecover ? t('settings.recovery') : ''}
                      {channel.hasSecret ? ` · ${t('settings.signed')}` : ''}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 5 }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => void testChannel(channel)}
                      disabled={busy}
                    >
                      {t('settings.test')}
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => void toggleChannel(channel, { enabled: !channel.enabled })}
                      disabled={busy}
                    >
                      {channel.enabled ? t('settings.disable') : t('settings.enable')}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setDeleting(channel)}
                      disabled={busy}
                    >
                      {t('settings.del')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('settings.recentDeliveries')}</h2>
            <p>{t('settings.recentDeliveriesSub')}</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('settings.colTime')}</th>
                <th>{t('settings.colEvent')}</th>
                <th>{t('settings.colStatus')}</th>
                <th>{t('settings.colDetail')}</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    {t('settings.noDeliveries')}
                  </td>
                </tr>
              ) : null}
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td className="mono">{formatRelative(delivery.createdAt)}</td>
                  <td>{delivery.event}</td>
                  <td>
                    <span
                      className={`pill ${
                        delivery.status === 'sent'
                          ? 'up'
                          : delivery.status === 'failed'
                            ? 'down'
                            : 'neutral'
                      }`}
                    >
                      {delivery.status}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>{delivery.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('settings.maintenance')}</h2>
              <p>{t('settings.maintenanceSub')}</p>
            </div>
          </div>
          <form className="panel-pad stack" onSubmit={createMaintenance} noValidate>
            {mError ? (
              <div className="form-error" role="alert">
                <span aria-hidden="true">⚠</span>
                <span>{mError}</span>
              </div>
            ) : null}
            <Field label={t('settings.mTitle')} htmlFor="m-title">
              <input
                id="m-title"
                className="input"
                value={mTitle}
                onChange={(event) => setMTitle(event.target.value)}
                placeholder={t('settings.mTitlePlaceholder')}
                maxLength={120}
              />
            </Field>
            <Field label={t('settings.mBody')} htmlFor="m-body">
              <textarea
                id="m-body"
                className="textarea"
                value={mBody}
                onChange={(event) => setMBody(event.target.value)}
                placeholder={t('settings.mBodyPlaceholder')}
                maxLength={2000}
              />
            </Field>
            <div className="grid-2">
              <Field label={t('settings.mStart')} htmlFor="m-start">
                <input
                  id="m-start"
                  className="input"
                  type="datetime-local"
                  lang={isZh ? 'zh-CN' : 'en-US'}
                  value={mStart}
                  onChange={(event) => setMStart(event.target.value)}
                />
              </Field>
              <Field label={t('settings.mEnd')} htmlFor="m-end">
                <input
                  id="m-end"
                  className="input"
                  type="datetime-local"
                  lang={isZh ? 'zh-CN' : 'en-US'}
                  value={mEnd}
                  onChange={(event) => setMEnd(event.target.value)}
                />
              </Field>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('settings.publish')}
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('settings.announcements')}</h2>
              <p>{t('settings.recorded', { n: maintenance.length })}</p>
            </div>
          </div>
          <div className="panel-pad stack" style={{ gap: 8 }}>
            {maintenance.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                {t('settings.noMaintenance')}
              </p>
            ) : null}
            {maintenance.map((item) => (
              <div
                key={item.id}
                className="panel"
                style={{ padding: 11, background: 'var(--panel-2)' }}
              >
                <div className="spread" style={{ gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 620, fontSize: 13.5 }}>{item.title}</div>
                    <div className="small muted">
                      {formatDateTime(item.startsAt)} → {formatDateTime(item.endsAt)}
                    </div>
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => setDeletingMaintenance(item)}
                    disabled={busy}
                  >
                    {t('settings.remove')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {deleting ? (
        <ConfirmDialog
          title={t('settings.deleteTitle')}
          message={t('settings.deleteBody')}
          confirmLabel={t('settings.deleteConfirm')}
          danger
          busy={busy}
          onConfirm={() => void deleteChannel()}
          onCancel={() => setDeleting(null)}
        />
      ) : null}

      {deletingMaintenance ? (
        <ConfirmDialog
          title={t('settings.mDeleteTitle')}
          message={t('settings.mDeleteBody')}
          confirmLabel={t('settings.mDeleteConfirm')}
          danger
          busy={busy}
          onConfirm={() => void deleteMaintenance()}
          onCancel={() => setDeletingMaintenance(null)}
        />
      ) : null}
    </div>
  );
}
