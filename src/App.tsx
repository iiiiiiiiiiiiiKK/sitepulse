import { useEffect } from 'react';
import { AppShell } from './pages/AppShell';
import { useI18n } from './lib/i18n';

/**
 * Root component.
 *
 * Public status pages (`/status/:slug`) are server-rendered by the Worker and
 * never reach this component — they must work without JavaScript.
 */
export function App() {
  const { lang } = useI18n();
  useDocumentTitle(
    lang === 'zh' ? 'SitePulse — 网站心跳监护仪' : 'SitePulse — website heartbeat monitor'
  );
  return <AppShell />;
}

/** Keeps the document title in sync with the current route/language. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
