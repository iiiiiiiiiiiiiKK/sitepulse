import { describe, expect, it } from 'vitest';
import { en, zh, translate } from '../src/lib/i18n';
import { renderStatusPage, resolveStatusLang } from '../worker/routes/statuspage';

/**
 * i18n tests.
 *
 * The dictionary is typed against `en`, so a missing key is already a compile
 * error; these tests additionally guard against empty strings, placeholder
 * mismatches (a `{name}` in English with no counterpart in Chinese renders a
 * literal brace in the UI) and untranslated copy.
 */

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe('dictionary parity', () => {
  it('has the same keys in both languages', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries({ ...en, ...zh })) {
      expect(String(value).trim().length, key).toBeGreaterThan(0);
    }
  });

  it('uses identical placeholders in both languages', () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('actually differs for UI strings (no copy-paste of the English)', () => {
    // These keys carry product meaning and must be translated.
    const mustDiffer: Array<keyof typeof en> = [
      'nav.monitors',
      'nav.signOut',
      'status.up',
      'status.down',
      'status.recovering',
      'status.paused',
      'status.unknown',
      'dash.title',
      'dash.new',
      'detail.availability',
      'detail.downtime',
      'settings.title',
      'auth.submitLogin',
      'landing.ctaPrimary',
    ];
    for (const key of mustDiffer) {
      expect(zh[key], key).not.toBe(en[key]);
    }
  });

  it('keeps the Chinese strings containing CJK characters', () => {
    const cjk = /[\u4e00-\u9fff]/;
    for (const key of ['status.up', 'dash.title', 'detail.downtime'] as const) {
      expect(cjk.test(zh[key]), key).toBe(true);
    }
  });
});

describe('translate', () => {
  it('interpolates placeholders', () => {
    expect(translate('en', 'time.minutesAgo', { n: 7 })).toBe('7m ago');
    expect(translate('zh', 'time.minutesAgo', { n: 7 })).toBe('7 分钟前');
  });

  it('interpolates several placeholders', () => {
    const text = translate('en', 'dash.summary', { total: 3, up: 2, down: 1, paused: 0 });
    expect(text).toBe('3 monitor(s) · 2 operational · 1 down · 0 paused');
  });

  it('leaves unknown placeholders untouched rather than printing undefined', () => {
    expect(translate('en', 'time.minutesAgo').includes('{n}')).toBe(true);
  });

  it('falls back to English for an unknown language', () => {
    // @ts-expect-error deliberately invalid language
    expect(translate('fr', 'status.up')).toBe('Operational');
  });
});

describe('status page language', () => {
  const view = {
    id: 'mon_1',
    name: 'Acme API',
    url: 'https://acme.example.com/health',
    status: 'down',
    availability: 97.5,
    totalChecks: 200,
    failedChecks: 5,
    avgResponseMs: 240,
    lastCheckAt: 1_700_000_000_000,
    lastSuccessAt: 1_699_999_000_000,
    lastStatusCode: 503,
    lastResponseMs: null,
    incidents: [
      {
        startedAt: 1_699_999_000_000,
        resolvedAt: null,
        durationSeconds: 300,
        cause: 'Unexpected HTTP status',
      },
    ],
    strip: [{ t: 1_700_000_000_000, availability: 100, total: 4 }],
  };

  it('resolves ?lang= over Accept-Language', () => {
    const url = new URL('https://x.example/status/m-1?lang=en');
    expect(resolveStatusLang(url, 'zh-CN,zh;q=0.9')).toBe('en');
  });

  it('falls back to Accept-Language', () => {
    const url = new URL('https://x.example/status/m-1');
    expect(resolveStatusLang(url, 'zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh');
    expect(resolveStatusLang(url, 'en-US,en;q=0.9')).toBe('en');
    expect(resolveStatusLang(url, null)).toBe('en');
  });

  it('renders Chinese copy and a Chinese lang attribute when asked', () => {
    const html = renderStatusPage({
      title: 'Acme',
      monitors: [view],
      maintenance: [{ title: '数据库升级', body: '', startsAt: 1, endsAt: 2 }],
      now: 1_700_000_100_000,
      lang: 'zh',
      switchHref: '?lang=en',
    });
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('SitePulse 状态页');
    expect(html).toContain('24 小时可用率');
    expect(html).toContain('故障');
    expect(html).toContain('计划维护');
    expect(html).toContain('98'); // availability digits still present
    expect(html).toContain('href="?lang=en"');
  });

  it('renders English by default with a link to Chinese', () => {
    const html = renderStatusPage({
      title: 'Acme',
      monitors: [view],
      maintenance: [],
      now: 1_700_000_100_000,
      lang: 'en',
      switchHref: '?lang=zh',
    });
    expect(html).toContain('lang="en"');
    expect(html).toContain('SitePulse status');
    expect(html).toContain('24h availability');
    expect(html).toContain('Outage');
    expect(html).toContain('href="?lang=zh"');
    expect(html).toContain('中文');
  });

  it('still escapes user content in both languages', () => {
    for (const lang of ['en', 'zh'] as const) {
      const html = renderStatusPage({
        title: '<script>alert(1)</script>',
        monitors: [{ ...view, name: '<img onerror=x>' }],
        maintenance: [],
        now: 1_700_000_100_000,
        lang,
      });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<img onerror=x>');
      expect(html).toContain('&lt;script&gt;');
    }
  });
});
