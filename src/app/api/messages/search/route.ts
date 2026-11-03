import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { loadSettings } from '@/lib/settings';
import { searchMessages } from '@/lib/message-search';

/**
 * GET /api/messages/search?q=关键词&limit=10&characterId=xxx
 * 按消息内容关键词搜索，支持日期搜索；带 characterId 时只搜该角色的对话
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();
  const characterId = request.nextUrl.searchParams.get('characterId')?.trim() || null;
  const limitParam = Number(request.nextUrl.searchParams.get('limit') || '15');
  const offsetParam = Number(request.nextUrl.searchParams.get('offset') || '0');
  const limit = Math.floor(Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 15, 1), 50));
  const offset = Math.floor(Math.max(Number.isFinite(offsetParam) ? offsetParam : 0, 0));

  if (!q) return NextResponse.json([]);

  const db = getDb();
  // 按用户上报时区解析日期搜索，否则容器 UTC 会让日边界整体偏移
  return NextResponse.json(searchMessages(db, {
    q,
    characterId,
    limit,
    offset,
    timeZone: loadSettings().client_timezone,
  }));
}
