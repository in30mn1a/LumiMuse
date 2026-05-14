import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(request: NextRequest) {
  const conversationId = request.nextUrl.searchParams.get('conversation_id')?.trim();

  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversation_id' }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT status, merge_count, updated_at
    FROM memory_tasks
    WHERE conversation_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(conversationId) as { status: string; merge_count: number; updated_at: string } | undefined;

  if (!row) {
    return NextResponse.json({ status: 'idle', mergeCount: 0, updatedAt: null });
  }

  return NextResponse.json({
    status: row.status,
    mergeCount: row.merge_count || 0,
    updatedAt: row.updated_at,
  });
}
