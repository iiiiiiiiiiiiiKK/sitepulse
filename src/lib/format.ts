import { t } from './i18n';
import { getLang, localeTag } from './lang';

/**
 * Formatting helpers.
 *
 * Every human-readable string goes through the active dictionary so switching
 * language changes the UI immediately without a reload, and every date/number is
 * formatted with the matching BCP-47 locale (zh-CN / en-US).
 */

export function formatRelative(timestamp: number | null, now = Date.now()): string {
  if (!timestamp) return t('time.never');
  const diff = Math.round((now - timestamp) / 1000);
  if (diff < 10) return t('time.justNow');
  if (diff < 60) return t('time.secondsAgo', { n: diff });
  if (diff < 3600) return t('time.minutesAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('time.hoursAgo', { n: Math.floor(diff / 3600) });
  return t('time.daysAgo', { n: Math.floor(diff / 86400) });
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const isZh = getLang() === 'zh';
  const unit = (value: number, zh: string, en: string) =>
    isZh ? `${value}${zh}` : `${value}${en}`;

  if (seconds < 60) return unit(Math.round(seconds), '秒', 's');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return isZh
      ? `${minutes}分${Math.round(seconds % 60)}秒`
      : `${minutes}m ${Math.round(seconds % 60)}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return isZh ? `${hours}小时${minutes % 60}分` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return isZh ? `${days}天${hours % 24}小时` : `${days}d ${hours % 24}h`;
}

export function formatDateTime(timestamp: number | null): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return date.toLocaleString(localeTag(), {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(localeTag(), {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(localeTag());
}

export function formatPercent(value: number | null, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return t('common.noData');
  return `${value.toFixed(digits)}%`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return getLang() === 'zh' ? `${Math.round(value)} 毫秒` : `${Math.round(value)} ms`;
}

export function formatInterval(seconds: number): string {
  const isZh = getLang() === 'zh';
  if (seconds < 60) return isZh ? `${seconds} 秒` : `${seconds}s`;
  if (seconds < 3600) {
    return isZh ? `${Math.round(seconds / 60)} 分钟` : `${Math.round(seconds / 60)} min`;
  }
  return isZh ? `${Math.round(seconds / 3600)} 小时` : `${Math.round(seconds / 3600)} h`;
}

export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return url;
  }
}
