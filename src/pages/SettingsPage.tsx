import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError, NetworkError } from '../api';
import type { Channel, Delivery, Maintenance, Monitor } from '../types';
import { ConfirmDialog, ErrorState, Field, LoadingPanel, useToast } from '../components/ui';
import { formatDateTime, formatRelative } from '../lib/format';

export function SettingsPage() {
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
          : 'Could not load alert settings.'
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createChannel = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!target.trim()) {
      setFormError(kind === 'webhook' ? 'Enter the webhook URL.' : 'Enter the email address.');
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
      else toast.push('Alert channel created.', 'ok');
      void load();
    } catch (caught) {
      setFormError(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Could not create the channel.'
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
          : 'Update failed.',
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
        toast.push('No delivery was attempted.', 'err');
      } else if (outcome.status === 'sent') {
        toast.push(`Test delivered: ${outcome.detail}`, 'ok');
      } else {
        toast.push(`Test ${outcome.status}: ${outcome.detail}`, 'err');
      }
      void load();
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Test failed.',
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
      toast.push('Channel deleted.', 'ok');
      void load();
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Delete failed.',
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
      setMError('Give the maintenance window a title.');
      return;
    }
    const startsAt = new Date(mStart).getTime();
    const endsAt = new Date(mEnd).getTime();
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
      setMError('Pick a start and end time.');
      return;
    }
    if (endsAt <= startsAt) {
      setMError('The end time must be after the start time.');
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
      toast.push('Maintenance announcement published.', 'ok');
    } catch (caught) {
      setMError(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Could not publish the announcement.'
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
      toast.push('Maintenance announcement removed.', 'ok');
    } catch (caught) {
      toast.push(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : 'Delete failed.',
        'err'
      );
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!channels) return <LoadingPanel rows={4} />;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1 className="page-title">Alerts &amp; status pages</h1>
        <p className="page-sub">
          Webhook and email destinations, plus scheduled maintenance announcements.
        </p>
      </div>

      {!emailConfigured ? (
        <div className="panel panel-pad">
          <div className="form-error" style={{ margin: 0 }}>
            <span aria-hidden="true">ℹ</span>
            <span>
              Email delivery is not configured on this deployment (no <code>EMAIL_API_KEY</code>).
              Email channels are saved, and each delivery is recorded as <strong>skipped</strong>{' '}
              with that reason — nothing pretends to have been sent.
            </span>
          </div>
        </div>
      ) : null}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>New alert channel</h2>
              <p>Webhooks are signed with HMAC-SHA256</p>
            </div>
          </div>
          <form className="panel-pad stack" onSubmit={createChannel} noValidate>
            {formError ? (
              <div className="form-error" role="alert">
                <span aria-hidden="true">⚠</span>
                <span>{formError}</span>
              </div>
            ) : null}

            <Field label="Channel type" htmlFor="channel-kind">
              <select
                id="channel-kind"
                className="select"
                value={kind}
                onChange={(event) => setKind(event.target.value as 'webhook' | 'email')}
              >
                <option value="webhook">Webhook (HTTP POST)</option>
                <option value="email">Email</option>
              </select>
            </Field>

            <Field
              label={kind === 'webhook' ? 'Webhook URL' : 'Email address'}
              hint={
                kind === 'webhook'
                  ? 'Receives a JSON POST with an X-SitePulse-Signature header. Redirects are not followed.'
                  : 'Delivery requires EMAIL_API_KEY on the server.'
              }
              htmlFor="channel-target"
            >
              <input
                id="channel-target"
                className="input"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder={kind === 'webhook' ? 'https://hooks.example.com/sitepulse' : 'oncall@example.com'}
                inputMode={kind === 'webhook' ? 'url' : 'email'}
                spellCheck={false}
              />
            </Field>

            {kind === 'webhook' ? (
              <Field
                label="Signing secret (optional)"
                hint="Stored AES-GCM encrypted. Sent as X-SitePulse-Signature — verify it on your side."
                htmlFor="channel-secret"
              >
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

            <Field
              label="Applies to"
              hint="Leave on “All monitors” to alert for everything."
              htmlFor="channel-monitor"
            >
              <select
                id="channel-monitor"
                className="select"
                value={monitorId}
                onChange={(event) => setMonitorId(event.target.value)}
              >
                <option value="">All monitors</option>
                {monitors.map((monitor) => (
                  <option key={monitor.id} value={monitor.id}>
                    {monitor.name}
                  </option>
                ))}
              </select>
            </Field>

            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              {busy ? 'Saving…' : 'Add channel'}
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Configured channels</h2>
              <p>{channels.length} channel(s)</p>
            </div>
          </div>
          <div className="panel-pad stack" style={{ gap: 10 }}>
            {channels.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                No channels yet. Create one on the left; monitors will then open incidents with real
                notifications.
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
                        ? monitors.find((monitor) => monitor.id === channel.monitorId)?.name ??
                          'Specific monitor'
                        : 'All monitors'}
                      {' · '}
                      {channel.onDown ? 'alerts on down' : ''}
                      {channel.onDown && channel.onRecover ? ' + ' : ''}
                      {channel.onRecover ? 'recovery' : ''}
                      {channel.hasSecret ? ' · signed' : ''}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 5 }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => void testChannel(channel)}
                      disabled={busy}
                    >
                      Test
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => void toggleChannel(channel, { enabled: !channel.enabled })}
                      disabled={busy}
                    >
                      {channel.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setDeleting(channel)}
                      disabled={busy}
                    >
                      Del
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
            <h2>Recent deliveries</h2>
            <p>Real results, including failures and skipped sends</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    No deliveries recorded yet.
                  </td>
                </tr>
              ) : null}
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td className="mono">{formatRelative(delivery.createdAt)}</td>
                  <td>{delivery.event}</td>
                  <td>
                    <span
                      className={`pill ${delivery.status === 'sent' ? 'up' : delivery.status === 'failed' ? 'down' : 'neutral'}`}
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
              <h2>Maintenance announcement</h2>
              <p>Shown on public status pages while the window is upcoming or active</p>
            </div>
          </div>
          <form className="panel-pad stack" onSubmit={createMaintenance} noValidate>
            {mError ? (
              <div className="form-error" role="alert">
                <span aria-hidden="true">⚠</span>
                <span>{mError}</span>
              </div>
            ) : null}
            <Field label="Title" htmlFor="m-title">
              <input
                id="m-title"
                className="input"
                value={mTitle}
                onChange={(event) => setMTitle(event.target.value)}
                placeholder="Database upgrade"
                maxLength={120}
              />
            </Field>
            <Field label="Details" htmlFor="m-body">
              <textarea
                id="m-body"
                className="textarea"
                value={mBody}
                onChange={(event) => setMBody(event.target.value)}
                placeholder="Brief expected impact, in public-safe wording."
                maxLength={2000}
              />
            </Field>
            <div className="grid-2">
              <Field label="Starts" htmlFor="m-start">
                <input
                  id="m-start"
                  className="input"
                  type="datetime-local"
                  value={mStart}
                  onChange={(event) => setMStart(event.target.value)}
                />
              </Field>
              <Field label="Ends" htmlFor="m-end">
                <input
                  id="m-end"
                  className="input"
                  type="datetime-local"
                  value={mEnd}
                  onChange={(event) => setMEnd(event.target.value)}
                />
              </Field>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              Publish announcement
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Announcements</h2>
              <p>{maintenance.length} recorded</p>
            </div>
          </div>
          <div className="panel-pad stack" style={{ gap: 8 }}>
            {maintenance.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                No maintenance windows yet.
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
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {deleting ? (
        <ConfirmDialog
          title="Delete this channel?"
          message="Future incidents will no longer notify this destination. Delivery history is removed too."
          confirmLabel="Delete channel"
          danger
          busy={busy}
          onConfirm={() => void deleteChannel()}
          onCancel={() => setDeleting(null)}
        />
      ) : null}

      {deletingMaintenance ? (
        <ConfirmDialog
          title="Remove this announcement?"
          message="It will disappear from public status pages immediately."
          confirmLabel="Remove"
          danger
          busy={busy}
          onConfirm={() => void deleteMaintenance()}
          onCancel={() => setDeletingMaintenance(null)}
        />
      ) : null}
    </div>
  );
}
