/**
 * Production verification against the live deployment.
 *
 * Usage:  node e2e/production-check.mjs [baseUrl]
 *
 * It exercises the real API with real HTTP: registration, monitor creation
 * (healthy site, 404, 5xx, timeout, DNS failure, redirect chain, SSRF targets),
 * waits for the actual cron trigger to run, then verifies probe rows,
 * incident creation, recovery, statistics, isolation between accounts and the
 * public status page.
 *
 * Requires HTTPS_PROXY/HTTP_PROXY + NODE_USE_ENV_PROXY=1 in environments where
 * workers.dev is only reachable through a local proxy.
 */

import { randomBytes } from 'node:crypto';

const BASE = (process.argv[2] || 'https://sitepulse.changyuansex.workers.dev').replace(/\/+$/, '');
const results = [];
let cookie = '';

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

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
    /* non-JSON (CSV / HTML) */
  }
  return { status: response.status, json, text, headers: response.headers };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs = 150_000, intervalMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${Math.round(timeoutMs / 1000)}s`);
}

async function main() {
  // ---------------------------------------------------------------- public ---
  const health = await call('/healthz');
  record('health endpoint reachable', health.status === 200 && health.json?.ok === true, `HTTP ${health.status}`);

  const home = await call('/');
  record('SPA shell served', home.status === 200 && home.text.includes('id="root"'));

  const missingStatus = await call('/status/does-not-exist');
  record('unknown status page returns 404', missingStatus.status === 404);

  // ------------------------------------------------------------------ auth ---
  const email = `e2e-${Date.now()}@example-mail.test`;
  // Throwaway password, generated per run so no fixed credential lives in the repo.
  const password = `E2e-${randomBytes(8).toString('hex')}-pw`;

  const registered = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  record('register new account', registered.status === 201 && Boolean(registered.json?.user?.id), `HTTP ${registered.status}`);

  const weak = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: `weak-${Date.now()}@example-mail.test`, password: '123456' }),
  });
  record('weak password rejected', weak.status === 400, weak.json?.error?.message);

  const dup = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  record('duplicate email rejected', dup.status === 409, dup.json?.error?.message);

  const me = await call('/api/auth/me');
  record('session cookie authenticates', me.status === 200 && me.json?.user?.email === email);

  // -------------------------------------------------------------- monitors ---
  const targets = [
    { key: 'healthy', name: 'Healthy site', url: 'https://example.com', expected: '200-299', timeout: 10000, threshold: 1, interval: 60 },
    { key: 'notfound', name: '404 page', url: 'https://example.com/sitepulse-missing-page-404', expected: '200-299', timeout: 10000, threshold: 1, interval: 60 },
    { key: 'server', name: '5xx page', url: 'https://httpbin.org/status/500', expected: '200-299', timeout: 10000, threshold: 1, interval: 60 },
    { key: 'redirect', name: 'Redirect chain', url: 'https://httpbin.org/redirect/3', expected: '200-299', timeout: 12000, threshold: 1, interval: 60 },
    { key: 'dnsfail', name: 'DNS failure', url: 'https://this-host-should-not-resolve-2026.com', expected: '200-299', timeout: 10000, threshold: 1, interval: 60 },
  ];

  const created = {};
  for (const target of targets) {
    const response = await call('/api/monitors', {
      method: 'POST',
      body: JSON.stringify({
        name: target.name,
        url: target.url,
        method: 'GET',
        intervalSeconds: target.interval,
        timeoutMs: target.timeout,
        expectedStatus: target.expected,
        failureThreshold: target.threshold,
        recoveryThreshold: 1,
      }),
    });
    created[target.key] = response.json?.monitor;
    record(`create monitor: ${target.name}`, response.status === 201, `HTTP ${response.status} ${response.json?.error?.message ?? ''}`);
  }

  // ------------------------------------------------------- SSRF rejections ---
  const ssrfTargets = [
    ['http://127.0.0.1/', 'loopback'],
    ['http://localhost:8080/', 'localhost'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://10.0.0.1/', 'private /8'],
    ['http://192.168.1.1/', 'private /16'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://metadata.google.internal/', 'GCP metadata host'],
    ['ftp://example.com/', 'non-http scheme'],
    ['https://example.com:22/', 'disallowed port'],
  ];
  for (const [url, label] of ssrfTargets) {
    const response = await call('/api/monitors', {
      method: 'POST',
      body: JSON.stringify({ name: `ssrf ${label}`, url, intervalSeconds: 300, timeoutMs: 5000 }),
    });
    record(`SSRF blocked: ${label}`, response.status === 400, `${url} → HTTP ${response.status}`);
  }

  // -------------------------------------------------- ownership isolation ---
  const otherCookie = cookie;
  const otherEmail = `e2e-other-${Date.now()}@example-mail.test`;
  const other = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: otherEmail, password }),
  });
  record('second account created', other.status === 201);
  const otherMonitors = await call('/api/monitors');
  record(
    'data isolation: second account sees no foreign monitors',
    Array.isArray(otherMonitors.json?.monitors) && otherMonitors.json.monitors.length === 0,
    `saw ${otherMonitors.json?.monitors?.length ?? 'n/a'}`
  );
  const stolen = await call(`/api/monitors/${created.healthy.id}`);
  record('data isolation: foreign monitor not readable', stolen.status === 404, `HTTP ${stolen.status}`);
  const stolenDelete = await call(`/api/monitors/${created.healthy.id}`, { method: 'DELETE' });
  record('data isolation: foreign monitor not deletable', stolenDelete.status === 404, `HTTP ${stolenDelete.status}`);

  // back to the first account
  cookie = otherCookie;
  const relogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  record('re-login works', relogin.status === 200);

  // -------------------------------------------------- wait for real probes ---
  console.log('\nWaiting for the cron trigger to probe the monitors (up to ~3 minutes)…\n');
  await waitFor(
    'all monitors to have a lastCheckAt',
    async () => {
      const list = await call('/api/monitors');
      const monitors = list.json?.monitors ?? [];
      const probed = monitors.filter((monitor) => monitor.lastCheckAt);
      console.log(`  … ${probed.length}/${monitors.length} monitors probed`);
      return probed.length === targets.length ? monitors : null;
    },
    240_000
  );

  const list = await call('/api/monitors');
  const byName = new Map((list.json?.monitors ?? []).map((monitor) => [monitor.name, monitor]));

  const healthy = byName.get('Healthy site');
  record('healthy site reported up', healthy?.status === 'up', `status=${healthy?.status} http=${healthy?.lastStatusCode}`);
  record('healthy site recorded a 2xx status code', (healthy?.lastStatusCode ?? 0) === 200, `HTTP ${healthy?.lastStatusCode}`);
  record('healthy site recorded a response time', typeof healthy?.lastResponseMs === 'number' && healthy.lastResponseMs > 0, `${healthy?.lastResponseMs} ms`);

  const notFound = byName.get('404 page');
  record('404 page reported down', notFound?.status === 'down', `status=${notFound?.status}`);
  record('404 page error kind is status', notFound?.lastErrorKind === 'status', notFound?.lastError ?? '');
  record('404 page records HTTP 404', notFound?.lastStatusCode === 404, `HTTP ${notFound?.lastStatusCode}`);

  const serverError = byName.get('5xx page');
  record('5xx page reported down', serverError?.status === 'down', `status=${serverError?.status}`);

  const redirect = byName.get('Redirect chain');
  record('redirect target resolved (not a redirect error)', redirect?.status !== 'unknown', `status=${redirect?.status} err=${redirect?.lastErrorKind ?? 'none'}`);

  const dns = byName.get('DNS failure');
  record('DNS failure detected', dns?.status === 'down' && dns?.lastErrorKind === 'dns', `status=${dns?.status} kind=${dns?.lastErrorKind}`);

  // ------------------------------------------------------------ incidents ---
  const detail = await call(`/api/monitors/${created.notfound.id}?range=24h`);
  record('monitor detail returns stats', detail.status === 200 && typeof detail.json?.stats === 'object');
  record(
    'incident opened for the failing monitor',
    Array.isArray(detail.json?.incidents) && detail.json.incidents.length >= 1,
    `${detail.json?.incidents?.length ?? 0} incident(s)`
  );
  const incident = detail.json?.incidents?.[0];
  record('incident has a start time', typeof incident?.startedAt === 'number');
  record('incident is unresolved while failing', incident?.resolvedAt === null);
  record('incident duration is measured', typeof incident?.durationSeconds === 'number' && incident.durationSeconds >= 0, `${incident?.durationSeconds}s`);
  record(
    'availability reflects the failures',
    typeof detail.json?.stats?.availability === 'number' && detail.json.stats.availability < 100,
    `${detail.json?.stats?.availability}%`
  );
  record('probe samples stored', (detail.json?.stats?.totalChecks ?? 0) >= 1, `${detail.json?.stats?.totalChecks} probes`);
  record('bucket series returned', Array.isArray(detail.json?.buckets) && detail.json.buckets.length > 0);

  // ---------------------------------------------------- pause / lifecycle ---
  const paused = await call(`/api/monitors/${created.healthy.id}/pause`, { method: 'POST' });
  record('pause monitor', paused.status === 200 && paused.json?.monitor?.status === 'paused', `status=${paused.json?.monitor?.status}`);
  const resumed = await call(`/api/monitors/${created.healthy.id}/resume`, { method: 'POST' });
  record('resume monitor', resumed.status === 200 && resumed.json?.monitor?.status === 'unknown', `status=${resumed.json?.monitor?.status}`);

  const checkNow = await call(`/api/monitors/${created.healthy.id}/check-now`, { method: 'POST' });
  record('manual check queued or deduped', checkNow.status === 200 || checkNow.status === 409, `HTTP ${checkNow.status} ${checkNow.json?.error?.message ?? checkNow.json?.message ?? ''}`);

  const secondCheckNow = await call(`/api/monitors/${created.healthy.id}/check-now`, { method: 'POST' });
  record(
    'duplicate manual check is prevented',
    secondCheckNow.status === 409,
    `HTTP ${secondCheckNow.status}`
  );

  // -------------------------------------------------------------- exports ---
  const csv = await fetch(`${BASE}/api/monitors/${created.notfound.id}/export?format=csv&range=24h`, {
    headers: { cookie },
  });
  const csvText = await csv.text();
  record('CSV export returns data rows', csv.status === 200 && csvText.split('\n').length > 1, `${csvText.split('\n').length - 1} rows`);
  record('CSV has the expected header', csvText.startsWith('checked_at_iso,ok,status_code'));

  const jsonExport = await call(`/api/monitors/${created.notfound.id}/export?format=json&range=24h`);
  record('JSON export parses', jsonExport.status === 200 && Array.isArray(jsonExport.json?.checks));

  // --------------------------------------------------------- status pages ---
  const publish = await call(`/api/monitors/${created.healthy.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ isPublic: true }),
  });
  record('publish status page', publish.status === 200 && publish.json?.monitor?.isPublic === true);

  const slug = publish.json?.monitor?.publicSlug;
  const statusHtml = await fetch(`${BASE}/status/${slug}`);
  const statusText = await statusHtml.text();
  record('public status page renders HTML', statusHtml.status === 200 && statusText.includes('SitePulse status'));
  record('status page shows the monitor name', statusText.includes('Healthy site'));
  record('status page links the author X account', statusText.includes('https://x.com/0xkillcoin'));
  record('status page does not leak the session cookie', !statusText.includes('sp_session'));

  const statusJson = await fetch(`${BASE}/api/status/${slug}`);
  const statusJsonBody = await statusJson.json();
  record('public status JSON endpoint', statusJson.status === 200 && statusJsonBody?.services?.length === 1);

  // A private monitor must not be readable via the status endpoint.
  const privateSlug = byName.get('404 page')?.publicSlug;
  const privateStatus = await fetch(`${BASE}/status/${privateSlug}`);
  record('private monitor has no public page', privateStatus.status === 404, `HTTP ${privateStatus.status}`);

  // ---------------------------------------------------------- notifications ---
  const channel = await call('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'webhook',
      target: 'https://httpbin.org/post',
      secret: 'whsec_e2e_signing_secret',
      onDown: true,
      onRecover: true,
    }),
  });
  record('create signed webhook channel', channel.status === 201 && channel.json?.channel?.hasSecret === true, `HTTP ${channel.status}`);
  record('channel secret is masked in the API response', channel.json?.channel?.secretMask?.includes('•') === true);
  record(
    'raw secret never returned',
    !JSON.stringify(channel.json).includes('whsec_e2e_signing_secret')
  );

  const testDelivery = await call(`/api/notifications/${channel.json.channel.id}/test`, { method: 'POST' });
  const outcome = testDelivery.json?.outcomes?.[0];
  record('test notification attempted with a real result', Boolean(outcome?.status), `status=${outcome?.status} detail=${outcome?.detail}`);

  const emailChannel = await call('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ kind: 'email', target: 'oncall@example.com' }),
  });
  record('email channel created', emailChannel.status === 201, `HTTP ${emailChannel.status}`);
  const emailTest = await call(`/api/notifications/${emailChannel.json.channel.id}/test`, { method: 'POST' });
  const emailOutcome = emailTest.json?.outcomes?.[0];
  record(
    'email without provider reports skipped (never fakes success)',
    emailOutcome?.status === 'skipped',
    `${emailOutcome?.status}: ${emailOutcome?.detail}`
  );

  // ------------------------------------------------------------ maintenance ---
  const maintenance = await call('/api/maintenance', {
    method: 'POST',
    body: JSON.stringify({
      title: 'E2E maintenance window',
      body: 'Verifying that announcements reach the public status page.',
      startsAt: Date.now() - 60_000,
      endsAt: Date.now() + 3_600_000,
    }),
  });
  record('create maintenance announcement', maintenance.status === 201);
  const statusWithMaintenance = await (await fetch(`${BASE}/status/${slug}`)).text();
  record('maintenance appears on the status page', statusWithMaintenance.includes('E2E maintenance window'));

  // -------------------------------------------------------------- security ---
  const anon = await fetch(`${BASE}/api/monitors`);
  record('unauthenticated API access rejected', anon.status === 401, `HTTP ${anon.status}`);

  const badJson = await fetch(`${BASE}/api/monitors`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{not json',
  });
  record('malformed JSON rejected', badJson.status === 400, `HTTP ${badJson.status}`);

  const headers = (await fetch(`${BASE}/`)).headers;
  record('security headers present', headers.get('x-content-type-options') === 'nosniff');

  const logout = await call('/api/auth/logout', { method: 'POST' });
  record('logout works', logout.status === 200);
  const afterLogout = await fetch(`${BASE}/api/monitors`, { headers: { cookie } });
  record('session invalid after logout', afterLogout.status === 401, `HTTP ${afterLogout.status}`);

  // ---------------------------------------------------------------- report ---
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const failure of failed) console.log(` - ${failure.name}: ${failure.detail ?? ''}`);
    process.exitCode = 1;
  }
  return { results, email, monitors: created };
}

main().catch((error) => {
  console.error('E2E run crashed:', error);
  process.exitCode = 1;
});
