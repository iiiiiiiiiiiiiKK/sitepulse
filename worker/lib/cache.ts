import type { Bindings } from './types';

/**
 * Edge-cache helpers for the public status page.
 *
 * Two problems this solves, both measured in production:
 *
 * 1. **Cost.** Every status-page view ran a `checks` range query (≈2 rows per
 *    probe in the window) plus incident/maintenance lookups. A shareable page
 *    that a few people refresh is a repeating bill on a metered database.
 * 2. **Availability.** When D1 hits its daily row-read limit, every query fails
 *    and the Worker returned a generic 500 — a public status page going 500 is
 *    the worst possible outcome for a status page.
 *
 * The Cache API is free and does not count against D1, so a stale copy is served
 * with `X-SitePulse-Cache: stale` while the database is unavailable.
 */

const CACHE_PREFIX = 'https://sitepulse.internal/status-cache/';

export interface CacheEntry {
  html: string;
  json: string;
  storedAt: number;
}

function keyFor(slug: string, variant: string): string {
  return `${CACHE_PREFIX}${encodeURIComponent(slug)}/${variant}`;
}

/**
 * Reads a cached render. Returns null on a miss.
 * Never throws: a broken cache must not break the page.
 */
export async function readCachedStatus(
  slug: string,
  maxAgeMs: number
): Promise<CacheEntry | null> {
  try {
    const cache = caches.default;
    const response = await cache.match(keyFor(slug, 'render'));
    if (!response) return null;
    const entry = (await response.json()) as CacheEntry;
    if (!entry?.html) return null;
    if (Date.now() - entry.storedAt > maxAgeMs) {
      // Too old to serve as fresh, but still useful as a stale fallback: hand it
      // back with its real age so the caller can decide.
      return { ...entry, stale: true } as CacheEntry & { stale: true };
    }
    return entry;
  } catch {
    return null;
  }
}

/** Stores a render for later reuse. Failures are ignored. */
export async function writeCachedStatus(slug: string, entry: CacheEntry): Promise<void> {
  try {
    const cache = caches.default;
    await cache.put(
      keyFor(slug, 'render'),
      new Response(JSON.stringify(entry), {
        headers: {
          'content-type': 'application/json',
          // Keep the copy independent of the HTTP cache-control we send to
          // browsers; the worker decides freshness itself.
          'cache-control': 'max-age=86400',
        },
      })
    );
  } catch {
    /* cache is best-effort */
  }
}

/** True when the error means "the database is out of budget", not a bug. */
export function isBudgetError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}` : String(error);
  return (
    /exceeded D1'?s free tier/i.test(text) ||
    /daily row read limit/i.test(text) ||
    /too many requests/i.test(text) ||
    /rate limit/i.test(text) ||
    /7500/.test(text)
  );
}
