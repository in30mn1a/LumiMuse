import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeMemoryCategory } from '@/lib/memory-category';
import { EXPORT_VERSION } from '@/lib/export-version';

/**
 * GET /api/export?type=character&id=xxx  — 导出单个角色（含记忆和对话）
 * GET /api/export?type=all               — 导出全部（角色、记忆、对话、消息）
 *
 * 可选过滤参数（type=all 时生效）：
 *   include_characters=1  是否包含角色（默认 1）
 *   include_memories=1    是否包含记忆（默认 1）
 *   include_conversations=1 是否包含对话和消息（默认 1）
 */
export async function GET(request: NextRequest) {
  const db = getDb();
  const { searchParams } = request.nextUrl;
  const type = searchParams.get('type') || 'all';
  const id = searchParams.get('id');

  // 解析 include 参数，默认全部包含
  const includeCharacters = searchParams.get('include_characters') !== '0';
  const includeMemories = searchParams.get('include_memories') !== '0';
  const includeConversations = searchParams.get('include_conversations') !== '0';

  // ── 单角色导出 ──────────────────────────────────────────────
  if (type === 'character' && id) {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    if (!character) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const memories = includeMemories
      ? (db.prepare('SELECT * FROM memories WHERE character_id = ?').all(id) as Record<string, unknown>[])
          .map(m => serializeMemory(m))
      : [];

    const conversations = includeConversations
      ? buildConversationsForCharacter(db, id)
      : [];

    const payload = {
      version: EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      character,
      memories,
      conversations,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="lumimuse-character-${id}.json"`,
      },
    });
  }

  // ── 全量导出 ────────────────────────────────────────────────
  const characters = includeCharacters
    ? (db.prepare('SELECT * FROM characters ORDER BY updated_at DESC').all() as Record<string, unknown>[])
    : [];

  const memories = includeMemories
    ? (db.prepare('SELECT * FROM memories ORDER BY character_id, updated_at DESC').all() as Record<string, unknown>[])
        .map(m => serializeMemory(m))
    : [];

  // 对话和消息：按角色分组，每条对话附带完整消息列表
  const conversations = includeConversations
    ? buildAllConversations(db)
    : [];

  const payload = {
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    characters,
    memories,
    conversations,
  };

  // 根据实际包含内容生成文件名
  const parts = [
    includeCharacters && 'chars',
    includeMemories && 'mems',
    includeConversations && 'convs',
  ].filter(Boolean).join('-');
  const filename = `lumimuse-${parts}-${new Date().toISOString().slice(0, 10)}.json`;

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

// ── 工具函数 ────────────────────────────────────────────────

function serializeMemory(m: Record<string, unknown>) {
  return {
    ...m,
    tags: typeof m.tags === 'string' ? JSON.parse(m.tags as string) : m.tags,
    source_msg_ids: typeof m.source_msg_ids === 'string' ? JSON.parse(m.source_msg_ids as string) : m.source_msg_ids,
    category: normalizeMemoryCategory(String(m.category || '话题历史')),
  };
}

function buildConversationsForCharacter(db: ReturnType<typeof import('@/lib/db').getDb>, characterId: string) {
  const convs = db.prepare(
    'SELECT * FROM conversations WHERE character_id = ? ORDER BY updated_at DESC'
  ).all(characterId) as Record<string, unknown>[];

  return convs.map(conv => ({
    ...conv,
    messages: db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
    ).all(conv.id as string) as Record<string, unknown>[],
  }));
}

function buildAllConversations(db: ReturnType<typeof import('@/lib/db').getDb>) {
  const convs = db.prepare(
    'SELECT * FROM conversations ORDER BY character_id, updated_at DESC'
  ).all() as Record<string, unknown>[];

  return convs.map(conv => ({
    ...conv,
    messages: db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
    ).all(conv.id as string) as Record<string, unknown>[],
  }));
}
