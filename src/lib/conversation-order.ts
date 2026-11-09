import type Database from 'better-sqlite3';

/** 同一角色下对话列表的排序：sort_order 越小越靠前，由主人拖拽决定；并列时退回最近更新。 */
export const CONVERSATION_LIST_ORDER = 'sort_order ASC, updated_at DESC, created_at DESC, id DESC';

/** 新建 / 复制出的对话放到该角色列表最前面。 */
export function topConversationSortOrder(db: Database.Database, characterId: string): number {
  const row = db.prepare('SELECT MIN(sort_order) AS min FROM conversations WHERE character_id = ?')
    .get(characterId) as { min: number | null };
  return row.min === null ? 0 : row.min - 1;
}
