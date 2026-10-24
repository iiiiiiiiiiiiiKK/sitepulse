/**
 * Recovery / flap verification against the live deployment.
 *
 * Scenario
 * ---------
 * 1. Create a monitor whose target currently returns 500, expecting 200-299.
 * 2. Wait for the cron to run → incident must OPEN, status must be `down`.
 * 3. Relax `expectedStatus` to accept 500 → next probe succeeds.
 * 4. Wait for the cron → incident must CLOSE, status must be `up`,
 *    `durationSeconds` must be > 0 and the incident must carry `resolvedAt`.
 *
 * This exercises the real scheduler, the real state machine and the real
 * recovery notification path — not a mocked function.
 */

const BASE = (process.argv[2] || 'https://sitepulse.changyuansex.workers.dev').replace(/\/+$/, '');
import { randomBytes } from 'node:crypto';

let cookie = '';

async function call(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, { ...options, headers, redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: response.status, json, text };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(label, predicate, timeoutMs, intervalMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    console.log(`  waiting for ${label}… (${Math.round((Date.now() - started) / 1000)}s)`);
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const email = `recovery-${Date.now()}@example-mail.test`;
  // Throwaway password, generated per run so no fixed credential lives in the repo.
  const password = `E2e-${randomBytes(8).toString('hex')}-pw`;
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.text.slice(0, 200)}`);
  record('account created', true);

  const created = await call('/api/monitors', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Recovery target',
      url: 'https://httpbin.org/status/500',
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 10000,
      expectedStatus: '200-299',
      failureThreshold: 1,
      recoveryThreshold: 1,
    }),
  });
  const monitor = created.json?.monitor;
  record('monitor created (expects 2xx, target returns 500)', created.status === 201);

  console.log('\nWaiting for the first probe to open an incident…');
  const downState = await poll(
    'incident to open',
    async () => {
      const detail = await call(`/api/monitors/${monitor.id}?range=24h`);
      const m = detail.json?.monitor;
      if (m?.status === 'down' && m?.currentIncidentId) return detail.json;
      return null;
    },
    240_000
  );
  record('monitor went down', downState.monitor.status === 'down', `status=${downState.monitor.status}`);
  record('open incident recorded', Boolean(downState.monitor.currentIncidentId), downState.monitor.currentIncidentId);
  record('incident is unresolved', downState.incidents?.[0]?.resolvedAt === null);

  // Relax the expectation so the same URL now counts as healthy.
  const patched = await call(`/api/monitors/${monitor.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ expectedStatus: '200-599' }),
  });
  record('expectation relaxed to 200-599', patched.status === 200, `expected=${patched.json?.monitor?.expectedStatus}`);

  console.log('\nWaiting for recovery…');
  const upState = await poll(
    'monitor to recover',
    async () => {
      const detail = await call(`/api/monitors/${monitor.id}?range=24h`);
      const m = detail.json?.monitor;
      if (m?.status === 'up' && !m?.currentIncidentId) return detail.json;
      return null;
    },
    300_000
  );
  record('monitor recovered', upState.monitor.status === 'up', `status=${upState.monitor.status}`);
  record('incident cleared from the monitor', upState.monitor.currentIncidentId === null);
  const incident = upState.incidents?.[0];
  record('incident resolved', Boolean(incident?.resolvedAt), new Date(incident?.resolvedAt ?? 0).toISOString());
  record(
    'incident duration measured in seconds',
    typeof incident?.durationSeconds === 'number' && incident.durationSeconds > 0,
    `${incident?.durationSeconds}s`
  );
  record('status page still private', upState.monitor.isPublic === false);

  const reopen = await call(`/api/monitors/${monitor.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ expectedStatus: '200-299' }),
  });
  record('expectation restored', reopen.status === 200);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('recovery check crashed:', error);
  process.exitCode = 1;
});
