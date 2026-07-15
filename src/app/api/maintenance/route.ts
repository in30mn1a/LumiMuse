import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { readdir, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

/** 孤儿文件最短存活时间：避免误删「已写盘、消息尚未落库」窗口内的上传/生图文件。 */
const ORPHAN_FILE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
import {
  collectLocalAssetUrlsFromMetadata,
  collectLocalAssetUrlsFromContent,
  resolveLocalAssetUrl,
} from '@/lib/character-file-utils';
import { requireAuth } from '@/lib/route-auth';

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
  orphanMemoryProfiles: number;
  orphanMemoryProfileVersions: number;
  orphanMemoryProfileUpdateTasks: number;
  orphanMemoryEmbeddings: number;
  orphanMemoryEmbeddingTasks: number;
  orphanMemoryExtractionCandidates: number;
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

  // 记忆画像相关孤儿（character_id 不在 characters 表）
  const orphanMemoryProfiles = safeCount(db, `
    SELECT COUNT(*) as n FROM character_memory_profiles
    WHERE character_id NOT IN (SELECT id FROM characters)
  `);

  const orphanMemoryProfileVersions = safeCount(db, `
    SELECT COUNT(*) as n FROM character_memory_profile_versions
    WHERE character_id NOT IN (SELECT id FROM characters)
  `);

  const orphanMemoryProfileUpdateTasks = safeCount(db, `
    SELECT COUNT(*) as n FROM character_memory_profile_update_tasks
    WHERE character_id NOT IN (SELECT id FROM characters)
  `);

  // 向量索引孤儿：character_id 不在 characters 表，或 memory_id 不在 memories 表
  const orphanMemoryEmbeddings = safeCount(db, `
    SELECT COUNT(*) as n FROM memory_embeddings
    WHERE character_id NOT IN (SELECT id FROM characters)
       OR memory_id NOT IN (SELECT id FROM memories)
  `);

  const orphanMemoryEmbeddingTasks = safeCount(db, `
    SELECT COUNT(*) as n FROM memory_embedding_tasks
    WHERE character_id NOT IN (SELECT id FROM characters)
       OR memory_id NOT IN (SELECT id FROM memories)
  `);

  const orphanMemoryExtractionCandidates = safeCount(db, `
    SELECT COUNT(*) as n FROM memory_extraction_candidates
    WHERE character_id NOT IN (SELECT id FROM characters)
  `);

  const total =
    orphanMessages +
    orphanConversations +
    orphanMemories +
    orphanMemoryTasks +
    orphanFts +
    orphanMemoryProfiles +
    orphanMemoryProfileVersions +
    orphanMemoryProfileUpdateTasks +
    orphanMemoryEmbeddings +
    orphanMemoryEmbeddingTasks +
    orphanMemoryExtractionCandidates;

  return {
    orphanMessages,
    orphanConversations,
    orphanMemories,
    orphanMemoryTasks,
    orphanFts,
    orphanMemoryProfiles,
    orphanMemoryProfileVersions,
    orphanMemoryProfileUpdateTasks,
    orphanMemoryEmbeddings,
    orphanMemoryEmbeddingTasks,
    orphanMemoryExtractionCandidates,
    total,
  };
}

/**
 * 安全计数：表可能不存在（旧库未迁移），返回 0 而非抛错。
 */
function safeCount(db: ReturnType<typeof getDb>, sql: string): number {
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

/**
 * 安全删除：表可能不存在（旧库未迁移），返回删除行数而非抛错。
 */
function safeDelete(db: ReturnType<typeof getDb>, sql: string): number {
  try {
    return db.prepare(sql).run().changes;
  } catch {
    return 0;
  }
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
  const now = Date.now();
  const orphans: string[] = [];
  for (const filename of files) {
    if (referenced.has(filename)) continue;
    try {
      const info = await stat(path.join(dir, filename));
      // 只清理「够老」的无引用文件，给上传→落库两阶段操作留出宽限期。
      if (now - info.mtimeMs >= ORPHAN_FILE_MIN_AGE_MS) {
        orphans.push(filename);
      }
    } catch {
      // 竞态删除/权限问题：跳过，下次再扫
    }
  }

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

    // 6. 孤儿记忆画像相关数据（character_id 不在 characters 表）
    // 这些表有 ON DELETE CASCADE 外键，正常情况下不会产生孤儿；
    // 但历史上若曾关过 foreign_keys 或通过其他途径写入，可能残留，这里兜底清理。
    deleted += safeDelete(db, `
      DELETE FROM memory_extraction_candidates
      WHERE character_id NOT IN (SELECT id FROM characters)
    `);
    deleted += safeDelete(db, `
      DELETE FROM memory_embedding_tasks
      WHERE character_id NOT IN (SELECT id FROM characters)
         OR memory_id NOT IN (SELECT id FROM memories)
    `);
    deleted += safeDelete(db, `
      DELETE FROM memory_embeddings
      WHERE character_id NOT IN (SELECT id FROM characters)
         OR memory_id NOT IN (SELECT id FROM memories)
    `);
    deleted += safeDelete(db, `
      DELETE FROM character_memory_profile_update_tasks
      WHERE character_id NOT IN (SELECT id FROM characters)
    `);
    deleted += safeDelete(db, `
      DELETE FROM character_memory_profile_versions
      WHERE character_id NOT IN (SELECT id FROM characters)
    `);
    deleted += safeDelete(db, `
      DELETE FROM character_memory_profiles
      WHERE character_id NOT IN (SELECT id FROM characters)
    `);

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
