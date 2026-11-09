import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { readJsonObject } from '@/lib/request-json';

/**
 * 批量更新某角色的对话排序
 * 请求体：{ character_id: string, ids: string[] }，按数组顺序写入 sort_order（0,1,2...）
 */
export async function PUT(request: NextRequest) {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;

  const characterId = body.data.character_id;
  const ids = body.data.ids;
  if (typeof characterId !== 'string' || !characterId) {
    return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
  }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id): id is string => typeof id === 'string')) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 });
  }
  if (new Set(ids).size !== ids.length) {
    return NextResponse.json({ error: 'ids must be unique' }, { status: 400 });
  }

  const db = getDb();
  const owned = new Set(
    (db.prepare('SELECT id FROM conversations WHERE character_id = ?').all(characterId) as { id: string }[])
      .map(row => row.id),
  );
  // 只允许重排该角色自己的对话，防止误把别的角色的对话写进来
  if (!ids.every(id => owned.has(id))) {
    return NextResponse.json({ error: 'ids must belong to the character' }, { status: 400 });
  }

  const update = db.prepare('UPDATE conversations SET sort_order = ? WHERE id = ?');
  db.transaction((orderedIds: string[]) => {
    for (let i = 0; i < orderedIds.length; i++) {
      update.run(i, orderedIds[i]);
    }
  })(ids);

  return NextResponse.json({ ok: true });
}
