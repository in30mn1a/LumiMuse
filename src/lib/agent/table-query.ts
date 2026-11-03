import type Database from 'better-sqlite3';

/**
 * Agent 的通用只读查询：不接受 SQL，只接受「表 + 列 + 等值条件 + 排序 + 分页」，
 * 由这里拼成参数化查询。
 *
 * 安全边界：
 * - 表名、列名只能来自下面的白名单常量，模型给的字符串只用来查表，不会进入 SQL；
 * - 条件的值一律走绑定参数；
 * - api_providers、settings 等含凭据的表不在白名单内，任务表的 claim_token 也不开放。
 *
 * 新增表或列时只改这里，并确认不含密钥一类的内容。
 */
export const QUERYABLE_TABLES = {
  characters: [
    'id', 'name', 'avatar_url', 'basic_info', 'personality', 'scenario', 'greeting',
    'example_dialogue', 'system_prompt', 'other_info', 'image_tags', 'user_image_tags',
    'background_provider_id', 'background_model', 'image_prompt_model',
    'background_reasoning_by_model', 'image_prompt_reasoning_by_model',
    'background_system_prompt_by_model', 'image_prompt_system_prompt_by_model',
    'memory_chat_injection_mode', 'active_preset_id', 'sort_order', 'created_at', 'updated_at',
  ],
  conversations: [
    'id', 'character_id', 'title', 'parent_id', 'parent_seq_end', 'ignore_memory',
    'created_at', 'updated_at',
  ],
  messages: [
    'id', 'conversation_id', 'role', 'content', 'token_count', 'seq', 'metadata', 'created_at',
  ],
  memories: [
    'id', 'character_id', 'category', 'content', 'confidence', 'tags', 'source_msg_ids',
    'memory_kind', 'importance', 'emotional_weight', 'status', 'pinned', 'last_used_at',
    'usage_count', 'metadata', 'created_at', 'updated_at',
  ],
  character_memory_profiles: [
    'character_id', 'profile_name', 'relationship_state', 'recent_story_state',
    'emotional_baseline', 'open_threads', 'user_profile_summary', 'pinned_summary', 'updated_at',
  ],
  character_memory_profile_versions: [
    'id', 'character_id', 'version_number', 'snapshot_json', 'reason', 'task_id', 'created_at',
  ],
  memory_tasks: [
    'id', 'character_id', 'conversation_id', 'message_ids', 'status', 'merge_count',
    'retry_count', 'error_message', 'lease_expires_at', 'started_at', 'result_committed',
    'result_insert_count', 'result_merge_count', 'created_at', 'updated_at',
  ],
  character_memory_profile_update_tasks: [
    'id', 'character_id', 'reason', 'patch_json', 'status', 'lease_expires_at', 'retry_count',
    'error_message', 'created_at', 'updated_at',
  ],
  memory_embedding_tasks: [
    'id', 'memory_id', 'character_id', 'reason', 'status', 'lease_expires_at', 'retry_count',
    'error_message', 'created_at', 'updated_at',
  ],
  memory_extraction_candidates: [
    'id', 'task_id', 'character_id', 'conversation_id', 'raw_candidate_json', 'raw_response',
    'status', 'error_reason', 'created_at', 'updated_at',
  ],
  app_events: [
    'id', 'ts', 'level', 'event', 'character_id', 'conversation_id', 'message_id', 'task_id',
    'provider_id', 'model', 'http_status', 'error_category', 'error_name', 'error_message',
  ],
} as const satisfies Record<string, readonly string[]>;

export type QueryableTable = keyof typeof QUERYABLE_TABLES;

export const QUERYABLE_TABLE_NAMES = Object.keys(QUERYABLE_TABLES) as [QueryableTable, ...QueryableTable[]];

export const TABLE_QUERY_MAX_LIMIT = 50;

export type TableFilterValue = string | number | boolean | null;

export interface TableQuerySpec {
  table: string;
  /** 省略或为空时返回该表全部允许的列 */
  columns?: string[];
  /** 等值条件，多个条件取 AND；null 表示 IS NULL */
  filters?: Array<{ column: string; value: TableFilterValue }>;
  orderBy?: { column: string; direction?: 'asc' | 'desc' };
  limit: number;
  offset: number;
}

export type TableQueryResult =
  | {
    ok: true;
    table: QueryableTable;
    columns: string[];
    rows: Record<string, unknown>[];
    has_more: boolean;
    next_offset: number | null;
  }
  | { ok: false; error: string };

export function isQueryableTable(table: string): table is QueryableTable {
  return Object.prototype.hasOwnProperty.call(QUERYABLE_TABLES, table);
}

export function allowedColumns(table: QueryableTable): readonly string[] {
  return QUERYABLE_TABLES[table];
}

function quoteIdentifier(name: string): string {
  // 名字只来自白名单常量；加引号只是防御性写法
  return `"${name.replace(/"/g, '""')}"`;
}

/** 按白名单校验并拼出参数化 SQL。任何不在白名单内的标识符都直接拒绝。 */
export function buildTableQuery(
  spec: TableQuerySpec,
): { ok: true; table: QueryableTable; columns: string[]; sql: string; params: Array<string | number> } | { ok: false; error: string } {
  if (!isQueryableTable(spec.table)) {
    return { ok: false, error: `不允许查询表 ${JSON.stringify(spec.table)}。可查询的表：${QUERYABLE_TABLE_NAMES.join(', ')}` };
  }
  const table = spec.table;
  const allowed = new Set<string>(QUERYABLE_TABLES[table]);
  const rejectColumn = (column: string) => ({
    ok: false as const,
    error: `表 ${table} 不允许列 ${JSON.stringify(column)}。允许的列：${QUERYABLE_TABLES[table].join(', ')}`,
  });

  const columns = spec.columns && spec.columns.length > 0 ? [...new Set(spec.columns)] : [...QUERYABLE_TABLES[table]];
  for (const column of columns) {
    if (!allowed.has(column)) return rejectColumn(column);
  }

  const where: string[] = [];
  const params: Array<string | number> = [];
  for (const filter of spec.filters || []) {
    if (!allowed.has(filter.column)) return rejectColumn(filter.column);
    if (filter.value === null) {
      where.push(`${quoteIdentifier(filter.column)} IS NULL`);
      continue;
    }
    where.push(`${quoteIdentifier(filter.column)} = ?`);
    params.push(typeof filter.value === 'boolean' ? (filter.value ? 1 : 0) : filter.value);
  }

  let orderSql = 'rowid ASC';
  if (spec.orderBy) {
    if (!allowed.has(spec.orderBy.column)) return rejectColumn(spec.orderBy.column);
    const direction = spec.orderBy.direction === 'desc' ? 'DESC' : 'ASC';
    // rowid 兜底，保证翻页顺序稳定
    orderSql = `${quoteIdentifier(spec.orderBy.column)} ${direction}, rowid ${direction}`;
  }

  if (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > TABLE_QUERY_MAX_LIMIT) {
    return { ok: false, error: `limit 必须是 1 到 ${TABLE_QUERY_MAX_LIMIT} 之间的整数` };
  }
  if (!Number.isInteger(spec.offset) || spec.offset < 0) {
    return { ok: false, error: 'offset 必须是非负整数' };
  }

  const sql = [
    `SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)}`,
    where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    `ORDER BY ${orderSql}`,
    'LIMIT ? OFFSET ?',
  ].filter(Boolean).join(' ');
  // 多取一行只用来判断是否还有下一页
  params.push(spec.limit + 1, spec.offset);
  return { ok: true, table, columns, sql, params };
}

export function runTableQuery(db: Database.Database, spec: TableQuerySpec): TableQueryResult {
  const built = buildTableQuery(spec);
  if (!built.ok) return built;
  const rows = db.prepare(built.sql).all(...built.params) as Record<string, unknown>[];
  const hasMore = rows.length > spec.limit;
  return {
    ok: true,
    table: built.table,
    columns: built.columns,
    rows: hasMore ? rows.slice(0, spec.limit) : rows,
    has_more: hasMore,
    next_offset: hasMore ? spec.offset + spec.limit : null,
  };
}
