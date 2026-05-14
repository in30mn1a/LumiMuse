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
  migrate(_db);

  // 服务启动时把上次崩溃遗留的 processing 任务重置为 pending
  // 延迟 import 避免循环依赖（memory-queue → db → memory-queue）
  setImmediate(() => {
    import('@/lib/memory-queue').then(({ recoverStaleTasks, triggerQueue }) => {
      recoverStaleTasks();
      triggerQueue();
    }).catch(() => {});
  });

  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar_url TEXT,
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
  if (messageCount > 0 && ftsCount === 0) {
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

  // 增量迁移：模型列表缓存表
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_cache (
      api_base TEXT PRIMARY KEY,
      models TEXT NOT NULL DEFAULT '[]',
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 增量迁移：characters 表补 image_tags 列（角色生图标签）
  const charCols = db.prepare("PRAGMA table_info(characters)").all() as { name: string }[];
  if (!charCols.some(c => c.name === 'image_tags')) {
    db.exec(`ALTER TABLE characters ADD COLUMN image_tags TEXT NOT NULL DEFAULT ''`);
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
