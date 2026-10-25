import { useCallback, useState } from 'react';
import { api, ApiClientError, NetworkError } from '../api';
import { setSessionUser } from '../lib/session';
import { navigateTo, X_HANDLE, X_URL } from '../router';
import { Field } from '../components/ui';
import { LangToggle } from '../components/layout';
import { useI18n } from '../lib/i18n';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      setFieldErrors({});

      const nextErrors: Record<string, string> = {};
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
        nextErrors.email = t('auth.errEmail');
      }
      if (password.length < 10) {
        nextErrors.password = t('auth.errPassword');
      }
      if (mode === 'register' && password !== confirm) {
        nextErrors.confirm = t('auth.errConfirm');
      }
      if (Object.keys(nextErrors).length > 0) {
        setFieldErrors(nextErrors);
        return;
      }

      setBusy(true);
      try {
        const result =
          mode === 'register'
            ? await api.register(email.trim(), password)
            : await api.login(email.trim(), password);
        setSessionUser(result.user);
        navigateTo('/app');
      } catch (caught) {
        if (caught instanceof ApiClientError || caught instanceof NetworkError) {
          setError(caught.message);
        } else {
          setError(t('common.unexpected'));
        }
      } finally {
        setBusy(false);
      }
    },
    [email, password, confirm, mode, t]
  );

  return (
    <div className="auth-wrap">
      <div className="stack" style={{ width: '100%', maxWidth: 420 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <a className="brand" href="/">
            <span className="brand-mark" aria-hidden="true">
              ◢
            </span>
            <span>SitePulse</span>
          </a>
          <div className="row" style={{ gap: 8 }}>
            <LangToggle compact />
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
          </div>
        </div>

        <form className="auth-card" onSubmit={submit} noValidate>
          <div>
            <h1 style={{ fontSize: 20 }}>
              {mode === 'register' ? t('auth.registerTitle') : t('auth.loginTitle')}
            </h1>
            <p className="small muted" style={{ margin: '5px 0 0' }}>
              {mode === 'register' ? t('auth.registerSub') : t('auth.loginSub')}
            </p>
          </div>

          {error ? (
            <div className="form-error" role="alert">
              <span aria-hidden="true">⚠</span>
              <span>{error}</span>
            </div>
          ) : null}

          <Field label={t('auth.email')} error={fieldErrors.email} htmlFor="email">
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(fieldErrors.email)}
              required
            />
          </Field>

          <Field
            label={t('auth.password')}
            error={fieldErrors.password}
            hint={mode === 'register' ? t('auth.passwordHint') : undefined}
            htmlFor="password"
          >
            <input
              id="password"
              className="input"
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              placeholder="••••••••••"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(fieldErrors.password)}
              required
            />
          </Field>

          {mode === 'register' ? (
            <Field label={t('auth.confirm')} error={fieldErrors.confirm} htmlFor="confirm">
              <input
                id="confirm"
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder="••••••••••"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                aria-invalid={Boolean(fieldErrors.confirm)}
                required
              />
            </Field>
          ) : null}

          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {busy
              ? t('common.loading')
              : mode === 'register'
                ? t('auth.submitRegister')
                : t('auth.submitLogin')}
          </button>

          <div className="small muted" style={{ textAlign: 'center' }}>
            {mode === 'register' ? (
              <>
                {t('auth.haveAccount')} <a href="/login">{t('auth.loginTitle')}</a>
              </>
            ) : (
              <>
                {t('auth.noAccount')} <a href="/register">{t('auth.registerTitle')}</a>
              </>
            )}
          </div>
        </form>

        <p className="small muted center" style={{ margin: 0 }}>
          <a href="/">{t('auth.back')}</a>
        </p>
      </div>
    </div>
  );
}
