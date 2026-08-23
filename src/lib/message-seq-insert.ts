import type Database from 'better-sqlite3';
import { buildChainMessageScope, resolveConversationChain } from '@/lib/conversation-chain';

export type AssistantInsertSlot = {
  seq: number;
  createdAt: string;
};

/**
 * 在指定用户消息之后为新 assistant 腾出 seq 槽位，并给出介于锚点与下一条之间的 created_at。
 *
 * 注意：本函数会执行 `UPDATE seq = seq + 1`，**不**自开事务。
 * 调用方必须把本函数与后续 INSERT 包在同一个 `db.transaction(...)` 里，
 * 避免 shift 已提交而 INSERT 失败留下永久空洞。
 *
 * 锚点可能是从父对话继承来的历史消息，shift 也必须覆盖所有实际受影响的分支。
 * 链在调用事务内重新解析，避免 LLM await 期间边界变化后继续使用旧 scope。
 * 锚点不存在或不是 user 时返回 null（不做任何写操作）。
 */
export function allocateAssistantInsertAfterUser(
  db: Database.Database,
  conversationId: string,
  userMessageId: string,
): AssistantInsertSlot | null {
  const chain = resolveConversationChain(db, conversationId);
  const scope = buildChainMessageScope(chain);

  const anchor = db.prepare(`
    SELECT conversation_id, seq, created_at
    FROM messages
    WHERE id = ? AND ${scope.sql} AND role = 'user'
  `).get(userMessageId, ...scope.params) as {
    conversation_id: string;
    seq: number;
    created_at: string;
  } | undefined;
  if (!anchor) return null;

  const nextMessage = db.prepare(`
    SELECT created_at
    FROM messages
    WHERE ${scope.sql} AND seq > ?
    ORDER BY seq ASC
    LIMIT 1
  `).get(...scope.params, anchor.seq) as { created_at: string } | undefined;

  const createdAt = resolveCreatedAtBetween(anchor.created_at, nextMessage?.created_at);

  const anchorOwnerIndex = chain.findIndex(
    segment => segment.conversationId === anchor.conversation_id,
  );
  if (anchorOwnerIndex < 0) {
    throw new Error(`Insert anchor owner is outside conversation chain: ${anchor.conversation_id}`);
  }

  // 当前选中分支在边界恰等于锚点时也要右移自身消息，为新回复腾出槽位。
  // 其它分支只有确实继承了锚点之后的内容（parent_seq_end > anchor.seq）才受影响。
  const selectedPath = new Set(
    chain.slice(anchorOwnerIndex).map(segment => segment.conversationId),
  );
  const shiftedConversationIds = new Set<string>([anchor.conversation_id]);
  const boundariesToShift: string[] = [];
  const queue = [anchor.conversation_id];
  const childStmt = db.prepare(`
    SELECT id, parent_seq_end
    FROM conversations
    WHERE parent_id = ?
  `);

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const parentId = queue[queueIndex];
    const children = childStmt.all(parentId) as Array<{
      id: string;
      parent_seq_end: number | null;
    }>;
    for (const child of children) {
      if (typeof child.parent_seq_end !== 'number'
        || !Number.isInteger(child.parent_seq_end)
        || child.parent_seq_end < 0) {
        throw new Error(`Invalid conversation chain link at: ${child.id}`);
      }
      const inheritsShiftedRange = child.parent_seq_end > anchor.seq;
      if (!inheritsShiftedRange && !selectedPath.has(child.id)) continue;
      if (shiftedConversationIds.has(child.id)) {
        throw new Error(`Conversation chain cycle detected at: ${child.id}`);
      }
      shiftedConversationIds.add(child.id);
      queue.push(child.id);
      if (inheritsShiftedRange) boundariesToShift.push(child.id);
    }
  }

  const shiftMessages = db.prepare(`
    UPDATE messages
    SET seq = seq + 1
    WHERE conversation_id = ? AND seq > ?
  `);
  for (const shiftedId of shiftedConversationIds) {
    shiftMessages.run(shiftedId, anchor.seq);
  }

  const shiftBoundary = db.prepare(`
    UPDATE conversations
    SET parent_seq_end = parent_seq_end + 1
    WHERE id = ?
  `);
  for (const childId of boundariesToShift) {
    shiftBoundary.run(childId);
  }

  return {
    seq: anchor.seq + 1,
    createdAt,
  };
}

function resolveCreatedAtBetween(anchorCreatedAt: string, nextCreatedAt?: string): string {
  if (!nextCreatedAt) return new Date().toISOString();
  const anchorMs = Date.parse(anchorCreatedAt);
  const nextMs = Date.parse(nextCreatedAt);
  if (!Number.isFinite(anchorMs) || !Number.isFinite(nextMs) || nextMs <= anchorMs) {
    return anchorCreatedAt;
  }
  return new Date(Math.floor((anchorMs + nextMs) / 2)).toISOString();
}
