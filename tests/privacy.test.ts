import { describe, expect, it } from 'vitest';
import { buildWebhookPayload, describeChannel } from '../worker/lib/notify';
import { renderStatusPage, renderStatusJson, escapeHtml } from '../worker/routes/statuspage';
import type { MonitorRow, NotificationRow } from '../worker/lib/types';

/**
 * Privacy tests for the public surface: the status page and the webhook payload
 * must never leak credentials, paths or notification secrets.
 */

function monitor(overrides: Partial<MonitorRow> = {}): MonitorRow {
  return {
    id: 'mon_1',
    user_id: 'usr_1',
    name: 'Marketing <site>',
    url: 'https://example.com/internal/admin?token=abc123',
    method: 'GET',
    interval_seconds: 300,
    timeout_ms: 10000,
    expected_status: '200-299',
    failure_threshold: 3,
    recovery_threshold: 1,
    status: 'down',
    enabled: 1,
    is_public: 1,
    public_slug: 'm-abc123',
    consecutive_failures: 4,
    consecutive_successes: 0,
    next_check_at: 0,
    last_check_at: 1_700_000_000_000,
    last_success_at: 1_699_999_000_000,
    last_status_code: 500,
    last_response_ms: null,
    last_error: 'Expected 200-299 but received 500.',
    last_error_kind: 'status',
    current_incident_id: 'inc_1',
    created_at: 1_699_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml('<script>alert("x&y")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;'
    );
  });
});

describe('renderStatusPage', () => {
  const view = {
    id: 'mon_1',
    name: 'Marketing <site>',
    url: 'https://example.com/internal/admin?token=abc123',
    status: 'down',
    availability: 98.5,
    totalChecks: 200,
    failedChecks: 3,
    avgResponseMs: 320,
    lastCheckAt: 1_700_000_000_000,
    lastSuccessAt: 1_699_999_000_000,
    lastStatusCode: 500,
    lastResponseMs: null,
    incidents: [
      {
        startedAt: 1_699_999_000_000,
        resolvedAt: null,
        durationSeconds: 1000,
        cause: 'Unexpected HTTP status',
      },
    ],
    strip: [{ t: 1_700_000_000_000, availability: 100, total: 4 }],
  };

  const html = renderStatusPage({
    title: 'Acme status',
    monitors: [view],
    maintenance: [],
    now: 1_700_000_100_000,
  });

  it('renders a complete HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('viewport');
  });

  it('escapes the monitor name', () => {
    expect(html).toContain('Marketing &lt;site&gt;');
    expect(html).not.toContain('Marketing <site>');
  });

  it('never leaks the full URL with query strings or internal paths', () => {
    expect(html).not.toContain('abc123');
    expect(html).not.toContain('/internal/admin');
    expect(html).toContain('example.com');
  });

  it('never leaks notification secrets or account identifiers', () => {
    expect(html.toLowerCase()).not.toContain('whsec');
    expect(html).not.toContain('usr_1');
    expect(html).not.toContain('authorization');
  });

  it('shows availability and the tail X link', () => {
    expect(html).toContain('98.50%');
    expect(html).toContain('https://x.com/0xkillcoin');
  });
});

describe('renderStatusJson', () => {
  it('returns only hostname, not the path or query', () => {
    const json = renderStatusJson(
      'Acme',
      [
        {
          id: 'mon_1',
          name: 'Marketing',
          url: 'https://example.com/internal/admin?token=abc123',
          status: 'up',
          availability: 100,
          totalChecks: 10,
          failedChecks: 0,
          avgResponseMs: 120,
          lastCheckAt: 1_700_000_000_000,
          lastSuccessAt: 1_700_000_000_000,
          lastStatusCode: 200,
          lastResponseMs: 120,
          incidents: [],
          strip: [],
        },
      ],
      1_700_000_000_000
    );
    expect(json).toContain('example.com');
    expect(json).not.toContain('abc123');
    expect(json).not.toContain('/internal/admin');
    expect(JSON.parse(json).services[0].host).toBe('example.com');
  });

  it('reports overall status', () => {
    const parsed = JSON.parse(renderStatusJson('Acme', [], Date.now()));
    expect(parsed.overall).toBe('empty');
  });
});

describe('buildWebhookPayload', () => {
  it('includes the incident and error but not the signing secret', () => {
    const payload = buildWebhookPayload({
      event: 'down',
      monitor: monitor(),
      incident: {
        id: 'inc_1',
        monitor_id: 'mon_1',
        started_at: 1_699_999_000_000,
        resolved_at: null,
        duration_seconds: null,
        cause: 'status',
        summary: 'Expected 200-299 but received 500.',
        last_status_code: 500,
        peak_response_ms: 800,
        notified_start: 0,
        notified_resolve: 0,
      },
      origin: 'https://sitepulse.example',
    });
    expect(payload.event).toBe('down');
    expect(payload.incident?.durationHuman).toBeTruthy();
    expect(payload.error?.label).toBe('Unexpected HTTP status');
    expect(JSON.stringify(payload)).not.toContain('whsec');
  });

  it('omits the status page link for private monitors', () => {
    const payload = buildWebhookPayload({
      event: 'down',
      monitor: monitor({ is_public: 0 }),
      origin: 'https://sitepulse.example',
    });
    expect(payload.statusPage).toBeNull();
  });
});

describe('describeChannel', () => {
  it('masks the email target and never returns the raw secret', () => {
    const channel: NotificationRow = {
      id: 'ntf_1',
      user_id: 'usr_1',
      monitor_id: null,
      kind: 'email',
      target: 'oncall@example.com',
      secret_enc: null,
      enabled: 1,
      on_down: 1,
      on_recover: 1,
      created_at: 0,
    };
    const described = describeChannel(channel);
    expect(described.target).not.toBe('oncall@example.com');
    expect(described.target).toContain('@example.com');
    expect(JSON.stringify(described)).not.toContain('secret_enc');
  });

  it('reports hasSecret without exposing the value for webhooks', () => {
    const described = describeChannel({
      id: 'ntf_2',
      user_id: 'usr_1',
      monitor_id: null,
      kind: 'webhook',
      target: 'https://hooks.example.com/x',
      secret_enc: 'v1.aaa.bbb',
      enabled: 1,
      on_down: 1,
      on_recover: 1,
      created_at: 0,
    });
    expect(described.hasSecret).toBe(true);
    expect(JSON.stringify(described)).not.toContain('v1.aaa.bbb');
  });
});
