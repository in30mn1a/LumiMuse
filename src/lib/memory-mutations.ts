import type Database from 'better-sqlite3';
import { inferMemoryDefaults, normalizeMemoryCategory } from '@/lib/memory-category';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';
import type { MemoryArchiveSourceMemory } from '@/lib/memory-archive';
import type { MemoryCreate, MemoryUpdate } from '@/lib/schemas';
import type { Memory, MemoryCategory, MemoryKind, MemoryStatus } from '@/types';

type MemorySourceRow = {
  id: string;
  category: MemoryCategory;
  content: string;
  confidence: number;
  tags: string;
  source_msg_ids: string;
  memory_kind: MemoryKind;
  importance: number;
  emotional_weight: number;
  status: MemoryStatus;
  pinned: number;
  metadata: string;
};

export type MemoryUpdateResult = 'updated' | 'no_fields' | 'not_found';

export type ArchiveSourcesResult =
  | { ok: true; sources: MemoryArchiveSourceMemory[] }
  | { ok: false; reason: 'not_found' | 'not_archivable' };

const BUSINESS_SNAPSHOT_FIELDS = [
  'content',
  'category',
  'confidence',
  'tags',
  'source_msg_ids',
  'memory_kind',
  'importance',
  'emotional_weight',
  'status',
  'pinned',
  'metadata',
] as const;

type BusinessSnapshotField = (typeof BUSINESS_SNAPSHOT_FIELDS)[number];

export type MemoryBusinessSnapshot = Record<BusinessSnapshotField, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toSourceMemory(row: MemorySourceRow): MemoryArchiveSourceMemory {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    confidence: row.confidence,
    tags: parseStringArray(row.tags),
    source_msg_ids: parseStringArray(row.source_msg_ids),
    memory_kind: row.memory_kind,
    importance: row.importance,
    emotional_weight: row.emotional_weight,
    status: row.status,
    pinned: row.pinned === 1,
    metadata: parseMetadata(row.metadata),
  };
}

function enqueueEmbeddingAfterWrite(
  db: Database.Database,
  memoryId: string,
  characterId: string,
  reason: 'created' | 'updated',
): void {
  try {
    if (enqueueMemoryEmbeddingTask(memoryId, characterId, reason, db)) {
      triggerMemoryIndexProcessing();
    }
  } catch (error) {
    const action = reason === 'created' ? 'create' : 'update';
    console.error(`Failed to enqueue memory embedding task after memory ${action}`, {
      memoryId,
      characterId,
      error,
    });
  }
}

export function applyMemoryUpdate(
  db: Database.Database,
  id: string,
  patch: MemoryUpdate & { source_msg_ids?: string[] },
  now: string,
): MemoryUpdateResult {
  const existing = db.prepare('SELECT character_id FROM memories WHERE id = ?').get(id) as
    | { character_id: string }
    | undefined;
  if (!existing) return 'not_found';

  const shouldEnqueueEmbeddingUpdate =
    patch.category !== undefined ||
    patch.content !== undefined ||
    patch.tags !== undefined ||
    patch.memory_kind !== undefined ||
    patch.importance !== undefined ||
    patch.emotional_weight !== undefined ||
    patch.status !== undefined ||
    patch.pinned !== undefined;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.category !== undefined) { fields.push('category = ?'); values.push(normalizeMemoryCategory(patch.category)); }
  if (patch.content !== undefined) { fields.push('content = ?'); values.push(patch.content); }
  if (patch.confidence !== undefined) { fields.push('confidence = ?'); values.push(patch.confidence); }
  if (patch.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(patch.tags)); }
  if (patch.source_msg_ids !== undefined) { fields.push('source_msg_ids = ?'); values.push(JSON.stringify(patch.source_msg_ids)); }
  if (patch.memory_kind !== undefined) { fields.push('memory_kind = ?'); values.push(patch.memory_kind); }
  if (patch.importance !== undefined) { fields.push('importance = ?'); values.push(patch.importance); }
  if (patch.emotional_weight !== undefined) { fields.push('emotional_weight = ?'); values.push(patch.emotional_weight); }
  if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status); }
  if (patch.pinned !== undefined) { fields.push('pinned = ?'); values.push(patch.pinned ? 1 : 0); }
  if (patch.last_used_at !== undefined) { fields.push('last_used_at = ?'); values.push(patch.last_used_at); }
  if (patch.usage_count !== undefined) { fields.push('usage_count = ?'); values.push(patch.usage_count); }
  if (patch.metadata !== undefined) { fields.push('metadata = ?'); values.push(JSON.stringify(patch.metadata)); }
  if (fields.length === 0) return 'no_fields';

  fields.push('updated_at = ?'); values.push(now);
  values.push(id);
  db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  if (shouldEnqueueEmbeddingUpdate) {
    enqueueEmbeddingAfterWrite(db, id, existing.character_id, 'updated');
  }
  return 'updated';
}

export function createMemoryRow(db: Database.Database, input: MemoryCreate, now: string): Memory {
  const id = crypto.randomUUID().slice(0, 12);
  const category = normalizeMemoryCategory(input.category);
  const defaults = inferMemoryDefaults(category);

  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.character_id,
    category,
    input.content,
    input.confidence ?? 0.9,
    JSON.stringify(input.tags || []),
    input.memory_kind ?? defaults.memory_kind,
    input.importance ?? defaults.importance,
    input.emotional_weight ?? defaults.emotional_weight,
    input.status ?? 'active',
    input.pinned ? 1 : 0,
    input.last_used_at ?? null,
    input.usage_count ?? 0,
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );

  enqueueEmbeddingAfterWrite(db, id, input.character_id, 'created');

  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory;
}

/**
 * 读取并校验归档来源。提前拒绝非 active / 已是 summary / 已归档的记忆；
 * executeMemorySummaryArchive 内部还会在事务里再校验一次，兜住 preview→execute 之间的状态变化。
 */
export function loadArchiveSources(
  db: Database.Database,
  characterId: string,
  coveredMemoryIds: string[],
): ArchiveSourcesResult {
  const placeholders = coveredMemoryIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, metadata
    FROM memories
    WHERE character_id = ? AND id IN (${placeholders})
  `).all(characterId, ...coveredMemoryIds) as MemorySourceRow[];

  if (rows.length !== coveredMemoryIds.length) {
    return { ok: false, reason: 'not_found' };
  }

  const rowById = new Map(rows.map(row => [row.id, row]));
  const sources = coveredMemoryIds.map(id => toSourceMemory(rowById.get(id)!));
  const hasInvalidSource = sources.some(
    memory => memory.status !== 'active'
      || memory.metadata?.archiveRole === 'summary'
      || Boolean(memory.metadata?.archiveBatchId),
  );
  return hasInvalidSource ? { ok: false, reason: 'not_archivable' } : { ok: true, sources };
}

function parseJsonField(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    // 损坏的 JSON 按原文比较，不能当成空值，否则会掩盖真实变化
    return value;
  }
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, sortObjectKeys(value[key])]),
  );
}

/**
 * 记忆的业务快照，用于判断记忆在提案之后是否被改过。
 * 只排除日常使用和时间戳（usage_count、last_used_at、created_at、updated_at），
 * 这样既不会被检索注入触发误判，也不会漏掉只补来源的改动。
 * JSON 字段解析并排序键后输出，JSON.stringify 的结果可以直接比较。
 */
export function memoryBusinessSnapshot(row: MemoryBusinessSnapshot): MemoryBusinessSnapshot {
  return {
    content: row.content,
    category: row.category,
    confidence: row.confidence,
    tags: sortObjectKeys(parseJsonField(row.tags)),
    source_msg_ids: sortObjectKeys(parseJsonField(row.source_msg_ids)),
    memory_kind: row.memory_kind,
    importance: row.importance,
    emotional_weight: row.emotional_weight,
    status: row.status,
    pinned: Boolean(row.pinned),
    metadata: sortObjectKeys(parseJsonField(row.metadata)),
  };
}
