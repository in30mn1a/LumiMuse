import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

type CandidateRow = {
  id: number;
  task_id: number | null;
  character_id: string;
  conversation_id: string | null;
  raw_candidate_json: string | null;
  raw_response: string | null;
  status: string;
  error_reason: string | null;
  created_at: string;
  updated_at: string;
};

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeCandidate(row: CandidateRow) {
  return {
    ...row,
    raw_candidate: parseJsonObject(row.raw_candidate_json),
  };
}

export async function GET(request: NextRequest) {
  const characterId = request.nextUrl.searchParams.get('character_id');
  const limitParam = request.nextUrl.searchParams.get('limit');
  const offsetParam = request.nextUrl.searchParams.get('offset');
  const limit = Math.min(Math.max(Number(limitParam ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(offsetParam ?? 0) || 0, 0);

  const db = getDb();
  let sql = "SELECT * FROM memory_extraction_candidates WHERE status = 'repairable'";
  let countSql = "SELECT COUNT(*) as count FROM memory_extraction_candidates WHERE status = 'repairable'";
  const params: unknown[] = [];

  if (characterId) {
    sql += ' AND character_id = ?';
    countSql += ' AND character_id = ?';
    params.push(characterId);
  }

  const total = db.prepare(countSql).get(...params) as { count: number };
  const rows = db.prepare(`${sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as CandidateRow[];

  return NextResponse.json({
    candidates: rows.map(normalizeCandidate),
    total: total.count,
    hasMore: offset + rows.length < total.count,
  });
}
