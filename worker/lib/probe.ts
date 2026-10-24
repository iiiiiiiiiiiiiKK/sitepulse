import { assertProbeableUrl, type DnsResolver } from './urlguard';
import type { ErrorKind, ProbeResult, ProbeTarget } from './types';

/**
 * HTTP probe policy
 * -----------------
 * - Method: `GET` by default. `HEAD` is opt-in per monitor. GET is the default
 *   because many CDNs/WAFs answer HEAD with 405/501 even though the page is
 *   perfectly healthy, which would produce false outages.
 * - Body: never downloaded. The request is aborted as soon as headers arrive, so
 *   a 500 MB response costs nothing and cannot be used to exhaust Worker memory.
 * - Redirects: followed manually, max 5 hops, and the target of EVERY hop passes
 *   the SSRF guard again (so `example.com -> 127.0.0.1` is refused, and a DNS
 *   answer that changes mid-chain is re-checked).
 * - Timeout: hard deadline for the whole probe, including redirect hops.
 */

export const MAX_REDIRECTS = 5;

export interface ProbeOptions {
  resolver?: DnsResolver | null;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Max redirect hops; defaults to MAX_REDIRECTS. */
  maxRedirects?: number;
}

/** Parses "200-299", "200,204,301" or "200-299,301,404" into a predicate. */
export function parseExpectedStatus(spec: string): (status: number) => boolean {
  const trimmed = (spec || '').trim();
  if (!trimmed) return (status) => status >= 200 && status <= 299;
  const ranges: Array<[number, number]> = [];
  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const dash = piece.indexOf('-');
    if (dash > 0) {
      const lo = Number(piece.slice(0, dash));
      const hi = Number(piece.slice(dash + 1));
      if (Number.isInteger(lo) && Number.isInteger(hi) && lo >= 100 && hi <= 599 && lo <= hi) {
        ranges.push([lo, hi]);
      }
    } else {
      const exact = Number(piece);
      if (Number.isInteger(exact) && exact >= 100 && exact <= 599) ranges.push([exact, exact]);
    }
  }
  if (ranges.length === 0) return (status) => status >= 200 && status <= 299;
  return (status) => ranges.some(([lo, hi]) => status >= lo && status <= hi);
}

/** Validates an expected-status spec; returns an error string or null. */
export function validateExpectedStatus(spec: string): string | null {
  const trimmed = (spec || '').trim();
  if (!trimmed) return null;
  const ranges = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  if (ranges.length === 0) return 'Expected status cannot be empty.';
  if (ranges.length > 12) return 'At most 12 status ranges are allowed.';
  for (const piece of ranges) {
    const dash = piece.indexOf('-');
    if (dash > 0) {
      const lo = Number(piece.slice(0, dash));
      const hi = Number(piece.slice(dash + 1));
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 100 || hi > 599 || lo > hi) {
        return `Invalid status range "${piece}". Use 100-599, e.g. 200-299.`;
      }
    } else {
      const exact = Number(piece);
      if (!Number.isInteger(exact) || exact < 100 || exact > 599) {
        return `Invalid status code "${piece}".`;
      }
    }
  }
  return null;
}

/** Maps a thrown fetch error onto a coarse, user-visible error kind. */
export function classifyFetchError(error: unknown): { kind: ErrorKind; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const text = `${raw} ${cause}`.toLowerCase();

  if (text.includes('timeout') || text.includes('timed out') || text.includes('aborted')) {
    return { kind: 'timeout', message: 'The request timed out.' };
  }
  if (
    text.includes('dns') ||
    text.includes('name not resolved') ||
    text.includes('nxdomain') ||
    text.includes('enotfound') ||
    text.includes('getaddrinfo') ||
    text.includes('eai_again')
  ) {
    return { kind: 'dns', message: 'DNS resolution failed for this hostname.' };
  }
  if (text.includes('ssl') || text.includes('tls') || text.includes('certificate')) {
    return { kind: 'tls', message: 'TLS handshake or certificate error.' };
  }
  if (text.includes('too many redirects') || text.includes('redirect')) {
    return { kind: 'redirect', message: 'Too many redirects.' };
  }
  if (text.includes('prohibited') || text.includes('not allowed')) {
    return { kind: 'blocked', message: 'The request was blocked by a safety rule.' };
  }
  return { kind: 'connection', message: raw.slice(0, 300) || 'Connection failed.' };
}

/** Human-readable text for each error kind, used in the UI and in alerts. */
export const ERROR_LABELS: Record<ErrorKind, string> = {
  status: 'Unexpected HTTP status',
  timeout: 'Timeout',
  dns: 'DNS failure',
  tls: 'TLS / certificate error',
  connection: 'Connection error',
  redirect: 'Redirect problem',
  blocked: 'Blocked by SSRF guard',
  resolver: 'Probe resolver unavailable',
  protocol: 'Protocol error',
  network: 'Network error',
};

async function fetchOnce(
  target: string,
  method: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(target, {
    method,
    redirect: 'manual',
    signal,
    headers: {
      // Some hosts 403 an unknown agent; identify honestly instead.
      'user-agent': 'SitePulse/1.0 (+https://github.com/iiiiiiiiiiiiiKK/sitepulse)',
      accept: '*/*',
      'cache-control': 'no-cache',
    },
    // Workers support this; it also keeps the body out of memory entirely.
    cf: { cacheTtl: 0 } as RequestInitCfProperties,
  });
}

/**
 * Probes a monitor target end to end and returns a normalised result.
 * Never throws: every failure is mapped to a `ProbeResult` with `ok: false`.
 */
export async function probe(
  target: ProbeTarget,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const started = Date.now();

  // Guard hop 0 before spending any time on the network.
  const firstGuard = await assertProbeableUrl(target.url, { resolver: options.resolver });
  if (!firstGuard.ok) {
    // A DNS resolution failure is reported as `dns` (that is what the user sees
    // for a dead hostname); a resolver outage is reported as `resolver`; every
    // other refusal is a deliberate SSRF block.
    const kind: ErrorKind =
      firstGuard.code === 'dns' ? 'dns' : firstGuard.code === 'resolver' ? 'resolver' : 'blocked';
    return {
      ok: false,
      statusCode: null,
      responseMs: Date.now() - started,
      errorKind: kind,
      errorMessage: firstGuard.reason,
      redirects: 0,
      finalUrl: null,
    };
  }

  const isExpected = parseExpectedStatus(target.expectedStatus);
  const deadline = started + Math.max(1000, target.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1000, target.timeoutMs));

  let currentUrl = firstGuard.url.toString();
  let redirects = 0;

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timeout');

      const response = await fetchOnce(currentUrl, target.method, controller.signal, fetchImpl);
      const responseMs = Date.now() - started;

      // Drop the body immediately; we only care about status + latency.
      try {
        await response.body?.cancel();
      } catch {
        /* body may already be consumed for HEAD */
      }

      const location = response.headers.get('location');
      const isRedirect = response.status >= 300 && response.status < 400 && location;

      if (isRedirect) {
        if (redirects >= maxRedirects) {
          return {
            ok: false,
            statusCode: response.status,
            responseMs,
            errorKind: 'redirect',
            errorMessage: `Exceeded ${maxRedirects} redirects.`,
            redirects,
            finalUrl: currentUrl,
          };
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location as string, currentUrl).toString();
        } catch {
          return {
            ok: false,
            statusCode: response.status,
            responseMs,
            errorKind: 'redirect',
            errorMessage: 'Redirect target is not a valid URL.',
            redirects,
            finalUrl: currentUrl,
          };
        }
        // Re-validate every hop: blocks redirects into private space and
        // re-resolves DNS so a rebinding answer cannot be reused.
        const hopGuard = await assertProbeableUrl(nextUrl, { resolver: options.resolver });
        if (!hopGuard.ok) {
          return {
            ok: false,
            statusCode: response.status,
            responseMs,
            errorKind: 'blocked',
            errorMessage: `Redirect blocked: ${hopGuard.reason}`,
            redirects,
            finalUrl: nextUrl,
          };
        }
        currentUrl = hopGuard.url.toString();
        redirects += 1;
        continue;
      }

      const ok = isExpected(response.status);
      return {
        ok,
        statusCode: response.status,
        responseMs,
        errorKind: ok ? null : 'status',
        errorMessage: ok
          ? null
          : `Expected ${target.expectedStatus || '200-299'} but received ${response.status}.`,
        redirects,
        finalUrl: currentUrl,
      };
    }
  } catch (error) {
    const classified = classifyFetchError(error);
    return {
      ok: false,
      statusCode: null,
      responseMs: Date.now() - started,
      errorKind: classified.kind,
      errorMessage: classified.message,
      redirects,
      finalUrl: redirects > 0 ? currentUrl : null,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
