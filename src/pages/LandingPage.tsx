import { X_HANDLE, X_URL } from '../router';
import { LangToggle } from '../components/layout';
import { useI18n } from '../lib/i18n';

export function LandingPage() {
  const { t } = useI18n();

  const FEATURES = [
    { title: t('landing.f1.title'), body: t('landing.f1.body') },
    { title: t('landing.f2.title'), body: t('landing.f2.body') },
    { title: t('landing.f3.title'), body: t('landing.f3.body') },
    { title: t('landing.f4.title'), body: t('landing.f4.body') },
    { title: t('landing.f5.title'), body: t('landing.f5.body') },
    { title: t('landing.f6.title'), body: t('landing.f6.body') },
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="container topbar-inner">
          <a className="brand" href="/">
            <span className="brand-mark" aria-hidden="true">
              ◢
            </span>
            <span className="brand-text">SitePulse</span>
          </a>
          <span className="topbar-spacer" />
          <LangToggle />
          <a
            className="x-link"
            href={X_URL}
            target="_blank"
            rel="me noopener noreferrer"
            title={t('landing.follow', { handle: X_HANDLE })}
          >
            <span className="x-glyph" aria-hidden="true">
              𝕏
            </span>
            <span className="x-label">@{X_HANDLE}</span>
          </a>
          <a className="btn btn-sm" href="/login">
            {t('auth.loginTitle')}
          </a>
          <a className="btn btn-sm btn-primary" href="/register">
            {t('landing.ctaPrimary')}
          </a>
        </div>
      </header>

      <main>
        <div className="container">
          <div className="stack" style={{ gap: 26, paddingTop: 26 }}>
            <section className="stack" style={{ gap: 14, maxWidth: 760 }}>
              <span className="eyebrow">{t('landing.eyebrow')}</span>
              <h1 style={{ fontSize: 'clamp(28px, 5.4vw, 46px)', fontWeight: 700 }}>
                {t('landing.title1')}
                <br />
                <span style={{ color: 'var(--accent)' }}>{t('landing.title2')}</span>
              </h1>
              <p style={{ color: 'var(--text-dim)', fontSize: 15.5, margin: 0, maxWidth: 620 }}>
                {t('landing.lede')}
              </p>
              <div className="row" style={{ marginTop: 4 }}>
                <a className="btn btn-primary" href="/register">
                  {t('landing.ctaPrimary')}
                </a>
                <a className="btn" href="/login">
                  {t('landing.ctaSecondary')}
                </a>
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                {t('landing.freeNote')}
              </p>
            </section>

            <section className="stat-grid">
              <div className="stat">
                <div className="stat-label">{t('landing.stat1.label')}</div>
                <div className="stat-value">60s</div>
                <div className="stat-sub">{t('landing.stat1.sub')}</div>
              </div>
              <div className="stat">
                <div className="stat-label">{t('landing.stat2.label')}</div>
                <div className="stat-value">N×</div>
                <div className="stat-sub">{t('landing.stat2.sub')}</div>
              </div>
              <div className="stat">
                <div className="stat-label">{t('landing.stat3.label')}</div>
                <div className="stat-value">5</div>
                <div className="stat-sub">{t('landing.stat3.sub')}</div>
              </div>
              <div className="stat">
                <div className="stat-label">{t('landing.stat4.label')}</div>
                <div className="stat-value">30d</div>
                <div className="stat-sub">{t('landing.stat4.sub')}</div>
              </div>
            </section>

            <section className="stack" style={{ gap: 12 }}>
              <h2 style={{ fontSize: 17 }}>{t('landing.featuresTitle')}</h2>
              <div
                className="stat-grid"
                style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}
              >
                {FEATURES.map((feature) => (
                  <article key={feature.title} className="panel panel-pad">
                    <h3 style={{ fontSize: 14, marginBottom: 6 }}>{feature.title}</h3>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--text-dim)' }}>
                      {feature.body}
                    </p>
                  </article>
                ))}
              </div>
            </section>

            <section className="panel panel-pad">
              <h2 style={{ fontSize: 15, marginBottom: 8 }}>{t('landing.ossTitle')}</h2>
              <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--text-dim)' }}>
                {t('landing.ossBody')}
              </p>
              <div className="row">
                <a
                  className="btn btn-sm"
                  href="https://github.com/iiiiiiiiiiiiiKK/sitepulse"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('landing.ossCta')}
                </a>
                <a className="btn btn-sm" href={X_URL} target="_blank" rel="me noopener noreferrer">
                  𝕏 {t('landing.follow', { handle: X_HANDLE })}
                </a>
              </div>
            </section>
          </div>
        </div>
      </main>

      <footer style={{ borderTop: '1px solid var(--line)', padding: '18px 0 28px' }}>
        <div className="container spread" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          <span>{t('footer.tagline')}</span>
          <a href={X_URL} target="_blank" rel="me noopener noreferrer">
            𝕏 @{X_HANDLE}
          </a>
        </div>
      </footer>
    </div>
  );
}
