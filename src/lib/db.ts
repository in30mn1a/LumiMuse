import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'lumimuse.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  // 记忆系统有多处后台并发写（embedding drain、profile 队列、提取队列，甚至跨进程）。
  // 默认 busy_timeout=0 会在撞写锁时立即抛 SQLITE_BUSY；设为 5s 让写入短暂等待重试而非直接失败。
  _db.pragma('busy_timeout = 5000');
  migrate(_db);

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
  // 注意:下面的 recoverStale* 无条件把 processing→pending,假设「单写入实例」(项目默认单容器部署)。
  // 若未来支持多副本共享同一 SQLite,必须改为基于租约(lease_expires_at)只回收过期任务,
  // 否则一个实例重启会把另一实例正在处理的 in-flight 任务抢回 pending,导致重复处理。
  setImmediate(() => {
    import('@/lib/memory-queue').then(({ recoverStaleTasks, triggerQueue }) => {
      recoverStaleTasks();
      triggerQueue();
    }).catch((err) => {
      // 不静默吞错：启动期失败必须可见，否则记忆队列恢复出问题用户根本无从察觉
      console.error('[db] memory-queue boot failed:', err);
    });
    // 画像更新队列同样需要启动恢复 + 触发处理（与提取队列对称），独立 import 避免互相影响
    import('@/lib/memory-profile').then(({ recoverStaleMemoryProfileTasks, triggerMemoryProfileQueue }) => {
      recoverStaleMemoryProfileTasks();
      triggerMemoryProfileQueue();
    }).catch((err) => {
      console.error('[db] memory-profile queue boot failed:', err);
    });
    // 向量索引任务没有租约机制,崩溃遗留的 processing 只能靠启动恢复(与上面两个队列对称);
    // 实际处理仍由 memory-index 路由按需驱动,这里只把卡死的 processing 重置为可领取的 pending——
    // 否则该记忆的 embedding 任务会永久卡死(既不被 drain 领取,也无法 rebuild/retry/重新入队)。
    import('@/lib/memory-embeddings').then(({ recoverStaleMemoryEmbeddingTasks }) => {
      recoverStaleMemoryEmbeddingTasks();
    }).catch((err) => {
      console.error('[db] memory-embedding boot recovery failed:', err);
    });
  });

  return _db;
}

export function ensureMemoryProfileTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_memory_profiles (
      character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
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

  // 增量迁移：memories 表补记忆系统升级字段，旧库无需重建表
  const memoryCols = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
  const hasMemoryCol = (name: string) => memoryCols.some(c => c.name === name);
  const needsMemoryKindBackfill = !hasMemoryCol('memory_kind');
  const needsImportanceBackfill = !hasMemoryCol('importance');
  const needsEmotionalWeightBackfill = !hasMemoryCol('emotional_weight');

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

  if (needsMemoryKindBackfill) {
    db.exec(`
      UPDATE memories
      SET memory_kind = CASE category
        WHEN '偏好习惯' THEN 'user_preference'
        WHEN '基础信息' THEN 'user_fact'
        WHEN '人格特质' THEN 'user_fact'
        WHEN '关系动态' THEN 'relationship_event'
        WHEN '重要事件' THEN 'relationship_event'
        ELSE 'general'
      END
      WHERE memory_kind = 'general'
    `);
  }
  if (needsImportanceBackfill) {
    db.exec(`
      UPDATE memories
      SET importance = CASE category
        WHEN '基础信息' THEN 0.85
        WHEN '人格特质' THEN 0.8
        WHEN '重要事件' THEN 0.75
        WHEN '偏好习惯' THEN 0.65
        WHEN '关系动态' THEN 0.6
        WHEN '话题历史' THEN 0.45
        WHEN '四季日常' THEN 0.4
        ELSE 0.5
      END
      WHERE importance = 0.5
    `);
  }
  if (needsEmotionalWeightBackfill) {
    db.exec(`
      UPDATE memories
      SET emotional_weight = CASE category
        WHEN '关系动态' THEN 0.6
        WHEN '重要事件' THEN 0.65
        ELSE 0.0
      END
      WHERE emotional_weight = 0.0
    `);
  }

  // 旁路表：为后续 embedding、角色级覆盖配置和无效候选隔离提供数据基础
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_blob BLOB NOT NULL,
      normalized INTEGER NOT NULL DEFAULT 1,
      embedding_text_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_embedding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claim_token TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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

    DELETE FROM memory_embeddings
    WHERE rowid NOT IN (
      SELECT rowid FROM (
        SELECT
          rowid,
          ROW_NUMBER() OVER (
            PARTITION BY memory_id, provider, model, dimension
            ORDER BY updated_at DESC, created_at DESC, rowid DESC
          ) AS rn
        FROM memory_embeddings
      )
      WHERE rn = 1
    );

    DELETE FROM memory_embedding_tasks
    WHERE status IN ('pending', 'processing')
      AND id NOT IN (
        SELECT id FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY memory_id
              ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, id ASC
            ) AS rn
          FROM memory_embedding_tasks
          WHERE status IN ('pending', 'processing')
        )
        WHERE rn = 1
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embeddings_unique_model
      ON memory_embeddings(memory_id, provider, model, dimension);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embedding_tasks_active_memory
      ON memory_embedding_tasks(memory_id)
      WHERE status IN ('pending', 'processing');
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_character_status ON memory_embeddings(character_id, status);
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory ON memory_embeddings(memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_status ON memory_embedding_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_memory ON memory_embedding_tasks(memory_id);
    CREATE INDEX IF NOT EXISTS idx_character_memory_configs_character ON character_memory_configs(character_id);
    CREATE INDEX IF NOT EXISTS idx_memory_extraction_candidates_character_status ON memory_extraction_candidates(character_id, status);
  `);

  const embeddingTaskCols = db.prepare("PRAGMA table_info(memory_embedding_tasks)").all() as { name: string }[];
  if (embeddingTaskCols.length > 0 && !embeddingTaskCols.some(c => c.name === 'claim_token')) {
    db.exec(`ALTER TABLE memory_embedding_tasks ADD COLUMN claim_token TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_claim
      ON memory_embedding_tasks(claim_token)
      WHERE claim_token IS NOT NULL;
  `);

  // 增量迁移：为 messages 表添加 seq 列，用于同毫秒时的稳定排序
  const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const hasSeq = cols.some(c => c.name === 'seq');
  if (!hasSeq) {
    db.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`);
    // 用 rowid 回填已有数据，保证历史消息顺序稳定
    db.exec(`UPDATE messages SET seq = rowid WHERE seq = 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(conversation_id, seq)`);
  }

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
  `);

  const ftsCount = (db.prepare('SELECT COUNT(*) as count FROM messages_fts').get() as { count: number }).count;
  const messageCount = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
  // 旧条件 `ftsCount === 0 && messageCount > 0` 不幂等：
  // 若 FTS 处于"半损坏"状态（部分丢失但非全空），永远走不到重建分支。
  // 改为「FTS 行数少于消息数」即视为损坏：触发器同步下两者应严格相等，
  // 任何缺失都说明索引落后或损坏，需要全量回灌。
  if (messageCount > 0 && ftsCount < messageCount) {
    // 重建前先清空，避免与残留索引行冲突 / 产生重复
    db.exec(`DELETE FROM messages_fts`);
    db.exec(`
      INSERT INTO messages_fts(id, content, role, conversation_id, created_at, seq)
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
  if (!charCols.some(c => c.name === 'sort_order')) {
    db.exec(`ALTER TABLE characters ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    // 旧数据按 updated_at DESC 回填，保持当前观感不变
    db.exec(`
      UPDATE characters
      SET sort_order = (
        SELECT rn FROM (
          SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at DESC) AS rn FROM characters
        ) AS ranked
        WHERE ranked.id = characters.id
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_characters_sort_order ON characters(sort_order)`);
  }

  // 增量迁移：conversations 表补 ignore_memory 列（忽略记忆提取）
  const convCols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!convCols.some(c => c.name === 'ignore_memory')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN ignore_memory INTEGER NOT NULL DEFAULT 0`);
  }
}
