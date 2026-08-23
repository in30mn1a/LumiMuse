import type Database from 'better-sqlite3';
import type { Message } from '@/types';
import type { ChainScope, ChainSegment } from '@/lib/conversation-chain';
import {
  ascendingMessageOrderSqlForChain,
  buildChainMessageScope,
  resolveConversationChain,
} from '@/lib/conversation-chain';
import { isMessageMemoryExtracted, serializeTypedMessages } from '@/lib/messages';

// 与 JavaScript truthiness 语义保持一致：memory_extracted 的非空字符串、
// 非零数字、true、数组或对象均视为已处理；noop 时间戳必须是字符串。
export const MEMORY_PROCESSED_SQL = `
  CASE WHEN json_valid(metadata) THEN
    CASE
      WHEN json_type(metadata, '$.memory_noop_extracted_at') = 'text' THEN 1
      WHEN json_type(metadata, '$.memory_extracted') = 'true' THEN 1
      WHEN json_type(metadata, '$.memory_extracted') IN ('integer', 'real')
        AND json_extract(metadata, '$.memory_extracted') != 0 THEN 1
      WHEN json_type(metadata, '$.memory_extracted') = 'text'
        AND json_extract(metadata, '$.memory_extracted') != '' THEN 1
      WHEN json_type(metadata, '$.memory_extracted') IN ('array', 'object') THEN 1
      ELSE 0
    END
  ELSE 0 END
`;

export function isMemoryProcessed(message: Message): boolean {
  return isMessageMemoryExtracted(message.metadata);
}

export type PendingMemoryExtractionBatch = {
  chain: ChainSegment[];
  scope: ChainScope;
  unprocessedUsers: Message[];
  extractionMessages: Message[];
};

/**
 * 读取当前对话视图中从最早未处理 user 开始的后缀，并组装提取批次。
 * 链式对话的祖先消息仍是同一物理行，因此这里只展开可见范围，不复制消息。
 */
export function loadPendingMemoryExtractionBatch(
  db: Database.Database,
  conversationId: string,
): PendingMemoryExtractionBatch {
  const chain = resolveConversationChain(db, conversationId);
  const scope = buildChainMessageScope(chain);
  const orderSql = ascendingMessageOrderSqlForChain(chain);
  const earliestUnprocessed = db.prepare(`
    SELECT id, created_at, seq
    FROM messages
    WHERE ${scope.sql}
      AND role = 'user'
      AND NOT (${MEMORY_PROCESSED_SQL})
    ORDER BY ${orderSql}
    LIMIT 1
  `).get(...scope.params) as { id: string; created_at: string; seq: number } | undefined;

  if (!earliestUnprocessed) {
    return { chain, scope, unprocessedUsers: [], extractionMessages: [] };
  }

  const linkedView = chain.length > 1;
  const suffixPredicate = linkedView
    ? '(seq, created_at, id) >= (?, ?, ?)'
    : '(created_at > ? OR (created_at = ? AND seq >= ?))';
  const suffixParams = linkedView
    ? [earliestUnprocessed.seq, earliestUnprocessed.created_at, earliestUnprocessed.id]
    : [earliestUnprocessed.created_at, earliestUnprocessed.created_at, earliestUnprocessed.seq];
  const suffixMessages = serializeTypedMessages(
    db.prepare(`
      SELECT * FROM messages
      WHERE ${scope.sql}
        AND ${suffixPredicate}
      ORDER BY ${orderSql}
    `).all(
      ...scope.params,
      ...suffixParams,
    ) as Message[],
  );

  const unprocessedUsers = suffixMessages.filter(
    message => message.role === 'user' && !isMemoryProcessed(message),
  );
  const unprocessedUserIds = new Set(unprocessedUsers.map(message => message.id));
  const extractionMessages: Message[] = [];
  let includeNextAssistant = false;

  for (const message of suffixMessages) {
    if (message.metadata.isSummary) continue;
    if (unprocessedUserIds.has(message.id)) {
      extractionMessages.push(message);
      includeNextAssistant = true;
    } else if (includeNextAssistant && message.role === 'assistant') {
      if (!isMemoryProcessed(message)) extractionMessages.push(message);
      includeNextAssistant = false;
    } else {
      includeNextAssistant = false;
    }
  }

  return { chain, scope, unprocessedUsers, extractionMessages };
}
