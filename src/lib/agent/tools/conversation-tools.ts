import type Database from 'better-sqlite3';
import { z } from 'zod';
import { buildChainMessageScope, resolveConversationChain } from '@/lib/conversation-chain';
import { MEMORY_PROCESSED_SQL } from '@/lib/memory-extraction-scope';
import { zonedDayRangeToUtc, zonedMinuteRangeToUtc } from '@/lib/chat-time';
import { escapeLikePattern, parseDateRange } from '@/lib/message-search';
import { defineReadTool } from './types';
import {
  errorMessage,
  pageFromOverfetch,
  pagingShape,
  parseJsonColumn,
  resolveIdPrefix,
  runReadTool,
  sqlPlaceholders,
  uniqueIds,
} from './shared';

/** 单段对话沿用消息路由的 `created_at, seq` 顺序；链式子对话按链内 seq。末尾补 id 保证稳定。 */
const PLAIN_ORDER = ['created_at', 'seq', 'id'] as const;
const CHAIN_ORDER = ['seq', 'created_at', 'id'] as const;

export interface ConversationMessageScope {
  sql: string;
  params: Array<string | number>;
  orderColumns: readonly string[];
  /** 父链损坏时退回只读本对话的消息，并把原因告诉模型 */
  chainError?: string;
}

/** 对话的消息可见范围：子对话会沿 parent 链带上继承的父对话消息，与聊天界面看到的一致。 */
export function conversationMessageScope(db: Database.Database, conversationId: string): ConversationMessageScope {
  try {
    const chain = resolveConversationChain(db, conversationId);
    const scope = buildChainMessageScope(chain);
    return { sql: scope.sql, params: scope.params, orderColumns: chain.length > 1 ? CHAIN_ORDER : PLAIN_ORDER };
  } catch (error) {
    return {
      sql: 'conversation_id = ?',
      params: [conversationId],
      orderColumns: PLAIN_ORDER,
      chainError: errorMessage(error),
    };
  }
}

export function orderSql(columns: readonly string[], direction: 'ASC' | 'DESC'): string {
  return columns.map(column => `${column} ${direction}`).join(', ');
}

export const MESSAGE_VIEW_COLUMNS_SQL = `
  id, conversation_id, role, content, created_at, seq, metadata,
  (${MEMORY_PROCESSED_SQL}) AS memory_processed
`;

export interface MessageView {
  id: string;
  /** 消息物理所属的对话；读取子对话时，继承来的消息显示父对话 ID */
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  seq: number;
  is_summary: boolean;
  memory_processed: boolean;
}

export function toMessageView(row: Record<string, unknown>): MessageView {
  const metadata = parseJsonColumn(row.metadata);
  const isSummary = Boolean(metadata && typeof metadata === 'object' && (metadata as Record<string, unknown>).isSummary === true);
  return {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    role: String(row.role),
    content: String(row.content),
    created_at: String(row.created_at),
    seq: Number(row.seq),
    is_summary: isSummary,
    memory_processed: Number(row.memory_processed) === 1,
  };
}

export const listConversationsTool = defineReadTool({
  name: 'list_conversations',
  description: '列出对话（最近更新的在前），可按角色过滤。own_message_count 只计本对话自己的消息，不含从父对话继承的。',
  schema: z.object({
    character_id: z.string().min(1).optional().describe('只看该角色的对话'),
    ...pagingShape,
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const where = args.character_id ? 'WHERE cv.character_id = ?' : '';
    const rows = ctx.db.prepare(`
      SELECT
        cv.id,
        cv.character_id,
        ch.name AS character_name,
        cv.title,
        cv.parent_id,
        cv.ignore_memory,
        cv.created_at,
        cv.updated_at,
        (SELECT COUNT(*) FROM messages msg WHERE msg.conversation_id = cv.id) AS own_message_count
      FROM conversations cv
      LEFT JOIN characters ch ON ch.id = cv.character_id
      ${where}
      ORDER BY cv.updated_at DESC, cv.created_at DESC, cv.id DESC
      LIMIT ? OFFSET ?
    `).all(...(args.character_id ? [args.character_id] : []), args.limit + 1, args.offset) as Record<string, unknown>[];
    const page = pageFromOverfetch(rows, args.limit, args.offset);
    return {
      ok: true,
      conversations: page.items.map(row => ({ ...row, ignore_memory: Number(row.ignore_memory) === 1 })),
      has_more: page.has_more,
      next_offset: page.next_offset,
    };
  }),
});

/** 按对话顺序取锚点消息前后各若干条（不含锚点本身），都按从早到晚排列。anchor 须带齐 scope.orderColumns 的列。 */
export function loadNeighborMessages(
  db: Database.Database,
  anchor: Record<string, unknown>,
  scope: ConversationMessageScope,
  before: number,
  after: number,
): { before: Record<string, unknown>[]; after: Record<string, unknown>[] } {
  const tupleSql = `(${scope.orderColumns.join(', ')})`;
  const tupleParams = scope.orderColumns.map(column => anchor[column] as string | number);
  const placeholders = sqlPlaceholders(tupleParams.length);
  const beforeRows = db.prepare(`
    SELECT ${MESSAGE_VIEW_COLUMNS_SQL} FROM messages
    WHERE ${scope.sql} AND ${tupleSql} < (${placeholders})
    ORDER BY ${orderSql(scope.orderColumns, 'DESC')}
    LIMIT ?
  `).all(...scope.params, ...tupleParams, before) as Record<string, unknown>[];
  const afterRows = db.prepare(`
    SELECT ${MESSAGE_VIEW_COLUMNS_SQL} FROM messages
    WHERE ${scope.sql} AND ${tupleSql} > (${placeholders})
    ORDER BY ${orderSql(scope.orderColumns, 'ASC')}
    LIMIT ?
  `).all(...scope.params, ...tupleParams, after) as Record<string, unknown>[];
  return { before: beforeRows.reverse(), after: afterRows };
}

const MAX_NEIGHBOR_MESSAGES = 25;

export const readMessagesTool = defineReadTool({
  name: 'read_messages',
  description: '读取一个对话的消息，正文完整。子对话会包含从父对话继承的消息。两种用法：传 conversation_id 按对话顺序（从最早开始）分页，返回 total，想看最新消息时可用 total 计算 offset；传 around_message_id 读这条消息及其前后文（适合接在 search_messages 的命中之后），返回的 anchor_offset 是它在对话里的位置，可接着用 offset 翻页。',
  schema: z.object({
    conversation_id: z.string().min(1).optional().describe('对话 ID；传了 around_message_id 时可省略'),
    around_message_id: z.string().min(1).optional().describe('以这条消息为中心读取，此时忽略 limit 和 offset'),
    before: z.number().int().min(0).max(MAX_NEIGHBOR_MESSAGES).default(3).describe('around_message_id 之前带几条，默认 3'),
    after: z.number().int().min(0).max(MAX_NEIGHBOR_MESSAGES).default(3).describe('around_message_id 之后带几条，默认 3'),
    ...pagingShape,
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const anchorId = args.around_message_id ? resolveIdPrefix(ctx.db, 'messages', args.around_message_id) : null;
    const anchor = anchorId
      ? ctx.db.prepare(`SELECT ${MESSAGE_VIEW_COLUMNS_SQL} FROM messages WHERE id = ?`).get(anchorId) as Record<string, unknown> | undefined
      : undefined;
    if (anchorId && !anchor) return { ok: false, error: `消息不存在：${anchorId}` };

    const conversationId = args.conversation_id
      ? resolveIdPrefix(ctx.db, 'conversations', args.conversation_id)
      : anchor ? String(anchor.conversation_id) : null;
    if (!conversationId) return { ok: false, error: '需要 conversation_id 或 around_message_id' };

    const conversation = ctx.db.prepare(`
      SELECT id, character_id, title, parent_id, parent_seq_end, ignore_memory, created_at, updated_at
      FROM conversations WHERE id = ?
    `).get(conversationId) as Record<string, unknown> | undefined;
    if (!conversation) return { ok: false, error: `对话不存在：${conversationId}` };

    const scope = conversationMessageScope(ctx.db, conversationId);
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${scope.sql}`)
      .get(...scope.params) as { count: number }).count;
    const conversationView = { ...conversation, ignore_memory: Number(conversation.ignore_memory) === 1 };
    const chainError = scope.chainError
      ? { chain_error: `父对话链损坏，只返回本对话自己的消息：${scope.chainError}` }
      : {};

    if (anchor) {
      const tupleSql = `(${scope.orderColumns.join(', ')})`;
      const tupleParams = scope.orderColumns.map(column => anchor[column] as string | number);
      if (!ctx.db.prepare(`SELECT 1 FROM messages WHERE id = ? AND ${scope.sql}`).get(anchorId, ...scope.params)) {
        return { ok: false, error: `消息 ${anchorId} 不在对话 ${conversationId} 的可见范围内` };
      }
      const anchorOffset = (ctx.db.prepare(`
        SELECT COUNT(*) AS count FROM messages
        WHERE ${scope.sql} AND ${tupleSql} < (${sqlPlaceholders(tupleParams.length)})
      `).get(...scope.params, ...tupleParams) as { count: number }).count;
      const neighbors = loadNeighborMessages(ctx.db, anchor, scope, args.before, args.after);
      return {
        ok: true,
        conversation: conversationView,
        total,
        anchor_message_id: anchorId,
        anchor_offset: anchorOffset,
        messages: [
          ...neighbors.before.map(row => ({ ...toMessageView(row), is_anchor: false })),
          { ...toMessageView(anchor), is_anchor: true },
          ...neighbors.after.map(row => ({ ...toMessageView(row), is_anchor: false })),
        ],
        ...chainError,
      };
    }

    const rows = ctx.db.prepare(`
      SELECT ${MESSAGE_VIEW_COLUMNS_SQL}
      FROM messages
      WHERE ${scope.sql}
      ORDER BY ${orderSql(scope.orderColumns, 'ASC')}
      LIMIT ? OFFSET ?
    `).all(...scope.params, args.limit + 1, args.offset) as Record<string, unknown>[];
    const page = pageFromOverfetch(rows, args.limit, args.offset);

    return {
      ok: true,
      conversation: conversationView,
      total,
      messages: page.items.map(toMessageView),
      has_more: page.has_more,
      next_offset: page.next_offset,
      ...chainError,
    };
  }),
});

/** 不超过这个长度的消息直接给全文，片段省不了多少 */
const SNIPPET_MIN_CONTENT = 400;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 140;

/** 每个关键词首次命中处前后各留一段，重叠的合并；没有关键词（按时间或来源列出）时取开头。 */
function snippetAround(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  // 极少数字符转小写后长度会变，那时下标对不上，只按原样匹配
  const haystack = lower.length === content.length ? lower : content;
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    const index = haystack.indexOf(haystack === lower ? term.toLowerCase() : term);
    if (index === -1) continue;
    ranges.push([Math.max(0, index - SNIPPET_BEFORE), Math.min(content.length, index + term.length + SNIPPET_AFTER)]);
  }
  if (ranges.length === 0) ranges.push([0, Math.min(content.length, SNIPPET_BEFORE + SNIPPET_AFTER)]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  const body = merged.map(([start, end]) => content.slice(start, end)).join('…');
  return (merged[0][0] > 0 ? '…' : '') + body + (merged[merged.length - 1][1] < content.length ? '…' : '');
}

/** from / to：`YYYY-MM-DD` 取那一天的开头或结尾，`YYYY-MM-DD HH:MM` 取那一分钟的开头或结尾，都按主人的时区。 */
function parseTimeBound(input: string, edge: 'start' | 'end', timeZone: string | undefined): string | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(input.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const range = match[4] === undefined
    ? zonedDayRangeToUtc(year, month, day, timeZone)
    : zonedMinuteRangeToUtc(year, month, day, Number(match[4]), Number(match[5]), timeZone);
  return range ? range[edge === 'start' ? 0 : 1] : null;
}

const TIME_BOUND_FORMAT = '格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM（主人的时区）';
const SEARCH_FROM_SQL = `
  FROM messages m
  JOIN conversations c ON m.conversation_id = c.id
  JOIN characters ch   ON c.character_id = ch.id
`;
const TERM_SQL = `m.content LIKE ? ESCAPE '\\'`;

export const searchMessagesTool = defineReadTool({
  name: 'search_messages',
  description: '搜索聊天消息（只含用户和角色的发言）。关键词按子串匹配，须是原文里一字不差的片段，自己概括的说法搜不到；多个关键词用空格分隔，要求同一条消息同时包含全部关键词（不分先后）。整个 query 是日期（如 2026-03-30、3月30日）时返回主人时区那一天的消息。可用 character_id、conversation_id、memory_id、from/to 缩小范围，并可与关键词组合；给了 memory_id 或 from/to 时可以不传 query，按时间列出范围内的消息。核对或细化某条记忆的来源时优先传 memory_id，只在它现有的来源消息里找。长消息默认只返回命中处片段（content_truncated 为 true），要全文传 content: "full"，或用 read_messages 的 around_message_id 连前后文一起读。total 是命中总数；多个关键词零命中时 term_hits 给出每个词单独的命中数，据此换掉或去掉命中为 0 的词。',
  schema: z.object({
    query: z.string().trim().min(1).optional().describe('关键词（空格分隔表示同时包含）或日期'),
    character_id: z.string().min(1).optional().describe('只搜该角色的对话'),
    conversation_id: z.string().min(1).optional().describe('只搜该对话（含从父对话继承的消息）'),
    memory_id: z.string().min(1).optional().describe('只搜该记忆现有的来源消息'),
    from: z.string().trim().min(1).optional().describe('起始时间，YYYY-MM-DD 或 YYYY-MM-DD HH:MM，主人的时区，含当刻'),
    to: z.string().trim().min(1).optional().describe('结束时间，格式同 from；只写日期时含当天全天'),
    content: z.enum(['snippet', 'full']).default('snippet').describe('snippet：长消息只给命中处片段（默认）；full：完整正文'),
    ...pagingShape,
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const timeZone = ctx.settings.client_timezone || undefined;
    const conditions = [`m.role IN ('user', 'assistant')`];
    const params: Array<string | number> = [];
    let timeWindow = false;

    // 界面搜索把整串当一个短语；模型习惯用空格拼多个关键词，整串匹配必然落空，所以按空格拆开后 AND
    let terms = uniqueIds((args.query ?? '').split(/\s+/).filter(Boolean));
    const dateRange = args.query ? parseDateRange(args.query, timeZone) : null;
    if (dateRange) {
      conditions.push('m.created_at >= ? AND m.created_at <= ?');
      params.push(...dateRange);
      terms = [];
      timeWindow = true;
    }
    for (const [key, edge, operator] of [['from', 'start', '>='], ['to', 'end', '<=']] as const) {
      const value = args[key];
      if (!value) continue;
      const bound = parseTimeBound(value, edge, timeZone);
      if (!bound) return { ok: false, error: `${key} 无法识别：${value}。${TIME_BOUND_FORMAT}` };
      conditions.push(`m.created_at ${operator} ?`);
      params.push(bound);
      timeWindow = true;
    }

    if (args.character_id) {
      conditions.push('ch.id = ?');
      params.push(args.character_id);
    }
    if (args.conversation_id) {
      const scope = conversationMessageScope(ctx.db, resolveIdPrefix(ctx.db, 'conversations', args.conversation_id));
      conditions.push(`m.id IN (SELECT id FROM messages WHERE ${scope.sql})`);
      params.push(...scope.params);
    }

    let memoryScope: { memory_id: string; source_total: number } | null = null;
    if (args.memory_id) {
      const memoryId = resolveIdPrefix(ctx.db, 'memories', args.memory_id);
      const memory = ctx.db.prepare('SELECT source_msg_ids FROM memories WHERE id = ?')
        .get(memoryId) as { source_msg_ids: string | null } | undefined;
      if (!memory) return { ok: false, error: `记忆不存在：${args.memory_id}` };
      const parsed = parseJsonColumn(memory.source_msg_ids);
      const sourceIds = uniqueIds(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
      memoryScope = { memory_id: memoryId, source_total: sourceIds.length };
      if (sourceIds.length === 0) {
        return {
          ok: true,
          results: [],
          total: 0,
          has_more: false,
          next_offset: null,
          memory_scope: memoryScope,
          note: '这条记忆没有记录来源消息，去掉 memory_id 改用 character_id 搜索。',
        };
      }
      conditions.push(`m.id IN (${sqlPlaceholders(sourceIds.length)})`);
      params.push(...sourceIds);
    }

    if (terms.length === 0 && !timeWindow && !memoryScope) {
      return { ok: false, error: '至少给出 query、from/to、memory_id 中的一个；要通读一个对话请用 read_messages' };
    }

    const likeParam = (term: string) => `%${escapeLikePattern(term)}%`;
    const countHits = (subset: string[]) => (ctx.db.prepare(`
      SELECT COUNT(*) AS count ${SEARCH_FROM_SQL}
      WHERE ${[...conditions, ...subset.map(() => TERM_SQL)].join(' AND ')}
    `).get(...params, ...subset.map(likeParam)) as { count: number }).count;

    const total = countHits(terms);
    // 关键词搜索先给最近的；限定了时间段或记忆来源时范围已经很小，按时间先后更便于对照
    const direction = timeWindow || memoryScope ? 'ASC' : 'DESC';
    const rows = total === 0 ? [] : ctx.db.prepare(`
      SELECT
        m.id AS message_id,
        c.id AS conversation_id,
        c.title AS conversation_title,
        ch.id AS character_id,
        ch.name AS character_name,
        m.role AS role,
        m.created_at AS created_at,
        m.content AS content
      ${SEARCH_FROM_SQL}
      WHERE ${[...conditions, ...terms.map(() => TERM_SQL)].join(' AND ')}
      ORDER BY m.created_at ${direction}, m.seq ${direction}, m.id ${direction}
      LIMIT ? OFFSET ?
    `).all(...params, ...terms.map(likeParam), args.limit, args.offset) as Array<Record<string, string>>;
    const hasMore = args.offset + rows.length < total;

    return {
      ok: true,
      results: rows.map(row => {
        const truncated = args.content === 'snippet' && row.content.length > SNIPPET_MIN_CONTENT;
        return {
          ...row,
          content: truncated ? snippetAround(row.content, terms) : row.content,
          content_length: row.content.length,
          content_truncated: truncated,
        };
      }),
      total,
      has_more: hasMore,
      next_offset: hasMore ? args.offset + args.limit : null,
      ...(memoryScope ? { memory_scope: memoryScope } : {}),
      ...(total === 0 && terms.length > 1
        ? { term_hits: terms.map(term => ({ term, hits: countHits([term]) })) }
        : {}),
    };
  }),
});
