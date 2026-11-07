import { z } from 'zod';
import { MEMORY_STATUSES } from '@/types';
import { blobToEmbedding, loadReadyMemoryEmbeddings } from '@/lib/memory-embeddings';
import { createMemoryReviewPlan, getMemoryReviewPlanBatch } from '@/lib/memory-review-plan';
import { MEMORY_REVIEW_SKILL } from '@/lib/agent/skills/memory-review';
import { defineReadTool } from './types';
import { MEMORY_COLUMNS_SQL, runReadTool, sqlPlaceholders, toMemoryView } from './shared';

export const AGENT_REVIEW_BATCH_SIZE = 40;

export const loadSkillTool = defineReadTool({
  name: 'load_skill',
  description: '读取内置 skill 的完整规则。开始整理记忆前先读取 memory-review。',
  schema: z.object({ name: z.enum(['memory-review']) }),
  execute(args, ctx) {
    return runReadTool(ctx, () => {
      if (args.name !== MEMORY_REVIEW_SKILL.name) return { ok: false, error: 'Skill 不存在' };
      return { ok: true, skill: MEMORY_REVIEW_SKILL };
    });
  },
});

export const prepareMemoryReviewTool = defineReadTool({
  name: 'prepare_memory_review',
  description: '为一个角色某一状态（默认 active，可选 archived 等）的全部记忆准备成员固定的分批读取计划，每批约 40 条，尽量保持同簇完整；审查期间新进入该状态的记忆不在计划内。不截断正文，不调用模型，也不修改角色记忆。',
  schema: z.object({
    character_id: z.string().min(1),
    status: z.enum(MEMORY_STATUSES).default('active').describe('要审查的记忆状态，默认 active'),
  }),
  execute(args, ctx) {
    return runReadTool(ctx, () => {
      if (!ctx.db.prepare('SELECT id FROM characters WHERE id = ?').get(args.character_id)) {
        return { ok: false, error: '角色不存在' };
      }
      const rows = ctx.db.prepare(`
        SELECT id, content, importance FROM memories WHERE character_id = ? AND status = ?
      `).all(args.character_id, args.status) as { id: string; content: string; importance: number }[];
      const embeddings = new Map<string, Float32Array>();
      for (const row of loadReadyMemoryEmbeddings(args.character_id, { db: ctx.db, limit: Number.POSITIVE_INFINITY })) {
        try {
          embeddings.set(row.memory_id, blobToEmbedding(row.embedding_blob));
        } catch {
          // 坏向量不阻碍全文读取，聚类仍可使用文本。
        }
      }
      const plan = createMemoryReviewPlan({
        characterId: args.character_id,
        status: args.status,
        memories: rows.map(row => ({ ...row, embedding: embeddings.get(row.id) ?? null })),
        clusterOptions: { batchSize: AGENT_REVIEW_BATCH_SIZE, keepClustersTogether: true },
      });
      return {
        ok: true,
        plan_id: plan.planId,
        character_id: plan.characterId,
        status: plan.status,
        total_memories: plan.memoryIds.length,
        total_batches: plan.batches.length,
        batch_sizes: plan.batches.map(batch => batch.length),
        expires_at: new Date(plan.expiresAt).toISOString(),
        note: '从 batch_index 0 开始读完全部批次，疑点用 search_memories 跨批检索，并读取来源。是否读完以每批结果里的 progress 为准。',
      };
    });
  },
});

export const readReviewBatchTool = defineReadTool({
  name: 'read_review_batch',
  description: '按计划读取一批完整记忆（正文不截断；来源只给条数 source_count，原文用 get_memory_sources 读取）。重读同一批可取回被折叠的结果；计划过期请重新 prepare_memory_review。消失或不再处于计划状态的条目单独列在 stale_ids，不算作已审查。progress 是服务端统计的覆盖进度：all_batches_read 为 true 之前不能说已经读完，unread_batch_indices 是还没读的批次。',
  schema: z.object({ plan_id: z.string().min(1), character_id: z.string().min(1), batch_index: z.number().int().min(0) }),
  execute(args, ctx) {
    return runReadTool(ctx, () => {
      const { plan, batchIds } = getMemoryReviewPlanBatch({ planId: args.plan_id, characterId: args.character_id, batchIndex: args.batch_index });
      const rows = ctx.db.prepare(`
        SELECT ${MEMORY_COLUMNS_SQL} FROM memories m
        WHERE m.character_id = ? AND m.status = ? AND m.id IN (${sqlPlaceholders(batchIds.length)})
      `).all(args.character_id, plan.status, ...batchIds) as Record<string, unknown>[];
      const byId = new Map(rows.map(row => [String(row.id), toMemoryView(row)]));
      // 来源 ID 列表只给条数：长期使用的角色每条记忆常挂上百个来源 ID，约占整批结果的四分之三，
      // 全量审查几十批时会把上下文挤爆。要看原文用 get_memory_sources，要完整条目用 get_memories。
      const memories = batchIds.flatMap(id => {
        const memory = byId.get(id);
        if (!memory) return [];
        const { source_msg_ids: sourceIds, ...rest } = memory;
        return [{ ...rest, source_count: sourceIds.length }];
      });
      plan.readBatches.add(args.batch_index);
      for (const memory of memories) plan.readMemoryIds.add(memory.id);
      const unread = plan.batches.map((_, index) => index).filter(index => !plan.readBatches.has(index));
      return {
        ok: true,
        plan_id: plan.planId,
        character_id: plan.characterId,
        status: plan.status,
        batch_index: args.batch_index,
        total_batches: plan.batches.length,
        total_memories: plan.memoryIds.length,
        memories,
        stale_ids: batchIds.filter(id => !byId.has(id)),
        next_batch_index: args.batch_index + 1 < plan.batches.length ? args.batch_index + 1 : null,
        progress: {
          read_batches: plan.readBatches.size,
          read_memories: plan.readMemoryIds.size,
          unread_batch_indices: unread,
          all_batches_read: unread.length === 0,
        },
      };
    });
  },
});
