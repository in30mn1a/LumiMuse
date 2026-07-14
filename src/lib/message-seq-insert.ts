import type Database from 'better-sqlite3';

export type AssistantInsertSlot = {
  seq: number;
  createdAt: string;
};

/**
 * 在指定用户消息之后插入新的 assistant：后移更大 seq，并给出介于锚点与下一条之间的 created_at。
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

  db.transaction(() => {
    db.prepare(`
      UPDATE messages
      SET seq = seq + 1
      WHERE conversation_id = ? AND seq > ?
    `).run(conversationId, anchor.seq);
  })();

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