import { useCallback, useState } from 'react';
import { api, ApiClientError, NetworkError } from '../api';
import { setSessionUser } from '../lib/session';
import { navigateTo, X_HANDLE, X_URL } from '../router';
import { Field } from '../components/ui';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
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
        nextErrors.email = 'Enter a valid email address.';
      }
      if (password.length < 10) {
        nextErrors.password = 'Password must be at least 10 characters.';
      }
      if (mode === 'register' && password !== confirm) {
        nextErrors.confirm = 'Passwords do not match.';
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
          setError('Unexpected error. Please retry.');
        }
      } finally {
        setBusy(false);
      }
    },
    [email, password, confirm, mode]
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
          <a className="x-link" href={X_URL} target="_blank" rel="me noopener noreferrer">
            <span className="x-glyph" aria-hidden="true">
              𝕏
            </span>
            <span className="x-label">@{X_HANDLE}</span>
          </a>
        </div>

        <form className="auth-card" onSubmit={submit} noValidate>
          <div>
            <h1 style={{ fontSize: 20 }}>{mode === 'register' ? 'Create your account' : 'Sign in'}</h1>
            <p className="small muted" style={{ margin: '5px 0 0' }}>
              {mode === 'register'
                ? 'Free plan includes 10 monitors, 60-second checks and 30 days of history.'
                : 'Welcome back. Your monitors keep running while you are away.'}
            </p>
          </div>

          {error ? (
            <div className="form-error" role="alert">
              <span aria-hidden="true">⚠</span>
              <span>{error}</span>
            </div>
          ) : null}

          <Field label="Email" error={fieldErrors.email} htmlFor="email">
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
            label="Password"
            error={fieldErrors.password}
            hint={mode === 'register' ? 'At least 10 characters. Avoid common phrases.' : undefined}
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
            <Field label="Confirm password" error={fieldErrors.confirm} htmlFor="confirm">
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
            {busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}
          </button>

          <div className="small muted" style={{ textAlign: 'center' }}>
            {mode === 'register' ? (
              <>
                Already have an account? <a href="/login">Sign in</a>
              </>
            ) : (
              <>
                No account yet? <a href="/register">Create one</a>
              </>
            )}
          </div>
        </form>

        <p className="small muted center" style={{ margin: 0 }}>
          <a href="/">← Back to overview</a>
        </p>
      </div>
    </div>
  );
}
