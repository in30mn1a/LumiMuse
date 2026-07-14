import type Database from 'better-sqlite3';

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
 * 锚点不存在或不是 user 时返回 null（不做任何写操作）。
 */
export function allocateAssistantInsertAfterUser(
  db: Database.Database,
  conversationId: string,
  userMessageId: string,
): AssistantInsertSlot | null {
  const anchor = db.prepare(`
    SELECT seq, created_at
    FROM messages
    WHERE id = ? AND conversation_id = ? AND role = 'user'
  `).get(userMessageId, conversationId) as { seq: number; created_at: string } | undefined;
  if (!anchor) return null;

  const nextMessage = db.prepare(`
    SELECT created_at
    FROM messages
    WHERE conversation_id = ? AND seq > ?
    ORDER BY seq ASC
    LIMIT 1
  `).get(conversationId, anchor.seq) as { created_at: string } | undefined;

  const createdAt = resolveCreatedAtBetween(anchor.created_at, nextMessage?.created_at);

  db.prepare(`
    UPDATE messages
    SET seq = seq + 1
    WHERE conversation_id = ? AND seq > ?
  `).run(conversationId, anchor.seq);

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
