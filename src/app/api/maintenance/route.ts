import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import {
  collectLocalAssetUrlsFromMetadata,
  collectLocalAssetUrlsFromContent,
  resolveLocalAssetUrl,
} from '@/lib/character-file-utils';

interface OrphanFileStats {
  total: number;
  orphanCount: number;
}

interface OrphanStats {
  orphanMessages: number;
  orphanConversations: number;
  orphanMemories: number;
  orphanMemoryTasks: number;
  orphanFts: number;
  total: number;
  orphanFiles?: {
    avatars: OrphanFileStats;
    attachments: OrphanFileStats;
    generated: OrphanFileStats;
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

function addReferencedFromUrl(url: string, dirName: string, set: Set<string>) {
  const asset = resolveLocalAssetUrl(url);
  if (asset && asset.dir === dirName) set.add(asset.filename);
}

/**
 * 将数组按指定大小切分成多个子数组，用于绕过 SQLite SQLITE_LIMIT_VARIABLE_NUMBER (默认 999) 限制。
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function getReferencedFiles(dirName: string): Set<string> {
  const db = getDb();
  const referenced = new Set<string>();

  if (dirName === 'avatars') {
    const rows = db.prepare('SELECT avatar_url FROM characters WHERE avatar_url IS NOT NULL').all() as { avatar_url: string }[];
    for (const row of rows) {
      addReferencedFromUrl(row.avatar_url, dirName, referenced);
    }
  } else {
    // 分页扫描 messages 表，避免一次性把所有消息拉进内存导致 OOM。
    // 使用 rowid 游标比 LIMIT/OFFSET 更稳定（OFFSET 大时扫描成本会线性增长）。
    const PAGE_SIZE = 1000;
    const stmt = db.prepare(
      'SELECT rowid, content, metadata FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?'
    );
    let lastRowid = 0;
    while (true) {
      const rows = stmt.all(lastRowid, PAGE_SIZE) as {
        rowid: number;
        content: string | null;
        metadata: string | null;
      }[];
      if (rows.length === 0) break;
      for (const row of rows) {
        for (const url of collectLocalAssetUrlsFromMetadata(row.metadata)) {
          addReferencedFromUrl(url, dirName, referenced);
        }
        for (const url of collectLocalAssetUrlsFromContent(row.content)) {
          addReferencedFromUrl(url, dirName, referenced);
        }
      }
      lastRowid = rows[rows.length - 1].rowid;
      if (rows.length < PAGE_SIZE) break;
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
 * 路由内独立鉴权检查（defense in depth）。
 *
 * 为什么要在路由内重做一次：
 *   - middleware 是全局兜底，一旦 PUBLIC_PATHS 配置失误、matcher 漏配，
 *     或未来重构把 /api/maintenance 误划入公开路径，将直接暴露破坏性接口。
 *   - 维护接口（删除孤儿数据 / 文件）属于高危操作，独立校验可以将单点
 *     失误造成的影响降到最低。
 */
async function requireAuth(request: NextRequest): Promise<NextResponse | null> {
  if (!process.env.ACCESS_PASSWORD) return null;
  const { AUTH_COOKIE_NAME, verifyAuthToken } = await import('@/lib/auth-token');
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const valid = await verifyAuthToken(token);
  if (!valid) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }
  return null;
}

/**
 * GET /api/maintenance
 * 预览孤儿数据数量，不实际删除（含文件孤儿）
 */
export async function GET(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const dbStats = countOrphans();
  const scanResults = {
    avatars: await scanOrphanFiles('avatars'),
    attachments: await scanOrphanFiles('attachments'),
    generated: await scanOrphanFiles('generated'),
  };
  const orphanFiles = {
    avatars: { total: scanResults.avatars.total, orphanCount: scanResults.avatars.orphans.length },
    attachments: { total: scanResults.attachments.total, orphanCount: scanResults.attachments.orphans.length },
    generated: { total: scanResults.generated.total, orphanCount: scanResults.generated.orphans.length },
  };
  return NextResponse.json({ ...dbStats, orphanFiles });
}

/**
 * POST /api/maintenance
 * 执行孤儿数据清理（含文件孤儿）
 */
export async function POST(request: NextRequest) {
  // defense in depth：维护接口危险性高，路由内独立鉴权
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

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
      // 分批 DELETE，单批 500 条，留足余量避开 SQLite SQLITE_LIMIT_VARIABLE_NUMBER (默认 999)。
      // 整个 cleanup 已经在外层事务中，所有分批 DELETE 共用同一事务，保持原子性。
      for (const chunk of chunkArray(orphanConvIds, 500)) {
        const placeholders = chunk.map(() => '?').join(',');
        db.prepare(`DELETE FROM messages WHERE conversation_id IN (${placeholders})`).run(...chunk);
        db.prepare(`DELETE FROM memory_tasks WHERE conversation_id IN (${placeholders})`).run(...chunk);
        const convR = db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).run(...chunk);
        deleted += convR.changes;
      }
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
