import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface AgentSession {
  id: string;
  title: string;
  character_id: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentMessageRole = 'user' | 'assistant' | 'tool' | 'event';

export interface AgentMessageRow {
  id: number;
  session_id: string;
  role: AgentMessageRole;
  content: string;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  assistant_fields_json: string | null;
  created_at: string;
}

export interface NewAgentMessage {
  role: AgentMessageRole;
  content: string;
  tool_calls_json?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  assistant_fields_json?: string | null;
}

const SESSION_COLUMNS = 'id, title, character_id, conversation_id, created_at, updated_at';
const TITLE_MAX_CHARS = 40;

/**
 * 新建会话。带对话进入时由对话推出角色；引用的角色或对话不存在就不关联，
 * 免得外键失败让主人连会话都开不了。
 */
export function createAgentSession(
  db: Database.Database,
  input: { title?: string; character_id?: string | null; conversation_id?: string | null },
  now: string,
): AgentSession {
  let characterId: string | null = null;
  let conversationId: string | null = null;
  if (input.conversation_id) {
    const conversation = db.prepare('SELECT id, character_id FROM conversations WHERE id = ?').get(input.conversation_id) as
      | { id: string; character_id: string }
      | undefined;
    if (conversation) {
      conversationId = conversation.id;
      characterId = conversation.character_id;
    }
  }
  if (!characterId && input.character_id) {
    const character = db.prepare('SELECT id FROM characters WHERE id = ?').get(input.character_id) as { id: string } | undefined;
    characterId = character?.id ?? null;
  }
  const session: AgentSession = {
    id: randomUUID(),
    title: (input.title ?? '').trim().slice(0, TITLE_MAX_CHARS),
    character_id: characterId,
    conversation_id: conversationId,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO agent_sessions (id, title, character_id, conversation_id, created_at, updated_at)
    VALUES (@id, @title, @character_id, @conversation_id, @created_at, @updated_at)
  `).run(session);
  return session;
}

export function getAgentSession(db: Database.Database, id: string): AgentSession | null {
  return (db.prepare(`SELECT ${SESSION_COLUMNS} FROM agent_sessions WHERE id = ?`).get(id) as AgentSession | undefined) ?? null;
}

export function listAgentSessions(
  db: Database.Database,
  limit: number,
  offset: number,
): { sessions: AgentSession[]; has_more: boolean } {
  const rows = db.prepare(`
    SELECT ${SESSION_COLUMNS} FROM agent_sessions ORDER BY updated_at DESC, id LIMIT ? OFFSET ?
  `).all(limit + 1, offset) as AgentSession[];
  return { sessions: rows.slice(0, limit), has_more: rows.length > limit };
}

export function renameAgentSession(db: Database.Database, id: string, title: string, now: string): boolean {
  const result = db.prepare('UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?')
    .run(title.trim().slice(0, TITLE_MAX_CHARS), now, id);
  return result.changes > 0;
}

const SESSION_DELETED_REJECT_REASON = '会话已删除';

/**
 * 删除会话，消息随外键级联删除。提案和修订记录因 SET NULL 保留，仍可在修改历史里查看和撤销；
 * 没人能再批准的 pending 项在同一事务里记为拒绝。
 */
export function deleteAgentSession(db: Database.Database, id: string, now: string): boolean {
  return db.transaction(() => {
    db.prepare(`
      UPDATE agent_proposal_items SET state = 'rejected', reject_reason = ?
      WHERE state = 'pending' AND proposal_id IN (SELECT id FROM agent_proposals WHERE session_id = ?)
    `).run(SESSION_DELETED_REJECT_REASON, id);
    db.prepare(`
      UPDATE agent_proposals SET status = 'decided', decided_at = ? WHERE session_id = ? AND status = 'pending'
    `).run(now, id);
    return db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id).changes > 0;
  })();
}

export function touchAgentSession(db: Database.Database, id: string, now: string): void {
  db.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(now, id);
}

export function appendAgentMessage(db: Database.Database, sessionId: string, message: NewAgentMessage, now: string): number {
  const result = db.prepare(`
    INSERT INTO agent_messages
      (session_id, role, content, tool_calls_json, tool_call_id, tool_name, assistant_fields_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    message.role,
    message.content,
    message.tool_calls_json ?? null,
    message.tool_call_id ?? null,
    message.tool_name ?? null,
    message.assistant_fields_json ?? null,
    now,
  );
  return Number(result.lastInsertRowid);
}

/** 保存主人的消息；会话还没有标题时用这条消息的开头命名。 */
export function appendAgentUserMessage(db: Database.Database, sessionId: string, content: string, now: string): number {
  return db.transaction(() => {
    const id = appendAgentMessage(db, sessionId, { role: 'user', content }, now);
    db.prepare(`
      UPDATE agent_sessions SET title = CASE WHEN title = '' THEN ? ELSE title END, updated_at = ? WHERE id = ?
    `).run(content.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS), now, sessionId);
    return id;
  })();
}

export function listAgentMessages(db: Database.Database, sessionId: string): AgentMessageRow[] {
  return db.prepare(`
    SELECT id, session_id, role, content, tool_calls_json, tool_call_id, tool_name, assistant_fields_json, created_at
    FROM agent_messages WHERE session_id = ? ORDER BY id
  `).all(sessionId) as AgentMessageRow[];
}
