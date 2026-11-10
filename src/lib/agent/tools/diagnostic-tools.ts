import { z } from 'zod';
import { getMemorySystemStatus } from '@/lib/memory-status';
import { activeAgentIndexFailureCount, activeAgentIssueCount, activeAgentIssueSql } from '@/lib/agent/status-dismissals';
import { defineReadTool } from './types';
import { pageFromOverfetch, pagingShape, parseJsonColumn, runReadTool } from './shared';

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_TOP_EVENT_COUNT = 10;
const inactiveShape = {
  include_inactive: z.boolean().optional().describe('包含主人已忽略的问题；默认排除'),
};

export const getSystemStatusTool = defineReadTool({
  name: 'get_system_status',
  description: '查看记忆系统状态：向量索引进度、提取/画像/索引队列计数、待修复提取记录、画像是否存在、归档数量，以及最近 24 小时（全局）的错误与警告记录统计。可按角色过滤记忆系统部分。',
  schema: z.object({
    character_id: z.string().min(1).optional().describe('只统计该角色的记忆系统'),
    ...inactiveShape,
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const memorySystem = getMemorySystemStatus(ctx.db, args.character_id);
    if (!args.include_inactive) {
      for (const kind of ['extraction', 'profile', 'embedding'] as const) {
        memorySystem.queues[kind].failed = activeAgentIssueCount(ctx.db, kind, args.character_id);
      }
      memorySystem.candidates.repairable = activeAgentIssueCount(ctx.db, 'repairable', args.character_id);
      memorySystem.index.failed = activeAgentIndexFailureCount(ctx.db, {
        model: memorySystem.index.target_model, dimension: memorySystem.index.target_dimension,
      }, args.character_id);
    }
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const activeClause = args.include_inactive ? '' : `AND ${activeAgentIssueSql('errors')}`;
    const byLevel = { warn: 0, error: 0 } as Record<string, number>;
    const levelRows = ctx.db.prepare(`
      SELECT level, COUNT(*) AS count FROM app_events WHERE ts >= ? ${activeClause} GROUP BY level
    `).all(since) as Array<{ level: string; count: number }>;
    for (const row of levelRows) byLevel[row.level] = row.count;
    const topEvents = ctx.db.prepare(`
      SELECT event, level, COUNT(*) AS count, MAX(ts) AS last_ts
      FROM app_events
      WHERE ts >= ? ${activeClause}
      GROUP BY event, level
      ORDER BY count DESC, last_ts DESC
      LIMIT ?
    `).all(since, STATUS_TOP_EVENT_COUNT);

    return {
      ok: true,
      memory_system: memorySystem,
      app_events_last_24h: { since, by_level: byLevel, top_events: topEvents },
    };
  }),
});

function toIsoBound(value: string | undefined, name: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: null };
  const time = Date.parse(value);
  if (Number.isNaN(time)) return { ok: false, error: `${name} 不是可识别的时间：${value}` };
  // app_events.ts 存的是 toISOString()，统一成同一格式才能按字符串比较
  return { ok: true, value: new Date(time).toISOString() };
}

export const listAppEventsTool = defineReadTool({
  name: 'list_app_events',
  description: '查询错误与警告记录（最近的在前），可按时间范围、级别、事件名、角色、对话过滤。记录不含消息正文和上游原文，error_category 区分鉴权、限流、上游故障、网络、超时。记录保留 30 天。',
  schema: z.object({
    ...inactiveShape,
    since: z.string().min(1).optional().describe('起始时间（ISO 格式，含）'),
    until: z.string().min(1).optional().describe('结束时间（ISO 格式，含）'),
    level: z.enum(['warn', 'error']).optional(),
    event: z.string().min(1).optional().describe('事件名，精确匹配，如 chat.reply_failed'),
    character_id: z.string().min(1).optional(),
    conversation_id: z.string().min(1).optional(),
    ...pagingShape,
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const since = toIsoBound(args.since, 'since');
    if (!since.ok) return since;
    const until = toIsoBound(args.until, 'until');
    if (!until.ok) return until;

    const where: string[] = [];
    if (!args.include_inactive) where.push(activeAgentIssueSql('errors'));
    const params: Array<string | number> = [];
    const add = (sql: string, value: string | number | null | undefined) => {
      if (value === null || value === undefined) return;
      where.push(sql);
      params.push(value);
    };
    add('ts >= ?', since.value);
    add('ts <= ?', until.value);
    add('level = ?', args.level);
    add('event = ?', args.event);
    add('character_id = ?', args.character_id);
    add('conversation_id = ?', args.conversation_id);

    const rows = ctx.db.prepare(`
      SELECT id, ts, level, event, character_id, conversation_id, message_id, task_id,
        provider_id, model, http_status, error_category, error_name, error_message
      FROM app_events
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ts DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, args.limit + 1, args.offset) as Record<string, unknown>[];
    const page = pageFromOverfetch(rows, args.limit, args.offset);
    return { ok: true, events: page.items, has_more: page.has_more, next_offset: page.next_offset };
  }),
});

const TASK_KINDS = ['extraction', 'profile', 'embedding'] as const;
type TaskKind = typeof TASK_KINDS[number];

/** 三张任务表对齐成同一组列；某表没有的列补 NULL。表名与列名都是常量。 */
const FAILED_TASK_SELECTS: Record<TaskKind, string> = {
  extraction: `
    SELECT 'extraction' AS kind, id, character_id, conversation_id, NULL AS memory_id, NULL AS reason,
      message_ids, retry_count, error_message, created_at, updated_at
    FROM memory_tasks WHERE status = 'failed'`,
  profile: `
    SELECT 'profile' AS kind, id, character_id, NULL AS conversation_id, NULL AS memory_id, reason,
      NULL AS message_ids, retry_count, error_message, created_at, updated_at
    FROM character_memory_profile_update_tasks WHERE status = 'failed'`,
  embedding: `
    SELECT 'embedding' AS kind, id, character_id, NULL AS conversation_id, memory_id, reason,
      NULL AS message_ids, retry_count, error_message, created_at, updated_at
    FROM memory_embedding_tasks WHERE status = 'failed'`,
};

export const listFailedTasksTool = defineReadTool({
  name: 'list_failed_tasks',
  description: '列出失败的后台任务及失败原因 error_message：记忆提取（extraction）、画像更新（profile）、向量索引（embedding）。最近更新的在前，可按角色和种类过滤。',
  schema: z.object({
    ...inactiveShape,
    kind: z.enum(TASK_KINDS).optional().describe('任务种类；省略则三种都看'),
    character_id: z.string().min(1).optional(),
    ...pagingShape,
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const kinds = args.kind ? [args.kind] : [...TASK_KINDS];
    const characterClause = args.character_id ? ' AND character_id = ?' : '';
    const parts = kinds.map(kind => `${FAILED_TASK_SELECTS[kind]}${characterClause}${args.include_inactive ? '' : ` AND ${activeAgentIssueSql(kind)}`}`);
    const params = args.character_id ? kinds.map(() => args.character_id as string) : [];

    // 各表时间格式不一（datetime('now') 与 ISO 混用），按 datetime() 归一后排序
    const rows = ctx.db.prepare(`
      SELECT * FROM (${parts.join(' UNION ALL ')})
      ORDER BY datetime(updated_at) DESC, updated_at DESC, kind ASC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, args.limit + 1, args.offset) as Record<string, unknown>[];
    const page = pageFromOverfetch(rows, args.limit, args.offset);
    return {
      ok: true,
      tasks: page.items.map(row => ({
        ...row,
        message_ids: row.message_ids === null ? null : parseJsonColumn(row.message_ids),
      })),
      has_more: page.has_more,
      next_offset: page.next_offset,
    };
  }),
});

export const listRepairableCandidatesTool = defineReadTool({
  name: 'list_repairable_candidates',
  description: '列出待修复的记忆提取记录（模型输出无法解析时留下的 raw_response），附原提取任务的状态、是否已提交结果、已写入条数和来源消息 ID。最新的在前。',
  schema: z.object({
    ...inactiveShape,
    character_id: z.string().min(1).optional(),
    ...pagingShape,
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const where = `${args.character_id ? 'AND c.character_id = ?' : ''}${args.include_inactive ? '' : ` AND ${activeAgentIssueSql('repairable', 'c')}`}`;
    const rows = ctx.db.prepare(`
      SELECT
        c.id, c.task_id, c.character_id, c.conversation_id, c.raw_candidate_json, c.raw_response,
        c.error_reason, c.created_at, c.updated_at,
        t.id AS joined_task_id, t.status AS task_status, t.result_committed AS task_result_committed,
        t.result_insert_count AS task_result_insert_count, t.message_ids AS task_message_ids
      FROM memory_extraction_candidates c
      LEFT JOIN memory_tasks t ON t.id = c.task_id
      WHERE c.status = 'repairable' ${where}
      ORDER BY c.id DESC
      LIMIT ? OFFSET ?
    `).all(...(args.character_id ? [args.character_id] : []), args.limit + 1, args.offset) as Record<string, unknown>[];
    const page = pageFromOverfetch(rows, args.limit, args.offset);

    return {
      ok: true,
      candidates: page.items.map(row => ({
        id: row.id,
        task_id: row.task_id,
        character_id: row.character_id,
        conversation_id: row.conversation_id,
        raw_candidate_json: row.raw_candidate_json,
        raw_response: row.raw_response,
        error_reason: row.error_reason,
        created_at: row.created_at,
        updated_at: row.updated_at,
        task: row.joined_task_id === null
          ? null
          : {
            status: row.task_status,
            result_committed: Number(row.task_result_committed) === 1,
            result_insert_count: row.task_result_insert_count,
            message_ids: parseJsonColumn(row.task_message_ids),
          },
      })),
      has_more: page.has_more,
      next_offset: page.next_offset,
    };
  }),
});
