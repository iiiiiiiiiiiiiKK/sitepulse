import { useEffect } from 'react';
import { AppShell } from './pages/AppShell';

/**
 * Root component: pure client-side routing over a small pattern matcher.
 *
 *   /                        landing page
 *   /login, /register        auth
 *   /app                     dashboard
 *   /app/monitors/:id        monitor detail
 *   /app/settings            alerts + maintenance
 *
 * Public status pages (`/status/:slug`) are server-rendered by the Worker, so
 * they never reach this component — they must work without JavaScript.
 */
export function App() {
  const path = window.location.pathname;
  void path;
  return <AppShell />;
}

/** Keeps the document title in sync with the current route. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
