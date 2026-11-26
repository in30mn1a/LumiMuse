import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { formatZodFieldErrors, workUpdateSchema } from '@/lib/schemas';
import { readJsonObject } from '@/lib/request-json';
import type Database from 'better-sqlite3';
import type { WorkEntry, WorkType } from '@/types';
import {
  cleanWorkTitle,
  getWork,
  listWorks,
  normalizeWorkTitle,
  updateWork,
  WorkValidationError,
} from '@/lib/works-catalog';
import { loadWorkSources, workConflictResponse } from '../works-route-helpers';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 两个方法都必须用 `?character_id=` 声明归属，并与库里的归属交叉校验：
 * 片单按角色隔离，拿着别的角色的条目 id 既读不到也改不了。
 */
function missingCharacterIdResponse(): NextResponse {
  return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
}

/** 名称比较用的键：与写库时一样先去外层书名号，再归一化。 */
function nameKey(name: string): string {
  return normalizeWorkTitle(cleanWorkTitle(name));
}

/** 同角色、同类型下与这些名称撞上的另一条未移除条目（不含自己）。 */
function findActiveDuplicate(
  db: Database.Database,
  current: WorkEntry,
  workType: WorkType,
  names: readonly string[],
): WorkEntry | null {
  const keys = new Set(names.map(nameKey).filter(Boolean));
  if (keys.size === 0) return null;
  return listWorks(db, current.character_id).find(other => (
    other.id !== current.id
    && other.work_type === workType
    && [other.title, ...other.aliases].some(name => keys.has(normalizeWorkTitle(name)))
  )) ?? null;
}

/** 单个条目；`include_sources=1` 时附带依据（来源记忆正文与来源消息片段）。 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const claimed = request.nextUrl.searchParams.get('character_id');
  if (!claimed) return missingCharacterIdResponse();

  const db = getDb();
  const work = getWork(db, id);
  if (!work) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (work.character_id !== claimed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (request.nextUrl.searchParams.get('include_sources') !== '1') return NextResponse.json(work);
  return NextResponse.json({ ...work, sources: loadWorkSources(db, work) });
}

/**
 * 主人手动修改：给出的字段原样写入（可以清空评分、进度、印象和别名），
 * `dismissed: true` 移除、`false` 恢复。与另一条未移除条目重复时返回 409：
 * 改类型或恢复时查条目的全部名称；只改名或别名时只查这次新加进来的名称。
 */
export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const parsed = workUpdateSchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const patch = parsed.data;
  if (Object.values(patch).every(value => value === undefined)) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }
  const claimed = request.nextUrl.searchParams.get('character_id');
  if (!claimed) return missingCharacterIdResponse();

  const db = getDb();
  const current = getWork(db, id);
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (current.character_id !== claimed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const willBeActive = patch.dismissed === undefined ? current.dismissed_at === null : !patch.dismissed;
  const restoring = patch.dismissed === false && current.dismissed_at !== null;
  if (willBeActive) {
    const workType = patch.work_type ?? current.work_type;
    const names = [patch.title ?? current.title, ...(patch.aliases ?? current.aliases)];
    // 改类型或恢复：整条重新进入该类型的未移除集合，全部名称都要查。
    // 否则只查新加进来的名称：已有的重名（自动更新、批准的提案或旧数据留下的）不该让两条都再也改不动。
    const currentKeys = new Set([current.title, ...current.aliases].map(nameKey));
    const namesToCheck = workType !== current.work_type || restoring
      ? names
      : names.filter(name => !currentKeys.has(nameKey(name)));
    const duplicate = findActiveDuplicate(db, current, workType, namesToCheck);
    if (duplicate) return workConflictResponse(duplicate);
  }

  try {
    return NextResponse.json(updateWork(db, id, patch, new Date().toISOString()));
  } catch (error) {
    if (error instanceof WorkValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
