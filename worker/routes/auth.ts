import type { Bindings } from '../lib/types';
import {
  ApiError,
  asBoolean,
  asIntInRange,
  asString,
  clearSessionCookie,
  clientIp,
  fail,
  getCookie,
  json,
  optionalString,
  rateLimit,
  readJson,
  sessionCookie,
} from '../lib/http';
import {
  authenticate,
  createUser,
  endSession,
  planFor,
  publicUser,
  resolveSession,
  startSession,
  type AuthContext,
} from '../lib/auth';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export async function requireUser(env: Bindings, request: Request): Promise<AuthContext> {
  const token = getCookie(request, 'sp_session') ?? bearer(request);
  const context = await resolveSession(env, token);
  if (!context) {
    throw new ApiError(401, 'You need to sign in to continue.', 'unauthenticated');
  }
  return context;
}

/** Allows API clients to authenticate with a session cookie or a bearer token. */
function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return null;
  return header.slice(7).trim() || null;
}

export async function handleAuth(
  env: Bindings,
  request: Request,
  path: string
): Promise<Response> {
  if (path === '/api/auth/register' && request.method === 'POST') {
    const body = await readJson<{ email?: string; password?: string }>(request);
    const email = asString(body.email, 'Email', 254);
    const password = asString(body.password, 'Password', 200);

    // Generous enough for shared/NATed networks and test suites, still bounded.
    const limit = await rateLimit(env.DB, `register:${clientIp(request)}`, 20, 3600);
    if (!limit.allowed) {
      return fail(429, 'Too many sign-up attempts from this address. Try again later.', 'rate_limited');
    }

    const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    // The very first account becomes pro so a fresh self-hosted install can try
    // the higher limits immediately; everything after starts on the free plan.
    const user = await createUser(env, email, password);
    if ((existing?.n ?? 0) === 0) {
      await env.DB.prepare("UPDATE users SET plan = 'pro' WHERE id = ?").bind(user.id).run();
      user.plan = 'pro';
    }
    const session = await startSession(env, user.id, request.headers.get('user-agent'));
    return json(
      { user: publicUser(user) },
      { status: 201, headers: { 'set-cookie': sessionCookie(session.token, SESSION_TTL_SECONDS) } }
    );
  }

  if (path === '/api/auth/login' && request.method === 'POST') {
    const body = await readJson<{ email?: string; password?: string }>(request);
    const email = asString(body.email, 'Email', 254);
    const password = typeof body.password === 'string' ? body.password : '';

    // Two limits: per-IP burst protection and per-account brute-force protection.
    const ipLimit = await rateLimit(env.DB, `login-ip:${clientIp(request)}`, 40, 600);
    if (!ipLimit.allowed) {
      return fail(429, 'Too many sign-in attempts. Please wait a few minutes.', 'rate_limited');
    }
    const accountLimit = await rateLimit(env.DB, `login-acct:${email.toLowerCase()}`, 10, 600);
    if (!accountLimit.allowed) {
      return fail(429, 'Too many sign-in attempts for this account.', 'rate_limited');
    }

    const user = await authenticate(env, email, password);
    const session = await startSession(env, user.id, request.headers.get('user-agent'));
    return json(
      { user: publicUser(user) },
      { headers: { 'set-cookie': sessionCookie(session.token, SESSION_TTL_SECONDS) } }
    );
  }

  if (path === '/api/auth/logout' && request.method === 'POST') {
    const token = getCookie(request, 'sp_session') ?? bearer(request);
    if (token) await endSession(env, token);
    return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
  }

  if (path === '/api/auth/me' && request.method === 'GET') {
    const { user } = await requireUser(env, request);
    const counts = await env.DB.prepare(
      'SELECT COUNT(*) AS monitors FROM monitors WHERE user_id = ?'
    )
      .bind(user.id)
      .first<{ monitors: number }>();
    return json({
      user: publicUser(user),
      usage: { monitors: counts?.monitors ?? 0, maxMonitors: planFor(user).maxMonitors },
    });
  }

  throw new ApiError(404, 'Unknown auth endpoint.', 'not_found');
}
