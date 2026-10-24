import { describe, expect, it, vi } from 'vitest';
import { parseExpectedStatus, probe, validateExpectedStatus } from '../worker/lib/probe';

/**
 * Probe tests use an injected fetch so they exercise the redirect/guard logic
 * deterministically. The SSRF DNS resolver is disabled except where a test
 * deliberately supplies one.
 */

function response(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers });
}

describe('parseExpectedStatus', () => {
  it('defaults to 200-299', () => {
    const predicate = parseExpectedStatus('');
    expect(predicate(200)).toBe(true);
    expect(predicate(299)).toBe(true);
    expect(predicate(301)).toBe(false);
    expect(predicate(204)).toBe(true);
  });

  it('parses ranges', () => {
    const predicate = parseExpectedStatus('200-204');
    expect(predicate(200)).toBe(true);
    expect(predicate(205)).toBe(false);
  });

  it('parses lists and mixed lists', () => {
    const predicate = parseExpectedStatus('200,204,301-302');
    expect(predicate(200)).toBe(true);
    expect(predicate(301)).toBe(true);
    expect(predicate(303)).toBe(false);
  });

  it('falls back to 2xx for garbage', () => {
    const predicate = parseExpectedStatus('abc');
    expect(predicate(200)).toBe(true);
    expect(predicate(500)).toBe(false);
  });
});

describe('validateExpectedStatus', () => {
  it('accepts valid specs', () => {
    expect(validateExpectedStatus('')).toBeNull();
    expect(validateExpectedStatus('200-299')).toBeNull();
    expect(validateExpectedStatus('200,204,301-302')).toBeNull();
  });

  it('rejects invalid specs', () => {
    expect(validateExpectedStatus('99-200')).toBeTruthy();
    expect(validateExpectedStatus('200-99')).toBeTruthy();
    expect(validateExpectedStatus('abc')).toBeTruthy();
    expect(validateExpectedStatus('200-999')).toBeTruthy();
  });
});

describe('probe', () => {
  it('reports a 200 as up and records latency', async () => {
    const fetchImpl = vi.fn(async () => response(200)) as unknown as typeof fetch;
    const result = await probe(
      { url: 'https://example.com', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.errorKind).toBeNull();
    expect(result.responseMs).toBeGreaterThanOrEqual(0);
    expect(result.redirects).toBe(0);
  });

  it('reports a 404 as a status failure', async () => {
    const fetchImpl = vi.fn(async () => response(404)) as unknown as typeof fetch;
    const result = await probe(
      { url: 'https://example.com', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.errorKind).toBe('status');
    expect(result.errorMessage).toContain('404');
  });

  it('treats a 500 as a failure but honours a custom expected range', async () => {
    const fetchImpl = vi.fn(async () => response(503)) as unknown as typeof fetch;
    const failing = await probe(
      { url: 'https://example.com', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(failing.ok).toBe(false);
    expect(failing.statusCode).toBe(503);

    const expected = await probe(
      { url: 'https://example.com', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299,503' },
      { fetchImpl, resolver: null }
    );
    expect(expected.ok).toBe(true);
  });

  it('follows a redirect and re-validates each hop', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) return response(301, { location: 'https://example.com/final' });
      return response(200);
    }) as unknown as typeof fetch;

    const result = await probe(
      { url: 'https://example.com/start', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(result.ok).toBe(true);
    expect(result.redirects).toBe(1);
    expect(result.finalUrl).toBe('https://example.com/final');
    expect(calls).toHaveLength(2);
  });

  it('blocks a redirect into a private address', async () => {
    const fetchImpl = vi.fn(async () =>
      response(302, { location: 'http://169.254.169.254/latest/meta-data/' })
    ) as unknown as typeof fetch;

    const result = await probe(
      { url: 'https://example.com', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('blocked');
    expect(result.errorMessage).toContain('Redirect blocked');
  });

  it('stops after the redirect limit', async () => {
    let counter = 0;
    const fetchImpl = vi.fn(async () => {
      counter += 1;
      return response(302, { location: `https://example.com/hop-${counter}` });
    }) as unknown as typeof fetch;

    const result = await probe(
      { url: 'https://example.com', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null, maxRedirects: 3 }
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('redirect');
    expect(counter).toBe(4); // initial request + 3 followed hops
  });

  it('classifies an aborted fetch as a timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as unknown as typeof fetch;

    const result = await probe(
      { url: 'https://example.com', method: 'GET', timeoutMs: 1000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('timeout');
  });

  it('classifies DNS failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('getaddrinfo ENOTFOUND nonexistent.invalid');
    }) as unknown as typeof fetch;

    const result = await probe(
      { url: 'https://nonexistent-host.com', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('dns');
  });

  it('classifies TLS failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('SSL certificate has expired');
    }) as unknown as typeof fetch;

    const result = await probe(
      { url: 'https://expired-host.com', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('tls');
  });

  it('classifies generic connection errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;

    const result = await probe(
      { url: 'https://down-host.com', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('connection');
  });

  it('refuses to probe a localhost target before any request is made', async () => {
    const fetchImpl = vi.fn(async () => response(200)) as unknown as typeof fetch;
    const result = await probe(
      { url: 'http://127.0.0.1:8080/', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('blocked');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses HEAD when requested', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(init?.method));
      return response(200);
    }) as unknown as typeof fetch;

    await probe(
      { url: 'https://example.com', method: 'HEAD', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(seen).toEqual(['HEAD']);
  });

  it('never follows redirects automatically (manual mode)', async () => {
    const modes: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      modes.push(init?.redirect);
      return response(200);
    }) as unknown as typeof fetch;

    await probe(
      { url: 'https://example.com', method: 'GET', timeoutMs: 5000, expectedStatus: '200-299' },
      { fetchImpl, resolver: null }
    );
    expect(modes).toEqual(['manual']);
  });
});
