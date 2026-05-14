import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * 批量更新角色排序
 * 请求体：{ ids: string[] }，按数组顺序写入 sort_order（0,1,2...）
 */
export async function PUT(request: NextRequest) {
  const body = await request.json() as { ids?: string[] };
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
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
  tx(body.ids);

  return NextResponse.json({ ok: true });
}
