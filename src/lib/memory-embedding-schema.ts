import type Database from 'better-sqlite3';

export const MEMORY_EMBEDDING_TABLE_DDL = `
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
    lease_expires_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const MEMORY_EMBEDDING_DEDUPLICATION_DML = `
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
`;

export const MEMORY_EMBEDDING_INDEX_DDL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embeddings_unique_model
    ON memory_embeddings(memory_id, provider, model, dimension);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embedding_tasks_active_memory
    ON memory_embedding_tasks(memory_id)
    WHERE status IN ('pending', 'processing');
  CREATE INDEX IF NOT EXISTS idx_memory_embeddings_character_status ON memory_embeddings(character_id, status);
  CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory ON memory_embeddings(memory_id);
  CREATE INDEX IF NOT EXISTS idx_memory_embeddings_character
    ON memory_embeddings(character_id, status, provider, model);
  CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_status ON memory_embedding_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_status_id ON memory_embedding_tasks(status, id);
  CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_memory ON memory_embedding_tasks(memory_id);
  CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_memory_status ON memory_embedding_tasks(memory_id, status);
  CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_character ON memory_embedding_tasks(character_id);
`;

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS exists_flag FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(tableName) as { exists_flag?: number } | undefined;
  return Boolean(row?.exists_flag);
}

function hasExpectedForeignKeys(db: Database.Database, tableName: string): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as {
    from: string;
    table: string;
    on_delete: string;
  }[];
  return (
    rows.some(row => row.from === 'memory_id' && row.table === 'memories' && row.on_delete === 'CASCADE') &&
    rows.some(row => row.from === 'character_id' && row.table === 'characters' && row.on_delete === 'CASCADE')
  );
}

function tableColumns(db: Database.Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  return new Set(rows.map(row => row.name));
}

function rebuildMemoryEmbeddingsWithForeignKeys(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS __memory_embeddings_without_fk;
    ALTER TABLE memory_embeddings RENAME TO __memory_embeddings_without_fk;
  `);
  db.exec(MEMORY_EMBEDDING_TABLE_DDL);
  db.exec(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, error_message, created_at, updated_at
    )
    SELECT
      old.memory_id, old.character_id, old.provider, old.model, old.dimension, old.embedding_blob,
      old.normalized, old.embedding_text_hash, old.status, old.error_message, old.created_at, old.updated_at
    FROM __memory_embeddings_without_fk old
    WHERE EXISTS (SELECT 1 FROM memories m WHERE m.id = old.memory_id)
      AND EXISTS (SELECT 1 FROM characters c WHERE c.id = old.character_id);

    DROP TABLE __memory_embeddings_without_fk;
  `);
}

function rebuildMemoryEmbeddingTasksWithForeignKeys(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS __memory_embedding_tasks_without_fk;
    ALTER TABLE memory_embedding_tasks RENAME TO __memory_embedding_tasks_without_fk;
  `);
  db.exec(MEMORY_EMBEDDING_TABLE_DDL);
  const columns = tableColumns(db, '__memory_embedding_tasks_without_fk');
  const claimTokenSelect = columns.has('claim_token') ? 'old.claim_token' : 'NULL';
  db.exec(`
    INSERT INTO memory_embedding_tasks (
      id, memory_id, character_id, reason, status, claim_token,
      retry_count, error_message, created_at, updated_at
    )
    SELECT
      old.id, old.memory_id, old.character_id, old.reason, old.status, ${claimTokenSelect},
      old.retry_count, old.error_message, old.created_at, old.updated_at
    FROM __memory_embedding_tasks_without_fk old
    WHERE EXISTS (SELECT 1 FROM memories m WHERE m.id = old.memory_id)
      AND EXISTS (SELECT 1 FROM characters c WHERE c.id = old.character_id);

    DROP TABLE __memory_embedding_tasks_without_fk;
  `);
}

export function ensureMemoryEmbeddingForeignKeys(db: Database.Database): void {
  if (!tableExists(db, 'memories') || !tableExists(db, 'characters')) return;

  db.transaction(() => {
    if (tableExists(db, 'memory_embeddings') && !hasExpectedForeignKeys(db, 'memory_embeddings')) {
      rebuildMemoryEmbeddingsWithForeignKeys(db);
    }
    if (tableExists(db, 'memory_embedding_tasks') && !hasExpectedForeignKeys(db, 'memory_embedding_tasks')) {
      rebuildMemoryEmbeddingTasksWithForeignKeys(db);
    }
  })();
}
