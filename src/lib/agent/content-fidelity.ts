/**
 * Agent 写入记忆正文时的保真检查。纯函数，不引入服务端模块：服务端用来拦截提案，卡片用来标注。
 * 词表与字表都是经验口径，只抓常见问题；常用字写错（如「是否」写成「是吾」）抓不到。
 */

/** 来源与依据说明只该写在 reason 或 evidence.note 里；写进正文会随记忆注入角色聊天。 */
export const SOURCE_NOTE_PHRASES = ['无原文依据', '批量导入', '早期记录', '无具体日期'] as const;

/** 新正文里出现、但来源正文里没有的来源说明词。来源原文本来就有的不算，避免误伤既有正文。 */
export function findSourceNotePhrases(content: string, sources: readonly string[]): string[] {
  return SOURCE_NOTE_PHRASES.filter(phrase => content.includes(phrase) && !sources.some(source => source.includes(phrase)));
}

const QUOTE_PATTERN = /「([^「」]*)」|『([^『』]*)』|“([^“”]*)”|"([^"\n]*)"/g;
const EDGE_PUNCTUATION = /^[\s。．.，,、！!？?…~～]+|[\s。．.，,、！!？?…~～]+$/g;
const MIN_QUOTE_LENGTH = 2;

/** 引号里的原话，去掉首尾空白和标点（句末的「。」常被摘要省掉），按出现顺序去重。 */
export function extractQuotes(text: string): string[] {
  const quotes: string[] = [];
  for (const match of text.matchAll(QUOTE_PATTERN)) {
    const quote = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').replace(EDGE_PUNCTUATION, '');
    if ([...quote].length >= MIN_QUOTE_LENGTH && !quotes.includes(quote)) quotes.push(quote);
  }
  return quotes;
}

/** 来源引号里的原话，没有逐字出现在新正文里的。 */
export function findMissingQuotes(content: string, sources: readonly string[]): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const quote of extractQuotes(source)) {
      if (seen.has(quote)) continue;
      seen.add(quote);
      if (!content.includes(quote)) missing.push(quote);
    }
  }
  return missing;
}

const HANZI = /^[㐀-䶿一-鿿豈-﫿\u{20000}-\u{323af}]$/u;
let commonHanzi: Set<string> | null | undefined;

/**
 * GB2312 一级字表（3755 个常用汉字），用解码器现场生成，不内嵌字表。
 * Node 官方构建与浏览器都支持 gb18030 解码；不支持时返回 null，生僻字检查随之跳过。
 */
function commonHanziSet(): Set<string> | null {
  if (commonHanzi !== undefined) return commonHanzi;
  try {
    const decoder = new TextDecoder('gb18030');
    const set = new Set<string>();
    for (let high = 0xb0; high <= 0xd7; high += 1) {
      for (let low = 0xa1; low <= 0xfe; low += 1) {
        const char = decoder.decode(new Uint8Array([high, low]));
        if (HANZI.test(char)) set.add(char);
      }
    }
    commonHanzi = set.size > 0 ? set : null;
  } catch {
    commonHanzi = null;
  }
  return commonHanzi;
}

/** 新正文里不在常用字表、来源里也没有的汉字，去重保序。多半是错字或模型自己造的字。 */
export function findUnfamiliarChars(content: string, sources: readonly string[]): string[] {
  const common = commonHanziSet();
  if (!common) return [];
  const known = new Set<string>();
  for (const source of sources) for (const char of source) known.add(char);
  const found = new Set<string>();
  for (const char of content) {
    if (HANZI.test(char) && !common.has(char) && !known.has(char)) found.add(char);
  }
  return [...found];
}

/**
 * update、merge 的新正文比最长的来源短了超过这个比例就提示：修正一处说法或合并重复，正文不该大幅变短。
 * 归档摘要本来就会压缩，不查长度。2026-11-06 实跑里一次「只改一处日期」的修改删掉了 70% 正文，正常修改不超过 18%。
 */
export const SHRINK_WARNING_RATIO = 0.3;

export interface ContentShrink {
  /** 最长来源的字数 */
  before: number;
  after: number;
  /** 变短的百分比，取整 */
  percent: number;
}

export function contentShrink(content: string, sources: readonly string[]): ContentShrink | null {
  let before = 0;
  for (const source of sources) before = Math.max(before, [...source].length);
  const after = [...content].length;
  if (before === 0 || after >= before * (1 - SHRINK_WARNING_RATIO)) return null;
  return { before, after, percent: Math.round((1 - after / before) * 100) };
}

export interface ContentFidelityIssues {
  missingQuotes: string[];
  unfamiliarChars: string[];
  shrink: ContentShrink | null;
}

const LENGTH_CHECKED_OPS: ReadonlySet<string> = new Set(['update', 'merge']);

/** 改写类操作（update、merge、archive）的新正文与来源正文比对，只给提示，不阻止提交。 */
export function contentFidelityIssues(op: string, content: string, sources: readonly string[]): ContentFidelityIssues {
  return {
    missingQuotes: findMissingQuotes(content, sources),
    unfamiliarChars: findUnfamiliarChars(content, sources),
    shrink: LENGTH_CHECKED_OPS.has(op) ? contentShrink(content, sources) : null,
  };
}
