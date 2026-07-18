import Database from 'better-sqlite3';
import { structuredLog } from '@/lib/structured-log';
import path from 'path';
import fs from 'fs';
import { inferMemoryDefaults } from '@/lib/memory-category';
import {
  ensureMemoryEmbeddingForeignKeys,
  MEMORY_EMBEDDING_DEDUPLICATION_DML,
  MEMORY_EMBEDDING_INDEX_DDL,
  MEMORY_EMBEDDING_TABLE_DDL,
} from '@/lib/memory-embedding-schema';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'lumimuse.db');
export const CURRENT_SCHEMA_VERSION = 1;

let _db: Database.Database | null = null;

function backfillMemoryDefaults(
  db: Database.Database,
  needsMemoryKindBackfill: boolean,
  needsImportanceBackfill: boolean,
  needsEmotionalWeightBackfill: boolean,
): void {
  // 始终可重复：NULL/空值必补；列默认值(general/0.5/0.0)在对应开关打开时按 category 重推断。
  // 对已人工改过、且不是列默认值的行不会覆盖。
  const rows = db.prepare(`
    SELECT id, category, memory_kind, importance, emotional_weight
    FROM memories
    WHERE memory_kind IS NULL
       OR memory_kind = ''
       OR importance IS NULL
       OR emotional_weight IS NULL
       OR (? AND memory_kind = 'general')
       OR (? AND importance = 0.5)
       OR (? AND emotional_weight = 0.0)
  `).all(
    needsMemoryKindBackfill ? 1 : 0,
    needsImportanceBackfill ? 1 : 0,
    needsEmotionalWeightBackfill ? 1 : 0,
  ) as Array<{
    id: string;
    category: string;
    memory_kind: string | null;
    importance: number | null;
    emotional_weight: number | null;
  }>;

  const update = db.prepare(`
    UPDATE memories
    SET memory_kind = ?,
        importance = ?,
        emotional_weight = ?
    WHERE id = ?
  `);

  const writeDefaults = db.transaction(() => {
    for (const row of rows) {
      const defaults = inferMemoryDefaults(row.category);
      const nextKind = (!row.memory_kind || row.memory_kind === '' || (needsMemoryKindBackfill && row.memory_kind === 'general'))
        ? defaults.memory_kind
        : row.memory_kind;
      const nextImportance = (row.importance === null || (needsImportanceBackfill && row.importance === 0.5))
        ? defaults.importance
        : row.importance;
      const nextEmotional = (row.emotional_weight === null || (needsEmotionalWeightBackfill && row.emotional_weight === 0.0))
        ? defaults.emotional_weight
        : row.emotional_weight;

      // 跳过无变化的行，避免把已是正确 category 默认值的记忆反复 UPDATE
      if (
        nextKind === row.memory_kind
        && nextImportance === row.importance
        && nextEmotional === row.emotional_weight
      ) {
        continue;
      }

      update.run(nextKind, nextImportance, nextEmotional, row.id);
    }
  });

  writeDefaults();
}

export function __migrateForTests(db: Database.Database): void {
  migrate(db);
}

/** 测试专用：关闭并清空模块级单例，避免用例之间串库。 */
export function __resetDbForTests(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore close errors in tests */ }
  }
  _db = null;
}

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  // 先用局部变量建连并 migrate；全部成功后再赋给 _db。
  // 若 migrate 中途抛错（含 user_version 前向拒绝），不得把半迁移连接留在单例里，
  // 否则后续 getDb() 会直接返回坏连接，fail-fast 只挡第一个请求。
  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // 记忆系统有多处后台并发写（embedding drain、profile 队列、提取队列，甚至跨进程）。
    // 默认 busy_timeout=0 会在撞写锁时立即抛 SQLITE_BUSY；设为 5s 让写入短暂等待重试而非直接失败。
    db.pragma('busy_timeout = 5000');
    migrate(db);
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    throw err;
  }
  _db = db;

  // 生产环境未设置访问密码时发出警告：proxy.ts 与 /api/auth 都会在 ACCESS_PASSWORD 缺失时直接放行，
  // 这是本地开发模式的有意设计；但生产部署若忘记配置，会导致整个应用无鉴权暴露。
  if (process.env.NODE_ENV === 'production' && !process.env.ACCESS_PASSWORD) {
    console.warn(
      '[lumimuse] WARNING: ACCESS_PASSWORD is not set in production mode. ' +
      'All routes are publicly accessible. Set ACCESS_PASSWORD env var to enable authentication.'
    );
  }

  // 服务启动时把上次崩溃遗留的 processing 任务重置为 pending
  // 延迟 import 避免循环依赖（memory-queue → db → memory-queue）
  // recoverStale* 仅回收已超过租约窗口的 processing（崩溃孤儿）；另一实例 in-flight 任务不会被抢回。
  setImmediate(() => {
    import('@/lib/memory-queue').then(({ recoverStaleTasks, triggerQueue }) => {
      recoverStaleTasks();
      triggerQueue();
    }).catch((err) => {
      // 不静默吞错：启动期失败必须可见，否则记忆队列恢复出问题用户根本无从察觉
      structuredLog('error', 'memory.queue.boot_failed', {
        operation: 'recover_and_drain', status: 'failed',
      }, err);
    });
    // 画像更新队列同样需要启动恢复 + 触发处理（与提取队列对称），独立 import 避免互相影响
    import('@/lib/memory-profile').then(({ recoverStaleMemoryProfileTasks, triggerMemoryProfileQueue }) => {
      recoverStaleMemoryProfileTasks();
      triggerMemoryProfileQueue();
    }).catch((err) => {
      structuredLog('error', 'memory.profile.boot_failed', {
        operation: 'recover_and_drain', status: 'failed',
      }, err);
    });
    // 向量索引任务：启动时回收过期 processing，并像提取/画像队列一样尝试触发 drain。
    // 仅 recover 不 trigger 时，若用户之后只聊天不产生新记忆写入，pending 可能长期闲置。
    // drain 自带 config 缺失短路与 claim_token 守卫，启动触发是安全的。
    import('@/lib/memory-embeddings').then(async ({ recoverStaleMemoryEmbeddingTasks }) => {
      recoverStaleMemoryEmbeddingTasks();
      try {
        const { triggerMemoryIndexProcessing } = await import('@/lib/memory-index-trigger');
        triggerMemoryIndexProcessing();
      } catch (triggerErr) {
        structuredLog('error', 'memory.embedding.boot_trigger_failed', {
          operation: 'trigger_drain', status: 'failed',
        }, triggerErr);
      }
    }).catch((err) => {
      structuredLog('error', 'memory.embedding.recovery_failed', {
        operation: 'recover_stale', status: 'failed',
      }, err);
    });
  });

  return _db;
}

export function ensureMemoryProfileTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_memory_profiles (
      character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
      profile_name TEXT NOT NULL DEFAULT '',
      relationship_state TEXT NOT NULL DEFAULT '',
      recent_story_state TEXT NOT NULL DEFAULT '',
      emotional_baseline TEXT NOT NULL DEFAULT '',
      open_threads TEXT NOT NULL DEFAULT '[]',
      user_profile_summary TEXT NOT NULL DEFAULT '',
      pinned_summary TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS character_memory_profile_update_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      patch_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claim_token TEXT,
      lease_expires_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS character_memory_profile_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      task_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memory_profile_update_tasks_character_status
      ON character_memory_profile_update_tasks(character_id, status);
    CREATE INDEX IF NOT EXISTS idx_memory_profile_versions_character
      ON character_memory_profile_versions(character_id, version_number DESC);
  `);

  const profileCols = db.prepare("PRAGMA table_info(character_memory_profiles)").all() as { name: string }[];
  if (profileCols.length > 0 && !profileCols.some(c => c.name === 'profile_name')) {
    db.exec(`ALTER TABLE character_memory_profiles ADD COLUMN profile_name TEXT NOT NULL DEFAULT ''`);
  }

  const taskCols = db.prepare("PRAGMA table_info(character_memory_profile_update_tasks)").all() as { name: string }[];
  if (taskCols.length > 0 && !taskCols.some(c => c.name === 'claim_token')) {
    db.exec(`ALTER TABLE character_memory_profile_update_tasks ADD COLUMN claim_token TEXT`);
  }
  if (taskCols.length > 0 && !taskCols.some(c => c.name === 'lease_expires_at')) {
    db.exec(`ALTER TABLE character_memory_profile_update_tasks ADD COLUMN lease_expires_at TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_profile_update_tasks_claim
      ON character_memory_profile_update_tasks(claim_token)
      WHERE claim_token IS NOT NULL;
  `);
}

function migrate(db: Database.Database): void {
  const schemaVersion = Number(db.pragma('user_version', { simple: true }));
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${schemaVersion} is newer than this build supports ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar_url TEXT,
      basic_info TEXT NOT NULL DEFAULT '',
      personality TEXT NOT NULL DEFAULT '',
      scenario TEXT NOT NULL DEFAULT '',
      greeting TEXT NOT NULL DEFAULT '',
      example_dialogue TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      tags TEXT NOT NULL DEFAULT '[]',
      source_msg_ids TEXT NOT NULL DEFAULT '[]',
      memory_kind TEXT NOT NULL DEFAULT 'general',
      importance REAL NOT NULL DEFAULT 0.5,
      emotional_weight REAL NOT NULL DEFAULT 0.0,
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_memories_character ON memories(character_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_character ON conversations(character_id);
  `);

  ensureMemoryProfileTables(db);

  // 增量迁移：memories 表补记忆系统升级字段，旧库无需重建表。
  // 加列与「回填 pending 标记」同事务提交：若随后回填崩溃，下次启动看到 value='0' 仍会重跑 category 推断，
  // 而不会因「列已存在」永久跳过。legacy 库无标记时不重推默认值，避免覆盖用户有意写的 general/0.5/0.0。
  const MEMORY_DEFAULTS_BACKFILL_KEY = 'migration_memory_defaults_backfill_v1';
  const memoryCols = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
  const hasMemoryCol = (name: string) => memoryCols.some(c => c.name === name);
  const needsMemoryKindBackfill = !hasMemoryCol('memory_kind');
  const needsImportanceBackfill = !hasMemoryCol('importance');
  const needsEmotionalWeightBackfill = !hasMemoryCol('emotional_weight');
  const justAddedDefaultColumns =
    needsMemoryKindBackfill || needsImportanceBackfill || needsEmotionalWeightBackfill;

  db.transaction(() => {
    if (needsMemoryKindBackfill) {
      db.exec(`ALTER TABLE memories ADD COLUMN memory_kind TEXT NOT NULL DEFAULT 'general'`);
    }
    if (needsImportanceBackfill) {
      db.exec(`ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5`);
    }
    if (needsEmotionalWeightBackfill) {
      db.exec(`ALTER TABLE memories ADD COLUMN emotional_weight REAL NOT NULL DEFAULT 0.0`);
    }
    if (!hasMemoryCol('status')) {
      db.exec(`ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
    }
    if (!hasMemoryCol('pinned')) {
      db.exec(`ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
    }
    if (!hasMemoryCol('last_used_at')) {
      db.exec(`ALTER TABLE memories ADD COLUMN last_used_at TEXT`);
    }
    if (!hasMemoryCol('usage_count')) {
      db.exec(`ALTER TABLE memories ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0`);
    }
    if (!hasMemoryCol('metadata')) {
      db.exec(`ALTER TABLE memories ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`);
    }
    if (justAddedDefaultColumns) {
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, '0')
        ON CONFLICT(key) DO UPDATE SET value = '0'
      `).run(MEMORY_DEFAULTS_BACKFILL_KEY);
    }
  })();

  const backfillMarker = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(MEMORY_DEFAULTS_BACKFILL_KEY) as { value: string } | undefined;
  const backfillPending = backfillMarker?.value === '0';
  const shouldInferColumnDefaults = justAddedDefaultColumns || backfillPending;

  // NULL/空值始终可补；列默认值仅在刚加列或 pending 时按 category 推断。
  backfillMemoryDefaults(
    db,
    shouldInferColumnDefaults,
    shouldInferColumnDefaults,
    shouldInferColumnDefaults,
  );

  // 回填成功后标完成；legacy 无标记库也写入 '1'，避免后续误判。
  if (shouldInferColumnDefaults || !backfillMarker) {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(MEMORY_DEFAULTS_BACKFILL_KEY);
  }

  // 旁路表：为后续 embedding、角色级覆盖配置和无效候选隔离提供数据基础
  db.exec(MEMORY_EMBEDDING_TABLE_DDL);
  ensureMemoryEmbeddingForeignKeys(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_memory_configs (
      character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
      enabled INTEGER,
      memory_package_token_budget INTEGER,
      profile_token_budget INTEGER,
      pinned_token_budget INTEGER,
      open_threads_token_budget INTEGER,
      retrieval_token_budget INTEGER,
      memory_max_inject_override INTEGER,
      vector_enabled_override INTEGER,
      reranker_enabled_override INTEGER,
      vector_top_k_override INTEGER,
      reranker_top_k_override INTEGER,
      embedding_model_override TEXT,
      reranker_model_override TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_extraction_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      conversation_id TEXT,
      raw_candidate_json TEXT,
      raw_response TEXT,
      status TEXT NOT NULL,
      error_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_character_memory_configs_character ON character_memory_configs(character_id);
    CREATE INDEX IF NOT EXISTS idx_memory_extraction_candidates_character_status ON memory_extraction_candidates(character_id, status);
  `);

  db.transaction(() => {
    db.exec(MEMORY_EMBEDDING_DEDUPLICATION_DML);
    db.exec(MEMORY_EMBEDDING_INDEX_DDL);
  })();

  const embeddingTaskCols = db.prepare("PRAGMA table_info(memory_embedding_tasks)").all() as { name: string }[];
  if (embeddingTaskCols.length > 0 && !embeddingTaskCols.some(c => c.name === 'claim_token')) {
    db.exec(`ALTER TABLE memory_embedding_tasks ADD COLUMN claim_token TEXT`);
  }
  if (embeddingTaskCols.length > 0 && !embeddingTaskCols.some(c => c.name === 'lease_expires_at')) {
    db.exec(`ALTER TABLE memory_embedding_tasks ADD COLUMN lease_expires_at TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_claim
      ON memory_embedding_tasks(claim_token)
      WHERE claim_token IS NOT NULL;
  `);

  // 增量迁移：为 messages 表添加 seq 列，用于同毫秒时的稳定排序
  const migrateMessageSeq = db.transaction(() => {
    const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'seq')) {
      db.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`);
    }
    // 用 rowid 回填已有数据，保证历史消息顺序稳定
    db.exec(`UPDATE messages SET seq = rowid WHERE seq = 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(conversation_id, seq)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_seq ON messages(conversation_id, created_at, seq)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`);
  });
  migrateMessageSeq();

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      id UNINDEXED,
      content,
      role UNINDEXED,
      conversation_id UNINDEXED,
      created_at UNINDEXED,
      seq UNINDEXED,
      tokenize = 'unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
      id UNINDEXED,
      content,
      role UNINDEXED,
      conversation_id UNINDEXED,
      created_at UNINDEXED,
      seq UNINDEXED,
      tokenize = 'trigram'
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(id, content, role, conversation_id, created_at, seq)
      VALUES (new.id, new.content, new.role, new.conversation_id, new.created_at, new.seq);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content, role, conversation_id, created_at, seq ON messages BEGIN
      DELETE FROM messages_fts WHERE id = old.id;
      INSERT INTO messages_fts(id, content, role, conversation_id, created_at, seq)
      VALUES (new.id, new.content, new.role, new.conversation_id, new.created_at, new.seq);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts_trigram(id, content, role, conversation_id, created_at, seq)
      VALUES (new.id, new.content, new.role, new.conversation_id, new.created_at, new.seq);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts_trigram WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_au AFTER UPDATE OF content, role, conversation_id, created_at, seq ON messages BEGIN
      DELETE FROM messages_fts_trigram WHERE id = old.id;
      INSERT INTO messages_fts_trigram(id, content, role, conversation_id, created_at, seq)
      VALUES (new.id, new.content, new.role, new.conversation_id, new.created_at, new.seq);
    END;
  `);

  const ftsCount = (db.prepare('SELECT COUNT(*) as count FROM messages_fts').get() as { count: number }).count;
  const messageCount = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
  // 触发器同步下 FTS 与 messages 行数应严格相等。
  // 用 !== 同时覆盖「缺失」与「多出/重复」损坏；旧条件 ftsCount < messageCount
  // 无法自愈「孤儿 FTS 行数恰好补齐」的半损坏状态（与 messages_fts_trigram 对齐）。
  if (messageCount > 0 && ftsCount !== messageCount) {
    // 重建前先清空，避免与残留索引行冲突 / 产生重复
    db.exec(`DELETE FROM messages_fts`);
    db.exec(`
      INSERT INTO messages_fts(id, content, role, conversation_id, created_at, seq)
      SELECT id, content, role, conversation_id, created_at, seq
      FROM messages
    `);
  }

  const trigramCount = (db.prepare('SELECT COUNT(*) as count FROM messages_fts_trigram').get() as { count: number }).count;
  if (trigramCount !== messageCount) {
    db.exec(`DELETE FROM messages_fts_trigram`);
    db.exec(`
      INSERT INTO messages_fts_trigram(id, content, role, conversation_id, created_at, seq)
      SELECT id, content, role, conversation_id, created_at, seq
      FROM messages
    `);
  }

  // 增量迁移：记忆提取任务持久化表，服务重启后可恢复未完成任务
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'done', 'failed')),
      merge_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TEXT,
      result_committed INTEGER NOT NULL DEFAULT 0,
      result_insert_count INTEGER NOT NULL DEFAULT 0,
      result_merge_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_tasks_status ON memory_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_memory_tasks_conversation ON memory_tasks(conversation_id);
  `);

  // 增量迁移：memory_tasks 表补 merge_count 列（旧数据库兼容）
  const taskCols = db.prepare("PRAGMA table_info(memory_tasks)").all() as { name: string }[];
  if (taskCols.length > 0 && !taskCols.some(c => c.name === 'merge_count')) {
    db.exec(`ALTER TABLE memory_tasks ADD COLUMN merge_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (taskCols.length > 0 && !taskCols.some(c => c.name === 'retry_count')) {
    db.exec(`ALTER TABLE memory_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (taskCols.length > 0 && !taskCols.some(c => c.name === 'error_message')) {
    db.exec(`ALTER TABLE memory_tasks ADD COLUMN error_message TEXT`);
  }
  if (taskCols.length > 0 && !taskCols.some(c => c.name === 'result_committed')) {
    db.exec(`ALTER TABLE memory_tasks ADD COLUMN result_committed INTEGER NOT NULL DEFAULT 0`);
  }
  if (taskCols.length > 0 && !taskCols.some(c => c.name === 'result_insert_count')) {
    db.exec(`ALTER TABLE memory_tasks ADD COLUMN result_insert_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (taskCols.length > 0 && !taskCols.some(c => c.name === 'result_merge_count')) {
    db.exec(`ALTER TABLE memory_tasks ADD COLUMN result_merge_count INTEGER NOT NULL DEFAULT 0`);
  }
  const migrateMemoryTaskStartedAt = db.transaction(() => {
    const currentTaskCols = db.prepare("PRAGMA table_info(memory_tasks)").all() as { name: string }[];
    if (currentTaskCols.length > 0 && !currentTaskCols.some(c => c.name === 'started_at')) {
      db.exec(`ALTER TABLE memory_tasks ADD COLUMN started_at TEXT`);
    }
    db.exec(`
      UPDATE memory_tasks
      SET started_at = updated_at
      WHERE status = 'processing' AND started_at IS NULL
    `);
  });
  migrateMemoryTaskStartedAt();

  // 增量迁移：模型列表缓存表
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_cache (
      api_base TEXT PRIMARY KEY,
      models TEXT NOT NULL DEFAULT '[]',
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 增量迁移：API 供应商表（支持保存多个 API 配置并切换）
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_base TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      temperature REAL NOT NULL DEFAULT 1,
      max_tokens INTEGER NOT NULL DEFAULT 4096,
      context_window INTEGER NOT NULL DEFAULT 131072,
      json_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 增量迁移：characters 表补 image_tags 列（角色生图标签）
  const charCols = db.prepare("PRAGMA table_info(characters)").all() as { name: string }[];

  // 增量迁移：characters 表补 basic_info 列（角色基本信息）
  if (!charCols.some(c => c.name === 'basic_info')) {
    db.exec(`ALTER TABLE characters ADD COLUMN basic_info TEXT NOT NULL DEFAULT ''`);
  }

  // 增量迁移：characters 表补 other_info 列（角色其他补充信息）
  if (!charCols.some(c => c.name === 'other_info')) {
    db.exec(`ALTER TABLE characters ADD COLUMN other_info TEXT NOT NULL DEFAULT ''`);
  }
  if (!charCols.some(c => c.name === 'image_tags')) {
    db.exec(`ALTER TABLE characters ADD COLUMN image_tags TEXT NOT NULL DEFAULT ''`);
  }
  if (!charCols.some(c => c.name === 'user_image_tags')) {
    db.exec(`ALTER TABLE characters ADD COLUMN user_image_tags TEXT NOT NULL DEFAULT ''`);
  }

  // 增量迁移：characters 表补 sort_order 列（侧边栏拖拽排序，越小越靠前）
  const migrateCharacterSortOrder = db.transaction(() => {
    const currentCharCols = db.prepare("PRAGMA table_info(characters)").all() as { name: string }[];
    const addedSortOrder = !currentCharCols.some(c => c.name === 'sort_order');
    if (addedSortOrder) {
      db.exec(`ALTER TABLE characters ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    }
    const sortOrderCounts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN sort_order = 0 THEN 1 ELSE 0 END) AS zero_count
      FROM characters
    `).get() as { total: number; zero_count: number | null };
    if (addedSortOrder || (sortOrderCounts.total > 0 && sortOrderCounts.zero_count === sortOrderCounts.total)) {
      // 旧数据按 updated_at DESC 回填，保持当前观感不变；全 0 表示旧迁移只完成了加列。
      db.exec(`
        UPDATE characters
        SET sort_order = (
          SELECT rn FROM (
            SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at DESC) AS rn FROM characters
          ) AS ranked
          WHERE ranked.id = characters.id
        )
      `);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_characters_sort_order ON characters(sort_order)`);
  });
  migrateCharacterSortOrder();

  // 增量迁移：conversations 表补 ignore_memory 列（忽略记忆提取）
  const convCols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!convCols.some(c => c.name === 'ignore_memory')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN ignore_memory INTEGER NOT NULL DEFAULT 0`);
  }

  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
}
