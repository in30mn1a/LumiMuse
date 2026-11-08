import type Database from 'better-sqlite3';
import { z } from 'zod';
import { MEMORY_CATEGORIES, MEMORY_STATUSES, type Memory, type MemoryCategory, type MemoryStatus } from '@/types';
import { embedTexts, loadReadyMemoryEmbeddings } from '@/lib/memory-embeddings';
import { tokenizeForRetrieval } from '@/lib/memory-engine';
import { recallMemoriesByVector } from '@/lib/memory-extraction-reference';
import { readMemoryProfile } from '@/lib/memory-profile';
import { resolveMemoryEngineConfig } from '@/lib/memory-retrieval';
import { estimateTokens } from '@/lib/token-counter';
import { getMemorySourceAttribution } from '@/lib/metadata';
import { defineReadTool } from './types';
import {
  conversationMessageScope,
  MESSAGE_VIEW_COLUMNS_SQL,
  orderSql,
  toMessageView,
  type MessageView,
} from './conversation-tools';
import {
  MEMORY_COLUMNS_SQL,
  pageFromList,
  pagingShape,
  runReadTool,
  sqlPlaceholders,
  toMemoryView,
  uniqueIds,
} from './shared';

const CATEGORY_VALUES = MEMORY_CATEGORIES as [MemoryCategory, ...MemoryCategory[]];

type EngineConfig = ReturnType<typeof resolveMemoryEngineConfig>;

/**
 * 语义检索是否可用。判断条件与索引队列一致（真正产出 ready 向量的那条链路）：
 * 索引开启、允许把记忆发给外部服务、配置了接口地址和模型。
 */
function vectorUnavailableReason(config: EngineConfig, status: MemoryStatus): string | null {
  if (status !== 'active') return '向量索引只覆盖 active 记忆，非 active 状态只做关键词匹配';
  if (!config.index_enabled) return '记忆向量索引未开启，只做了关键词匹配';
  if (!config.allow_external_memory_payloads) return '设置禁止把记忆发送给外部服务，只做了关键词匹配';
  if (!config.embedding_api_base.trim()) return '未配置 embedding 接口地址，只做了关键词匹配';
  if (!config.embedding_model.trim()) return '未配置 embedding 模型，只做了关键词匹配';
  return null;
}

/**
 * 本地关键词匹配：分词与聊天检索（retrieveRelevantMemories）同源，评分公式也相同；
 * 另加整串包含，兜住分词拿不到 token 的短查询（单个汉字、单个字母）。
 *
 * 不直接调用 retrieveRelevantMemories：它在记忆总数不超过条数上限、或零命中时，
 * 会按重要度返回未命中的记忆来填满候选池。那对聊天注入合理，对搜索工具却会让模型
 * 把「没搜到」误当成「搜到了」。而且它只看 active，读的是全局连接而非工具上下文。
 */
function rankByKeyword(query: string, memories: Memory[]): Memory[] {
  const queryTokens = tokenizeForRetrieval(query);
  const needle = query.trim().toLowerCase();
  const scored: Array<{ memory: Memory; score: number }> = [];

  for (const memory of memories) {
    const tokens = tokenizeForRetrieval(memory.content);
    for (const tag of memory.tags) {
      if (tag) tokens.add(tag.toLowerCase());
    }
    tokens.add(memory.category);

    let overlap = 0;
    for (const token of queryTokens) {
      if (tokens.has(token)) overlap += 1;
    }
    let score = overlap > 0 ? overlap / Math.sqrt((tokens.size + 1) * (queryTokens.size + 1)) : 0;
    const haystack = [memory.content, ...memory.tags].join('\n').toLowerCase();
    if (needle && haystack.includes(needle)) score += 1;
    if (score > 0) scored.push({ memory, score });
  }

  // sort 是稳定的：同分时保留数据库的置顶/重要度顺序
  return scored.sort((a, b) => b.score - a.score).map(item => item.memory);
}

export interface SearchMemoriesDeps {
  /** 测试注入假向量源；默认调用真实 embedding 接口 */
  embedTexts?: typeof embedTexts;
}

export function createSearchMemoriesTool(deps: SearchMemoriesDeps = {}) {
  const embed = deps.embedTexts || embedTexts;

  return defineReadTool({
    name: 'search_memories',
    description: '在一个角色的记忆中查找相关条目：语义（向量）召回与关键词召回取并集，正文完整。'
      + '向量结果按相似度排在前面，总会给出最接近的若干条，不代表每条都相关，matched_by 标明命中来源。'
      + 'vector_used 为 false 时表示这次没有语义检索，措辞差异大的相关记忆可能查不到，不能据此断定不存在。',
    schema: z.object({
      character_id: z.string().min(1).describe('角色 ID'),
      query: z.string().trim().min(1).describe('要找的内容，用一句话描述即可'),
      category: z.enum(CATEGORY_VALUES).optional().describe('只看该分类'),
      status: z.enum(MEMORY_STATUSES).default('active').describe('记忆状态，默认 active'),
      ...pagingShape,
    }),
    execute: (args, ctx) => runReadTool(ctx, async () => {
      const rows = ctx.db.prepare(`
        SELECT ${MEMORY_COLUMNS_SQL}
        FROM memories m
        WHERE m.character_id = ? AND m.status = ?
        ORDER BY COALESCE(m.pinned, 0) DESC, COALESCE(m.importance, 0) DESC, m.updated_at DESC, m.id ASC
      `).all(args.character_id, args.status) as Record<string, unknown>[];
      const pool = rows.map(toMemoryView).filter(memory => !args.category || memory.category === args.category);
      const keywordHits = rankByKeyword(args.query, pool);

      const config = resolveMemoryEngineConfig(ctx.settings);
      let vectorUsed = false;
      let vectorHits: Memory[] = [];
      let unavailableReason = vectorUnavailableReason(config, args.status);
      if (!unavailableReason) {
        const poolById = new Map(pool.map(memory => [memory.id, memory]));
        const recall = await recallMemoriesByVector(args.character_id, [args.query], config, {
          embedTexts: (texts, embeddingConfig) => embed(texts, { ...embeddingConfig, signal: ctx.signal }),
          // 扫描全部 ready 向量，排名前按候选池过滤，避免其他分类占满召回名额
          loadEmbeddingRows: (characterId, options) => loadReadyMemoryEmbeddings(characterId, {
            ...options,
            limit: Number.POSITIVE_INFINITY,
            db: ctx.db,
          }).filter(row => poolById.has(row.memory_id)),
          // 召回结果映射回已按分类过滤的记忆池，保持与关键词结果同一份数据
          loadMemoriesByIds: ids => ids.flatMap(id => poolById.get(id) ?? []),
        });
        if (recall.failure) {
          unavailableReason = `语义检索失败，本次只有关键词结果：${recall.failure}`;
        } else {
          vectorUsed = true;
          vectorHits = recall.memories;
        }
      }

      // 并集而不是「关键词为空才用向量」：新记忆的向量可能还在排队，只有关键词能看到它
      const vectorIds = new Set(vectorHits.map(memory => memory.id));
      const keywordIds = new Set(keywordHits.map(memory => memory.id));
      const merged = [...vectorHits, ...keywordHits.filter(memory => !vectorIds.has(memory.id))]
        .map(memory => ({
          ...memory,
          matched_by: [
            ...(vectorIds.has(memory.id) ? ['vector'] : []),
            ...(keywordIds.has(memory.id) ? ['keyword'] : []),
          ],
        }));
      const page = pageFromList(merged, args.limit, args.offset);

      return {
        ok: true,
        character_id: args.character_id,
        status: args.status,
        category: args.category ?? null,
        vector_used: vectorUsed,
        vector_unavailable_reason: unavailableReason,
        vector_hit_count: vectorHits.length,
        keyword_hit_count: keywordHits.length,
        total: merged.length,
        memories: page.items,
        has_more: page.has_more,
        next_offset: page.next_offset,
      };
    }),
  });
}

export const searchMemoriesTool = createSearchMemoriesTool();

const memoryIdsSchema = (max: number) => z.array(z.string().min(1)).min(1).max(max);

function loadMemoriesByIds(
  db: Database.Database,
  ids: string[],
  characterId: string | undefined,
): Map<string, Memory> {
  const where = characterId ? 'AND m.character_id = ?' : '';
  const rows = db.prepare(`
    SELECT ${MEMORY_COLUMNS_SQL}
    FROM memories m
    WHERE m.id IN (${sqlPlaceholders(ids.length)}) ${where}
  `).all(...ids, ...(characterId ? [characterId] : [])) as Record<string, unknown>[];
  return new Map(rows.map(row => [String(row.id), toMemoryView(row)]));
}

export const getMemoriesTool = defineReadTool({
  name: 'get_memories',
  description: '按 ID 读取完整记忆（正文不截断，含标签、来源消息 ID、状态、metadata）。传 character_id 时只返回该角色的记忆；查不到的 ID 列在 missing_ids。',
  schema: z.object({
    memory_ids: memoryIdsSchema(50).describe('记忆 ID，一次最多 50 个'),
    character_id: z.string().min(1).optional().describe('限定角色'),
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const ids = uniqueIds(args.memory_ids);
    const byId = loadMemoriesByIds(ctx.db, ids, args.character_id);
    return {
      ok: true,
      memories: ids.flatMap(id => byId.get(id) ?? []),
      missing_ids: ids.filter(id => !byId.has(id)),
    };
  }),
});

/**
 * 单次调用返回来源原文的 token 预算。长期使用的角色每条记忆常挂 50–100 个来源，
 * 一次读十条记忆曾返回约 500KB、把 Agent 请求撑到五十多万 token。超出的来源不丢：
 * 结果带 next_source_offset，Agent 翻页继续读。这是 Agent 后台工具，与角色聊天链路无关。
 */
const SOURCE_OUTPUT_TOKEN_BUDGET = 20_000;

interface SourceContext {
  message_id: string;
  conversation_id: string;
  conversation_title: string | null;
  messages: Array<MessageView & { is_source: boolean }>;
  chain_error?: string;
}

export const getMemorySourcesTool = defineReadTool({
  name: 'get_memory_sources',
  description: '读取记忆的来源消息原文及其前后文（默认前后各 2 条，同一对话内）。source_attribution 标明 message/batch/mixed/unknown 粒度；批次、混合和未标注来源只是待核实范围。修改正文、合并或判定矛盾前用它核对依据。已被删除的来源列在 missing_source_ids。单次输出有预算：某条记忆的 next_source_offset 不为 null 时表示没读完，对它单独再调用并传 source_offset 继续读。',
  schema: z.object({
    memory_ids: memoryIdsSchema(20).describe('记忆 ID，一次最多 20 个'),
    context: z.number().int().min(0).max(10).default(2).describe('来源消息前后各带几条消息，默认 2'),
    source_offset: z.number().int().min(0).default(0).describe('从每条记忆的第几个来源开始，翻页时传上次返回的 next_source_offset'),
    character_id: z.string().min(1).optional().describe('限定角色'),
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const ids = uniqueIds(args.memory_ids);
    const memories = loadMemoriesByIds(ctx.db, ids, args.character_id);
    const loadMessage = ctx.db.prepare(`SELECT ${MESSAGE_VIEW_COLUMNS_SQL} FROM messages WHERE id = ?`);
    const loadConversation = ctx.db.prepare('SELECT title FROM conversations WHERE id = ?');

    const sourceContext = (messageId: string): SourceContext | null => {
      const row = loadMessage.get(messageId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const source = toMessageView(row);
      const scope = conversationMessageScope(ctx.db, source.conversation_id);
      const tupleSql = `(${scope.orderColumns.join(', ')})`;
      const tupleParams = scope.orderColumns.map(column => row[column] as string | number);
      const before = ctx.db.prepare(`
        SELECT ${MESSAGE_VIEW_COLUMNS_SQL} FROM messages
        WHERE ${scope.sql} AND ${tupleSql} < (${sqlPlaceholders(tupleParams.length)})
        ORDER BY ${orderSql(scope.orderColumns, 'DESC')}
        LIMIT ?
      `).all(...scope.params, ...tupleParams, args.context) as Record<string, unknown>[];
      const after = ctx.db.prepare(`
        SELECT ${MESSAGE_VIEW_COLUMNS_SQL} FROM messages
        WHERE ${scope.sql} AND ${tupleSql} > (${sqlPlaceholders(tupleParams.length)})
        ORDER BY ${orderSql(scope.orderColumns, 'ASC')}
        LIMIT ?
      `).all(...scope.params, ...tupleParams, args.context) as Record<string, unknown>[];
      const conversation = loadConversation.get(source.conversation_id) as { title: string } | undefined;

      return {
        message_id: messageId,
        conversation_id: source.conversation_id,
        conversation_title: conversation?.title ?? null,
        messages: [
          ...before.reverse().map(item => ({ ...toMessageView(item), is_source: false })),
          { ...source, is_source: true },
          ...after.map(item => ({ ...toMessageView(item), is_source: false })),
        ],
        ...(scope.chainError ? { chain_error: scope.chainError } : {}),
      };
    };

    let usedTokens = 0;
    let truncated = false;
    const results = ids.flatMap(id => {
      const memory = memories.get(id);
      if (!memory) return [];
      const sourceIds = uniqueIds(memory.source_msg_ids);
      const sources: SourceContext[] = [];
      const missingSourceIds: string[] = [];
      let nextSourceOffset: number | null = null;
      for (let index = args.source_offset; index < sourceIds.length; index += 1) {
        const context = sourceContext(sourceIds[index]);
        if (!context) {
          missingSourceIds.push(sourceIds[index]);
          continue;
        }
        const cost = estimateTokens(JSON.stringify(context));
        // 整次调用至少放进一条来源，单条再大也照给，保证翻页总能前进
        if (usedTokens > 0 && usedTokens + cost > SOURCE_OUTPUT_TOKEN_BUDGET) {
          nextSourceOffset = index;
          truncated = true;
          break;
        }
        usedTokens += cost;
        sources.push(context);
      }
      return [{
        memory_id: memory.id,
        character_id: memory.character_id,
        status: memory.status,
        content: memory.content,
        source_attribution: getMemorySourceAttribution(memory.metadata),
        source_total: sourceIds.length,
        sources,
        missing_source_ids: missingSourceIds,
        next_source_offset: nextSourceOffset,
      }];
    });

    return {
      ok: true,
      memories: results,
      missing_memory_ids: ids.filter(id => !memories.has(id)),
      ...(truncated ? {
        truncated: true,
        note: '来源超出单次输出预算，没读完的记忆带 next_source_offset：对它单独再调用并传 source_offset，直到为 null。没读完的来源不能当作不存在。',
      } : {}),
    };
  }),
});

export const getMemoryProfileTool = defineReadTool({
  name: 'get_memory_profile',
  description: '读取角色的记忆画像（关系状态、近期剧情、情感基线、未完话题、用户画像、置顶摘要）。',
  schema: z.object({
    character_id: z.string().min(1).describe('角色 ID'),
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const profile = readMemoryProfile(args.character_id, ctx.db);
    return {
      ok: true,
      character_id: args.character_id,
      exists: profile !== null,
      profile,
    };
  }),
});
