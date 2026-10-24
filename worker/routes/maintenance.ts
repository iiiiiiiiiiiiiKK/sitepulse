import type { Bindings } from '../lib/types';
import { ApiError, asString, json, readJson } from '../lib/http';
import type { AuthContext } from '../lib/auth';

/**
 * Maintenance announcements shown on public status pages.
 * Owner-scoped: a user can only see and edit their own announcements.
 */
export async function handleMaintenance(
  env: Bindings,
  request: Request,
  auth: AuthContext,
  segments: string[]
): Promise<Response> {
  const userId = auth.user.id;

  if (segments.length === 2 && request.method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM maintenance_windows WHERE user_id = ? ORDER BY starts_at DESC LIMIT 50'
    )
      .bind(userId)
      .all<{
        id: string;
        title: string;
        body: string;
        starts_at: number;
        ends_at: number;
        created_at: number;
      }>();
    return json({
      maintenance: (results ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        createdAt: row.created_at,
      })),
    });
  }

  if (segments.length === 2 && request.method === 'POST') {
    const body = await readJson<{
      title?: unknown;
      body?: unknown;
      startsAt?: unknown;
      endsAt?: unknown;
    }>(request);
    const title = asString(body.title, 'Title', 120);
    const text = typeof body.body === 'string' ? body.body.slice(0, 2000) : '';
    const startsAt = Number(body.startsAt);
    const endsAt = Number(body.endsAt);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
      throw new ApiError(400, 'startsAt and endsAt must be epoch milliseconds.', 'validation');
    }
    if (endsAt <= startsAt) {
      throw new ApiError(400, 'The maintenance window must end after it starts.', 'validation');
    }
    if (endsAt - startsAt > 90 * 86400000) {
      throw new ApiError(400, 'Maintenance windows are limited to 90 days.', 'validation');
    }
    const id = `mnt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await env.DB.prepare(
      'INSERT INTO maintenance_windows (id, user_id, title, body, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, userId, title, text, startsAt, endsAt, Date.now())
      .run();
    return json(
      { maintenance: { id, title, body: text, startsAt, endsAt } },
      { status: 201 }
    );
  }

  if (segments.length === 3 && request.method === 'DELETE') {
    const id = segments[2];
    const result = await env.DB.prepare(
      'DELETE FROM maintenance_windows WHERE id = ? AND user_id = ?'
    )
      .bind(id, userId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      throw new ApiError(404, 'Maintenance window not found.', 'not_found');
    }
    return json({ ok: true, deleted: id });
  }

  throw new ApiError(404, 'Unknown maintenance endpoint.', 'not_found');
}
