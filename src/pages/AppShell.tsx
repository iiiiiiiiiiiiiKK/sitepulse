import { useCallback } from 'react';
import { api } from '../api';
import { signOutLocal, useSession } from '../lib/session';
import { matchPath, navigateTo, useLocation } from '../router';
import { TopBar, PageShell } from '../components/layout';
import { ErrorState, LoadingPanel } from '../components/ui';
import { LandingPage } from './LandingPage';
import { AuthPage } from './AuthPage';
import { DashboardPage } from './DashboardPage';
import { MonitorDetailPage } from './MonitorDetailPage';
import { SettingsPage } from './SettingsPage';

export function AppShell() {
  const [path, navigate] = useLocation();
  const session = useSession();

  const handleSignOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Even if the network call fails, drop the local session: the cookie may
      // still be valid server-side, but the UI must not pretend to be signed in.
    }
    signOutLocal();
    navigate('/');
  }, [navigate]);

  // Intercept in-app anchor clicks so we never do a full page reload.
  const onClickCapture = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      const anchor = target.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || !href.startsWith('/') || anchor.target === '_blank') return;
      if (anchor.hasAttribute('download')) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(href);
    },
    [navigate]
  );

  const pathOnly = path.split('?')[0];

  // --- public pages ---------------------------------------------------------
  if (pathOnly === '/' ) {
    return (
      <div onClickCapture={onClickCapture}>
        <LandingPage />
      </div>
    );
  }

  if (pathOnly === '/login' || pathOnly === '/register') {
    if (session.status === 'authenticated') {
      navigate('/app', true);
      return <LoadingPanel rows={2} />;
    }
    return (
      <div onClickCapture={onClickCapture}>
        <AuthPage mode={pathOnly === '/register' ? 'register' : 'login'} />
      </div>
    );
  }

  // --- app pages ------------------------------------------------------------
  if (session.status === 'loading') {
    return (
      <PageShell>
        <LoadingPanel rows={4} />
      </PageShell>
    );
  }

  if (session.status === 'anonymous') {
    if (session.error) {
      return (
        <PageShell>
          <ErrorState
            message={session.error}
            onRetry={() => window.location.reload()}
          />
        </PageShell>
      );
    }
    // Not signed in: send them to the login screen, preserving the target.
    navigate(`/login`, true);
    return <LoadingPanel rows={2} />;
  }

  const detailMatch = matchPath('/app/monitors/:id', pathOnly);

  return (
    <div onClickCapture={onClickCapture}>
      <TopBar user={session.user} path={pathOnly} onSignOut={() => void handleSignOut()} />
      <PageShell>
        {detailMatch ? (
          <MonitorDetailPage monitorId={detailMatch.id} />
        ) : pathOnly === '/app/settings' ? (
          <SettingsPage />
        ) : pathOnly === '/app' ? (
          <DashboardPage />
        ) : (
          <ErrorState
            message="This page does not exist."
            onRetry={() => navigateTo('/app')}
          />
        )}
      </PageShell>
    </div>
  );
}
