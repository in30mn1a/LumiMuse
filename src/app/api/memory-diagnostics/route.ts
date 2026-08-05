import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ensureMemoryEmbeddingTables, getMemoryIndexStatus } from '@/lib/memory-embeddings';
import { loadSettings } from '@/lib/settings';

type CountMap = Record<string, number>;

function hasTable(db: ReturnType<typeof getDb>, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function statusCounts(
  db: ReturnType<typeof getDb>,
  tableName: string,
  statuses: string[],
  characterId?: string,
): CountMap {
  const result = Object.fromEntries(statuses.map(status => [status, 0])) as CountMap;
  if (!hasTable(db, tableName)) return result;

  const where = characterId ? 'WHERE character_id = ?' : '';
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM ${tableName}
    ${where}
    GROUP BY status
  `).all(...(characterId ? [characterId] : [])) as Array<{ status: string; count: number }>;

  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(result, row.status)) {
      result[row.status] = row.count;
    }
  }
  return result;
}

function getCurrentEmbeddingTarget() {
  const engine = loadSettings().memory_engine;
  return {
    provider: 'openai-compatible',
    model: engine.embedding_model,
    dimension: engine.embedding_dimension,
  };
}

/**
 * 与索引面板对齐：ready/total 按当前 embedding target + 活跃记忆计数；
 * library_rows / other_target_ready 暴露库内多模型残留，避免「总数超过记忆」的误解。
 */
function memoryIndexOverview(db: ReturnType<typeof getDb>, characterId?: string) {
  ensureMemoryEmbeddingTables(db);
  const status = getMemoryIndexStatus(characterId, db, getCurrentEmbeddingTarget());
  return {
    ready: status.ready,
    total: status.total,
    failed: status.failed,
    library_rows: status.embedding_rows,
    other_target_ready: status.other_target_ready,
    target_model: status.target_model,
    target_dimension: status.target_dimension,
  };
}

function memoryProfileOverview(db: ReturnType<typeof getDb>, characterId?: string) {
  if (!characterId || !hasTable(db, 'character_memory_profiles')) {
    return { exists: false, filled_fields: 0 };
  }

  const row = db.prepare(`
    SELECT relationship_state, recent_story_state, emotional_baseline,
      open_threads, user_profile_summary, pinned_summary
    FROM character_memory_profiles
    WHERE character_id = ?
  `).get(characterId) as Record<string, string> | undefined;
  if (!row) return { exists: false, filled_fields: 0 };

  const filledFields = [
    row.relationship_state,
    row.recent_story_state,
    row.emotional_baseline,
    row.user_profile_summary,
    row.pinned_summary,
  ].filter(value => value.trim()).length;

  let openThreadsFilled = false;
  try {
    const parsed = JSON.parse(row.open_threads || '[]');
    openThreadsFilled = Array.isArray(parsed) && parsed.length > 0;
  } catch {
    openThreadsFilled = Boolean(row.open_threads?.trim());
  }

  return {
    exists: true,
    filled_fields: filledFields + (openThreadsFilled ? 1 : 0),
  };
}

export async function GET(request: NextRequest) {
  const characterId = request.nextUrl.searchParams.get('character_id')?.trim() || undefined;
  const db = getDb();
  const queueStatuses = ['pending', 'processing', 'failed'];
  const embeddingTasks = statusCounts(db, 'memory_embedding_tasks', queueStatuses, characterId);

  return NextResponse.json({
    ok: true,
    character_id: characterId || null,
    index: memoryIndexOverview(db, characterId),
    tasks: embeddingTasks,
    queues: {
      extraction: statusCounts(db, 'memory_tasks', queueStatuses, characterId),
      profile: statusCounts(db, 'character_memory_profile_update_tasks', queueStatuses, characterId),
      embedding: embeddingTasks,
    },
    candidates: statusCounts(db, 'memory_extraction_candidates', ['repairable', 'ignored'], characterId),
    profile: memoryProfileOverview(db, characterId),
    archive: statusCounts(db, 'memories', ['archived', 'summarized'], characterId),
  });
}
