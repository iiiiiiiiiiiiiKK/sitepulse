/**
 * Crypto helpers: password hashing (PBKDF2-SHA256) and AES-GCM envelope
 * encryption for notification secrets.
 *
 * Everything here relies on WebCrypto, which is available in Workers and in
 * Node >= 20 (used by the test suite), so the same code runs in both.
 */

/**
 * PBKDF2 iteration count.
 *
 * 100_000 is the maximum Cloudflare Workers accepts for WebCrypto PBKDF2
 * (`deriveBits` throws above it), and it is the value we store per user row so
 * future deployments can raise it without invalidating existing passwords.
 */
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  pepper: string
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password + pepper),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    KEY_LENGTH_BITS
  );
  return new Uint8Array(bits);
}

export interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

export async function hashPassword(password: string, pepper = ''): Promise<PasswordHash> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const derived = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS, pepper);
  return {
    hash: toBase64(derived),
    salt: toBase64(salt),
    iterations: PBKDF2_ITERATIONS,
  };
}

/** Constant-time comparison to avoid leaking hash prefixes through timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  stored: PasswordHash,
  pepper = ''
): Promise<boolean> {
  const derived = await derivePasswordKey(
    password,
    fromBase64(stored.salt),
    stored.iterations,
    pepper
  );
  return timingSafeEqual(toBase64(derived), stored.hash);
}

/** Rejects the most common weak-password shapes before any hashing happens. */
export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < 10) return 'Password must be at least 10 characters long.';
  if (password.length > 200) return 'Password must be at most 200 characters long.';
  const lower = password.toLowerCase();
  const banned = ['password', '12345678', 'qwerty', 'letmein', 'iloveyou', 'admin123'];
  if (banned.some((word) => lower.includes(word))) {
    return 'Password contains a very common weak pattern. Please choose another one.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// AES-GCM envelope for notification secrets
// ---------------------------------------------------------------------------

async function importAesKey(secret: string): Promise<CryptoKey> {
  const raw = fromBase64(secret);
  if (raw.byteLength !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 base64-encoded bytes (use `openssl rand -base64 32`).');
  }
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const key = await importAesKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    encoder.encode(plaintext)
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(envelope: string, secret: string): Promise<string> {
  const parts = envelope.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Malformed secret envelope.');
  const key = await importAesKey(secret);
  const iv = fromBase64(parts[1]);
  const data = fromBase64(parts[2]);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    data as unknown as BufferSource
  );
  return new TextDecoder().decode(plaintext);
}

/** Best-effort mask so the API can show "whsec_…9f2a" without leaking the value. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/** HMAC-SHA256 signature header for outgoing webhook payloads. */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
