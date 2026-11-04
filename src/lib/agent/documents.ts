import type Database from 'better-sqlite3';

/** `agents` 是主人写的 Agents.md，`memory` 是 Agent 自己的 memory.md。 */
export type AgentDocumentKey = 'agents' | 'memory';
export type AgentDocumentSource = 'user' | 'agent';

export const AGENT_DOCUMENT_KEYS: readonly AgentDocumentKey[] = ['agents', 'memory'];

export interface AgentDocument {
  key: AgentDocumentKey;
  content: string;
  updated_at: string | null;
}

export interface AgentDocumentVersion {
  id: number;
  key: AgentDocumentKey;
  content: string;
  source: AgentDocumentSource;
  created_at: string;
}

export function isAgentDocumentKey(value: unknown): value is AgentDocumentKey {
  return value === 'agents' || value === 'memory';
}

export function readAgentDocument(db: Database.Database, key: AgentDocumentKey): AgentDocument {
  const row = db.prepare('SELECT content, updated_at FROM agent_documents WHERE key = ?').get(key) as
    | { content: string; updated_at: string }
    | undefined;
  return { key, content: row?.content ?? '', updated_at: row?.updated_at ?? null };
}

/**
 * 保存文档并追加一个版本。内容没变时不写，避免重复保存刷出无意义的版本。
 * 每个版本保存的是当时的完整内容，最新版本就是当前内容。
 */
export function saveAgentDocument(
  db: Database.Database,
  key: AgentDocumentKey,
  content: string,
  source: AgentDocumentSource,
  now: string,
): AgentDocument {
  return db.transaction(() => {
    const current = readAgentDocument(db, key);
    if (current.updated_at !== null && current.content === content) return current;
    db.prepare(`
      INSERT INTO agent_documents (key, content, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(key, content, now);
    db.prepare('INSERT INTO agent_document_versions (key, content, source, created_at) VALUES (?, ?, ?, ?)')
      .run(key, content, source, now);
    return { key, content, updated_at: now };
  })();
}

export function listAgentDocumentVersions(
  db: Database.Database,
  key: AgentDocumentKey,
  limit: number,
  offset: number,
): { versions: AgentDocumentVersion[]; has_more: boolean } {
  const rows = db.prepare(`
    SELECT id, key, content, source, created_at FROM agent_document_versions
    WHERE key = ? ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(key, limit + 1, offset) as AgentDocumentVersion[];
  return { versions: rows.slice(0, limit), has_more: rows.length > limit };
}

/** 恢复旧版本：把那份内容作为主人的一次新保存，历史不被改写。 */
export function restoreAgentDocumentVersion(
  db: Database.Database,
  key: AgentDocumentKey,
  versionId: number,
  now: string,
): AgentDocument | null {
  const row = db.prepare('SELECT content FROM agent_document_versions WHERE id = ? AND key = ?').get(versionId, key) as
    | { content: string }
    | undefined;
  if (!row) return null;
  return saveAgentDocument(db, key, row.content, 'user', now);
}

/** Agent 只追加自己的笔记；版本与本回合工具记录由调用方一起提交。 */
export function appendAgentMemory(db: Database.Database, content: string, now: string): number {
  return db.transaction(() => {
    const current = readAgentDocument(db, 'memory').content;
    saveAgentDocument(db, 'memory', `${current}${current ? '\n\n' : ''}${content}`, 'agent', now);
    return (db.prepare('SELECT id FROM agent_document_versions WHERE key = ? ORDER BY id DESC LIMIT 1')
      .get('memory') as { id: number }).id;
  })();
}

export type AgentMemoryUndoResult =
  | { ok: true; document: AgentDocument }
  | { ok: false; code: 'not_found' | 'changed' };

/** 只撤销最新一次 Agent 追加；任何后续保存（包括同时间戳）都会阻止覆盖。 */
export function undoAgentMemory(db: Database.Database, versionId: number, now: string): AgentMemoryUndoResult {
  return db.transaction((): AgentMemoryUndoResult => {
    const version = db.prepare('SELECT content, source FROM agent_document_versions WHERE id = ? AND key = ?')
      .get(versionId, 'memory') as { content: string; source: AgentDocumentSource } | undefined;
    if (!version || version.source !== 'agent') return { ok: false, code: 'not_found' };
    const latest = db.prepare('SELECT id FROM agent_document_versions WHERE key = ? ORDER BY id DESC LIMIT 1')
      .get('memory') as { id: number };
    if (latest.id !== versionId || readAgentDocument(db, 'memory').content !== version.content) {
      return { ok: false, code: 'changed' };
    }
    const previous = db.prepare('SELECT content FROM agent_document_versions WHERE key = ? AND id < ? ORDER BY id DESC LIMIT 1')
      .get('memory', versionId) as { content: string } | undefined;
    return { ok: true, document: saveAgentDocument(db, 'memory', previous?.content ?? '', 'user', now) };
  })();
}
