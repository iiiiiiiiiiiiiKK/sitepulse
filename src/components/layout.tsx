import type { ReactNode } from 'react';
import { X_HANDLE, X_URL } from '../router';
import type { User } from '../types';
import { useI18n } from '../lib/i18n';

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

/**
 * Language switch.
 *
 * A single button that toggles EN ⇄ 中文. The current language is shown in its
 * own script so it is unambiguous, the target language is in the title/aria
 * label, and the choice is persisted in localStorage (see lib/lang.ts).
 */
export function LangToggle({ compact = false }: { compact?: boolean }) {
  const { lang, toggle, t } = useI18n();
  const label = lang === 'en' ? t('common.switchToChinese') : t('common.switchToEnglish');
  return (
    <button
      type="button"
      className="lang-toggle"
      onClick={toggle}
      title={label}
      aria-label={label}
      data-lang={lang}
    >
      <span className="lang-glyph" aria-hidden="true">
        {lang === 'en' ? '中' : 'EN'}
      </span>
      {!compact ? <span className="lang-label">{label}</span> : null}
    </button>
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
  const { t } = useI18n();
  const isDashboard = path.startsWith('/app');
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <Brand href={user ? '/app' : '/'} />
        {user ? (
          <nav className="nav" aria-label="Main navigation">
            <a className={`nav-link ${path === '/app' ? 'active' : ''}`} href="/app">
              {t('nav.monitors')}
            </a>
            <a
              className={`nav-link ${isDashboard && path.startsWith('/app/settings') ? 'active' : ''}`}
              href="/app/settings"
            >
              {t('nav.alerts')}
            </a>
          </nav>
        ) : null}
        <span className="topbar-spacer" />
        <LangToggle />
        <XLink />
        {user ? (
          <>
            <span className="pill neutral" title={t('nav.signedInAs', { email: user.email })}>
              {user.plan === 'pro' ? t('nav.planPro') : t('nav.planFree')}
            </span>
            <button
              className="btn btn-sm btn-ghost"
              onClick={onSignOut}
              title={t('nav.signOutTitle')}
            >
              {t('nav.signOut')}
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
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
          <span>{t('footer.tagline')}</span>
          <span className="row" style={{ gap: 12 }}>
            <a
              href="https://github.com/iiiiiiiiiiiiiKK/sitepulse"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('footer.github')}
            </a>
            <XLink compact />
          </span>
        </div>
      </footer>
    </div>
  );
}
