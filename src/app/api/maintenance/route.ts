import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

interface OrphanStats {
  orphanMessages: number;
  orphanConversations: number;
  orphanMemories: number;
  orphanMemoryTasks: number;
  orphanFts: number;
  total: number;
  orphanFiles?: {
    avatars: { total: number; orphans: number };
    attachments: { total: number; orphans: number };
    generated: { total: number; orphans: number };
  };
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
 * 从 URL 中提取文件名（如 /api/files/avatars/abc.png → abc.png）
 */
function extractFilename(url: string, dirName: string): string | null {
  const pattern = `/api/files/${dirName}/`;
  const idx = url.indexOf(pattern);
  if (idx === -1) return null;
  const filename = url.slice(idx + pattern.length).split('?')[0]; // 去掉可能的 query string
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;
  return filename;
}

/**
 * 获取指定目录中被 DB 引用的文件集合
 */
function getReferencedFiles(dirName: string): Set<string> {
  const db = getDb();
  const referenced = new Set<string>();

  if (dirName === 'avatars') {
    const rows = db.prepare('SELECT avatar_url FROM characters WHERE avatar_url IS NOT NULL').all() as { avatar_url: string }[];
    for (const row of rows) {
      const filename = extractFilename(row.avatar_url, 'avatars');
      if (filename) referenced.add(filename);
    }
  } else if (dirName === 'attachments') {
    const rows = db.prepare("SELECT metadata FROM messages WHERE metadata IS NOT NULL AND metadata != ''").all() as { metadata: string }[];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata);
        // 检查顶层 attachments
        const attachments = meta.attachments as Array<{ url?: string }> | undefined;
        if (attachments) {
          for (const att of attachments) {
            if (att.url) {
              const filename = extractFilename(att.url, 'attachments');
              if (filename) referenced.add(filename);
            }
          }
        }
        // 也检查版本历史中的 attachments
        const versions = meta.versions as Array<{ content?: string; attachments?: Array<{ url?: string }> }> | undefined;
        if (versions) {
          for (const ver of versions) {
            if (ver.attachments) {
              for (const att of ver.attachments) {
                if (att.url) {
                  const filename = extractFilename(att.url, 'attachments');
                  if (filename) referenced.add(filename);
                }
              }
            }
          }
        }
      } catch {
        // 跳过 JSON 解析失败的行
      }
    }
  } else if (dirName === 'generated') {
    // 从消息内容和版本历史中提取 /api/files/generated/xxx.png 引用
    const rows = db.prepare("SELECT content, metadata FROM messages WHERE content LIKE '%/api/files/generated/%' OR metadata LIKE '%/generated/%'").all() as { content: string; metadata: string | null }[];
    const regex = /\/api\/files\/generated\/([a-f0-9-]+\.\w+)/gi;

    for (const row of rows) {
      // 扫描消息内容
      let match: RegExpExecArray | null;
      while ((match = regex.exec(row.content)) !== null) {
        referenced.add(match[1]);
      }

      // 扫描版本历史中的图片
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          const versions = meta.versions as Array<{ content?: string }> | undefined;
          if (versions) {
            for (const ver of versions) {
              if (ver.content) {
                let vm: RegExpExecArray | null;
                while ((vm = regex.exec(ver.content)) !== null) {
                  referenced.add(vm[1]);
                }
              }
            }
          }
        } catch { /* skip */ }
      }
    }
  }

  return referenced;
}

/**
 * 扫描目录找出不被任何 DB 记录引用的孤儿文件
 */
async function scanOrphanFiles(dirName: string): Promise<{ total: number; orphans: string[] }> {
  const dir = path.join(process.cwd(), 'public', dirName);
  if (!existsSync(dir)) return { total: 0, orphans: [] };

  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter(e => e.isFile()).map(e => e.name);

  const referenced = getReferencedFiles(dirName);
  const orphans = files.filter(f => !referenced.has(f));

  return { total: files.length, orphans };
}

/**
 * GET /api/maintenance
 * 预览孤儿数据数量，不实际删除（含文件孤儿）
 */
export async function GET(_request: NextRequest) {
  const dbStats = countOrphans();
  const orphanFiles = {
    avatars: await scanOrphanFiles('avatars'),
    attachments: await scanOrphanFiles('attachments'),
    generated: await scanOrphanFiles('generated'),
  };
  return NextResponse.json({ ...dbStats, orphanFiles });
}

/**
 * POST /api/maintenance
 * 执行孤儿数据清理（含文件孤儿）
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

  const dbDeleted = cleanup();

  // 6. 清理孤儿文件
  const fileResults: Record<string, { deleted: number; errors: number }> = {};

  for (const dirName of ['avatars', 'attachments', 'generated'] as const) {
    const { orphans } = await scanOrphanFiles(dirName);
    let deleted = 0;
    let errors = 0;

    for (const filename of orphans) {
      try {
        const filepath = path.join(process.cwd(), 'public', dirName, filename);
        await unlink(filepath);
        deleted++;
      } catch {
        errors++;
      }
    }

    fileResults[dirName] = { deleted, errors };
  }

  // 返回清理后的统计
  const after = {
    conversations: (db.prepare('SELECT COUNT(*) as n FROM conversations').get() as { n: number }).n,
    messages: (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n,
    memories: (db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }).n,
    memory_tasks: (db.prepare('SELECT COUNT(*) as n FROM memory_tasks').get() as { n: number }).n,
  };

  return NextResponse.json({ dbDeleted, fileResults, after });
}