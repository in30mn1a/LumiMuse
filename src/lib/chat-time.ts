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

/**
 * 后台任务（记忆提取 / 画像更新）拼对话文本用的时间戳，格式 `2026/8/2 01:00`。
 *
 * 与聊天时间戳分开：EXTRACTION_PROMPT 明确告诉模型对话文本里的时间戳长这样，
 * 换格式等于改 prompt 契约，故保持月/日不补零的既有写法。
 *
 * timeZone 来自 settings.client_timezone（浏览器上报）。留空则回退服务器本地时区——
 * 后台任务没有客户端上下文，容器默认 UTC 会让凌晨的对话被记成前一天，
 * 而提取 prompt 要求日期前置写进 content，这个错误会随记忆持久化。
 */
export function formatExtractionTimestamp(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const render = (context?: ChatTimeContext) => {
    const parts = getTimeParts(date, context);
    return `${parts.year}/${Number(parts.month)}/${Number(parts.day)} ${parts.hour}:${parts.minute}`;
  };
  try {
    return render(timeZone ? { timeZone } : undefined);
  } catch {
    // 非法时区（DB 脏数据或手工编辑 settings）不得让后台提取任务抛错——那会让任务重试并丢记忆
    return render();
  }
}

/**
 * 某个 UTC 时刻在目标时区的偏移（毫秒，东为正）。
 * 做法是把该时刻在目标时区的墙上时间当作 UTC 再相减。
 */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(utcMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  ) as Record<string, string>;

  // 某些 locale/ICU 组合会把午夜渲染成 24 时；归一化避免整体多算一天
  const hour = Number(values.hour) % 24;
  const wallClock = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    hour,
    Number(values.minute),
    Number(values.second),
  );
  return wallClock - utcMs;
}

/** 该 year/month/day 是否是真实存在的日历日（拒绝 2 月 30 日这类输入）。与时区无关。 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day;
}

/** 把目标时区的墙上时间转成真正的 UTC 时刻。 */
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): number {
  // 偏移必须用整秒时刻计算：zoneOffsetMs 的 formatToParts 精度只到秒，
  // 若把毫秒一起传进去，偏移会少算这部分，结果整体偏移相同的毫秒数。
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = zoneOffsetMs(guess, timeZone);
  const candidate = guess - firstOffset;
  // DST 跳变附近，用初次偏移修正后落到了另一侧，需要按修正后的时刻重算一次
  const secondOffset = zoneOffsetMs(candidate, timeZone);
  const resolved = secondOffset === firstOffset ? candidate : guess - secondOffset;
  return resolved + ms;
}

/**
 * 把「某时区的某个日历日」转成 UTC 时间范围 [当天 00:00:00.000, 当天 23:59:59.999]。
 *
 * 用于按日期搜索消息：消息的 created_at 存的是 UTC，而用户说的「3月30日」
 * 指的是他本地的那一天。服务器时区（容器默认 UTC）与用户时区不同时，
 * 直接用 new Date(y, m-1, d) 构造会让边界整体偏移，搜出来的结果头尾都不对。
 *
 * timeZone 留空或非法时回退服务器本地时区（即旧行为）。
 * 返回 null 表示该日期不存在。
 */
export function zonedDayRangeToUtc(
  year: number,
  month: number,
  day: number,
  timeZone?: string,
): [string, string] | null {
  if (!isRealCalendarDate(year, month, day)) return null;

  if (timeZone) {
    try {
      const start = zonedWallClockToUtc(year, month, day, 0, 0, 0, 0, timeZone);
      const end = zonedWallClockToUtc(year, month, day, 23, 59, 59, 999, timeZone);
      return [new Date(start).toISOString(), new Date(end).toISOString()];
    } catch {
      // 非法时区回退服务器本地时区，不让搜索直接失败
    }
  }

  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day, 23, 59, 59, 999);
  return [start.toISOString(), end.toISOString()];
}

/** 目标时区的当前年份，用于补全「3月30日」这种省略年份的输入。 */
export function currentYearInZone(timeZone?: string): number {
  const now = new Date();
  if (timeZone) {
    try {
      return Number(
        new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(now),
      );
    } catch {
      // 落到服务器本地年份
    }
  }
  return now.getFullYear();
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
