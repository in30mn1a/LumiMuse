import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { listProposalViews } from '@/lib/agent/proposals';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function pageParam(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/** 某个角色的修改历史，新的在前，包括已删除会话产生的提案。 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const characterId = params.get('character_id')?.trim();
  if (!characterId) return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
  const limit = pageParam(params.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const offset = pageParam(params.get('offset'), 0, Number.MAX_SAFE_INTEGER);
  return NextResponse.json(listProposalViews(getDb(), characterId, limit, offset));
}
