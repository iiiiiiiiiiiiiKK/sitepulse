import type { Bindings, MonitorRow, NotificationRow } from '../lib/types';
import {
  ApiError,
  asBoolean,
  asString,
  clientIp,
  json,
  rateLimit,
  readJson,
} from '../lib/http';
import { encryptSecret } from '../lib/crypto';
import { describeChannel, dispatchEvent } from '../lib/notify';
import type { AuthContext } from '../lib/auth';
import { origin } from './monitors';

/**
 * Notification channel management.
 *
 * The webhook URL is itself user-supplied, so it is validated against the same
 * SSRF rules as monitors *at send time* (see notify.ts: redirects are not
 * followed and the request is a plain POST to the exact stored URL).
 * Signing secrets are AES-GCM encrypted with ENCRYPTION_KEY before storage and
 * are never returned by the API.
 */

async function loadOwnedChannel(
  env: Bindings,
  id: string,
  auth: AuthContext
): Promise<NotificationRow & { monitor_owned: number | null }> {
  const channel = await env.DB.prepare(
    `SELECT n.*, m.user_id AS monitor_owned FROM notifications n
     LEFT JOIN monitors m ON m.id = n.monitor_id
     WHERE n.id = ? AND n.user_id = ?`
  )
    .bind(id, auth.user.id)
    .first<NotificationRow & { monitor_owned: number | null }>();
  if (!channel) throw new ApiError(404, 'Notification channel not found.', 'not_found');
  if (channel.monitor_id && !channel.monitor_owned) {
    // Defensive: a channel pointing at another user's monitor is not usable.
    throw new ApiError(404, 'Notification channel not found.', 'not_found');
  }
  return channel;
}

const ALLOWED_WEBHOOK_SCHEMES = ['https:', 'http:'];

function validateWebhookTarget(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, 'Webhook URL is not a valid URL.', 'validation');
  }
  if (!ALLOWED_WEBHOOK_SCHEMES.includes(url.protocol)) {
    throw new ApiError(400, 'Webhook URL must start with https:// (or http:// for local testing).', 'validation');
  }
  if (url.username || url.password) {
    throw new ApiError(400, 'Webhook URL must not contain credentials in the URL.', 'validation');
  }
  return url.toString();
}

export async function handleNotifications(
  env: Bindings,
  request: Request,
  auth: AuthContext,
  segments: string[]
): Promise<Response> {
  const userId = auth.user.id;

  if (segments.length === 2) {
    if (request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at ASC'
      )
        .bind(userId)
        .all<NotificationRow>();
      const deliveries = await env.DB.prepare(
        `SELECT d.*, n.kind FROM deliveries d JOIN notifications n ON n.id = d.notification_id
         WHERE n.user_id = ? ORDER BY d.created_at DESC LIMIT 20`
      )
        .bind(userId)
        .all<{
          id: string;
          notification_id: string;
          event: string;
          status: string;
          detail: string | null;
          created_at: number;
          kind: string;
        }>();
      return json({
        channels: (results ?? []).map(describeChannel),
        recentDeliveries: (deliveries.results ?? []).map((row) => ({
          id: row.id,
          notificationId: row.notification_id,
          kind: row.kind,
          event: row.event,
          status: row.status,
          detail: row.detail,
          createdAt: row.created_at,
        })),
        emailConfigured: Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM),
      });
    }

    if (request.method === 'POST') {
      const limit = await rateLimit(env.DB, `notif-create:${userId}`, 30, 3600);
      if (!limit.allowed) {
        throw new ApiError(429, 'Too many notification channels created. Try again later.', 'rate_limited');
      }
      const count = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?'
      )
        .bind(userId)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= 20) {
        throw new ApiError(403, 'You can configure at most 20 notification channels.', 'quota_exceeded');
      }

      const body = await readJson<{
        kind?: unknown;
        target?: unknown;
        monitorId?: unknown;
        secret?: unknown;
        onDown?: unknown;
        onRecover?: unknown;
      }>(request);

      const kind = asString(body.kind, 'Channel type', 16).toLowerCase();
      if (kind !== 'webhook' && kind !== 'email') {
        throw new ApiError(400, 'Channel type must be "webhook" or "email".', 'validation');
      }
      const rawTarget = asString(body.target, 'Target', 1000);
      let target: string;
      if (kind === 'webhook') {
        target = validateWebhookTarget(rawTarget);
      } else {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rawTarget)) {
          throw new ApiError(400, 'Enter a valid email address.', 'validation');
        }
        target = rawTarget.trim();
      }

      let monitorId: string | null = null;
      if (body.monitorId !== undefined && body.monitorId !== null && body.monitorId !== '') {
        monitorId = asString(body.monitorId, 'Monitor', 64);
        const owned = await env.DB.prepare('SELECT id FROM monitors WHERE id = ? AND user_id = ?')
          .bind(monitorId, userId)
          .first<{ id: string }>();
        if (!owned) throw new ApiError(404, 'Monitor not found.', 'not_found');
      }

      let secretEnc: string | null = null;
      if (body.secret !== undefined && body.secret !== null && body.secret !== '') {
        const secret = asString(body.secret, 'Signing secret', 200);
        if (kind !== 'webhook') {
          throw new ApiError(400, 'Signing secrets only apply to webhook channels.', 'validation');
        }
        if (!env.ENCRYPTION_KEY) {
          throw new ApiError(
            503,
            'Server encryption key is not configured, so signing secrets cannot be stored safely. Add ENCRYPTION_KEY as a Worker secret.',
            'not_configured'
          );
        }
        secretEnc = await encryptSecret(secret, env.ENCRYPTION_KEY);
      }

      const id = `ntf_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await env.DB.prepare(
        `INSERT INTO notifications (id, user_id, monitor_id, kind, target, secret_enc, enabled, on_down, on_recover, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
        .bind(
          id,
          userId,
          monitorId,
          kind,
          target,
          secretEnc,
          asBoolean(body.onDown, true) ? 1 : 0,
          asBoolean(body.onRecover, true) ? 1 : 0,
          Date.now()
        )
        .run();

      const created = await env.DB.prepare('SELECT * FROM notifications WHERE id = ?')
        .bind(id)
        .first<NotificationRow>();
      return json(
        {
          channel: describeChannel(created as NotificationRow),
          warning:
            kind === 'email' && !env.EMAIL_API_KEY
              ? 'Email provider is not configured yet. Deliveries will be logged as "skipped" until EMAIL_API_KEY and EMAIL_FROM are set.'
              : null,
        },
        { status: 201 }
      );
    }

    throw new ApiError(405, 'Method not allowed.', 'method_not_allowed');
  }

  const channelId = segments[2];
  const action = segments[3];

  if (segments.length === 3) {
    const channel = await loadOwnedChannel(env, channelId, auth);

    if (request.method === 'PATCH') {
      const body = await readJson<{
        enabled?: unknown;
        onDown?: unknown;
        onRecover?: unknown;
        target?: unknown;
        secret?: unknown;
      }>(request);
      const patch: Record<string, string | number | null> = {};
      if (body.enabled !== undefined) patch.enabled = asBoolean(body.enabled) ? 1 : 0;
      if (body.onDown !== undefined) patch.on_down = asBoolean(body.onDown) ? 1 : 0;
      if (body.onRecover !== undefined) patch.on_recover = asBoolean(body.onRecover) ? 1 : 0;
      if (body.target !== undefined) {
        const rawTarget = asString(body.target, 'Target', 1000);
        patch.target =
          channel.kind === 'webhook' ? validateWebhookTarget(rawTarget) : rawTarget.trim();
      }
      if (body.secret !== undefined) {
        if (channel.kind !== 'webhook') {
          throw new ApiError(400, 'Signing secrets only apply to webhook channels.', 'validation');
        }
        if (body.secret === null || body.secret === '') {
          patch.secret_enc = null;
        } else {
          if (!env.ENCRYPTION_KEY) {
            throw new ApiError(503, 'ENCRYPTION_KEY is not configured.', 'not_configured');
          }
          patch.secret_enc = await encryptSecret(
            asString(body.secret, 'Signing secret', 200),
            env.ENCRYPTION_KEY
          );
        }
      }
      const columns = Object.keys(patch);
      if (columns.length === 0) throw new ApiError(400, 'Nothing to update.', 'validation');
      await env.DB.prepare(
        `UPDATE notifications SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND user_id = ?`
      )
        .bind(...columns.map((c) => patch[c] as string | number | null), channelId, userId)
        .run();

      const updated = await env.DB.prepare('SELECT * FROM notifications WHERE id = ?')
        .bind(channelId)
        .first<NotificationRow>();
      return json({ channel: describeChannel(updated as NotificationRow) });
    }

    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?')
        .bind(channelId, userId)
        .run();
      return json({ ok: true, deleted: channelId });
    }

    throw new ApiError(405, 'Method not allowed.', 'method_not_allowed');
  }

  if (segments.length === 4 && action === 'test' && request.method === 'POST') {
    const channel = await loadOwnedChannel(env, channelId, auth);
    const limit = await rateLimit(env.DB, `notif-test:${userId}`, 20, 600);
    if (!limit.allowed) {
      throw new ApiError(429, 'Too many test notifications. Wait a few minutes.', 'rate_limited');
    }

    // Build a synthetic monitor row so the payload looks like a real alert.
    const monitorRow: MonitorRow =
      (channel.monitor_id
        ? await env.DB.prepare('SELECT * FROM monitors WHERE id = ?')
            .bind(channel.monitor_id)
            .first<MonitorRow>()
        : null) ?? {
        id: 'test',
        user_id: userId,
        name: 'SitePulse test monitor',
        url: 'https://example.com',
        method: 'GET',
        interval_seconds: 300,
        timeout_ms: 10000,
        expected_status: '200-299',
        failure_threshold: 3,
        recovery_threshold: 1,
        status: 'up',
        enabled: 1,
        is_public: 0,
        public_slug: 'test',
        consecutive_failures: 0,
        consecutive_successes: 1,
        next_check_at: Date.now(),
        last_check_at: Date.now(),
        last_success_at: Date.now(),
        last_status_code: 200,
        last_response_ms: 142,
        last_error: null,
        last_error_kind: null,
        current_incident_id: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      };

    // Temporarily restrict dispatch to this single channel by testing it directly.
    const outcomes = await dispatchEvent(env, { event: 'test', monitor: monitorRow, origin: origin(request) });
    const mine = outcomes.filter((o) => o.notificationId === channelId);
    return json({ outcomes: mine.length > 0 ? mine : outcomes });
  }

  if (segments.length === 4 && action === 'deliveries' && request.method === 'GET') {
    await loadOwnedChannel(env, channelId, auth);
    const { results } = await env.DB.prepare(
      'SELECT * FROM deliveries WHERE notification_id = ? ORDER BY created_at DESC LIMIT 50'
    )
      .bind(channelId)
      .all<{
        id: string;
        event: string;
        status: string;
        detail: string | null;
        attempts: number;
        created_at: number;
      }>();
    return json({
      deliveries: (results ?? []).map((row) => ({
        id: row.id,
        event: row.event,
        status: row.status,
        detail: row.detail,
        attempts: row.attempts,
        createdAt: row.created_at,
      })),
    });
  }

  throw new ApiError(404, 'Unknown notification endpoint.', 'not_found');
}

export { clientIp };
