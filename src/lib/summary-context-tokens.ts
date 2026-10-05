import { parseMessageMetadata } from '@/lib/messages';

interface ContextTokenMessage {
  id: string;
  token_count: number;
  metadata: unknown;
  seq?: unknown;
}

/** 旧版单批 ID 列表不能作为累计覆盖集合；由调用方回退到 seq 边界。 */
export function getSummaryCoverageIds(metadata: unknown): string[] | undefined {
  const parsed = parseMessageMetadata(metadata);
  return parsed.summaryCoverageVersion === 1 && Array.isArray(parsed.summarizedIds)
    ? parsed.summarizedIds.filter(id => typeof id === 'string')
    : undefined;
}

/** 与聊天上下文一致：最新总结加未覆盖消息；只统计当前已加载的消息。 */
export function countSummaryContextTokens(messages: readonly ContextTokenMessage[]): number {
  const metadata = messages.map(message => parseMessageMetadata(message.metadata));
  let summaryIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (metadata[index].isSummary !== true) continue;
    const seq = messages[index].seq;
    const previousSeq = messages[summaryIndex]?.seq;
    // 持久化消息以 seq 为准；尚无 seq 的本地消息保留列表顺序回退。
    if (summaryIndex < 0 || typeof seq !== 'number' || typeof previousSeq !== 'number' || seq >= previousSeq) {
      summaryIndex = index;
    }
  }
  const summary = messages[summaryIndex];
  const coverage = summary ? getSummaryCoverageIds(summary.metadata) : undefined;
  const coveredIds = coverage ? new Set(coverage) : undefined;
  return messages.reduce((total, message, index) => {
    let included = true;
    if (summary && coveredIds) {
      included = message.id === summary.id || (metadata[index].isSummary !== true && !coveredIds.has(message.id));
    } else if (summary) {
      included = typeof message.seq === 'number' && typeof summary.seq === 'number'
        ? message.seq >= summary.seq
        : index >= summaryIndex;
    }
    return total + (included ? message.token_count || 0 : 0);
  }, 0);
}
