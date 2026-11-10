import type Database from 'better-sqlite3';

export const AGENT_ISSUE_KINDS = ['extraction', 'profile', 'embedding', 'repairable', 'errors'] as const;
export type AgentIssueKind = typeof AGENT_ISSUE_KINDS[number];

export interface AgentIssueSnapshot {
  kind: AgentIssueKind;
  id: number;
  version: string;
}

const SOURCES = {
  extraction: { table: 'memory_tasks', condition: "status = 'failed'", retry: true },
  profile: { table: 'character_memory_profile_update_tasks', condition: "status = 'failed'", retry: true },
  embedding: { table: 'memory_embedding_tasks', condition: "status = 'failed'", retry: true },
  repairable: { table: 'memory_extraction_candidates', condition: "status = 'repairable'", retry: false },
  errors: { table: 'app_events', condition: "level = 'error'", retry: false },
} as const;

/** 参数均来自内部常量，不能传入模型提供的标识符。 */
function versionSql(kind: AgentIssueKind, alias: string): string {
  if (kind === 'errors') return "''";
  const updated = `COALESCE(${alias}.updated_at, '')`;
  return SOURCES[kind].retry ? `${updated} || ':' || ${alias}.retry_count` : updated;
}

export function activeAgentIssueSql(kind: AgentIssueKind, alias: string = SOURCES[kind].table): string {
  return `NOT EXISTS (
    SELECT 1 FROM agent_status_dismissals AS dismissed
    WHERE dismissed.kind = '${kind}' AND dismissed.source_id = ${alias}.id
      AND dismissed.source_version = (${versionSql(kind, alias)})
  )`;
}

/** 通用查表也排除已忽略的问题；其他状态的源记录仍正常可见。 */
export function activeAgentTableSql(table: string): string | null {
  const kind = AGENT_ISSUE_KINDS.find(item => SOURCES[item].table === table);
  if (!kind) return null;
  return `(NOT (${SOURCES[kind].condition}) OR ${activeAgentIssueSql(kind)})`;
}

export function readActiveAgentIssueSnapshot(db: Database.Database, since: string): AgentIssueSnapshot[] {
  return AGENT_ISSUE_KINDS.flatMap(kind => {
    const source = SOURCES[kind];
    const rows = db.prepare(`
      SELECT id, ${versionSql(kind, source.table)} AS version FROM ${source.table}
      WHERE ${source.condition} AND ${activeAgentIssueSql(kind)} ${kind === 'errors' ? 'AND ts >= ?' : ''}
      ORDER BY id
    `).all(...(kind === 'errors' ? [since] : [])) as Array<{ id: number; version: string }>;
    return rows.map(row => ({ kind, ...row }));
  });
}

export function activeAgentIssueCount(db: Database.Database, kind: AgentIssueKind, characterId?: string): number {
  const source = SOURCES[kind];
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM ${source.table}
    WHERE ${source.condition} AND ${activeAgentIssueSql(kind)} ${characterId ? 'AND character_id = ?' : ''}
  `).get(...(characterId ? [characterId] : [])) as { count: number }).count;
}

/** 与记忆索引的未解决失败口径一致，仅在 Agent 层排除已忽略的任务。 */
export function activeAgentIndexFailureCount(
  db: Database.Database,
  target: { model?: string | null; dimension?: number | null },
  characterId?: string,
): number {
  const model = target.model?.trim();
  const dimension = Math.floor(Number(target.dimension || 0));
  const params: Array<string | number> = characterId ? [characterId] : [];
  if (model) params.push(model);
  if (dimension > 0) params.push(dimension);
  return (db.prepare(`
    SELECT COUNT(DISTINCT t.memory_id) AS count FROM memory_embedding_tasks t
    WHERE t.status = 'failed' AND ${activeAgentIssueSql('embedding', 't')}
      ${characterId ? 'AND t.character_id = ?' : ''}
      AND NOT EXISTS (
        SELECT 1 FROM memory_embedding_tasks active
        WHERE active.memory_id = t.memory_id AND active.status IN ('pending', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_embeddings e WHERE e.memory_id = t.memory_id AND e.status = 'ready'
          AND e.provider = 'openai-compatible' ${model ? 'AND e.model = ?' : 'AND 1 = 0'}
          ${dimension > 0 ? 'AND e.dimension = ?' : ''}
      )
  `).get(...params) as { count: number }).count;
}

/** 只忽略读取时那一版；期间重试、更新或新增的问题不会被旧快照吞掉。 */
export function dismissAgentIssueSnapshot(db: Database.Database, snapshot: AgentIssueSnapshot[], now: string): void {
  db.transaction(() => {
    for (const item of snapshot) {
      const source = SOURCES[item.kind];
      db.prepare(`
        INSERT INTO agent_status_dismissals (kind, source_id, source_version, dismissed_at)
        SELECT ?, id, ${versionSql(item.kind, source.table)}, ? FROM ${source.table}
        WHERE id = ? AND ${source.condition} AND (${versionSql(item.kind, source.table)}) = ?
        ON CONFLICT(kind, source_id) DO UPDATE SET source_version = excluded.source_version, dismissed_at = excluded.dismissed_at
      `).run(item.kind, now, item.id, item.version);
    }
  })();
}
