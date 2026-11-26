/**
 * /api/works 两个路由共用的小工具：重复条目的 409 响应、条目依据的读取。
 * 路由文件只能导出 HTTP 方法，所以放在这里；界面只 `import type` 这里的类型。
 */
import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import type { MemoryStatus, WorkEntry } from '@/types';

export interface WorkSourceMemory {
  id: string;
  content: string;
  status: MemoryStatus;
  created_at: string;
}

export interface WorkSourceMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  /** 正文开头一段（空白折叠后约 120 字） */
  excerpt: string;
  created_at: string;
}

export interface WorkSources {
  memories: WorkSourceMemory[];
  messages: WorkSourceMessage[];
}

export type WorkWithSources = WorkEntry & { sources: WorkSources };

/** 撞上已有条目：已移除的提示改为恢复，未移除的提示改为编辑；`code` 给界面选文案，`work` 是撞上的条目。 */
export function workConflictResponse(existing: WorkEntry): NextResponse {
  const dismissed = existing.dismissed_at !== null;
  return NextResponse.json(
    {
      error: dismissed
        ? 'A matching entry was removed; restore it instead'
        : 'A matching entry already exists; edit it instead',
      code: dismissed ? 'work_dismissed' : 'work_exists',
      work: existing,
    },
    { status: 409 },
  );
}

const MESSAGE_EXCERPT_CHARS = 120;

function toExcerpt(content: string): string {
  const chars = Array.from(content.replace(/\s+/g, ' ').trim());
  return chars.length > MESSAGE_EXCERPT_CHARS ? `${chars.slice(0, MESSAGE_EXCERPT_CHARS).join('')}…` : chars.join('');
}

/** 按依据 id 的原顺序排列查到的行；查不到的 id（已删除、或不属于该角色）直接略过。 */
function orderByIds<T extends { id: string }>(ids: readonly string[], rows: readonly T[]): T[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.flatMap(id => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * 读取条目的依据：来源记忆（只限该角色）和来源消息（只限属于该角色对话的消息）。
 * id 列表经 json_each 传入，不受 SQLite 绑定变量个数限制。
 */
export function loadWorkSources(db: Database.Database, work: WorkEntry): WorkSources {
  const memoryRows = work.source_memory_ids.length === 0 ? [] : db.prepare(`
    SELECT id, content, status, created_at FROM memories
    WHERE character_id = ? AND id IN (SELECT value FROM json_each(?))
  `).all(work.character_id, JSON.stringify(work.source_memory_ids)) as WorkSourceMemory[];

  const messageRows = work.source_msg_ids.length === 0 ? [] : db.prepare(`
    SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.character_id = ? AND m.id IN (SELECT value FROM json_each(?))
  `).all(work.character_id, JSON.stringify(work.source_msg_ids)) as Array<Omit<WorkSourceMessage, 'excerpt'> & { content: string }>;

  return {
    memories: orderByIds(work.source_memory_ids, memoryRows),
    messages: orderByIds(work.source_msg_ids, messageRows).map(({ content, ...row }) => ({
      ...row,
      excerpt: toExcerpt(content),
    })),
  };
}
