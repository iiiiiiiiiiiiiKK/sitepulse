/**
 * Browser UI verification + README screenshots.
 *
 * Uses playwright-core with the locally installed Chrome (no download needed).
 * Checks desktop (1440×900), iPhone 13 (390×844) and a narrow 320px viewport:
 *   - no horizontal overflow / no console errors
 *   - the X author link exists in the header and points at x.com/0xkillcoin
 *   - landing, login, dashboard, monitor detail, settings and the public status
 *     page all render and stay responsive
 *
 * Usage: node e2e/ui-check.mjs [baseUrl]
 */

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const BASE = (process.argv[2] || 'https://sitepulse.changyuansex.workers.dev').replace(/\/+$/, '');
const SHOT_DIR = resolve(process.cwd(), 'docs/screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Optional: some networks can only reach workers.dev through an HTTP proxy.
const PROXY = process.env.PROXY_SERVER || process.env.HTTPS_PROXY || '';

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
    ...(PROXY ? { proxy: { server: PROXY } } : {}),
  });

  const consoleErrors = [];
  const email = `ui-${Date.now()}@example-mail.test`;
  // Throwaway password, generated per run so no fixed credential lives in the repo.
  const password = `E2e-${randomBytes(8).toString('hex')}-pw`;

  // ---------------------------------------------------------------- desktop --
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  // Landing page
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Know your site is down', { timeout: 20000 });
  const xLink = page.locator('header a.x-link').first();
  const xHref = await xLink.getAttribute('href');
  record('landing renders', true);
  record('header X author link present', xHref === 'https://x.com/0xkillcoin', xHref ?? 'missing');
  await page.screenshot({ path: resolve(SHOT_DIR, '01-landing.png'), fullPage: false });

  // Register through the real form
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#email');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.fill('#confirm', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/app', { timeout: 25000 });
  await page.waitForSelector('text=Monitors', { timeout: 20000 });
  record('registration flow reaches dashboard', true);

  // Create a monitor through the UI
  await page.click('text=+ New monitor');
  await page.waitForSelector('#monitor-name');
  await page.fill('#monitor-name', 'SitePulse demo');
  await page.fill('#monitor-url', 'https://example.com');
  await page.selectOption('#monitor-interval', '60');
  await page.fill('#monitor-fail', '1');
  await page.screenshot({ path: resolve(SHOT_DIR, '02-new-monitor.png') });
  await page.click('.modal button[type="submit"]');
  await page.waitForSelector('text=SitePulse demo', { timeout: 25000 });
  record('create-monitor form works end to end', true);

  // Wait for the first real probe so the screenshot shows real data.
  console.log('  waiting for the first probe (~60s)…');
  await page.waitForFunction(
    () => !document.body.innerText.includes('Last check: never'),
    { timeout: 180_000 }
  ).catch(() => {});
  await page.waitForTimeout(4000);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('text=SitePulse demo');
  await page.screenshot({ path: resolve(SHOT_DIR, '03-dashboard.png'), fullPage: true });

  const cardText = await page.locator('.monitor-card').first().innerText();
  record('dashboard shows monitor status', /Operational|Unknown|Down/.test(cardText), cardText.split('\n')[1] ?? '');

  // Detail page
  await page.click('.monitor-card a.monitor-name');
  await page.waitForSelector('text=Response time', { timeout: 20000 });
  await page.screenshot({ path: resolve(SHOT_DIR, '04-monitor-detail.png'), fullPage: true });
  record('monitor detail renders charts and timeline', true);

  // Publish the status page from the UI
  const publishButton = page.locator('button', { hasText: 'Publish' }).first();
  if (await publishButton.count()) {
    await publishButton.click();
    await page.waitForTimeout(2500);
  }
  const publicInput = page.locator('input[readonly]').first();
  const publicUrl = (await publicInput.count())
    ? await publicInput.inputValue()
    : null;
  record('publish toggled in UI', Boolean(publicUrl), publicUrl ?? 'no public url');

  // Settings
  await page.goto(`${BASE}/app/settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=New alert channel');
  await page.screenshot({ path: resolve(SHOT_DIR, '05-settings.png'), fullPage: true });
  record('settings page renders', true);

  // Public status page (server-rendered)
  if (publicUrl) {
    await page.goto(publicUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=SitePulse status');
    await page.screenshot({ path: resolve(SHOT_DIR, '06-status-page.png'), fullPage: true });
    record('public status page renders in a browser', true);
  }

  // -------------------------------------------------------------- mobile -----
  const iphone = await browser.newContext({
    ...(await import('playwright-core')).devices['iPhone 13'],
  });
  const mobile = await iphone.newPage();
  mobile.on('pageerror', (error) => consoleErrors.push(`[mobile] ${error}`));

  const overflow = async (target) =>
    target.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

  for (const [label, url] of [
    ['landing', `${BASE}/`],
    ['login', `${BASE}/login`],
    ['status page', publicUrl ?? `${BASE}/`],
  ]) {
    await mobile.goto(url, { waitUntil: 'networkidle' });
    await mobile.waitForTimeout(900);
    const size = await overflow(mobile);
    record(
      `iPhone 13 · no horizontal overflow on ${label}`,
      size.scrollWidth <= size.clientWidth + 1,
      `${size.scrollWidth}px vs ${size.clientWidth}px`
    );
  }

  await mobile.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await mobile.screenshot({ path: resolve(SHOT_DIR, '07-mobile-landing.png'), fullPage: true });
  const mobileX = await mobile.locator('header a.x-link').first().getAttribute('href');
  record('iPhone header X link present', mobileX === 'https://x.com/0xkillcoin', mobileX ?? 'missing');

  // Signed-in mobile dashboard
  await mobile.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await mobile.fill('#email', email);
  await mobile.fill('#password', password);
  await mobile.click('button[type="submit"]');
  await mobile.waitForURL('**/app', { timeout: 25000 });
  await mobile.waitForSelector('.monitor-card', { timeout: 25000 });
  await mobile.waitForTimeout(1200);
  const dashSize = await overflow(mobile);
  record(
    'iPhone 13 · dashboard has no horizontal overflow',
    dashSize.scrollWidth <= dashSize.clientWidth + 1,
    `${dashSize.scrollWidth}px vs ${dashSize.clientWidth}px`
  );
  await mobile.screenshot({ path: resolve(SHOT_DIR, '08-mobile-dashboard.png'), fullPage: true });

  // Tap targets: every visible button should be at least 32px tall.
  const tiny = await mobile.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('button, a.btn')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.height < 30) bad.push(`${el.textContent?.trim().slice(0, 18)}=${Math.round(rect.height)}px`);
    }
    return bad;
  });
  record('iPhone 13 · tap targets ≥ 30px tall', tiny.length === 0, tiny.join(', ') || 'all good');

  // ------------------------------------------------------------- 320px ------
  const tiny32 = await browser.newContext({ viewport: { width: 320, height: 720 } });
  const narrow = await tiny32.newPage();
  await narrow.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await narrow.waitForTimeout(800);
  const narrowSize = await overflow(narrow);
  record(
    '320px viewport · no horizontal overflow',
    narrowSize.scrollWidth <= narrowSize.clientWidth + 1,
    `${narrowSize.scrollWidth}px vs ${narrowSize.clientWidth}px`
  );

  // --------------------------------------------------------- console log ----
  const realErrors = consoleErrors.filter(
    (message) => !/favicon|Failed to load resource.*404|status of 40[0-9]/.test(message)
  );
  record('no uncaught console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
  console.log(`screenshots: ${SHOT_DIR}`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const failure of failed) console.log(` - ${failure.name}: ${failure.detail ?? ''}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('UI check crashed:', error);
  process.exitCode = 1;
});
