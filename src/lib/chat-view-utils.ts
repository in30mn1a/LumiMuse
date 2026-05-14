import type { Message } from '@/types';

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatDateLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();

  if (isSameCalendarDay(date, now)) return '今天';

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return '昨天';

  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (diffDays < 7) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return weekdays[date.getDay()];
  }

  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function isSameDay(a: string, b: string): boolean {
  return isSameCalendarDay(new Date(a), new Date(b));
}

export function getVersionInfo(message: Message): { total: number; active: number } | undefined {
  const meta = message.metadata as Record<string, unknown> | undefined;
  if (!meta?.versions) return undefined;
  const versions = meta.versions as Array<{ content: string; token_count: number }>;
  return { total: versions.length, active: (meta.activeVersion as number) ?? 0 };
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
