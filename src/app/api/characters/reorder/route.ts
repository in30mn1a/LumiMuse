import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { readJsonObject } from '@/lib/request-json';

/**
 * 批量更新角色排序
 * 请求体：{ ids: string[] }，按数组顺序写入 sort_order（0,1,2...）
 */
export async function PUT(request: NextRequest) {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;

  const ids = body.data.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id): id is string => typeof id === 'string')) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 });
  }

  const db = getDb();
  const update = db.prepare('UPDATE characters SET sort_order = ? WHERE id = ?');

  // 用事务保证整批排序原子写入
  const tx = db.transaction((ids: string[]) => {
    for (let i = 0; i < ids.length; i++) {
      update.run(i, ids[i]);
    }
  });
  tx(ids);

  return NextResponse.json({ ok: true });
}
