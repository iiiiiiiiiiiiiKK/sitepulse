import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hmacSha256Hex,
  maskSecret,
  passwordProblem,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
} from '../worker/lib/crypto';

/** Deterministic 32-byte base64 key for tests only. */
const TEST_KEY = 'a'.repeat(43) + '=';

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored.hash).not.toContain('correct horse battery');
    expect(stored.iterations).toBeGreaterThanOrEqual(100_000);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('wrong horse battery', stored)).toBe(false);
  });

  it('produces a different hash for the same password (unique salt)', async () => {
    const a = await hashPassword('same-password-value');
    const b = await hashPassword('same-password-value');
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });

  it('mixes in the pepper', async () => {
    const stored = await hashPassword('peppered-password', 'pepper-1');
    expect(await verifyPassword('peppered-password', stored, 'pepper-1')).toBe(true);
    expect(await verifyPassword('peppered-password', stored, 'pepper-2')).toBe(false);
  });
});

describe('passwordProblem', () => {
  it('rejects short passwords', () => {
    expect(passwordProblem('short')).toBeTruthy();
  });

  it('rejects common patterns', () => {
    expect(passwordProblem('my-password-123')).toBeTruthy();
    expect(passwordProblem('qwertyuiop12')).toBeTruthy();
  });

  it('accepts a reasonable password', () => {
    expect(passwordProblem('Tr0ub4dor&3xample')).toBeNull();
  });

  it('rejects absurdly long input', () => {
    expect(passwordProblem('a'.repeat(201))).toBeTruthy();
  });
});

describe('timingSafeEqual', () => {
  it('compares equal strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('detects a difference', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
  });

  it('detects a length difference', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('secret encryption', () => {
  it('round-trips a webhook secret', async () => {
    const envelope = await encryptSecret('whsec_super_secret_value', TEST_KEY);
    expect(envelope.startsWith('v1.')).toBe(true);
    expect(envelope).not.toContain('whsec_super_secret_value');
    expect(await decryptSecret(envelope, TEST_KEY)).toBe('whsec_super_secret_value');
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const a = await encryptSecret('same', TEST_KEY);
    const b = await encryptSecret('same', TEST_KEY);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with the wrong key', async () => {
    const envelope = await encryptSecret('secret', TEST_KEY);
    const wrongKey = 'b'.repeat(43) + '=';
    await expect(decryptSecret(envelope, wrongKey)).rejects.toBeTruthy();
  });

  it('rejects a malformed envelope', async () => {
    await expect(decryptSecret('not-an-envelope', TEST_KEY)).rejects.toBeTruthy();
  });

  it('rejects a wrong-length key with a helpful message', async () => {
    await expect(encryptSecret('x', 'dG9vLXNob3J0')).rejects.toThrow(/ENCRYPTION_KEY/);
  });
});

describe('tokens', () => {
  it('generates URL-safe random tokens', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(30);
  });

  it('generates unique tokens', () => {
    expect(randomToken()).not.toBe(randomToken());
  });

  it('hashes deterministically', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('hello');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe('hmacSha256Hex', () => {
  it('produces a stable hex signature', async () => {
    const signature = await hmacSha256Hex('secret', '{"a":1}');
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).toBe(await hmacSha256Hex('secret', '{"a":1}'));
  });

  it('changes when the body changes', async () => {
    expect(await hmacSha256Hex('secret', 'a')).not.toBe(await hmacSha256Hex('secret', 'b'));
  });

  it('changes when the secret changes', async () => {
    expect(await hmacSha256Hex('s1', 'body')).not.toBe(await hmacSha256Hex('s2', 'body'));
  });
});

describe('maskSecret', () => {
  it('masks most of the value', () => {
    const masked = maskSecret('whsec_abcdefghijklmnop');
    expect(masked).toContain('whse');
    expect(masked).not.toContain('ijklmnop');
  });

  it('fully masks short values', () => {
    expect(maskSecret('short')).toBe('••••');
  });
});
