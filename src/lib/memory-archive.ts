import { MEMORY_STATUSES, type MemoryCategory, type MemoryKind, type MemoryStatus } from '@/types';
import type Database from 'better-sqlite3';

export interface MemoryArchiveSourceMemory {
  id: string;
  category: MemoryCategory;
  content: string;
  confidence: number;
  tags: string[];
  source_msg_ids: string[];
  memory_kind: MemoryKind;
  importance: number;
  emotional_weight: number;
  status: MemoryStatus;
  pinned: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface PlanMemorySummaryArchiveParams {
  batchId: string;
  characterId: string;
  summaryMemoryId: string;
  summaryContent: string;
  sourceMemories: MemoryArchiveSourceMemory[];
  now: string;
}

export interface MemoryArchiveSummaryInsert {
  id: string;
  character_id: string;
  category: MemoryCategory;
  content: string;
  confidence: number;
  tags: string[];
  source_msg_ids: string[];
  memory_kind: MemoryKind;
  importance: number;
  emotional_weight: number;
  status: Extract<MemoryStatus, 'active'>;
  pinned: false;
  last_used_at: null;
  usage_count: 0;
  metadata: {
    archiveBatchId: string;
    archiveRole: 'summary';
    coveredMemoryIds: string[];
  };
  created_at: string;
  updated_at: string;
}

export interface MemoryArchiveCoveredUpdate {
  id: string;
  status: Extract<MemoryStatus, 'summarized' | 'archived'>;
  metadata: Record<string, unknown> & {
    archiveBatchId: string;
    summarizedBy: string;
    previousStatus: MemoryStatus;
  };
  updated_at: string;
}

export interface MemoryArchivePlan {
  summaryMemory: MemoryArchiveSummaryInsert;
  coveredMemoryUpdates: MemoryArchiveCoveredUpdate[];
}

export interface ExecuteMemorySummaryArchiveParams {
  batchId: string;
  characterId: string;
  summaryMemoryId: string;
  summaryContent: string;
  coveredMemoryIds: string[];
  now: string;
}

export interface UndoMemorySummaryArchiveBatchParams {
  batchId: string;
  characterId: string;
  now: string;
}

export interface UndoMemorySummaryArchiveBatchResult {
  summaryMemoryId: string | null;
  restoredMemoryIds: string[];
}

export interface MemoryArchiveBatch {
  batch_id: string;
  summary_memory_id: string | null;
  summary_content: string;
  covered_count: number;
  updated_at: string;
}

type MemoryRow = {
  id: string;
  character_id: string;
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
  return [...new Set(values)];
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

function toSourceMemory(row: MemoryRow): MemoryArchiveSourceMemory {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    confidence: row.confidence,
    tags: parseJsonArray(row.tags),
    source_msg_ids: parseJsonArray(row.source_msg_ids),
    memory_kind: row.memory_kind,
    importance: row.importance,
    emotional_weight: row.emotional_weight,
    status: row.status,
    pinned: row.pinned === 1,
    metadata: parseJsonObject(row.metadata),
  };
}

export function planMemorySummaryArchive(params: PlanMemorySummaryArchiveParams): MemoryArchivePlan {
  const coveredMemoryIds = params.sourceMemories.map(memory => memory.id);
  const sourceMsgIds = uniqueStrings(params.sourceMemories.flatMap(memory => memory.source_msg_ids));

  const summaryMemory: MemoryArchiveSummaryInsert = {
    id: params.summaryMemoryId,
    character_id: params.characterId,
    category: '基础信息',
    content: params.summaryContent,
    confidence: 0.9,
    tags: ['archive-summary'],
    source_msg_ids: sourceMsgIds,
    memory_kind: 'general',
    importance: 0.7,
    emotional_weight: 0,
    status: 'active',
    pinned: false,
    last_used_at: null,
    usage_count: 0,
    metadata: {
      archiveBatchId: params.batchId,
      archiveRole: 'summary',
      coveredMemoryIds,
    },
    created_at: params.now,
    updated_at: params.now,
  };

  return {
    summaryMemory,
    coveredMemoryUpdates: params.sourceMemories.map(memory => ({
      id: memory.id,
      status: memory.pinned ? 'summarized' : 'archived',
      metadata: {
        ...(memory.metadata ?? {}),
        archiveBatchId: params.batchId,
        summarizedBy: params.summaryMemoryId,
        previousStatus: memory.status,
      },
      updated_at: params.now,
    })),
  };
}

export function executeMemorySummaryArchive(
  db: Database.Database,
  params: ExecuteMemorySummaryArchiveParams,
): MemoryArchivePlan {
  if (params.coveredMemoryIds.length === 0) {
    throw new Error('coveredMemoryIds must not be empty');
  }

  return db.transaction(() => {
    const placeholders = params.coveredMemoryIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT * FROM memories
      WHERE character_id = ? AND id IN (${placeholders})
    `).all(params.characterId, ...params.coveredMemoryIds) as MemoryRow[];

    if (rows.length !== params.coveredMemoryIds.length) {
      throw new Error('Some covered memories were not found');
    }

    // 只允许把 active 的普通记忆纳入归档:
    // - 拒绝非 active(否则 previousStatus 会记成 archived/superseded,undo 后记忆停在非 active 被静默隐藏);
    // - 拒绝已是某批次 summary 或已带 archiveBatchId 的记忆(否则其 archiveBatchId 被覆盖,原批次 undo 找不到 summary,链路损坏)。
    for (const row of rows) {
      if (row.status !== 'active') {
        throw new Error('Only active memories can be archived');
      }
      const metadata = parseJsonObject(row.metadata);
      if (metadata.archiveRole === 'summary' || metadata.archiveBatchId) {
        throw new Error('Archive summary memories cannot be re-archived');
      }
    }

    const rowById = new Map(rows.map(row => [row.id, row]));
    const sourceMemories = params.coveredMemoryIds.map(id => toSourceMemory(rowById.get(id)!));
    const plan = planMemorySummaryArchive({
      batchId: params.batchId,
      characterId: params.characterId,
      summaryMemoryId: params.summaryMemoryId,
      summaryContent: params.summaryContent,
      sourceMemories,
      now: params.now,
    });

    db.prepare(`
      INSERT INTO memories (
        id, character_id, category, content, confidence, tags, source_msg_ids,
        memory_kind, importance, emotional_weight, status, pinned, last_used_at,
        usage_count, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.summaryMemory.id,
      plan.summaryMemory.character_id,
      plan.summaryMemory.category,
      plan.summaryMemory.content,
      plan.summaryMemory.confidence,
      JSON.stringify(plan.summaryMemory.tags),
      JSON.stringify(plan.summaryMemory.source_msg_ids),
      plan.summaryMemory.memory_kind,
      plan.summaryMemory.importance,
      plan.summaryMemory.emotional_weight,
      plan.summaryMemory.status,
      0,
      plan.summaryMemory.last_used_at,
      plan.summaryMemory.usage_count,
      JSON.stringify(plan.summaryMemory.metadata),
      plan.summaryMemory.created_at,
      plan.summaryMemory.updated_at,
    );

    const updateCovered = db.prepare(`
      UPDATE memories
      SET status = ?, metadata = ?, updated_at = ?
      WHERE character_id = ? AND id = ?
    `);
    for (const update of plan.coveredMemoryUpdates) {
      updateCovered.run(
        update.status,
        JSON.stringify(update.metadata),
        update.updated_at,
        params.characterId,
        update.id,
      );
    }

    return plan;
  })();
}

export function undoMemorySummaryArchiveBatch(
  db: Database.Database,
  params: UndoMemorySummaryArchiveBatchParams,
): UndoMemorySummaryArchiveBatchResult {
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM memories
      WHERE character_id = ?
        AND json_extract(metadata, '$.archiveBatchId') = ?
        AND json_extract(metadata, '$.summarizedBy') IS NOT NULL
    `).all(params.characterId, params.batchId) as MemoryRow[];

    const summary = db.prepare(`
      SELECT * FROM memories
      WHERE character_id = ?
        AND json_extract(metadata, '$.archiveBatchId') = ?
        AND json_extract(metadata, '$.archiveRole') = 'summary'
      LIMIT 1
    `).get(params.characterId, params.batchId) as MemoryRow | undefined;

    const updateCovered = db.prepare(`
      UPDATE memories
      SET status = ?, metadata = ?, updated_at = ?
      WHERE character_id = ? AND id = ?
    `);

    const restoredMemoryIds: string[] = [];
    for (const row of rows) {
      const metadata = parseJsonObject(row.metadata);
      const previousStatus = metadata.previousStatus ?? 'active';
      if (!isMemoryStatus(previousStatus)) {
        throw new Error(`Invalid archive previousStatus for memory ${row.id}`);
      }
      delete metadata.archiveBatchId;
      delete metadata.summarizedBy;
      delete metadata.previousStatus;

      updateCovered.run(
        previousStatus,
        JSON.stringify(metadata),
        params.now,
        params.characterId,
        row.id,
      );
      restoredMemoryIds.push(row.id);
    }

    if (summary) {
      // 撤销时直接删除 summary 记忆：它是归档时临时生成的，
      // 撤销后原始记忆已恢复，summary 保留为 archived 只会污染诊断计数。
      db.prepare('DELETE FROM memories WHERE character_id = ? AND id = ?')
        .run(params.characterId, summary.id);
    }

    return {
      summaryMemoryId: summary?.id ?? null,
      restoredMemoryIds,
    };
  })();
}

export function listUndoableMemoryArchiveBatches(
  db: Database.Database,
  characterId: string,
): MemoryArchiveBatch[] {
  return db.prepare(`
    SELECT
      json_extract(covered.metadata, '$.archiveBatchId') as batch_id,
      json_extract(covered.metadata, '$.summarizedBy') as summary_memory_id,
      COALESCE(summary.content, '') as summary_content,
      COUNT(*) as covered_count,
      MAX(covered.updated_at) as updated_at
    FROM memories covered
    LEFT JOIN memories summary
      ON summary.character_id = covered.character_id
      AND summary.id = json_extract(covered.metadata, '$.summarizedBy')
    WHERE covered.character_id = ?
      AND json_extract(covered.metadata, '$.archiveBatchId') IS NOT NULL
      AND json_extract(covered.metadata, '$.summarizedBy') IS NOT NULL
    GROUP BY batch_id, summary_memory_id, summary_content
    ORDER BY updated_at DESC
  `).all(characterId) as MemoryArchiveBatch[];
}
