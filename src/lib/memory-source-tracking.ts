import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';

export type MemorySourceInvalidationReason = 'deleted' | 'edited';

interface MemorySourceInvalidationParams {
  db?: Database.Database;
  messageId: string;
  reason: MemorySourceInvalidationReason;
  replacementMessageId?: string;
  now?: string;
}

interface SourceMemoryRow {
  id: string;
  status: string;
  metadata: string;
  source_msg_ids: string;
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseSourceMessageIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function invalidateMemoriesForSourceMessage(params: MemorySourceInvalidationParams): { updatedCount: number } {
  const db = params.db || getDb();
  const now = params.now || new Date().toISOString();
  const rows = db.prepare(`
    SELECT id, status, metadata, source_msg_ids
    FROM memories
    WHERE status = 'active'
      AND source_msg_ids LIKE ?
  `).all(`%"${params.messageId}"%`) as SourceMemoryRow[];

  let updatedCount = 0;
  const update = db.prepare(`
    UPDATE memories
    SET status = 'superseded',
        metadata = ?,
        updated_at = ?
    WHERE id = ?
  `);

  db.transaction(() => {
    for (const row of rows) {
      if (!parseSourceMessageIds(row.source_msg_ids).includes(params.messageId)) continue;

      const metadata = parseMetadata(row.metadata);
      update.run(JSON.stringify({
        ...metadata,
        previousStatus: row.status,
        sourceInvalidation: {
          messageId: params.messageId,
          reason: params.reason,
          replacementMessageId: params.replacementMessageId,
          invalidatedAt: now,
        },
      }), now, row.id);
      updatedCount += 1;
    }
  })();

  return { updatedCount };
}
