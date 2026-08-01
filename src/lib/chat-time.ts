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

interface TimeParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  /** 缩写星期（Sun/Mon/…），用于每条消息的时间戳前缀 */
  weekdayShort: string;
  /** 全称星期（Sunday/Monday/…），用于系统提示中的当前时间说明 */
  weekdayLong: string;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayNames(dayIndex: number): { weekdayShort: string; weekdayLong: string } {
  return { weekdayShort: WEEKDAY_SHORT[dayIndex], weekdayLong: WEEKDAY_LONG[dayIndex] };
}

function formatPartsInTimeZone(date: Date, timeZone: string): TimeParts {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  // 星期由已解析出的目标时区日历日期反推，而不是再建一个 en-US formatter：
  // y/m/d 已是该时区的本地日期，用 Date.UTC 重建后取 getUTCDay 即为该地星期。
  // 避免 en-US + hour12:false 在午夜输出 "24:00"（zh-CN 输出 "00:00"）的 ICU 差异。
  const dayIndex = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day))).getUTCDay();

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    ...weekdayNames(dayIndex),
  };
}

function formatPartsWithOffset(date: Date, utcOffsetMinutes: number): TimeParts {
  const shifted = new Date(date.getTime() - utcOffsetMinutes * 60000);
  return {
    year: String(shifted.getUTCFullYear()),
    month: String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    day: String(shifted.getUTCDate()).padStart(2, '0'),
    hour: String(shifted.getUTCHours()).padStart(2, '0'),
    minute: String(shifted.getUTCMinutes()).padStart(2, '0'),
    ...weekdayNames(shifted.getUTCDay()),
  };
}

function formatLocalParts(date: Date): TimeParts {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    hour: String(date.getHours()).padStart(2, '0'),
    minute: String(date.getMinutes()).padStart(2, '0'),
    ...weekdayNames(date.getDay()),
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
  return `${parts.year}-${parts.month}-${parts.day} ${parts.weekdayShort} ${parts.hour}:${parts.minute}`;
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

  return `当前用户本地时间是 ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}，${parts.weekdayLong}${sourceLabel}。如果用户询问现在几点、今天几号、星期几等现实时间问题，必须严格依据这个时间回答，不要猜测，也不要引用其他日期。`;
}
