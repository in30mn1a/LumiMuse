export interface ChatTimeContext {
  clientNowIso?: string;
  timeZone?: string;
  utcOffsetMinutes?: number;
}

export function resolveCurrentTimeContext(
  baseContext: ChatTimeContext | undefined,
  messageCreatedAt?: string,
): ChatTimeContext | undefined {
  if (!baseContext && !messageCreatedAt) return undefined;
  if (!messageCreatedAt) return baseContext;

  const date = new Date(messageCreatedAt);
  if (Number.isNaN(date.getTime())) return baseContext;

  return {
    ...baseContext,
    clientNowIso: date.toISOString(),
  };
}

function formatPartsInTimeZone(date: Date, timeZone: string): { year: string; month: string; day: string; hour: string; minute: string; weekday: string } {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'long',
  });

  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    weekday: values.weekday,
  };
}

function formatPartsWithOffset(date: Date, utcOffsetMinutes: number): { year: string; month: string; day: string; hour: string; minute: string; weekday: string } {
  const shifted = new Date(date.getTime() - utcOffsetMinutes * 60000);
  return {
    year: String(shifted.getUTCFullYear()),
    month: String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    day: String(shifted.getUTCDate()).padStart(2, '0'),
    hour: String(shifted.getUTCHours()).padStart(2, '0'),
    minute: String(shifted.getUTCMinutes()).padStart(2, '0'),
    weekday: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][shifted.getUTCDay()],
  };
}

function formatLocalParts(date: Date): { year: string; month: string; day: string; hour: string; minute: string; weekday: string } {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    hour: String(date.getHours()).padStart(2, '0'),
    minute: String(date.getMinutes()).padStart(2, '0'),
    weekday: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()],
  };
}

function getTimeParts(date: Date, context?: ChatTimeContext) {
  if (context?.timeZone) {
    return formatPartsInTimeZone(date, context.timeZone);
  }

  if (typeof context?.utcOffsetMinutes === 'number' && Number.isFinite(context.utcOffsetMinutes)) {
    return formatPartsWithOffset(date, context.utcOffsetMinutes);
  }

  return formatLocalParts(date);
}

export function formatChatTimestamp(iso: string, context?: ChatTimeContext): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = getTimeParts(date, context);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function buildCurrentTimeInstruction(context?: ChatTimeContext): string {
  const date = context?.clientNowIso ? new Date(context.clientNowIso) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = getTimeParts(safeDate, context);
  const sourceLabel = context?.timeZone
    ? `（用户时区：${context.timeZone}）`
    : typeof context?.utcOffsetMinutes === 'number'
      ? `（用户 UTC 偏移：${context.utcOffsetMinutes} 分钟）`
      : '';

  return `当前用户本地时间是 ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}，${parts.weekday}${sourceLabel}。如果用户询问现在几点、今天几号、星期几等现实时间问题，必须严格依据这个时间回答，不要猜测，也不要引用其他日期。`;
}
