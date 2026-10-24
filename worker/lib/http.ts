/** Small HTTP helper layer: JSON responses, cookies, rate limits, validation. */

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('cache-control', headers.get('cache-control') ?? 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function fail(status: number, message: string, code = 'error'): Response {
  return json({ error: { message, code } }, { status });
}

export async function readJson<T>(request: Request, limitBytes = 64 * 1024): Promise<T> {
  const text = await request.text();
  if (text.length > limitBytes) {
    throw new ApiError(413, 'Request body is too large.', 'payload_too_large');
  }
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON.', 'invalid_json');
  }
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `sp_session=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function clearSessionCookie(): string {
  return 'sp_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
};

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Fixed-window rate limiter backed by D1.
 *
 * Uses an atomic UPSERT so two concurrent requests cannot both slip through the
 * same window. Windows are per (bucket key + window start), and the row is
 * reused/rewritten once the window rolls over.
 */
export async function rateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
  nowMs = Date.now()
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const windowStart = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  try {
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (bucket_key, window_start, hits) VALUES (?, ?, 1)
         ON CONFLICT(bucket_key) DO UPDATE SET
           hits = CASE WHEN rate_limits.window_start = excluded.window_start
                       THEN rate_limits.hits + 1 ELSE 1 END,
           window_start = excluded.window_start
         RETURNING hits, window_start`
      )
      .bind(key, windowStart)
      .first<{ hits: number; window_start: number }>();
    const hits = row?.hits ?? 1;
    return {
      allowed: hits <= limit,
      remaining: Math.max(0, limit - hits),
      retryAfter: Math.max(1, windowStart + windowSeconds - Math.floor(nowMs / 1000)),
    };
  } catch {
    // A rate-limit table hiccup must not take the whole API down; fail open but
    // do not cache the failure.
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

export function asString(value: unknown, field: string, maxLength = 2048): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, `${field} is required.`, 'validation');
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ApiError(400, `${field} is too long (max ${maxLength} characters).`, 'validation');
  }
  return trimmed;
}

export function optionalString(value: unknown, field: string, maxLength = 2048): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, field, maxLength);
}

export function asIntInRange(
  value: unknown,
  field: string,
  min: number,
  max: number
): number {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num)) {
    throw new ApiError(400, `${field} must be an integer.`, 'validation');
  }
  if (num < min || num > max) {
    throw new ApiError(400, `${field} must be between ${min} and ${max}.`, 'validation');
  }
  return num;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}
