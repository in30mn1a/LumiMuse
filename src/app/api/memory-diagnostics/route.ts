import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getMemorySystemStatus } from '@/lib/memory-status';

export async function GET(request: NextRequest) {
  const characterId = request.nextUrl.searchParams.get('character_id')?.trim() || undefined;
  return NextResponse.json({ ok: true, ...getMemorySystemStatus(getDb(), characterId) });
}
