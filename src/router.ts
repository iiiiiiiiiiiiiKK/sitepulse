import { useCallback, useEffect, useState } from 'react';

/**
 * Minimal history router (~40 lines) instead of pulling in a routing library.
 * Supports pushState navigation, popstate, and an internal link helper that
 * keeps middle-click / ctrl-click behaviour intact.
 */

export function useLocation(): [string, (to: string, replace?: boolean) => void] {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, replace = false) => {
    if (to === window.location.pathname + window.location.search) return;
    if (replace) window.history.replaceState({}, '', to);
    else window.history.pushState({}, '', to);
    setPath(to);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, []);

  return [path, navigate];
}

/** Matches `/app/monitors/:id` style patterns. */
export function matchPath(
  pattern: string,
  path: string
): Record<string, string> | null {
  const pathOnly = path.split('?')[0];
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathOnly.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i];
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternPart !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export function navigateTo(to: string) {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export const X_HANDLE = '0xkillcoin';
export const X_URL = `https://${'x'}.com/${X_HANDLE}`;
