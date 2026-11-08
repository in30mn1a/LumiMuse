import type Database from 'better-sqlite3';
import { characterUpdateSchema } from '@/lib/schemas';
import { PRESET_ID_NONE } from '@/lib/prompt-presets';

/** 角色卡文本字段；运行配置与头像继续由角色编辑器管理。 */
export const CHARACTER_CARD_FIELDS = [
  'name', 'basic_info', 'personality', 'scenario', 'greeting', 'example_dialogue',
  'system_prompt', 'other_info', 'image_tags', 'user_image_tags', 'image_prompt_other_requirements',
] as const;
export type CharacterCardField = (typeof CHARACTER_CARD_FIELDS)[number];
export type CharacterCardSnapshot = Record<CharacterCardField, string>;

/** 与手动编辑使用相同的校验，未知字段直接拒绝，不补填未提供的字段。 */
export const characterCardUpdateSchema = characterUpdateSchema.pick({
  name: true, basic_info: true, personality: true, scenario: true, greeting: true,
  example_dialogue: true, system_prompt: true, other_info: true, image_tags: true,
  user_image_tags: true, image_prompt_other_requirements: true,
}).strict();
export type ProposalCharacterFields = Partial<CharacterCardSnapshot>;

/** 创建必须有名称，其余文本沿用现有校验，完整保留输入。 */
export const characterCardCreateSchema = characterCardUpdateSchema.extend({
  name: characterUpdateSchema.shape.name.unwrap().refine(name => name.trim().length > 0, '角色名称不能为空'),
});
export type CreatedCharacterSnapshot = Record<string, string | number | null>;

export function completeCharacterCard(fields: ProposalCharacterFields): CharacterCardSnapshot {
  return Object.fromEntries(CHARACTER_CARD_FIELDS.map(field => [field, fields[field] ?? ''])) as CharacterCardSnapshot;
}

/** 批准时创建，运行配置使用手动新建的默认值，排序依据批准时的列表。 */
export function applyCharacterCardCreate(
  db: Database.Database,
  id: string,
  fields: CharacterCardSnapshot,
  now: string,
): CreatedCharacterSnapshot {
  const minRow = db.prepare('SELECT MIN(sort_order) AS min_sort FROM characters').get() as { min_sort: number | null };
  const nextSort = minRow.min_sort === null ? 0 : minRow.min_sort - 1;
  db.prepare(`
    INSERT INTO characters (
      id, ${CHARACTER_CARD_FIELDS.join(', ')}, active_preset_id, memory_chat_injection_mode,
      sort_order, created_at, updated_at
    ) VALUES (?, ${CHARACTER_CARD_FIELDS.map(() => '?').join(', ')}, ?, ?, ?, ?, ?)
  `).run(id, ...CHARACTER_CARD_FIELDS.map(field => fields[field]), PRESET_ID_NONE, 'full', nextSort, now, now);
  return db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as CreatedCharacterSnapshot;
}

/** 固定字段顺序，快照比较包含完整角色卡，排除排序、时间及运行配置。 */
export function loadCharacterCard(db: Database.Database, id: string): CharacterCardSnapshot | null {
  const row = db.prepare(`SELECT ${CHARACTER_CARD_FIELDS.join(', ')} FROM characters WHERE id = ?`)
    .get(id) as CharacterCardSnapshot | undefined;
  if (!row) return null;
  return Object.fromEntries(CHARACTER_CARD_FIELDS.map(field => [field, row[field]])) as CharacterCardSnapshot;
}

/** 只写白名单里的指定字段；调用方在同一事务内完成快照检查。 */
export function applyCharacterCardUpdate(
  db: Database.Database,
  id: string,
  fields: ProposalCharacterFields,
  now: string,
): void {
  const keys = CHARACTER_CARD_FIELDS.filter(field => fields[field] !== undefined);
  if (keys.length === 0) throw new Error('角色卡没有实际修改字段');
  const row = db.prepare('SELECT updated_at FROM characters WHERE id = ?').get(id) as { updated_at: string } | undefined;
  if (!row) throw new Error(`角色 ${id} 不存在`);
  // 与角色 PUT 相同：同毫秒保存也要推进时间，避免被当作未保存的空白草稿。
  const updatedAt = new Date(Math.max(Date.parse(now), Date.parse(row.updated_at) + 1)).toISOString();
  db.prepare(`UPDATE characters SET ${keys.map(field => `${field} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map(field => fields[field]!), updatedAt, id);
}
