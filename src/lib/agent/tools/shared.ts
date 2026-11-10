import { z } from 'zod';
import type { Memory } from '@/types';
import { normalizeMemoryRow } from '@/lib/memory-normalization';
import { escapeLikePattern } from '@/lib/message-search';
import { QUERYABLE_TABLES } from '@/lib/agent/table-query';
import { redactCredentials } from './credentials';
import type { AgentToolContext, AgentToolResult } from './types';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 50;

/** 列表类工具共用的分页参数。 */
export const pagingShape = {
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT)
    .describe(`每页条数，默认 ${DEFAULT_PAGE_LIMIT}，最多 ${MAX_PAGE_LIMIT}`),
  offset: z.number().int().min(0).default(0)
    .describe('跳过前面多少条；翻页时传上一页返回的 next_offset'),
};

export interface PageInfo {
  has_more: boolean;
  next_offset: number | null;
}

/** rows 须按 limit + 1 条查询，多出的那条只用来判断是否还有下一页。 */
export function pageFromOverfetch<T>(rows: T[], limit: number, offset: number): { items: T[] } & PageInfo {
  const hasMore = rows.length > limit;
  return {
    items: hasMore ? rows.slice(0, limit) : rows,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
  };
}

/** 对已在内存中的完整列表分页。 */
export function pageFromList<T>(all: T[], limit: number, offset: number): { items: T[] } & PageInfo {
  return pageFromOverfetch(all.slice(offset, offset + limit + 1), limit, offset);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 所有只读工具的统一外壳：中止检查、异常转成 ok:false、返回前做凭据脱敏。
 * 脱敏本身失败时宁可丢弃结果，也不返回未脱敏的内容。
 */
export async function runReadTool(
  ctx: AgentToolContext,
  run: () => AgentToolResult | Promise<AgentToolResult>,
): Promise<AgentToolResult> {
  let result: AgentToolResult;
  if (ctx.signal?.aborted) {
    result = { ok: false, error: '已中止' };
  } else {
    try {
      result = await run();
    } catch (error) {
      result = { ok: false, error: `工具执行失败：${errorMessage(error)}` };
    }
  }
  try {
    return redactCredentials(ctx, result);
  } catch {
    try {
      // 固定提示也可能包含合法短凭据；仅尝试一次，无法脱敏就不返回任何正文。
      return redactCredentials(ctx, { ok: false, error: '结果脱敏失败，已丢弃本次结果' });
    } catch {
      return { ok: false, error: '' };
    }
  }
}

/** 解析 JSON 文本列；解析失败时原样返回，方便模型看到坏数据本身。 */
export function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

const ID_PREFIX_MIN_LENGTH = 8;

/**
 * 把模型给的 ID 还原成库里的完整 ID：精确命中时原样返回；否则当作前缀，只匹配到一条时返回那条。
 * 上下文压缩后的摘要常只留下 ID 的前 8 位，没有这一步只能重新搜索才能找回完整 ID。
 * 匹配不到或不唯一时原样返回，由调用方按「不存在」处理。只用于只读工具。
 */
export function resolveIdPrefix(
  db: AgentToolContext['db'],
  table: 'memories' | 'messages' | 'conversations',
  id: string,
): string {
  if (id.length < ID_PREFIX_MIN_LENGTH) return id;
  if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id;
  const matches = db.prepare(`SELECT id FROM ${table} WHERE id LIKE ? ESCAPE '\\' LIMIT 2`)
    .all(`${escapeLikePattern(id)}%`) as Array<{ id: string }>;
  return matches.length === 1 ? matches[0].id : id;
}

/** 输入里重复的 ID 只保留第一次出现的位置。 */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** memories 的白名单列，避免 SELECT * 把以后新增的列不加审视地带出去。 */
export const MEMORY_COLUMNS_SQL = QUERYABLE_TABLES.memories.map(column => `m.${column}`).join(', ');

/** 与应用其它读取路径一致的记忆规范化（标签、来源解析为数组，metadata 解析为对象）。正文不截断。 */
export function toMemoryView(row: Record<string, unknown>): Memory {
  return normalizeMemoryRow(row as Memory);
}
