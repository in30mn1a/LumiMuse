/** 搜索高亮：按后端返回的精确正文范围切分消息。 */

export interface TextHighlightRange {
  start: number;
  end: number;
  /** 搜索时该范围的原文，用于拒绝消息编辑后的过期坐标。 */
  text: string;
}

export interface TextSegment {
  text: string;
  isMatch: boolean;
}

/**
 * 按后端 FTS / LIKE 搜索得到的原文坐标切分正文。
 * 坐标必须有序、不重叠、未越界，且快照文本必须与当前正文一致；
 * 否则忽略该范围，避免编辑后的旧搜索结果把无关文字标黄。
 */
export function splitByHighlightRanges(
  text: string,
  ranges: readonly TextHighlightRange[],
): TextSegment[] {
  if (!text || ranges.length === 0) return [{ text, isMatch: false }];

  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (
      !Number.isInteger(range.start)
      || !Number.isInteger(range.end)
      || range.start < cursor
      || range.start < 0
      || range.end <= range.start
      || range.end > text.length
      || text.slice(range.start, range.end) !== range.text
    ) {
      continue;
    }

    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), isMatch: false });
    }
    segments.push({ text: range.text, isMatch: true });
    cursor = range.end;
  }

  if (segments.length === 0) return [{ text, isMatch: false }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), isMatch: false });
  return segments;
}
