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

/** 全部或某个角色的提案历史，包含未绑定角色的新建提案和已删除会话的记录。 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const characterId = params.get('character_id')?.trim() || null;
  const limit = pageParam(params.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const offset = pageParam(params.get('offset'), 0, Number.MAX_SAFE_INTEGER);
  return NextResponse.json(listProposalViews(getDb(), characterId, limit, offset));
}
