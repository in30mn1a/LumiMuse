/**
 * 作品片单的纯文本工具：名称归一化、字段上限、类型与状态的说法。
 *
 * 不依赖 Node 内置模块和数据库，服务端（works-catalog.ts、接口、导入、Agent）与
 * 浏览器端（片单编辑器）共用同一份规则，避免两边的校验各写一套、慢慢走样。
 */
import { WORK_STATUSES, WORK_TYPES, type WorkStatus, type WorkType } from '@/types';

/** 各字段的长度上限（字符数）。接口按它校验，自动更新和导入按它截断。 */
export const WORK_FIELD_LIMITS = {
  title: 100,
  alias: 100,
  aliases: 8,
  rating: 16,
  progress: 40,
  note: 60,
} as const;

export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  movie: '电影',
  series: '剧集/动画',
  book: '书',
  game: '游戏',
};

/** 状态的说法随类型变化：书是读过/在读/想读，游戏是玩过/在玩/想玩。 */
export const WORK_STATUS_LABELS: Record<WorkType, Record<WorkStatus, string>> = {
  movie: { watched: '看过', watching: '在看', want: '想看' },
  series: { watched: '看过', watching: '在看', want: '想看' },
  book: { watched: '读过', watching: '在读', want: '想读' },
  game: { watched: '玩过', watching: '在玩', want: '想玩' },
};

export function isWorkType(value: unknown): value is WorkType {
  return typeof value === 'string' && (WORK_TYPES as readonly string[]).includes(value);
}

export function isWorkStatus(value: unknown): value is WorkStatus {
  return typeof value === 'string' && (WORK_STATUSES as readonly string[]).includes(value);
}

/**
 * 匹配用的归一化：NFKC（全角转半角）、转小写，去掉空白、书名号、引号和常见标点。
 * 只用于比较，不改存储的原文。
 */
export function normalizeWorkTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s《》〈〉「」『』【】“”"'‘’`·・:：\-—–_.,，。、!！?？()（）[\]]/gu, '');
}

/** 存储前清理名称：去掉首尾空白和外层书名号。 */
export function cleanWorkTitle(value: string): string {
  const trimmed = value.trim();
  const unwrapped = trimmed.match(/^《(.+)》$/u);
  return (unwrapped ? unwrapped[1] : trimmed).trim();
}

/** 名称去掉书名号、标点和空白后仍有内容才算有效（「《》」这类不算）。 */
export function isUsableWorkTitle(value: string): boolean {
  return normalizeWorkTitle(cleanWorkTitle(value)).length > 0;
}

/** 别名去空、去外层书名号、按归一化结果去重，并排除与规范名相同的叫法。 */
export function cleanWorkAliases(aliases: readonly string[], title: string): string[] {
  const seen = new Set<string>([normalizeWorkTitle(title)]);
  const result: string[] = [];
  for (const raw of aliases) {
    const alias = cleanWorkTitle(raw);
    const key = normalizeWorkTitle(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(alias);
  }
  return result;
}

export function mergeIdLists(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of lists) {
    for (const id of list) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/** 按字段上限截断文本（自动更新、导入用；接口直接拒绝超长输入）。按字符计，不切断代理对。 */
export function clipWorkText(value: string, limit: number): string {
  const chars = Array.from(value.trim());
  return chars.length > limit ? chars.slice(0, limit).join('') : chars.join('');
}
