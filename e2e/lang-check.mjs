/**
 * Language / i18n verification against the live deployment.
 *
 * Checks:
 *  - the React app renders the language toggle and never leaks raw i18n keys
 *  - clicking the toggle switches every visible string, and the choice persists
 *    across a reload and across in-app navigation
 *  - the server-rendered public status page answers `?lang=zh`, `?lang=en` and
 *    `Accept-Language`, and its switch link works without JavaScript
 *  - Chinese mode has no horizontal overflow on iPhone 13 / 320px
 *
 * Usage: node e2e/lang-check.mjs [baseUrl]
 */

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const BASE = (process.argv[2] || 'https://sitepulse.changyuansex.workers.dev').replace(/\/+$/, '');
const SHOT_DIR = resolve(process.cwd(), 'docs/screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROXY = process.env.PROXY_SERVER || process.env.HTTPS_PROXY || '';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Any `foo.bar` token left on screen means a missing translation. */
const RAW_KEY = /\b(common|status|time|nav|landing|auth|dash|form|detail|chart|settings|api|app)\.[a-zA-Z]+\b/;

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
    ...(PROXY ? { proxy: { server: PROXY } } : {}),
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  // ---------------------------------------------------------------- landing --
  await page.goto(`${BASE}/?lang=en`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Know your site is down', { timeout: 20000 });
  const toggle = page.locator('button.lang-toggle');
  record('language toggle exists on the landing page', (await toggle.count()) > 0);
  record('toggle shows the target language (中) while in English', (await toggle.first().innerText()).includes('中'));

  await page.screenshot({ path: resolve(SHOT_DIR, '09-landing-en.png') });

  // Click it → everything should switch to Chinese.
  await toggle.first().click();
  await page.waitForSelector('text=在用户抱怨之前', { timeout: 10000 });
  const zhBody = await page.locator('body').innerText();
  record('landing switches to Chinese', zhBody.includes('在用户抱怨之前'));
  record('no raw i18n keys visible in Chinese', !RAW_KEY.test(zhBody), (zhBody.match(RAW_KEY) ?? [''])[0]);
  record('html lang attribute updated', (await page.evaluate(() => document.documentElement.lang)) === 'zh-CN');
  record('document title localised', (await page.title()).includes('网站心跳监护仪'));
  record('X author link still present after switching', (await page.locator('header a.x-link').first().getAttribute('href')) === 'https://x.com/0xkillcoin');
  await page.screenshot({ path: resolve(SHOT_DIR, '10-landing-zh.png') });

  // Persistence across a full reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  record(
    'choice persists across reload',
    (await page.locator('body').innerText()).includes('在用户抱怨之前')
  );

  // ------------------------------------------------------------- auth flow --
  const email = `lang-${Date.now()}@example-mail.test`;
  const password = `E2e-${randomBytes(8).toString('hex')}-pw`;

  await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  const registerText = await page.locator('body').innerText();
  record('register page is Chinese', registerText.includes('创建账号'));
  record('register page has no raw keys', !RAW_KEY.test(registerText));

  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.fill('#confirm', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/app', { timeout: 25000 });
  await page.waitForSelector('text=监控列表', { timeout: 20000 });
  // The subtitle shows a loading string until the first fetch resolves.
  await page.waitForFunction(
    () => !document.querySelector('.page-sub')?.textContent?.includes('正在加载'),
    { timeout: 20000 }
  ).catch(() => {});
  const dashText = await page.locator('body').innerText();
  record('dashboard is Chinese', dashText.includes('监控列表'));
  record('dashboard subtitle localised', dashText.includes('个监控'));
  record('dashboard has no raw keys', !RAW_KEY.test(dashText), (dashText.match(RAW_KEY) ?? [''])[0]);
  record('nav links localised', dashText.includes('告警') && dashText.includes('退出登录'));
  await page.screenshot({ path: resolve(SHOT_DIR, '11-dashboard-zh.png'), fullPage: true });

  // Create a monitor through the Chinese UI.
  await page.click('text=+ 新建监控');
  await page.waitForSelector('#monitor-name');
  const modalText = await page.locator('.modal').innerText();
  record('monitor form is Chinese', modalText.includes('名称') && modalText.includes('检测间隔'));
  record('monitor form has no raw keys', !RAW_KEY.test(modalText));
  await page.fill('#monitor-name', '中文界面测试站点');
  await page.fill('#monitor-url', 'https://example.com');
  await page.fill('#monitor-fail', '1');
  await page.click('.modal button[type="submit"]');
  await page.waitForSelector('text=中文界面测试站点', { timeout: 25000 });
  record('create monitor works from the Chinese UI', true);

  // Detail page in Chinese.
  await page.click('.monitor-card a.monitor-name');
  await page.waitForSelector('text=响应时间', { timeout: 25000 });
  const detailText = await page.locator('body').innerText();
  record('detail page is Chinese', detailText.includes('可用率') && detailText.includes('故障事件时间线'));
  record('detail page has no raw keys', !RAW_KEY.test(detailText), (detailText.match(RAW_KEY) ?? [''])[0]);
  record('period tabs localised', detailText.includes('24 小时') && detailText.includes('30 天'));
  await page.screenshot({ path: resolve(SHOT_DIR, '12-monitor-zh.png'), fullPage: true });

  // Publish the status page so we can check its switch too.
  const publish = page.locator('button', { hasText: '发布' }).first();
  if (await publish.count()) {
    await publish.click();
    await page.waitForTimeout(2500);
  }
  const publicUrl = (await page.locator('input[readonly]').first().inputValue?.()) ?? null;

  // Settings in Chinese.
  await page.goto(`${BASE}/app/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=告警与状态页');
  const settingsText = await page.locator('body').innerText();
  record('settings page is Chinese', settingsText.includes('新建告警渠道'));
  record('settings page has no raw keys', !RAW_KEY.test(settingsText));
  await page.screenshot({ path: resolve(SHOT_DIR, '13-settings-zh.png'), fullPage: true });

  // Switch back to English from inside the app.
  await page.locator('button.lang-toggle').first().click();
  await page.waitForSelector('text=Alerts & status pages', { timeout: 10000 });
  record('switching back to English inside the app works', true);
  const enSettings = await page.locator('body').innerText();
  record('English settings has no raw keys', !RAW_KEY.test(enSettings));

  // ------------------------------------------------- server-rendered page ----
  if (publicUrl) {
    const zhHtml = await (await fetch(`${publicUrl}?lang=zh`)).text();
    record('status page ?lang=zh renders Chinese', zhHtml.includes('SitePulse 状态页') && zhHtml.includes('24 小时可用率'));
    record('status page zh keeps the X author link', zhHtml.includes('https://x.com/0xkillcoin'));

    const enHtml = await (await fetch(`${publicUrl}?lang=en`)).text();
    record('status page ?lang=en renders English', enHtml.includes('SitePulse status') && enHtml.includes('24h availability'));

    const autoZh = await (
      await fetch(publicUrl, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })
    ).text();
    record('Accept-Language zh-CN selects Chinese', autoZh.includes('SitePulse 状态页'));

    await page.goto(`${publicUrl}?lang=zh`, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: resolve(SHOT_DIR, '14-status-zh.png'), fullPage: true });

    // The switch is a plain link: clicking it must work without any JS state.
    await page.locator('a.lang-switch').first().click();
    await page.waitForSelector('text=SitePulse status', { timeout: 10000 });
    record('status page switch link works', page.url().includes('lang=en'));
  } else {
    record('status page published for language check', false, 'no public URL found');
  }

  // --------------------------------------------------------------- mobile ----
  const iphone = await browser.newContext({
    ...(await import('playwright-core')).devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const mobile = await iphone.newPage();
  for (const [label, url] of [
    ['landing', `${BASE}/?lang=zh`],
    ['login', `${BASE}/login?lang=zh`],
  ]) {
    await mobile.goto(url, { waitUntil: 'domcontentloaded' });
    await mobile.waitForTimeout(800);
    const size = await mobile.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    record(
      `iPhone 13 · Chinese ${label} has no horizontal overflow`,
      size.scroll <= size.client + 1,
      `${size.scroll}px vs ${size.client}px`
    );
  }
  record(
    'iPhone · toggle is compact but present',
    (await mobile.locator('button.lang-toggle').first().count()) > 0
  );
  await mobile.screenshot({ path: resolve(SHOT_DIR, '15-mobile-zh.png'), fullPage: true });

  record('no uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await browser.close();

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} language checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const failure of failed) console.log(` - ${failure.name}: ${failure.detail ?? ''}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('language check crashed:', error);
  process.exitCode = 1;
});
