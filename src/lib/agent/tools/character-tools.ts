import { z } from 'zod';
import { QUERYABLE_TABLES } from '@/lib/agent/table-query';
import { defineReadTool } from './types';
import { pageFromOverfetch, pagingShape, parseJsonColumn, runReadTool } from './shared';

/** 按角色配置的后台任务字段；只有 provider ID，没有任何密钥。 */
const TASK_CONFIG_COLUMNS = new Set<string>([
  'background_provider_id',
  'background_model',
  'image_prompt_model',
  'background_reasoning_by_model',
  'image_prompt_reasoning_by_model',
  'background_system_prompt_by_model',
  'image_prompt_system_prompt_by_model',
]);

const JSON_MAP_COLUMNS = new Set<string>([
  'background_reasoning_by_model',
  'image_prompt_reasoning_by_model',
  'background_system_prompt_by_model',
  'image_prompt_system_prompt_by_model',
]);

export const listCharactersTool = defineReadTool({
  name: 'list_characters',
  description: '列出角色：ID、名称、活跃记忆数、对话数。按侧边栏顺序分页。',
  schema: z.object({ ...pagingShape }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const rows = ctx.db.prepare(`
      SELECT
        c.id,
        c.name,
        c.sort_order,
        c.updated_at,
        (SELECT COUNT(*) FROM memories m WHERE m.character_id = c.id AND m.status = 'active') AS active_memory_count,
        (SELECT COUNT(*) FROM conversations cv WHERE cv.character_id = c.id) AS conversation_count
      FROM characters c
      ORDER BY c.sort_order ASC, c.updated_at DESC, c.id ASC
      LIMIT ? OFFSET ?
    `).all(args.limit + 1, args.offset) as Record<string, unknown>[];
    const page = pageFromOverfetch(rows, args.limit, args.offset);
    return { ok: true, characters: page.items, has_more: page.has_more, next_offset: page.next_offset };
  }),
});

export const getCharacterTool = defineReadTool({
  name: 'get_character',
  description: '读取一个角色的完整设定（人设、开场白、示例对话、生图标签等）和后台任务配置。任务配置只含 provider ID，留空表示回退主接口和主模型。',
  schema: z.object({
    character_id: z.string().min(1).describe('角色 ID'),
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const columns = QUERYABLE_TABLES.characters;
    const row = ctx.db.prepare(`SELECT ${columns.join(', ')} FROM characters WHERE id = ?`)
      .get(args.character_id) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, error: `角色不存在：${args.character_id}` };

    const character: Record<string, unknown> = {};
    const taskConfig: Record<string, unknown> = {};
    for (const column of columns) {
      const value = JSON_MAP_COLUMNS.has(column) ? parseJsonColumn(row[column]) : row[column];
      if (TASK_CONFIG_COLUMNS.has(column)) taskConfig[column] = value;
      else character[column] = value;
    }

    const modelPresetBindings = ctx.db.prepare(`
      SELECT model, preset_id
      FROM character_model_preset_bindings
      WHERE character_id = ?
      ORDER BY sort_order ASC, model ASC
    `).all(args.character_id);

    return {
      ok: true,
      character,
      task_config: taskConfig,
      model_preset_bindings: modelPresetBindings,
    };
  }),
});
