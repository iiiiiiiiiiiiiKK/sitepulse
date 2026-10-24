import type { Bindings, IncidentRow, MonitorRow, NotificationRow } from './types';
import { decryptSecret, hmacSha256Hex, maskSecret, randomHex } from './crypto';
import { ERROR_LABELS } from './probe';
import { incidentDurationSeconds } from './monitor-state';

/**
 * Notification dispatch.
 *
 * Design notes
 * ------------
 * - Each (notification, incident, event) tuple is unique in `deliveries`, so a
 *   cron retry, an overlapping cron run or a KV/DB replay can never send the
 *   same alert twice.
 * - Webhook bodies are signed with HMAC-SHA256 over the exact body and sent in
 *   `X-SitePulse-Signature`, so receivers can verify authenticity.
 * - Secrets are AES-GCM encrypted at rest and are never written to logs, to the
 *   API response (only a mask is returned) or to the public status page.
 * - If the email provider is not configured the delivery is recorded as
 *   `skipped` with a reason instead of pretending it was sent.
 */

export type NotifyEvent = 'down' | 'recover' | 'test';

export interface DeliveryOutcome {
  notificationId: string;
  kind: 'webhook' | 'email';
  status: 'sent' | 'failed' | 'skipped' | 'duplicate';
  detail: string;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function buildWebhookPayload(input: {
  event: NotifyEvent;
  monitor: MonitorRow;
  incident?: IncidentRow | null;
  origin: string;
  nowMs?: number;
}) {
  const { event, monitor, incident, origin } = input;
  const now = input.nowMs ?? Date.now();
  return {
    event,
    sentAt: new Date(now).toISOString(),
    service: { id: monitor.id, name: monitor.name, url: monitor.url },
    statusPage: monitor.is_public === 1 ? `${origin}/status/${monitor.public_slug}` : null,
    monitorStatus: monitor.status,
    lastCheckAt: monitor.last_check_at ? new Date(monitor.last_check_at).toISOString() : null,
    lastStatusCode: monitor.last_status_code,
    lastResponseMs: monitor.last_response_ms,
    consecutiveFailures: monitor.consecutive_failures,
    error: monitor.last_error
      ? {
          kind: monitor.last_error_kind,
          label: monitor.last_error_kind
            ? ERROR_LABELS[monitor.last_error_kind as keyof typeof ERROR_LABELS]
            : 'Error',
          message: monitor.last_error,
        }
      : null,
    incident: incident
      ? {
          id: incident.id,
          startedAt: new Date(incident.started_at).toISOString(),
          resolvedAt: incident.resolved_at ? new Date(incident.resolved_at).toISOString() : null,
          durationSeconds: incidentDurationSeconds(incident, now),
          durationHuman: formatDuration(incidentDurationSeconds(incident, now)),
          cause: incident.cause,
          summary: incident.summary,
        }
      : null,
  };
}

function buildEmailBody(input: {
  event: NotifyEvent;
  monitor: MonitorRow;
  incident?: IncidentRow | null;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { event, monitor, incident, origin } = input;
  const monitorUrl = `${origin}/app/monitors/${monitor.id}`;
  const duration = incident ? formatDuration(incidentDurationSeconds(incident, Date.now())) : null;

  const subject =
    event === 'down'
      ? `[SitePulse] ${monitor.name} is DOWN`
      : event === 'recover'
        ? `[SitePulse] ${monitor.name} recovered${duration ? ` after ${duration}` : ''}`
        : `[SitePulse] Test notification for ${monitor.name}`;

  const headline =
    event === 'down'
      ? `<strong>${escapeHtml(monitor.name)}</strong> is not responding as expected.`
      : event === 'recover'
        ? `<strong>${escapeHtml(monitor.name)}</strong> is back online.`
        : `This is a test notification for <strong>${escapeHtml(monitor.name)}</strong>.`;

  const rows: Array<[string, string]> = [
    ['URL', monitor.url],
    ['Status', monitor.status],
    ['HTTP status', monitor.last_status_code ? String(monitor.last_status_code) : '—'],
    ['Response time', monitor.last_response_ms !== null ? `${monitor.last_response_ms} ms` : '—'],
    ['Consecutive failures', String(monitor.consecutive_failures)],
    ['Error', monitor.last_error ?? '—'],
  ];
  if (incident) {
    rows.push(['Incident started', new Date(incident.started_at).toUTCString()]);
    if (incident.resolved_at) rows.push(['Resolved', new Date(incident.resolved_at).toUTCString()]);
    if (duration) rows.push(['Duration', duration]);
  }

  const html = `<!doctype html><html><body style="margin:0;background:#0b0f14;padding:24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e6edf3">
  <div style="max-width:560px;margin:0 auto;background:#111821;border:1px solid #1f2a37;border-radius:14px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #1f2a37">
      <div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#7d8da1">SitePulse</div>
      <h1 style="margin:8px 0 0;font-size:19px;line-height:1.4">${headline}</h1>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${rows
        .map(
          ([key, value]) =>
            `<tr><td style="padding:10px 24px;color:#7d8da1;width:44%">${escapeHtml(key)}</td><td style="padding:10px 24px;word-break:break-word">${escapeHtml(value)}</td></tr>`
        )
        .join('')}
    </table>
    <div style="padding:18px 24px;border-top:1px solid #1f2a37">
      <a href="${escapeHtml(monitorUrl)}" style="display:inline-block;background:#2f81f7;color:#fff;text-decoration:none;padding:10px 16px;border-radius:9px;font-size:14px">Open monitor dashboard</a>
    </div>
  </div>
  <p style="max-width:560px;margin:16px auto 0;color:#5d6b7d;font-size:12px">You receive this because a notification channel is enabled for this monitor. Manage channels in SitePulse settings.</p>
</body></html>`;

  const text = [
    headline.replace(/<[^>]+>/g, ''),
    ...rows.map(([key, value]) => `${key}: ${value}`),
    `Dashboard: ${monitorUrl}`,
  ].join('\n');

  return { subject, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function recordDelivery(
  env: Bindings,
  notificationId: string,
  incidentId: string | null,
  event: NotifyEvent,
  status: 'sent' | 'failed' | 'skipped',
  detail: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO deliveries (id, notification_id, incident_id, event, status, detail, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(notification_id, incident_id, event) DO NOTHING`
  )
    .bind(`dlv_${randomHex(8)}`, notificationId, incidentId, event, status, detail.slice(0, 500), Date.now())
    .run();
  // `changes === 0` means a delivery row already existed -> duplicate suppressed.
  return (result.meta?.changes ?? 0) > 0;
}

async function alreadyDelivered(
  env: Bindings,
  notificationId: string,
  incidentId: string | null,
  event: NotifyEvent
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM deliveries WHERE notification_id = ? AND incident_id IS ? AND event = ? AND status IN ('sent','skipped')`
  )
    .bind(notificationId, incidentId, event)
    .first<{ id: string }>();
  return Boolean(row);
}

/** Sends one webhook, with one retry on network/5xx failures. */
async function sendWebhook(
  env: Bindings,
  notification: NotificationRow,
  payload: unknown
): Promise<{ status: 'sent' | 'failed' | 'skipped'; detail: string }> {
  const body = JSON.stringify(payload);
  let secret = '';
  if (notification.secret_enc) {
    if (!env.ENCRYPTION_KEY) {
      return {
        status: 'skipped',
        detail: 'Webhook signing secret is stored encrypted but ENCRYPTION_KEY is not configured.',
      };
    }
    try {
      secret = await decryptSecret(notification.secret_enc, env.ENCRYPTION_KEY);
    } catch {
      return { status: 'failed', detail: 'Stored webhook secret could not be decrypted.' };
    }
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'SitePulse-Webhook/1.0',
    'x-sitepulse-event': String((payload as { event?: string }).event ?? 'unknown'),
  };
  if (secret) headers['x-sitepulse-signature'] = await hmacSha256Hex(secret, body);

  let lastDetail = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(notification.target, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(8000),
        // Webhook receivers are user-supplied URLs, so redirects are not followed
        // (prevents using our sender as an SSRF relay).
        redirect: 'manual',
      });
      if (response.status >= 200 && response.status < 300) {
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        return { status: 'sent', detail: `HTTP ${response.status} on attempt ${attempt}` };
      }
      lastDetail = `HTTP ${response.status} on attempt ${attempt}`;
      if (response.status < 500) break; // 4xx will not improve by retrying
    } catch (error) {
      lastDetail = `${error instanceof Error ? error.message : 'network error'} (attempt ${attempt})`;
    }
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { status: 'failed', detail: lastDetail || 'Webhook delivery failed.' };
}

/** Sends one email through the configured HTTP provider (Resend-compatible). */
async function sendEmail(
  env: Bindings,
  notification: NotificationRow,
  content: { subject: string; html: string; text: string }
): Promise<{ status: 'sent' | 'failed' | 'skipped'; detail: string }> {
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) {
    return {
      status: 'skipped',
      detail: 'Email provider is not configured (EMAIL_API_KEY / EMAIL_FROM missing).',
    };
  }
  const endpoint = env.EMAIL_API_URL ?? 'https://api.resend.com/emails';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.EMAIL_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [notification.target],
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (response.status >= 200 && response.status < 300) {
      await response.body?.cancel();
      return { status: 'sent', detail: `HTTP ${response.status}` };
    }
    const text = await response.text();
    return { status: 'failed', detail: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : 'Email delivery failed.',
    };
  }
}

/** Loads every enabled channel that applies to a monitor. */
export async function channelsForMonitor(
  env: Bindings,
  monitor: MonitorRow,
  event: NotifyEvent
): Promise<NotificationRow[]> {
  const column = event === 'down' ? 'on_down' : event === 'recover' ? 'on_recover' : 'on_down';
  const { results } = await env.DB.prepare(
    `SELECT * FROM notifications
     WHERE user_id = ? AND enabled = 1 AND (monitor_id IS NULL OR monitor_id = ?)
       AND ${column} = 1`
  )
    .bind(monitor.user_id, monitor.id)
    .all<NotificationRow>();
  return results ?? [];
}

/**
 * Dispatches an alert to every matching channel for one monitor + event.
 * Deduplication is guaranteed by the unique `deliveries` row.
 */
export async function dispatchEvent(
  env: Bindings,
  input: {
    event: NotifyEvent;
    monitor: MonitorRow;
    incident?: IncidentRow | null;
    origin: string;
  }
): Promise<DeliveryOutcome[]> {
  const channels = await channelsForMonitor(env, input.monitor, input.event);
  const outcomes: DeliveryOutcome[] = [];
  const incidentId = input.incident?.id ?? null;

  for (const channel of channels) {
    if (await alreadyDelivered(env, channel.id, incidentId, input.event)) {
      outcomes.push({
        notificationId: channel.id,
        kind: channel.kind,
        status: 'duplicate',
        detail: 'Already delivered for this event.',
      });
      continue;
    }

    let result: { status: 'sent' | 'failed' | 'skipped'; detail: string };
    if (channel.kind === 'webhook') {
      const payload = buildWebhookPayload(input);
      result = await sendWebhook(env, channel, payload);
    } else {
      const content = buildEmailBody(input);
      result = await sendEmail(env, channel, content);
    }

    const inserted = await recordDelivery(
      env,
      channel.id,
      incidentId,
      input.event,
      result.status,
      result.detail
    );
    outcomes.push({
      notificationId: channel.id,
      kind: channel.kind,
      status: inserted ? result.status : 'duplicate',
      detail: result.detail,
    });

    if (input.incident) {
      const column = input.event === 'down' ? 'notified_start' : 'notified_resolve';
      if (result.status === 'sent') {
        await env.DB.prepare(`UPDATE incidents SET ${column} = 1 WHERE id = ?`)
          .bind(input.incident.id)
          .run();
      }
    }
  }
  return outcomes;
}

export function describeChannel(channel: NotificationRow) {
  return {
    id: channel.id,
    kind: channel.kind,
    target: channel.kind === 'webhook' ? channel.target : maskEmail(channel.target),
    monitorId: channel.monitor_id,
    enabled: channel.enabled === 1,
    onDown: channel.on_down === 1,
    onRecover: channel.on_recover === 1,
    hasSecret: Boolean(channel.secret_enc),
    secretMask: channel.secret_enc ? maskSecret('whsec_••••••••') : null,
    createdAt: channel.created_at,
  };
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return '••••';
  const head = name.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(2, name.length - 2))}@${domain}`;
}
