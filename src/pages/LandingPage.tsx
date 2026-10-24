import { X_HANDLE, X_URL } from '../router';

const FEATURES = [
  {
    title: 'Scheduled probes that outlive your browser',
    body: 'A Cloudflare Cron Trigger runs every minute. Probes keep firing whether your laptop is open, closed, or asleep.',
  },
  {
    title: 'Failure thresholds, not flapping alerts',
    body: 'Set how many consecutive failures count as an outage. One dropped packet will not page you at 3am.',
  },
  {
    title: 'Incident timeline with real durations',
    body: 'Every outage records when it started, how long it lasted and what the last observed error was.',
  },
  {
    title: 'Public status pages',
    body: 'Server-rendered, shareable, and JS-optional. Only the hostname and status you choose are exposed.',
  },
  {
    title: 'Webhook and email alerts',
    body: 'Signed HMAC-SHA256 webhooks plus email delivery. Secrets encrypted at rest, never logged.',
  },
  {
    title: 'SSRF-hardened by default',
    body: 'Private networks, link-local ranges and cloud metadata endpoints are refused, including on every redirect hop.',
  },
];

export function LandingPage() {
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
          <a
            className="x-link"
            href={X_URL}
            target="_blank"
            rel="me noopener noreferrer"
            title={`Follow @${X_HANDLE} on X`}
          >
            <span className="x-glyph" aria-hidden="true">
              𝕏
            </span>
            <span className="x-label">@{X_HANDLE}</span>
          </a>
          <a className="btn btn-sm" href="/login">
            Sign in
          </a>
          <a className="btn btn-sm btn-primary" href="/register">
            Get started
          </a>
        </div>
      </header>

      <main>
        <div className="container">
          <div className="stack" style={{ gap: 26, paddingTop: 26 }}>
            <section className="stack" style={{ gap: 14, maxWidth: 760 }}>
              <span className="eyebrow">Website heartbeat monitor</span>
              <h1 style={{ fontSize: 'clamp(28px, 5.4vw, 46px)', fontWeight: 700 }}>
                Know your site is down
                <br />
                <span style={{ color: 'var(--accent)' }}>before your users tell you.</span>
              </h1>
              <p style={{ color: 'var(--text-dim)', fontSize: 15.5, margin: 0, maxWidth: 620 }}>
                SitePulse probes your websites on a schedule, records every response, groups failures
                into incidents with real durations, and publishes a status page you can share. Built
                entirely on Cloudflare Workers, Cron Triggers and D1 — no servers to babysit.
              </p>
              <div className="row" style={{ marginTop: 4 }}>
                <a className="btn btn-primary" href="/register">
                  Start monitoring free
                </a>
                <a className="btn" href="/login">
                  I already have an account
                </a>
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                10 monitors · 60-second interval · 30 days of history on the free plan
              </p>
            </section>

            <section className="stat-grid">
              <div className="stat">
                <div className="stat-label">Probe cadence</div>
                <div className="stat-value">60s</div>
                <div className="stat-sub">per monitor, cron-driven</div>
              </div>
              <div className="stat">
                <div className="stat-label">Failure logic</div>
                <div className="stat-value">N×</div>
                <div className="stat-sub">consecutive failures before alert</div>
              </div>
              <div className="stat">
                <div className="stat-label">Redirect hops re-checked</div>
                <div className="stat-value">5</div>
                <div className="stat-sub">each one revalidated for SSRF</div>
              </div>
              <div className="stat">
                <div className="stat-label">History retained</div>
                <div className="stat-value">30d</div>
                <div className="stat-sub">90d on Pro plans</div>
              </div>
            </section>

            <section className="stack" style={{ gap: 12 }}>
              <h2 style={{ fontSize: 17 }}>What it actually does</h2>
              <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
                {FEATURES.map((feature) => (
                  <article key={feature.title} className="panel panel-pad">
                    <h3 style={{ fontSize: 14, marginBottom: 6 }}>{feature.title}</h3>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--text-dim)' }}>{feature.body}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="panel panel-pad">
              <h2 style={{ fontSize: 15, marginBottom: 8 }}>Open source, MIT licensed</h2>
              <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--text-dim)' }}>
                The whole stack — Worker, D1 schema, React dashboard, tests — lives in one repository.
                Deploy your own copy to your Cloudflare account and own your monitoring data.
              </p>
              <div className="row">
                <a
                  className="btn btn-sm"
                  href="https://github.com/iiiiiiiiiiiiiKK/sitepulse"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View source on GitHub
                </a>
                <a className="btn btn-sm" href={X_URL} target="_blank" rel="me noopener noreferrer">
                  𝕏 Follow @{X_HANDLE}
                </a>
              </div>
            </section>
          </div>
        </div>
      </main>

      <footer style={{ borderTop: '1px solid var(--line)', padding: '18px 0 28px' }}>
        <div className="container spread" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          <span>SitePulse · MIT license · Cloudflare Workers + D1</span>
          <a href={X_URL} target="_blank" rel="me noopener noreferrer">
            𝕏 @{X_HANDLE}
          </a>
        </div>
      </footer>
    </div>
  );
}
