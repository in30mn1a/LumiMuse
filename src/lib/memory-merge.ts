/**
 * 审核式记忆合并：execute / undo / list。
 * 源记忆 supersede 不物理删除；结果记忆带 mergeRole=result；整批可撤销。
 * 守卫语义对齐归档：仅 active、拒绝二次占用。
 */
import type Database from 'better-sqlite3';
import { MEMORY_CATEGORIES, MEMORY_KINDS, MEMORY_STATUSES, type MemoryCategory, type MemoryKind, type MemoryStatus } from '@/types';
import { MAX_MEMORY_CONTENT } from '@/lib/schemas';

export type MemoryMergeKind = 'merge' | 'conflict';

export interface ExecuteMemoryMergeParams {
  batchId: string;
  characterId: string;
  resultMemoryId: string;
  sourceIds: string[];
  mergedContent: string;
  category?: string;
  tags?: string[];
  importance?: number;
  memoryKind?: string;
  now: string;
}

export interface ExecuteMemoryMergeResult {
  batchId: string;
  resultMemoryId: string;
  sourceIds: string[];
  content: string;
}

export interface UndoMemoryMergeBatchParams {
  batchId: string;
  characterId: string;
  now: string;
}

export interface UndoMemoryMergeBatchResult {
  resultMemoryId: string | null;
  restoredMemoryIds: string[];
}

export interface MemoryMergeBatch {
  batch_id: string;
  result_memory_id: string | null;
  result_content: string;
  covered_count: number;
  updated_at: string;
}

type MemoryRow = {
  id: string;
  character_id: string;
  category: string;
  content: string;
  confidence: number;
  tags: string;
  source_msg_ids: string;
  memory_kind: string;
  importance: number;
  emotional_weight: number;
  status: string;
  pinned: number;
  last_used_at: string | null;
  usage_count: number;
  metadata: string;
  created_at: string;
  updated_at: string;
};

function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim().length > 0))];
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function resolveCategory(value: string | undefined, fallback: string): string {
  if (value && (MEMORY_CATEGORIES as readonly string[]).includes(value)) return value;
  if ((MEMORY_CATEGORIES as readonly string[]).includes(fallback)) return fallback;
  return '基础信息';
}

function resolveMemoryKind(value: string | undefined, fallback: string): string {
  if (value && (MEMORY_KINDS as readonly string[]).includes(value)) return value;
  if ((MEMORY_KINDS as readonly string[]).includes(fallback)) return fallback;
  return 'general';
}

function assertMergeSources(rows: MemoryRow[], sourceIds: string[]): void {
  if (sourceIds.length < 2) {
    throw new Error('source_ids must contain at least 2 memories');
  }
  if (rows.length !== sourceIds.length) {
    throw new Error('Some source memories were not found');
  }
  for (const row of rows) {
    if (row.status !== 'active') {
      throw new Error('Only active memories can be merged');
    }
    if (row.pinned === 1) {
      throw new Error('Pinned memories cannot be merged');
    }
    const metadata = parseJsonObject(row.metadata);
    if (
      metadata.mergeRole === 'result'
      || metadata.mergeBatchId
      || metadata.archiveRole === 'summary'
      || metadata.archiveBatchId
    ) {
      throw new Error('Memories already reserved by merge/archive cannot be re-merged');
    }
  }
}

export function executeMemoryMerge(
  db: Database.Database,
  params: ExecuteMemoryMergeParams,
): ExecuteMemoryMergeResult {
  const mergedContent = (params.mergedContent || '').trim();
  if (!mergedContent) {
    throw new Error('merged_content must not be empty');
  }
  if (mergedContent.length > MAX_MEMORY_CONTENT) {
    throw new Error(`merged_content exceeds MAX_MEMORY_CONTENT (${MAX_MEMORY_CONTENT})`);
  }

  const sourceIds = uniqueStrings(params.sourceIds);
  if (sourceIds.length < 2) {
    throw new Error('source_ids must contain at least 2 memories');
  }

  return db.transaction(() => {
    const placeholders = sourceIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT * FROM memories
      WHERE character_id = ? AND id IN (${placeholders})
    `).all(params.characterId, ...sourceIds) as MemoryRow[];

    // 保持与入参顺序一致，便于测试与溯源展示
    const rowById = new Map(rows.map(row => [row.id, row]));
    const orderedRows = sourceIds.map(id => {
      const row = rowById.get(id);
      if (!row) throw new Error('Some source memories were not found');
      return row;
    });
    assertMergeSources(orderedRows, sourceIds);

    const tags = uniqueStrings(params.tags ?? orderedRows.flatMap(row => parseJsonArray(row.tags))).slice(0, 20);
    const sourceMsgIds = uniqueStrings(orderedRows.flatMap(row => parseJsonArray(row.source_msg_ids)));
    const importance = typeof params.importance === 'number' && Number.isFinite(params.importance)
      ? Math.min(1, Math.max(0, params.importance))
      : Math.max(...orderedRows.map(row => row.importance), 0);
    const category = resolveCategory(params.category, orderedRows[0].category);
    const memoryKind = resolveMemoryKind(params.memoryKind, orderedRows[0].memory_kind);
    const confidence = Math.max(...orderedRows.map(row => row.confidence), 0.8);
    const emotionalWeight = Math.max(...orderedRows.map(row => row.emotional_weight), 0);

    const resultMetadata = {
      mergeBatchId: params.batchId,
      mergeRole: 'result' as const,
      mergedFromIds: sourceIds,
    };

    db.prepare(`
      INSERT INTO memories (
        id, character_id, category, content, confidence, tags, source_msg_ids,
        memory_kind, importance, emotional_weight, status, pinned, last_used_at,
        usage_count, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.resultMemoryId,
      params.characterId,
      category,
      mergedContent,
      confidence,
      JSON.stringify(tags),
      JSON.stringify(sourceMsgIds),
      memoryKind,
      importance,
      emotionalWeight,
      'active',
      0,
      null,
      0,
      JSON.stringify(resultMetadata),
      params.now,
      params.now,
    );

    const updateSource = db.prepare(`
      UPDATE memories
      SET status = ?, metadata = ?, updated_at = ?
      WHERE character_id = ? AND id = ? AND status = 'active'
    `);

    for (const row of orderedRows) {
      const metadata = parseJsonObject(row.metadata);
      metadata.previousStatus = row.status;
      metadata.mergeBatchId = params.batchId;
      metadata.mergedInto = params.resultMemoryId;
      metadata.supersededBy = {
        action: 'memory_merge',
        memoryId: params.resultMemoryId,
        sourceMsgIds,
        supersededAt: params.now,
      };
      const result = updateSource.run(
        'superseded',
        JSON.stringify(metadata),
        params.now,
        params.characterId,
        row.id,
      );
      if (result.changes !== 1) {
        throw new Error(`Failed to supersede source memory ${row.id}`);
      }
    }

    return {
      batchId: params.batchId,
      resultMemoryId: params.resultMemoryId,
      sourceIds,
      content: mergedContent,
    };
  })();
}

export function undoMemoryMergeBatch(
  db: Database.Database,
  params: UndoMemoryMergeBatchParams,
): UndoMemoryMergeBatchResult {
  return db.transaction(() => {
    const sources = db.prepare(`
      SELECT * FROM memories
      WHERE character_id = ?
        AND json_extract(metadata, '$.mergeBatchId') = ?
        AND json_extract(metadata, '$.mergedInto') IS NOT NULL
    `).all(params.characterId, params.batchId) as MemoryRow[];

    const result = db.prepare(`
      SELECT * FROM memories
      WHERE character_id = ?
        AND json_extract(metadata, '$.mergeBatchId') = ?
        AND json_extract(metadata, '$.mergeRole') = 'result'
      LIMIT 1
    `).get(params.characterId, params.batchId) as MemoryRow | undefined;

    const updateSource = db.prepare(`
      UPDATE memories
      SET status = ?, metadata = ?, updated_at = ?
      WHERE character_id = ? AND id = ?
    `);

    const restoredMemoryIds: string[] = [];
    for (const row of sources) {
      const metadata = parseJsonObject(row.metadata);
      const previousStatus = metadata.previousStatus ?? 'active';
      if (!isMemoryStatus(previousStatus)) {
        throw new Error(`Invalid merge previousStatus for memory ${row.id}`);
      }
      delete metadata.mergeBatchId;
      delete metadata.mergedInto;
      delete metadata.previousStatus;
      delete metadata.supersededBy;

      updateSource.run(
        previousStatus,
        JSON.stringify(metadata),
        params.now,
        params.characterId,
        row.id,
      );
      restoredMemoryIds.push(row.id);
    }

    if (result) {
      // 撤销时删除合并结果：它是确认时生成的产物，源记忆恢复后保留只会污染列表与诊断。
      db.prepare('DELETE FROM memories WHERE character_id = ? AND id = ?')
        .run(params.characterId, result.id);
    }

    return {
      resultMemoryId: result?.id ?? null,
      restoredMemoryIds,
    };
  })();
}

export function listUndoableMemoryMergeBatches(
  db: Database.Database,
  characterId: string,
): MemoryMergeBatch[] {
  return db.prepare(`
    SELECT
      json_extract(covered.metadata, '$.mergeBatchId') as batch_id,
      json_extract(covered.metadata, '$.mergedInto') as result_memory_id,
      COALESCE(result.content, '') as result_content,
      COUNT(*) as covered_count,
      MAX(covered.updated_at) as updated_at
    FROM memories covered
    LEFT JOIN memories result
      ON result.character_id = covered.character_id
      AND result.id = json_extract(covered.metadata, '$.mergedInto')
    WHERE covered.character_id = ?
      AND json_extract(covered.metadata, '$.mergeBatchId') IS NOT NULL
      AND json_extract(covered.metadata, '$.mergedInto') IS NOT NULL
    GROUP BY batch_id
    ORDER BY updated_at DESC
  `).all(characterId) as MemoryMergeBatch[];
}

