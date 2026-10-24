import type { ReactNode } from 'react';
import { X_HANDLE, X_URL } from '../router';
import type { User } from '../types';

/** The author's X profile, shown in the top bar on every screen. */
export function XLink({ compact = false }: { compact?: boolean }) {
  return (
    <a
      className="x-link"
      href={X_URL}
      target="_blank"
      rel="me noopener noreferrer"
      title={`Follow @${X_HANDLE} on X`}
      aria-label={`Follow @${X_HANDLE} on X`}
    >
      <span className="x-glyph" aria-hidden="true">
        𝕏
      </span>
      {!compact ? <span className="x-label">@{X_HANDLE}</span> : null}
    </a>
  );
}

export function Brand({ href = '/' }: { href?: string }) {
  return (
    <a className="brand" href={href}>
      <span className="brand-mark" aria-hidden="true">
        ◢
      </span>
      <span className="brand-text">SitePulse</span>
    </a>
  );
}

export function TopBar({
  user,
  path,
  onSignOut,
}: {
  user: User | null;
  path: string;
  onSignOut: () => void;
}) {
  const isDashboard = path.startsWith('/app');
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <Brand href={user ? '/app' : '/'} />
        {user ? (
          <nav className="nav" aria-label="Main navigation">
            <a className={`nav-link ${path === '/app' ? 'active' : ''}`} href="/app">
              Monitors
            </a>
            <a
              className={`nav-link ${isDashboard && path.startsWith('/app/settings') ? 'active' : ''}`}
              href="/app/settings"
            >
              Alerts
            </a>
          </nav>
        ) : null}
        <span className="topbar-spacer" />
        <XLink />
        {user ? (
          <>
            <span className="pill neutral" title={`Signed in as ${user.email}`}>
              {user.plan === 'pro' ? 'Pro' : 'Free'}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={onSignOut} title="Sign out">
              Sign out
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <main>
        <div className="container">{children}</div>
      </main>
      <footer style={{ borderTop: '1px solid var(--line)', padding: '18px 0 28px' }}>
        <div
          className="container spread"
          style={{ fontSize: 12, color: 'var(--text-faint)', gap: 10 }}
        >
          <span>SitePulse · open-source uptime monitoring on Cloudflare Workers</span>
          <span className="row" style={{ gap: 12 }}>
            <a href="https://github.com/iiiiiiiiiiiiiKK/sitepulse" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <XLink compact />
          </span>
        </div>
      </footer>
    </div>
  );
}
