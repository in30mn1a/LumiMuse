import type Database from 'better-sqlite3';
import { z } from 'zod';
import { buildChainMessageScope, resolveConversationChain } from '@/lib/conversation-chain';
import { MEMORY_PROCESSED_SQL } from '@/lib/memory-extraction-scope';
import { escapeLikePattern, searchMessages } from '@/lib/message-search';
import { defineReadTool } from './types';
import {
  errorMessage,
  pageFromOverfetch,
  pagingShape,
  parseJsonColumn,
  runReadTool,
  sqlPlaceholders,
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

export const readMessagesTool = defineReadTool({
  name: 'read_messages',
  description: '按对话顺序（从最早开始）分页读取一个对话的消息，正文完整。子对话会包含从父对话继承的消息。返回 total，想看最新消息时可用 total 计算 offset。',
  schema: z.object({
    conversation_id: z.string().min(1).describe('对话 ID'),
    ...pagingShape,
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const conversation = ctx.db.prepare(`
      SELECT id, character_id, title, parent_id, parent_seq_end, ignore_memory, created_at, updated_at
      FROM conversations WHERE id = ?
    `).get(args.conversation_id) as Record<string, unknown> | undefined;
    if (!conversation) return { ok: false, error: `对话不存在：${args.conversation_id}` };

    const scope = conversationMessageScope(ctx.db, args.conversation_id);
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${scope.sql}`)
      .get(...scope.params) as { count: number }).count;
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
      conversation: { ...conversation, ignore_memory: Number(conversation.ignore_memory) === 1 },
      total,
      messages: page.items.map(toMessageView),
      has_more: page.has_more,
      next_offset: page.next_offset,
      ...(scope.chainError ? { chain_error: `父对话链损坏，只返回本对话自己的消息：${scope.chainError}` } : {}),
    };
  }),
});

/** 每个关键词都须以子串形式出现在同一条消息里；排序与分页口径同 searchMessages 的 LIKE 路径。 */
function searchMessagesAllTerms(
  db: Database.Database,
  terms: string[],
  characterId: string | null,
  limit: number,
  offset: number,
) {
  const termClause = terms.map(() => `m.content LIKE ? ESCAPE '\\'`).join(' AND ');
  const charClause = characterId ? 'AND ch.id = ?' : '';
  const rows = db.prepare(`
    SELECT
      m.id AS messageId,
      m.role AS role,
      m.created_at AS createdAt,
      c.id AS conversationId,
      c.title AS conversationTitle,
      ch.id AS characterId,
      ch.name AS characterName
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    JOIN characters ch   ON c.character_id = ch.id
    WHERE ${termClause} AND m.role IN ('user', 'assistant') ${charClause}
    ORDER BY m.created_at DESC, m.seq DESC, m.id DESC
    LIMIT ? OFFSET ?
  `).all(
    ...terms.map(term => `%${escapeLikePattern(term)}%`),
    ...(characterId ? [characterId] : []),
    limit + 1,
    offset,
  ) as Array<{
    messageId: string;
    role: string;
    createdAt: string;
    conversationId: string;
    conversationTitle: string;
    characterId: string;
    characterName: string;
  }>;
  const hasMore = rows.length > limit;
  // 完整正文由调用方按 ID 补齐，这里 snippet 留空
  return { results: (hasMore ? rows.slice(0, limit) : rows).map(row => ({ ...row, snippet: '' })), hasMore };
}

export const searchMessagesTool = defineReadTool({
  name: 'search_messages',
  description: '搜索聊天消息（只含用户和角色的发言），按子串匹配原文。多个关键词用空格分隔时，要求同一条消息同时包含全部关键词（不分先后）。也支持按日期搜索（如 2026-03-30、3月30日，按主人的时区）。返回完整正文，可按角色过滤。',
  schema: z.object({
    query: z.string().trim().min(1).describe('关键词（空格分隔表示同时包含）或日期'),
    character_id: z.string().min(1).optional().describe('只搜该角色的对话'),
    ...pagingShape,
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    // 界面搜索把整串当一个短语；模型习惯用空格拼多个关键词，整串匹配必然落空，所以多词时在这里按 AND 搜
    const terms = args.query.split(/\s+/).filter(Boolean);
    const result = terms.length > 1
      ? searchMessagesAllTerms(ctx.db, terms, args.character_id ?? null, args.limit, args.offset)
      : searchMessages(ctx.db, {
          q: args.query,
          characterId: args.character_id ?? null,
          limit: args.limit,
          offset: args.offset,
          timeZone: ctx.settings.client_timezone || undefined,
        });

    // 搜索库只给 80 字片段（给界面用）；模型要拿原文当依据，补上完整正文
    const ids = result.results.map(item => item.messageId);
    const contentById = new Map<string, string>();
    if (ids.length > 0) {
      const rows = ctx.db.prepare(`SELECT id, content FROM messages WHERE id IN (${sqlPlaceholders(ids.length)})`)
        .all(...ids) as Array<{ id: string; content: string }>;
      for (const row of rows) contentById.set(row.id, row.content);
    }

    return {
      ok: true,
      results: result.results.map(item => ({
        message_id: item.messageId,
        conversation_id: item.conversationId,
        conversation_title: item.conversationTitle,
        character_id: item.characterId,
        character_name: item.characterName,
        role: item.role,
        created_at: item.createdAt,
        content: contentById.get(item.messageId) ?? item.snippet,
      })),
      has_more: result.hasMore,
      next_offset: result.hasMore ? args.offset + args.limit : null,
    };
  }),
});
