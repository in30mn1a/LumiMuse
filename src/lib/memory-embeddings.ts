import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { DEFAULT_BACKGROUND_TASK_LEASE_SECONDS } from '@/lib/background-task-recovery';
import { createDbTaskQueue } from '@/lib/db-task-queue';
import { getDb } from '@/lib/db';
import { safeFetch } from '@/lib/ssrf-guard';
import { Memory } from '@/types';
import {
  ensureMemoryEmbeddingForeignKeys,
  MEMORY_EMBEDDING_INDEX_DDL,
  MEMORY_EMBEDDING_TABLE_DDL,
} from '@/lib/memory-embedding-schema';

/** embedding 任务队列：claim/lease/recover 走 DbTaskQueue；复杂 drain 仍在 memory-index-trigger */
const embeddingTaskQueue = createDbTaskQueue({
  table: 'memory_embedding_tasks',
  timestampMode: 'iso',
  defaultLeaseSeconds: DEFAULT_BACKGROUND_TASK_LEASE_SECONDS,
});

export interface EmbeddingAdapterConfig {
  api_base?: string;
  api_key?: string;
  model?: string;
  dimension?: number;
  timeout_ms?: number;
  provider?: string;
  signal?: AbortSignal;
}

export interface MemoryEmbeddingRow {
  memory_id: string;
  character_id: string;
  provider: string;
  model: string;
  dimension: number;
  embedding_blob: Buffer;
  normalized: number;
  embedding_text_hash: string;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryEmbeddingTask {
  id: number;
  memory_id: string;
  character_id: string;
  reason: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  claim_token: string | null;
  lease_expires_at: string | null;
  retry_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryIndexStatus {
  total: number;
  ready: number;
  pending: number;
  processing: number;
  failed: number;
  latest_error?: string | null;
}

export interface MemoryEmbeddingTarget {
  provider?: string;
  model?: string;
  dimension?: number;
}

const MAX_RECOVERABLE_EMBEDDING_ATTEMPTS = 3;
const RECOVERABLE_EMBEDDING_RETRY_DELAY_MS = 30_000;
// From the audit remediation performance spec: keep vector retrieval's synchronous
// SQLite read and JS ranking bounded as memory history grows.
const VECTOR_RETRIEVAL_SCAN_LIMIT = 5_000;
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function getEmbeddingErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableEmbeddingError(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes('timed out') || lower.includes('aborted')) return true;
  if (lower.includes('fetch failed') || lower.includes('network')) return true;
  if (/\b(econnreset|etimedout|eai_again|und_err_)\b/i.test(message)) return true;
  const status = message.match(/embedding API error\s+(\d{3})/i)?.[1];
  if (!status) return false;
  const code = Number(status);
  return code === 429 || code >= 500;
}

function buildReadyEmbeddingTargetFilter(
  target: MemoryEmbeddingTarget | undefined,
  columnPrefix = '',
): { sql: string; params: unknown[] } {
  if (!target) return { sql: '', params: [] };

  const prefix = columnPrefix ? `${columnPrefix}.` : '';
  const provider = target.provider?.trim();
  const hasModel = Object.prototype.hasOwnProperty.call(target, 'model');
  const model = target.model?.trim();
  const dimension = Math.floor(Number(target.dimension || 0));
  const filters: string[] = [];
  const params: unknown[] = [];

  if (provider) {
    filters.push(`${prefix}provider = ?`);
    params.push(provider);
  }
  if (model) {
    filters.push(`${prefix}model = ?`);
    params.push(model);
  } else if (hasModel) {
    filters.push('1 = 0');
  }
  if (dimension > 0) {
    filters.push(`${prefix}dimension = ?`);
    params.push(dimension);
  }

  return {
    sql: filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '',
    params,
  };
}

export function normalizeEmbedding(vector: ArrayLike<number>): Float32Array {
  const result = new Float32Array(vector.length);
  let sumSquares = 0;

  for (let i = 0; i < vector.length; i += 1) {
    const value = Number(vector[i]);
    if (!Number.isFinite(value)) {
      throw new Error('embedding contains non-finite values');
    }
    result[i] = value;
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return result;

  for (let i = 0; i < result.length; i += 1) {
    result[i] /= norm;
  }
  return result;
}

export function embeddingToBlob(vector: ArrayLike<number>): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) {
    buffer.writeFloatLE(Number(vector[i]), i * 4);
  }
  return buffer;
}

export function blobToEmbedding(blob: Buffer | Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error('embedding blob byte length must be divisible by 4');
  }

  const bytes = Buffer.isBuffer(blob)
    ? blob
    : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (HOST_IS_LITTLE_ENDIAN && bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }

  const vector = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = bytes.readFloatLE(i * 4);
  }
  return vector;
}

export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new Error(`embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    total += Number(a[i]) * Number(b[i]);
  }
  return total;
}

export function rankEmbeddingRows<T extends { embedding_blob: Buffer | Uint8Array }>(
  queryEmbedding: ArrayLike<number>,
  rows: T[],
  limit: number,
): Array<{ row: T; similarity: number }> {
  const normalizedQuery = normalizeEmbedding(queryEmbedding);
  const scored: Array<{ row: T; similarity: number }> = [];

  for (const row of rows) {
    try {
      const embedding = blobToEmbedding(row.embedding_blob);
      if (embedding.length !== normalizedQuery.length) continue;
      const similarity = dotProduct(normalizedQuery, embedding);
      if (!Number.isFinite(similarity)) continue;
      scored.push({ row, similarity });
    } catch {
      continue;
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, Math.max(0, limit));
}

export function buildMemoryEmbeddingText(memory: Memory): string {
  const tags = Array.isArray(memory.tags) ? memory.tags.filter(Boolean).join('、') : '';
  return [
    `分类：${memory.category}`,
    `内容：${memory.content}`,
    tags ? `标签：${tags}` : '',
  ].filter(Boolean).join('\n');
}

export function hashEmbeddingText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeEmbeddingEndpoint(apiBase: string): string {
  const trimmed = apiBase.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/embeddings')) return trimmed;
  return `${trimmed}/embeddings`;
}

function parseEmbeddingResponse(data: unknown): number[] {
  const record = data as Record<string, unknown>;
  const first = Array.isArray(record.data) ? record.data[0] as Record<string, unknown> | undefined : undefined;
  const embedding = first?.embedding ?? record.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('embedding response missing data[0].embedding');
  }
  return embedding.map(Number);
}

function parseEmbeddingBatchResponse(data: unknown, expectedCount: number): number[][] {
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.data)) {
    if (expectedCount === 1) return [parseEmbeddingResponse(data)];
    throw new Error('embedding response missing data array');
  }

  const rows = [...record.data] as Array<Record<string, unknown>>;
  rows.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const embeddings = rows.map(row => row.embedding);
  if (embeddings.length !== expectedCount) {
    throw new Error(`embedding response count mismatch: expected ${expectedCount}, got ${embeddings.length}`);
  }
  return embeddings.map(embedding => {
    if (!Array.isArray(embedding)) {
      throw new Error('embedding response missing data[].embedding');
    }
    return embedding.map(Number);
  });
}

async function requestEmbeddings(input: string | string[], config: EmbeddingAdapterConfig): Promise<unknown> {
  const apiBase = config.api_base?.trim();
  const model = config.model?.trim();
  if (!apiBase) throw new Error('embedding api_base is required');
  if (!model) throw new Error('embedding model is required');

  const controller = new AbortController();
  const timeoutMs = Math.max(1, config.timeout_ms || 1500);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = config.signal;
  const abortFromExternalSignal = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
  }

  try {
    const body: Record<string, unknown> = { model, input, encoding_format: 'float' };
    // 仅在用户显式设置了 dimension 时才发送，某些模型不支持该参数
    if (config.dimension && config.dimension > 0) {
      body.dimensions = config.dimension;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.api_key) headers.Authorization = `Bearer ${config.api_key}`;

    const response = await safeFetch(normalizeEmbeddingEndpoint(apiBase), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`embedding API error ${response.status}: ${errorText.slice(0, 200)}`);
    }

    return response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      if (externalSignal?.aborted) {
        throw new Error('embedding request aborted');
      }
      throw new Error(`embedding request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternalSignal);
  }
}

export async function embedText(text: string, config: EmbeddingAdapterConfig): Promise<Float32Array> {
  const vector = normalizeEmbedding(parseEmbeddingResponse(await requestEmbeddings(text, config)));
  if (config.dimension && config.dimension > 0 && vector.length !== config.dimension) {
    throw new Error(`embedding dimension mismatch: expected ${config.dimension}, got ${vector.length}`);
  }
  return vector;
}

export async function embedTexts(texts: string[], config: EmbeddingAdapterConfig): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const data = await requestEmbeddings(texts, config);
  return parseEmbeddingBatchResponse(data, texts.length).map((embedding, index) => {
    const vector = normalizeEmbedding(embedding);
    if (config.dimension && config.dimension > 0 && vector.length !== config.dimension) {
      throw new Error(`embedding dimension mismatch at index ${index}: expected ${config.dimension}, got ${vector.length}`);
    }
    return vector;
  });
}

export function fakeEmbeddingForText(text: string, dimension: number = 16): Float32Array {
  const size = Math.max(1, dimension);
  const values = new Float32Array(size);
  let offset = 0;

  while (offset < size) {
    const hash = createHash('sha256').update(`${text}:${offset}`).digest();
    for (let i = 0; i < hash.length && offset < size; i += 2) {
      values[offset] = (hash.readUInt16LE(i) / 65535) * 2 - 1;
      offset += 1;
    }
  }

  return normalizeEmbedding(values);
}

export function ensureMemoryEmbeddingTables(db: Database.Database = getDb()): void {
  db.exec(MEMORY_EMBEDDING_TABLE_DDL);
  ensureMemoryEmbeddingForeignKeys(db);
  db.exec(MEMORY_EMBEDDING_INDEX_DDL);

  const taskCols = db.prepare('PRAGMA table_info(memory_embedding_tasks)').all() as { name: string }[];
  if (taskCols.length > 0 && !taskCols.some(c => c.name === 'claim_token')) {
    db.exec(`ALTER TABLE memory_embedding_tasks ADD COLUMN claim_token TEXT`);
  }
  if (taskCols.length > 0 && !taskCols.some(c => c.name === 'lease_expires_at')) {
    db.exec(`ALTER TABLE memory_embedding_tasks ADD COLUMN lease_expires_at TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_embedding_tasks_claim
      ON memory_embedding_tasks(claim_token)
      WHERE claim_token IS NOT NULL;
  `);
}

export function upsertMemoryEmbedding(params: {
  memoryId: string;
  characterId: string;
  provider: string;
  model: string;
  embedding: ArrayLike<number>;
  embeddingTextHash: string;
  status?: string;
  errorMessage?: string | null;
  db?: Database.Database;
}): void {
  const db = params.db || getDb();
  ensureMemoryEmbeddingTables(db);
  const normalized = normalizeEmbedding(params.embedding);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, error_message, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id, provider, model, dimension) DO UPDATE SET
      character_id = excluded.character_id,
      embedding_blob = excluded.embedding_blob,
      normalized = excluded.normalized,
      embedding_text_hash = excluded.embedding_text_hash,
      status = excluded.status,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at
  `).run(
    params.memoryId,
    params.characterId,
    params.provider,
    params.model,
    normalized.length,
    embeddingToBlob(normalized),
    params.embeddingTextHash,
    params.status || 'ready',
    params.errorMessage || null,
    now,
    now,
  );
}

export function loadReadyMemoryEmbeddings(
  characterId: string,
  options: { provider?: string; model?: string; dimension?: number; limit?: number; db?: Database.Database } = {},
): MemoryEmbeddingRow[] {
  const db = options.db || getDb();
  ensureMemoryEmbeddingTables(db);

  const scanLimit = Number.isFinite(options.limit) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : VECTOR_RETRIEVAL_SCAN_LIMIT;
  let sql = `
    SELECT e.*
    FROM memory_embeddings e
    JOIN memories m ON m.id = e.memory_id
    WHERE e.character_id = ?
      AND e.status = 'ready'
      AND m.status = 'active'
  `;
  const params: unknown[] = [characterId];
  if (options.provider) {
    sql += ' AND e.provider = ?';
    params.push(options.provider);
  }
  if (options.model) {
    sql += ' AND e.model = ?';
    params.push(options.model);
  }
  if (options.dimension && options.dimension > 0) {
    sql += ' AND e.dimension = ?';
    params.push(options.dimension);
  }
  sql += `
    ORDER BY
      COALESCE(m.pinned, 0) DESC,
      COALESCE(m.importance, 0) DESC,
      e.updated_at DESC,
      e.memory_id ASC
    LIMIT ?
  `;
  const stmt = db.prepare(sql);
  return stmt.all(...params, scanLimit) as MemoryEmbeddingRow[];
}

export function enqueueMemoryEmbeddingTask(
  memoryId: string,
  characterId: string,
  reason: 'created' | 'updated' | 'imported' | 'rebuild' | 'retry_failed' | 'semantic_backfill' = 'created',
  db: Database.Database = getDb(),
): boolean {
  ensureMemoryEmbeddingTables(db);
  const now = new Date().toISOString();
  const result = embeddingTaskQueue.enqueue(db, {
    columns: {
      memory_id: memoryId,
      character_id: characterId,
      reason,
      created_at: now,
      updated_at: now,
    },
    dedupeKey: { column: 'memory_id', value: memoryId },
    reviveFailed: true,
    reviveColumns: {
      character_id: characterId,
      reason,
      retry_count: 0,
    },
  });
  return result.inserted || result.revived;
}

export function enqueueRebuildMemoryEmbeddings(
  characterId: string,
  db: Database.Database = getDb(),
): number {
  ensureMemoryEmbeddingTables(db);
  const rows = db.prepare(
    "SELECT id, character_id FROM memories WHERE character_id = ? AND status = 'active'",
  ).all(characterId) as Array<{
    id: string;
    character_id: string;
  }>;

  let queued = 0;
  for (const row of rows) {
    if (enqueueMemoryEmbeddingTask(row.id, row.character_id, 'rebuild', db)) queued += 1;
  }
  return queued;
}

export function enqueueUnindexedMemoryEmbeddings(
  characterId: string | undefined,
  options: {
    provider: string;
    model: string;
    dimension?: number;
    db?: Database.Database;
  },
): number {
  const db = options.db || getDb();
  ensureMemoryEmbeddingTables(db);
  const provider = options.provider.trim();
  const model = options.model.trim();
  const dimension = Math.floor(Number(options.dimension || 0));
  if (!provider || !model) return 0;

  const characterFilter = characterId ? 'AND m.character_id = ?' : '';
  const dimensionFilter = dimension > 0 ? 'AND e.dimension = ?' : '';
  const params: unknown[] = [provider, model];
  if (dimension > 0) params.push(dimension);
  if (characterId) params.push(characterId);

  const rows = db.prepare(`
    SELECT m.id, m.character_id
    FROM memories m
    WHERE NOT EXISTS (
      SELECT 1
      FROM memory_embeddings e
      WHERE e.memory_id = m.id
        AND e.status = 'ready'
        AND e.provider = ?
        AND e.model = ?
        ${dimensionFilter}
    )
    ${characterFilter}
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1 FROM memory_embeddings existing
        WHERE existing.memory_id = m.id AND existing.status = 'ready'
      ) THEN 0 ELSE 1 END,
      m.updated_at ASC,
      m.id ASC
  `).all(...params) as Array<{ id: string; character_id: string }>;

  let queued = 0;
  for (const row of rows) {
    if (enqueueMemoryEmbeddingTask(row.id, row.character_id, 'semantic_backfill', db)) queued += 1;
  }
  return queued;
}

export function clearMemoryIndex(
  characterId?: string,
  db: Database.Database = getDb(),
): { cleared_embeddings: number; cleared_tasks: number } {
  ensureMemoryEmbeddingTables(db);

  return db.transaction(() => {
    const embeddingResult = characterId
      ? db.prepare('DELETE FROM memory_embeddings WHERE character_id = ?').run(characterId)
      : db.prepare('DELETE FROM memory_embeddings').run();
    const taskResult = characterId
      ? db.prepare('DELETE FROM memory_embedding_tasks WHERE character_id = ?').run(characterId)
      : db.prepare('DELETE FROM memory_embedding_tasks').run();

    return {
      cleared_embeddings: embeddingResult.changes,
      cleared_tasks: taskResult.changes,
    };
  })();
}

export function stopCurrentMemoryIndexTasks(
  characterId?: string,
  db: Database.Database = getDb(),
): { stopped_tasks: number } {
  ensureMemoryEmbeddingTables(db);

  const result = characterId
    ? db.prepare("DELETE FROM memory_embedding_tasks WHERE character_id = ? AND status IN ('pending', 'processing')")
      .run(characterId)
    : db.prepare("DELETE FROM memory_embedding_tasks WHERE status IN ('pending', 'processing')")
      .run();

  return { stopped_tasks: result.changes };
}

export function recoverStaleMemoryEmbeddingTasks(db: Database.Database = getDb()): number {
  ensureMemoryEmbeddingTables(db);
  // 仅回收 lease_expires_at 已过期/缺失的 processing（崩溃孤儿）；另一实例 in-flight 不抢。
  return embeddingTaskQueue.recoverStale(db);
}

export function retryFailedMemoryEmbeddings(
  characterId?: string,
  db: Database.Database = getDb(),
  target?: MemoryEmbeddingTarget,
): number {
  ensureMemoryEmbeddingTables(db);
  const now = new Date().toISOString();
  const characterFilter = characterId ? 'AND t.character_id = ?' : '';
  const readyTarget = buildReadyEmbeddingTargetFilter(target, 'e');
  const params: unknown[] = characterId ? [characterId] : [];
  params.push(...readyTarget.params);

  const rows = db.prepare(`
    SELECT t.id
    FROM memory_embedding_tasks t
    WHERE t.status = 'failed' ${characterFilter}
      AND EXISTS (
        SELECT 1 FROM memories m
        WHERE m.id = t.memory_id
          AND m.character_id = t.character_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_embedding_tasks active
        WHERE active.memory_id = t.memory_id
          AND active.status IN ('pending', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_embeddings e
        WHERE e.memory_id = t.memory_id
          AND e.status = 'ready'
          ${readyTarget.sql}
      )
      AND t.id = (
        SELECT latest.id
        FROM memory_embedding_tasks latest
        WHERE latest.memory_id = t.memory_id
          AND latest.status = 'failed'
        ORDER BY latest.updated_at DESC, latest.id DESC
        LIMIT 1
      )
    ORDER BY t.updated_at ASC, t.id ASC
  `).all(...params) as Array<{ id: number }>;
  if (rows.length === 0) return 0;

  return db.transaction(() => {
    const update = db.prepare(`
      UPDATE memory_embedding_tasks
      SET reason = 'retry_failed', status = 'pending', claim_token = NULL,
          lease_expires_at = NULL, retry_count = 0, error_message = NULL, updated_at = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      update.run(now, row.id);
    }
    return rows.length;
  })();
}

export function getMemoryIndexStatus(
  characterId?: string,
  db: Database.Database = getDb(),
  target?: MemoryEmbeddingTarget,
): MemoryIndexStatus {
  ensureMemoryEmbeddingTables(db);
  const memoryWhere = characterId ? 'WHERE character_id = ?' : '';
  const memoryParams = characterId ? [characterId] : [];
  const taskCharacterFilter = characterId ? 'AND t.character_id = ?' : '';
  const taskParams = characterId ? [characterId] : [];
  const readyTarget = buildReadyEmbeddingTargetFilter(target);
  const failedReadyTarget = buildReadyEmbeddingTargetFilter(target, 'e');
  const readyParams: unknown[] = [...memoryParams, ...readyTarget.params];
  const failedParams: unknown[] = characterId ? [characterId] : [];
  failedParams.push(...failedReadyTarget.params);
  const latestFailedParams: unknown[] = characterId ? [characterId] : [];
  latestFailedParams.push(...failedReadyTarget.params);

  const total = (db.prepare(`SELECT COUNT(*) as n FROM memories ${memoryWhere}`).get(...memoryParams) as { n: number }).n;
  const ready = (db.prepare(`
    SELECT COUNT(DISTINCT memory_id) as n
    FROM memory_embeddings
    WHERE status = 'ready' ${characterId ? 'AND character_id = ?' : ''}
      ${readyTarget.sql}
  `).get(...readyParams) as { n: number }).n;
  const activeTasks = db.prepare(`
    SELECT t.status, COUNT(DISTINCT t.memory_id) as n
    FROM memory_embedding_tasks
    t
    WHERE t.status IN ('pending', 'processing') ${taskCharacterFilter}
    GROUP BY t.status
  `).all(...taskParams) as Array<{ status: string; n: number }>;
  const unresolvedFailed = db.prepare(`
    SELECT COUNT(DISTINCT t.memory_id) as n
    FROM memory_embedding_tasks t
    WHERE t.status = 'failed' ${taskCharacterFilter}
      AND NOT EXISTS (
        SELECT 1 FROM memory_embedding_tasks active
        WHERE active.memory_id = t.memory_id
          AND active.status IN ('pending', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_embeddings e
        WHERE e.memory_id = t.memory_id
          AND e.status = 'ready'
          ${failedReadyTarget.sql}
      )
  `).get(...failedParams) as { n: number };
  const latestFailed = db.prepare(`
    SELECT t.error_message
    FROM memory_embedding_tasks t
    WHERE t.status = 'failed' ${taskCharacterFilter}
      AND t.error_message IS NOT NULL
      AND t.error_message != ''
      AND NOT EXISTS (
        SELECT 1 FROM memory_embedding_tasks active
        WHERE active.memory_id = t.memory_id
          AND active.status IN ('pending', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_embeddings e
        WHERE e.memory_id = t.memory_id
          AND e.status = 'ready'
          ${failedReadyTarget.sql}
      )
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT 1
  `).get(...latestFailedParams) as { error_message: string } | undefined;

  const byStatus = new Map(activeTasks.map(row => [row.status, row.n]));
  return {
    total,
    ready,
    pending: byStatus.get('pending') || 0,
    processing: byStatus.get('processing') || 0,
    failed: unresolvedFailed.n || 0,
    latest_error: latestFailed?.error_message || null,
  };
}

export async function processMemoryEmbeddingTasks(
  config: EmbeddingAdapterConfig,
  options: {
    limit?: number;
    leaseSeconds?: number;
    db?: Database.Database;
    embed?: (text: string, config: EmbeddingAdapterConfig) => Promise<ArrayLike<number>>;
    embedBatch?: (texts: string[], config: EmbeddingAdapterConfig) => Promise<ArrayLike<number>[]>;
  } = {},
): Promise<{ processed: number; failed: number }> {
  const db = options.db || getDb();
  ensureMemoryEmbeddingTables(db);
  const limit = Math.max(1, Math.min(options.limit || 8, 64));
  const leaseSeconds = Math.max(
    1,
    Math.floor(options.leaseSeconds ?? DEFAULT_BACKGROUND_TASK_LEASE_SECONDS),
  );
  const provider = config.provider || 'openai-compatible';
  const model = config.model?.trim() || '';
  const embed = options.embed || embedText;
  const embedBatch = options.embedBatch || (options.embed ? null : embedTexts);
  let processed = 0;
  let failed = 0;

  // 可恢复失败后的冷却：retry_count>0 时需等 updated_at 过了延迟才可再 claim
  const retryReadyBefore = new Date(Date.now() - RECOVERABLE_EMBEDDING_RETRY_DELAY_MS).toISOString();
  const tasks = embeddingTaskQueue.claim<MemoryEmbeddingTask>(db, {
    limit,
    leaseSeconds,
    filters: [{
      sql: `(retry_count = 0 OR updated_at <= ?)`,
      params: [retryReadyBefore],
    }],
  });

  const finishMissingMemoryTask = (task: MemoryEmbeddingTask) => {
    if (embeddingTaskQueue.complete(db, task)) processed += 1;
  };

  const failTask = (task: MemoryEmbeddingTask, error: unknown) => {
    const errorMessage = getEmbeddingErrorMessage(error);
    const nextRetryCount = task.retry_count + 1;
    const shouldRetry = isRecoverableEmbeddingError(errorMessage)
      && nextRetryCount < MAX_RECOVERABLE_EMBEDDING_ATTEMPTS;
    if (shouldRetry) {
      embeddingTaskQueue.requeue(db, task, {
        errorMessage,
        incrementRetry: true,
      });
      return;
    }
    if (embeddingTaskQueue.fail(db, task, errorMessage)) failed += 1;
  };

  const completeTask = (task: MemoryEmbeddingTask, memory: Memory, text: string, embedding: ArrayLike<number>) => {
    const completed = db.transaction(() => {
      if (!embeddingTaskQueue.confirmClaim(db, task)) return false;

      upsertMemoryEmbedding({
        memoryId: task.memory_id,
        characterId: task.character_id,
        provider,
        model,
        embedding,
        embeddingTextHash: hashEmbeddingText(text),
        db,
      });

      return embeddingTaskQueue.complete(db, task);
    })();
    if (completed) processed += 1;
  };

  if (embedBatch) {
    const batchItems: Array<{ task: MemoryEmbeddingTask; memory: Memory; text: string }> = [];
    for (const task of tasks) {
      const memory = db.prepare('SELECT * FROM memories WHERE id = ? AND character_id = ?')
        .get(task.memory_id, task.character_id) as Memory | undefined;
      if (!memory) {
        finishMissingMemoryTask(task);
        continue;
      }
      batchItems.push({ task, memory, text: buildMemoryEmbeddingText(memory) });
    }

    if (batchItems.length > 0) {
      try {
        const embeddings = await embedBatch(batchItems.map(item => item.text), config);
        if (embeddings.length !== batchItems.length) {
          throw new Error(`embedding response count mismatch: expected ${batchItems.length}, got ${embeddings.length}`);
        }
        for (let index = 0; index < batchItems.length; index += 1) {
          const item = batchItems[index];
          completeTask(item.task, item.memory, item.text, embeddings[index]);
        }
      } catch (error) {
        for (const item of batchItems) {
          failTask(item.task, error);
        }
      }
    }

    return { processed, failed };
  }

  for (const task of tasks) {
    try {
      const memory = db.prepare('SELECT * FROM memories WHERE id = ? AND character_id = ?')
        .get(task.memory_id, task.character_id) as Memory | undefined;
      if (!memory) {
        finishMissingMemoryTask(task);
        continue;
      }

      const text = buildMemoryEmbeddingText(memory);
      const embedding = await embed(text, config);
      completeTask(task, memory, text, embedding);
    } catch (error) {
      failTask(task, error);
    }
  }

  return { processed, failed };
}
