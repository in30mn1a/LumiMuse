import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { formatZodFieldErrors, workCreateSchema } from '@/lib/schemas';
import { readJsonObject } from '@/lib/request-json';
import { createWork, findMatchingWork, listWorks, WorkValidationError } from '@/lib/works-catalog';
import { workConflictResponse } from './works-route-helpers';

/** 某角色的片单；`include_dismissed=1` 时连同已移除条目一起返回（界面的「已移除」区要用）。 */
export async function GET(request: NextRequest) {
  const characterId = request.nextUrl.searchParams.get('character_id');
  if (!characterId) return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
  const includeDismissed = request.nextUrl.searchParams.get('include_dismissed') === '1';
  return NextResponse.json(listWorks(getDb(), characterId, { includeDismissed }));
}

/** 主人手动新增条目。同角色同类型下名称或别名撞上已有条目（含已移除的）时返回 409，提示改为编辑或恢复。 */
export async function POST(request: NextRequest) {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const parsed = workCreateSchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(input.character_id)) {
    return NextResponse.json({ error: 'Character not found' }, { status: 404 });
  }

  const existing = findMatchingWork(db, input.character_id, input.work_type, [input.title, ...(input.aliases ?? [])]);
  if (existing) return workConflictResponse(existing);

  try {
    const work = createWork(db, input, new Date().toISOString());
    return NextResponse.json(work, { status: 201 });
  } catch (error) {
    if (error instanceof WorkValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
