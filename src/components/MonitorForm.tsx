import { useState } from 'react';
import { ApiClientError, NetworkError } from '../api';
import { Field } from './ui';
import { useI18n } from '../lib/i18n';
import type { Monitor } from '../types';

export interface MonitorFormValues {
  name: string;
  url: string;
  method: 'GET' | 'HEAD';
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: string;
  failureThreshold: number;
  recoveryThreshold: number;
}

const INTERVALS = [
  { value: 60, key: 'form.every60' },
  { value: 300, key: 'form.every5m' },
  { value: 600, key: 'form.every10m' },
  { value: 900, key: 'form.every15m' },
  { value: 1800, key: 'form.every30m' },
  { value: 3600, key: 'form.every1h' },
] as const;

const TIMEOUTS = [5000, 10000, 15000, 20000, 30000];

/**
 * Shared create/edit form. Client validation mirrors the server's rules so the
 * user gets instant feedback, but the server is still authoritative — every
 * submit surfaces the real API error message if it disagrees.
 */
export function MonitorForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Monitor;
  submitLabel: string;
  onSubmit: (values: MonitorFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const { t, lang } = useI18n();
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [method, setMethod] = useState<'GET' | 'HEAD'>(
    (initial?.method as 'GET' | 'HEAD') ?? 'GET'
  );
  const [intervalSeconds, setIntervalSeconds] = useState(initial?.intervalSeconds ?? 300);
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs ?? 10000);
  const [expectedStatus, setExpectedStatus] = useState(initial?.expectedStatus ?? '200-299');
  const [failureThreshold, setFailureThreshold] = useState(initial?.failureThreshold ?? 3);
  const [recoveryThreshold, setRecoveryThreshold] = useState(initial?.recoveryThreshold ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t('form.errName');
    if (!url.trim()) next.url = t('form.errUrlRequired');

    const candidate = url.trim();
    if (candidate) {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
        ? candidate
        : `https://${candidate}`;
      try {
        const parsed = new URL(withScheme);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          next.url = t('form.errUrlScheme');
        } else if (
          ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname.toLowerCase())
        ) {
          next.url = t('form.errUrlPrivate');
        }
      } catch {
        next.url = t('form.errUrlInvalid');
      }
    }
    if (!/^[0-9,\-]+$/.test(expectedStatus.trim())) {
      next.expectedStatus = t('form.errExpected');
    }

    if (Object.keys(next).length > 0) {
      setFieldErrors(next);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        url: url.trim(),
        method,
        intervalSeconds,
        timeoutMs,
        expectedStatus: expectedStatus.trim(),
        failureThreshold,
        recoveryThreshold,
      });
    } catch (caught) {
      setError(
        caught instanceof ApiClientError || caught instanceof NetworkError
          ? caught.message
          : t('form.saveFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {error ? (
        <div className="form-error" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </div>
      ) : null}

      <Field label={t('form.name')} error={fieldErrors.name} htmlFor="monitor-name">
        <input
          id="monitor-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('form.namePlaceholder')}
          maxLength={80}
          aria-invalid={Boolean(fieldErrors.name)}
          required
        />
      </Field>

      <Field
        label={t('form.url')}
        hint={t('form.urlHint')}
        error={fieldErrors.url}
        htmlFor="monitor-url"
      >
        <input
          id="monitor-url"
          className="input"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={t('form.urlPlaceholder')}
          inputMode="url"
          spellCheck={false}
          aria-invalid={Boolean(fieldErrors.url)}
          required
        />
      </Field>

      <div className="grid-2">
        <Field label={t('form.interval')} htmlFor="monitor-interval">
          <select
            id="monitor-interval"
            className="select"
            value={intervalSeconds}
            onChange={(event) => setIntervalSeconds(Number(event.target.value))}
          >
            {INTERVALS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.key)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('form.timeout')} htmlFor="monitor-timeout">
          <select
            id="monitor-timeout"
            className="select"
            value={timeoutMs}
            onChange={(event) => setTimeoutMs(Number(event.target.value))}
          >
            {TIMEOUTS.map((value) => (
              <option key={value} value={value}>
                {lang === 'zh' ? `${value / 1000} 秒` : `${value / 1000} s`}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid-2">
        <Field label={t('form.method')} hint={t('form.methodHint')} htmlFor="monitor-method">
          <select
            id="monitor-method"
            className="select"
            value={method}
            onChange={(event) => setMethod(event.target.value as 'GET' | 'HEAD')}
          >
            <option value="GET">{t('form.methodGet')}</option>
            <option value="HEAD">HEAD</option>
          </select>
        </Field>

        <Field
          label={t('form.expected')}
          hint={t('form.expectedHint')}
          error={fieldErrors.expectedStatus}
          htmlFor="monitor-status"
        >
          <input
            id="monitor-status"
            className="input mono"
            value={expectedStatus}
            onChange={(event) => setExpectedStatus(event.target.value)}
            placeholder="200-299"
            aria-invalid={Boolean(fieldErrors.expectedStatus)}
          />
        </Field>
      </div>

      <div className="grid-2">
        <Field
          label={t('form.failThreshold')}
          hint={t('form.failThresholdHint')}
          htmlFor="monitor-fail"
        >
          <input
            id="monitor-fail"
            className="input"
            type="number"
            min={1}
            max={10}
            value={failureThreshold}
            onChange={(event) => setFailureThreshold(Number(event.target.value))}
          />
        </Field>

        <Field
          label={t('form.recoverThreshold')}
          hint={t('form.recoverThresholdHint')}
          htmlFor="monitor-recover"
        >
          <input
            id="monitor-recover"
            className="input"
            type="number"
            min={1}
            max={10}
            value={recoveryThreshold}
            onChange={(event) => setRecoveryThreshold(Number(event.target.value))}
          />
        </Field>
      </div>

      <div className="modal-foot" style={{ margin: '4px -18px -18px', paddingTop: 14 }}>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <span className="spinner" /> : null}
          {busy ? t('common.saving') : submitLabel}
        </button>
      </div>
    </form>
  );
}
