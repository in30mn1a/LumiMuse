import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

interface OrphanStats {
  orphanMessages: number;
  orphanConversations: number;
  orphanMemories: number;
  orphanMemoryTasks: number;
  orphanFts: number;
  total: number;
}

function countOrphans(): OrphanStats {
  const db = getDb();

  const orphanMessages = (db.prepare(`
    SELECT COUNT(*) as n FROM messages
    WHERE conversation_id NOT IN (SELECT id FROM conversations)
  `).get() as { n: number }).n;

  const orphanConversations = (db.prepare(`
    SELECT COUNT(*) as n FROM conversations
    WHERE character_id NOT IN (SELECT id FROM characters)
  `).get() as { n: number }).n;

  const orphanMemories = (db.prepare(`
    SELECT COUNT(*) as n FROM memories
    WHERE character_id NOT IN (SELECT id FROM characters)
  `).get() as { n: number }).n;

  const orphanMemoryTasks = (db.prepare(`
    SELECT COUNT(*) as n FROM memory_tasks
    WHERE conversation_id NOT IN (SELECT id FROM conversations)
  `).get() as { n: number }).n;

  let orphanFts = 0;
  try {
    orphanFts = (db.prepare(`
      SELECT COUNT(*) as n FROM messages_fts
      WHERE id NOT IN (SELECT id FROM messages)
    `).get() as { n: number }).n;
  } catch {
    // messages_fts 可能不存在
  }

  return {
    orphanMessages,
    orphanConversations,
    orphanMemories,
    orphanMemoryTasks,
    orphanFts,
    total: orphanMessages + orphanConversations + orphanMemories + orphanMemoryTasks + orphanFts,
  };
}

/**
 * GET /api/maintenance
 * 预览孤儿数据数量，不实际删除
 */
export async function GET(_request: NextRequest) {
  const stats = countOrphans();
  return NextResponse.json(stats);
}

/**
 * POST /api/maintenance
 * 执行孤儿数据清理
 */
export async function POST(_request: NextRequest) {
  const db = getDb();

  const cleanup = db.transaction(() => {
    let deleted = 0;

    // 1. 孤儿消息（对话已删除）
    const msgR = db.prepare(`
      DELETE FROM messages
      WHERE conversation_id NOT IN (SELECT id FROM conversations)
    `).run();
    deleted += msgR.changes;

    // 2. 孤儿对话（角色已删除）——先删其消息和记忆任务，再删对话
    const orphanConvIds = (db.prepare(`
      SELECT id FROM conversations
      WHERE character_id NOT IN (SELECT id FROM characters)
    `).all() as { id: string }[]).map(r => r.id);

    if (orphanConvIds.length > 0) {
      const placeholders = orphanConvIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM messages WHERE conversation_id IN (${placeholders})`).run(...orphanConvIds);
      db.prepare(`DELETE FROM memory_tasks WHERE conversation_id IN (${placeholders})`).run(...orphanConvIds);
      const convR = db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).run(...orphanConvIds);
      deleted += convR.changes;
    }

    // 3. 孤儿记忆（角色已删除）
    const memR = db.prepare(`
      DELETE FROM memories
      WHERE character_id NOT IN (SELECT id FROM characters)
    `).run();
    deleted += memR.changes;

    // 4. 孤儿记忆任务（对话已删除）
    const taskR = db.prepare(`
      DELETE FROM memory_tasks
      WHERE conversation_id NOT IN (SELECT id FROM conversations)
    `).run();
    deleted += taskR.changes;

    // 5. 孤儿 FTS 索引
    try {
      const ftsR = db.prepare(`
        DELETE FROM messages_fts
        WHERE id NOT IN (SELECT id FROM messages)
      `).run();
      deleted += ftsR.changes;
    } catch {
      // messages_fts 可能不存在，忽略
    }

    return deleted;
  });

  const deleted = cleanup();

  // 返回清理后的统计
  const after = {
    conversations: (db.prepare('SELECT COUNT(*) as n FROM conversations').get() as { n: number }).n,
    messages: (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n,
    memories: (db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }).n,
    memory_tasks: (db.prepare('SELECT COUNT(*) as n FROM memory_tasks').get() as { n: number }).n,
  };

  return NextResponse.json({ deleted, after });
}
