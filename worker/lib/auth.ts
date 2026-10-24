import type { Bindings, UserRow } from './types';
import { ApiError } from './http';
import { hashPassword, passwordProblem, randomHex, sha256Hex, verifyPassword } from './crypto';

/** Plan limits. Enforced server-side on every write path. */
export interface PlanLimits {
  id: 'free' | 'pro';
  maxMonitors: number;
  minIntervalSeconds: number;
  retentionDays: number;
  checksPerDay: number;
}

export const PLANS: Record<'free' | 'pro', PlanLimits> = {
  free: {
    id: 'free',
    maxMonitors: 10,
    minIntervalSeconds: 60,
    retentionDays: 30,
    checksPerDay: 3_000,
  },
  pro: {
    id: 'pro',
    maxMonitors: 50,
    minIntervalSeconds: 60,
    retentionDays: 90,
    checksPerDay: 20_000,
  },
};

export function planFor(user: Pick<UserRow, 'plan'> | null): PlanLimits {
  return user?.plan === 'pro' ? PLANS.pro : PLANS.free;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export interface AuthContext {
  user: UserRow;
  sessionId: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailProblem(email: string): string | null {
  if (!email) return 'Email is required.';
  if (email.length > 254) return 'Email is too long.';
  // Deliberately strict but simple: one @, a dot in the domain, no whitespace.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return 'Enter a valid email address.';
  return null;
}

export async function createUser(
  env: Bindings,
  email: string,
  password: string
): Promise<UserRow> {
  const normalised = normalizeEmail(email);
  const problem = emailProblem(normalised);
  if (problem) throw new ApiError(400, problem, 'validation');
  const pwProblem = passwordProblem(password);
  if (pwProblem) throw new ApiError(400, pwProblem, 'validation');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email_norm = ?')
    .bind(normalised)
    .first<{ id: string }>();
  if (existing) {
    throw new ApiError(409, 'An account with that email already exists.', 'email_taken');
  }

  const pw = await hashPassword(password, env.AUTH_PEPPER ?? '');
  const id = `usr_${randomHex(8)}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_norm, password_hash, password_salt, password_iters, plan, email_verified, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'free', 0, ?)`
  )
    .bind(id, email.trim(), normalised, pw.hash, pw.salt, pw.iterations, now)
    .run();

  const created = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(id)
    .first<UserRow>();
  if (!created) throw new ApiError(500, 'Account creation failed.', 'internal');
  return created;
}

export async function authenticate(
  env: Bindings,
  email: string,
  password: string
): Promise<UserRow> {
  const normalised = normalizeEmail(email);
  const user = await env.DB.prepare('SELECT * FROM users WHERE email_norm = ?')
    .bind(normalised)
    .first<UserRow>();
  if (!user) {
    // Burn comparable time so a missing account is not obviously faster.
    await hashPassword(password || 'x', env.AUTH_PEPPER ?? '');
    throw new ApiError(401, 'Invalid email or password.', 'invalid_credentials');
  }
  const ok = await verifyPassword(
    password ?? '',
    { hash: user.password_hash, salt: user.password_salt, iterations: user.password_iters },
    env.AUTH_PEPPER ?? ''
  );
  if (!ok) throw new ApiError(401, 'Invalid email or password.', 'invalid_credentials');
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(Date.now(), user.id)
    .run();
  return user;
}

/** Creates a session and returns the RAW token (only the hash is stored). */
export async function startSession(
  env: Bindings,
  userId: string,
  userAgent: string | null
): Promise<{ token: string; expiresAt: number }> {
  const token = randomHex(32);
  const id = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, userId, now, expiresAt, userAgent?.slice(0, 200) ?? null)
    .run();
  return { token, expiresAt };
}

export async function endSession(env: Bindings, token: string): Promise<void> {
  const id = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

export async function resolveSession(
  env: Bindings,
  token: string | null,
  nowMs = Date.now()
): Promise<AuthContext | null> {
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`
  )
    .bind(id, nowMs)
    .first<UserRow>();
  if (!row) return null;
  return { user: row, sessionId: id };
}

export function publicUser(user: UserRow) {
  const plan = planFor(user);
  return {
    id: user.id,
    email: user.email,
    plan: plan.id,
    createdAt: user.created_at,
    emailVerified: user.email_verified === 1,
    limits: {
      maxMonitors: plan.maxMonitors,
      minIntervalSeconds: plan.minIntervalSeconds,
      retentionDays: plan.retentionDays,
    },
  };
}
