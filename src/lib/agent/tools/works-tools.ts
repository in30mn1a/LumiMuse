import { z } from 'zod';
import { WORK_TYPES } from '@/types';
import { listWorks } from '@/lib/works-catalog';
import { defineReadTool } from './types';
import { runReadTool } from './shared';

/**
 * 读取一个角色的作品片单，含主人移除过的条目（dismissed_at 非空）。
 * Agent 整理片单前先读它：已有条目要用 update，移除过的条目不要当新作品再加。
 */
export const getWorksCatalogTool = defineReadTool({
  name: 'get_works_catalog',
  description: '读取一个角色的作品片单（电影、剧集/动画、书、游戏），包括主人移除过的条目（dismissed_at 非空）。每条带 id、类型、规范名、别名、状态、评分、进度、印象、first_seen_at 和依据（来源记忆 ID、来源消息 ID）。修改片单用 create_works_proposal。片单很长、结果放不下时用 type 分类型读取。',
  schema: z.object({
    character_id: z.string().min(1).describe('角色 ID'),
    type: z.enum(WORK_TYPES).optional().describe('只读这一类：movie、series、book、game；不填读全部'),
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    if (!ctx.db.prepare('SELECT 1 FROM characters WHERE id = ?').get(args.character_id)) {
      return { ok: false, error: `角色不存在：${args.character_id}` };
    }
    const entries = listWorks(ctx.db, args.character_id, { includeDismissed: true })
      .filter(entry => args.type === undefined || entry.work_type === args.type);
    const works = entries.map(entry => ({
      id: entry.id,
      type: entry.work_type,
      title: entry.title,
      aliases: entry.aliases,
      status: entry.status,
      rating: entry.rating,
      progress: entry.progress,
      note: entry.note,
      first_seen_at: entry.first_seen_at,
      dismissed_at: entry.dismissed_at,
      source_memory_ids: entry.source_memory_ids,
      source_msg_ids: entry.source_msg_ids,
    }));
    const dismissed = works.filter(work => work.dismissed_at !== null).length;
    return {
      ok: true,
      character_id: args.character_id,
      total: works.length,
      active_count: works.length - dismissed,
      dismissed_count: dismissed,
      works,
    };
  }),
});
