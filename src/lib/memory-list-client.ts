import type { MemoryListItem } from '@/types';
import { parseJsonArrayResponse } from '@/lib/http';

/**
 * 聊天页用的角色记忆列表（默认隐藏已归档等非 active 状态）。
 * 带 omit_sources=1：source_msg_ids 占响应一半以上，聊天页只用条数、分类和正文。
 */
export async function fetchCharacterMemoryList(
  characterId: string,
  init?: { signal?: AbortSignal },
): Promise<MemoryListItem[]> {
  const response = await fetch(
    `/api/memories?character_id=${encodeURIComponent(characterId)}&omit_sources=1`,
    init,
  );
  return parseJsonArrayResponse<MemoryListItem>(response);
}
