/**
 * Language state without React, so non-component modules (format helpers,
 * API error localisation) can read the active language without importing React.
 *
 * Persisted in localStorage under `sp_lang`; a `?lang=zh` / `?lang=en` URL
 * parameter wins over the stored value, which makes it possible to link to a
 * specific language and to drive the E2E tests deterministically.
 */

export type Lang = 'en' | 'zh';

const STORAGE_KEY = 'sp_lang';

let active: Lang = 'en';
const listeners = new Set<(lang: Lang) => void>();

export function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'zh';
}

/** Best-effort initial guess: explicit URL param, then storage, then browser. */
export function detectInitialLang(): Lang {
  if (typeof window === 'undefined') return 'en';
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('lang');
    if (isLang(fromUrl)) return fromUrl;
  } catch {
    /* ignore */
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLang(stored)) return stored;
  } catch {
    /* storage can be blocked */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function getLang(): Lang {
  return active;
}

export function setActiveLang(lang: Lang): void {
  active = lang;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore write failures (private mode, quota) */
  }
  try {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  } catch {
    /* ignore */
  }
  // Keep the URL in sync so a reload or a shared link cannot contradict the
  // choice the user just made (a stale `?lang=en` would otherwise win over
  // localStorage on the next load).
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('lang') !== lang) {
      url.searchParams.set('lang', lang);
      window.history.replaceState(window.history.state, '', url.toString());
    }
  } catch {
    /* ignore */
  }
  listeners.forEach((listener) => listener(lang));
}

export function onLangChange(listener: (lang: Lang) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** BCP-47 tag used for date/number formatting. */
export function localeTag(lang: Lang = active): string {
  return lang === 'zh' ? 'zh-CN' : 'en-US';
}
