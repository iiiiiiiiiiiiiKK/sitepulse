import { useState } from 'react';
import { ApiClientError, NetworkError } from '../api';
import { Field } from './ui';
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
  { value: 60, label: 'Every 60 seconds' },
  { value: 300, label: 'Every 5 minutes' },
  { value: 600, label: 'Every 10 minutes' },
  { value: 900, label: 'Every 15 minutes' },
  { value: 1800, label: 'Every 30 minutes' },
  { value: 3600, label: 'Every hour' },
];

const TIMEOUTS = [
  { value: 5000, label: '5 s' },
  { value: 10000, label: '10 s' },
  { value: 15000, label: '15 s' },
  { value: 20000, label: '20 s' },
  { value: 30000, label: '30 s' },
];

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
    if (!name.trim()) next.name = 'Give this monitor a name.';
    if (!url.trim()) next.url = 'A URL is required.';

    const candidate = url.trim();
    if (candidate) {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
        ? candidate
        : `https://${candidate}`;
      try {
        const parsed = new URL(withScheme);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          next.url = 'Only http:// and https:// URLs are supported.';
        } else if (
          ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname.toLowerCase())
        ) {
          next.url = 'Private and loopback addresses cannot be monitored.';
        }
      } catch {
        next.url = 'That does not look like a valid URL.';
      }
    }
    if (!/^[0-9,\-]+$/.test(expectedStatus.trim())) {
      next.expectedStatus = 'Use codes or ranges, e.g. 200-299 or 200,204,301.';
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
          : 'Saving failed. Please retry.'
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

      <Field label="Name" error={fieldErrors.name} htmlFor="monitor-name">
        <input
          id="monitor-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Marketing site"
          maxLength={80}
          aria-invalid={Boolean(fieldErrors.name)}
          required
        />
      </Field>

      <Field
        label="URL"
        hint="HTTPS is assumed if you omit the scheme. Private IPs, localhost and cloud metadata endpoints are rejected."
        error={fieldErrors.url}
        htmlFor="monitor-url"
      >
        <input
          id="monitor-url"
          className="input"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/health"
          inputMode="url"
          spellCheck={false}
          aria-invalid={Boolean(fieldErrors.url)}
          required
        />
      </Field>

      <div className="grid-2">
        <Field label="Check interval" htmlFor="monitor-interval">
          <select
            id="monitor-interval"
            className="select"
            value={intervalSeconds}
            onChange={(event) => setIntervalSeconds(Number(event.target.value))}
          >
            {INTERVALS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Timeout" htmlFor="monitor-timeout">
          <select
            id="monitor-timeout"
            className="select"
            value={timeoutMs}
            onChange={(event) => setTimeoutMs(Number(event.target.value))}
          >
            {TIMEOUTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid-2">
        <Field
          label="HTTP method"
          hint="GET is the safe default. Some CDNs answer HEAD with 405."
          htmlFor="monitor-method"
        >
          <select
            id="monitor-method"
            className="select"
            value={method}
            onChange={(event) => setMethod(event.target.value as 'GET' | 'HEAD')}
          >
            <option value="GET">GET (recommended)</option>
            <option value="HEAD">HEAD</option>
          </select>
        </Field>

        <Field
          label="Expected status"
          hint="Ranges and code lists, e.g. 200-299 or 200,204."
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
          label="Failures before alerting"
          hint="Consecutive failures required to open an incident."
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
          label="Successes before recovery"
          hint="Consecutive successes required to close the incident."
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
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <span className="spinner" /> : null}
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
