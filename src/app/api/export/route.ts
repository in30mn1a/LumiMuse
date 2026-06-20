import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeMemoryCategory } from '@/lib/memory-category';
import { EXPORT_VERSION } from '@/lib/export-version';

/**
 * GET /api/export?type=character&id=xxx  — 导出单个角色（含记忆和对话）
 * GET /api/export?type=all               — 导出全部（角色、记忆、对话、消息）
 *
 * 可选过滤参数（type=all 时生效）：
 *   include_characters=1      是否包含角色（默认 1）
 *   include_memories=1        是否包含记忆（默认 1）
 *   include_conversations=1   是否包含对话和消息（默认 1）
 *   include_profiles=1        是否包含记忆画像及画像版本历史（默认 1）
 *   include_embeddings=1      是否包含记忆向量索引（默认 0，体积大且可重建）
 *
 * 单角色导出（type=character）始终尝试带上画像 / 画像版本 / embedding，
 * 并受 include_profiles / include_embeddings 控制；include_memories=0 时
 * embedding 自动跳过（没有记忆就没有向量索引）。
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
  const includeProfiles = searchParams.get('include_profiles') !== '0';
  // embedding 默认不导出：向量索引是可重建的派生数据（从记忆内容 + embedding 模型重新生成），
  // 但体积庞大（每条记忆几千 float32 = 几十 KB），默认塞进备份会让文件膨胀到几十甚至上百 MB。
  // 需要保留索引的用户可显式传 include_embeddings=1。
  const includeEmbeddings = includeMemories && searchParams.get('include_embeddings') === '1';

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

    // 画像与画像版本历史：跟角色绑定，导出后可在导入端直接还原，
    // 避免重新跑 LLM 画像提取（昂贵且会丢失人工 patch 历史）。
    const profile = includeProfiles ? loadProfileForCharacter(db, id) : null;
    const profileVersions = includeProfiles ? loadProfileVersionsForCharacter(db, id) : [];

    // 向量索引：跟记忆绑定，导出后避免重新跑 embedding（API 调用 + 时间成本）。
    // 只导出 ready 状态的向量，failed/pending 的让导入端按需重建。
    const embeddings = includeEmbeddings
      ? loadEmbeddingsForCharacter(db, id)
      : [];

    const payload = {
      version: EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      character,
      memories,
      conversations,
      // 画像可能为 null（角色从未生成过画像），导入端按「有则写入」处理。
      memory_profile: profile,
      memory_profile_versions: profileVersions,
      memory_embeddings: embeddings,
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

  const profiles = includeProfiles ? loadAllProfiles(db) : [];
  const profileVersions = includeProfiles ? loadAllProfileVersions(db) : [];
  const embeddings = includeEmbeddings ? loadAllEmbeddings(db) : [];

  const payload = {
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    characters,
    memories,
    conversations,
    memory_profiles: profiles,
    memory_profile_versions: profileVersions,
    memory_embeddings: embeddings,
  };

  // 根据实际包含内容生成文件名
  const parts = [
    includeCharacters && 'chars',
    includeMemories && 'mems',
    includeConversations && 'convs',
    includeProfiles && 'profiles',
    includeEmbeddings && 'embeds',
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
    tags: parseJsonArray(m.tags),
    source_msg_ids: parseJsonArray(m.source_msg_ids),
    category: normalizeMemoryCategory(String(m.category || '话题历史')),
  };
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 序列化画像行：open_threads 在 DB 里是 JSON 字符串，导出时保持字符串形式，
 * 导入端会重新解析。其余字段都是 TEXT，直接透传。
 */
function serializeProfile(row: Record<string, unknown>) {
  return { ...row };
}

/**
 * 序列化画像版本行：snapshot_json 在 DB 里是 JSON 字符串（画像快照），
 * 导出时保持字符串形式，导入端直接写入。
 */
function serializeProfileVersion(row: Record<string, unknown>) {
  return { ...row };
}

/**
 * 序列化 embedding 行：embedding_blob 是 Float32Array 的二进制 Buffer，
 * JSON.stringify 会自动转成 { type: 'Buffer', data: [...] } 对象。
 * 导入端用 Buffer.from() 还原。保留所有字段以便导入端完整重建索引。
 */
function serializeEmbedding(row: Record<string, unknown>) {
  return { ...row };
}

function tableExists(db: ReturnType<typeof getDb>, tableName: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS exists_flag FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(tableName) as { exists_flag?: number } | undefined;
  return Boolean(row?.exists_flag);
}

function loadProfileForCharacter(db: ReturnType<typeof getDb>, characterId: string): Record<string, unknown> | null {
  if (!tableExists(db, 'character_memory_profiles')) return null;
  const row = db.prepare('SELECT * FROM character_memory_profiles WHERE character_id = ?').get(characterId) as
    | Record<string, unknown>
    | undefined;
  return row ? serializeProfile(row) : null;
}

function loadProfileVersionsForCharacter(db: ReturnType<typeof getDb>, characterId: string): Record<string, unknown>[] {
  if (!tableExists(db, 'character_memory_profile_versions')) return [];
  return (db.prepare(
    'SELECT * FROM character_memory_profile_versions WHERE character_id = ? ORDER BY version_number ASC',
  ).all(characterId) as Record<string, unknown>[]).map(serializeProfileVersion);
}

function loadEmbeddingsForCharacter(db: ReturnType<typeof getDb>, characterId: string): Record<string, unknown>[] {
  if (!tableExists(db, 'memory_embeddings')) return [];
  // 只导出 ready 状态的向量，failed/pending 的让导入端按需重建
  return (db.prepare(
    "SELECT * FROM memory_embeddings WHERE character_id = ? AND status = 'ready' ORDER BY memory_id",
  ).all(characterId) as Record<string, unknown>[]).map(serializeEmbedding);
}

function loadAllProfiles(db: ReturnType<typeof getDb>): Record<string, unknown>[] {
  if (!tableExists(db, 'character_memory_profiles')) return [];
  return (db.prepare('SELECT * FROM character_memory_profiles ORDER BY character_id').all() as Record<string, unknown>[]).map(
    serializeProfile,
  );
}

function loadAllProfileVersions(db: ReturnType<typeof getDb>): Record<string, unknown>[] {
  if (!tableExists(db, 'character_memory_profile_versions')) return [];
  return (db.prepare(
    'SELECT * FROM character_memory_profile_versions ORDER BY character_id, version_number ASC',
  ).all() as Record<string, unknown>[]).map(serializeProfileVersion);
}

function loadAllEmbeddings(db: ReturnType<typeof getDb>): Record<string, unknown>[] {
  if (!tableExists(db, 'memory_embeddings')) return [];
  return (db.prepare(
    "SELECT * FROM memory_embeddings WHERE status = 'ready' ORDER BY character_id, memory_id",
  ).all() as Record<string, unknown>[]).map(serializeEmbedding);
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

/**
 * 将数组按指定大小切分，用于绕过 SQLite SQLITE_LIMIT_VARIABLE_NUMBER (默认 999) 限制。
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function buildAllConversations(db: ReturnType<typeof import('@/lib/db').getDb>) {
  const convs = db.prepare(
    'SELECT * FROM conversations ORDER BY character_id, updated_at DESC'
  ).all() as Record<string, unknown>[];

  if (convs.length === 0) return [];

  // 原先每个 conversation 都单独 SELECT 一次 messages，会话量大时 N+1 拖慢导出。
  // 改为单次 IN 查询拉全部消息，再按 conversation_id 在内存里分桶。
  // IN 列表分批，单批 500 个 id（留足余量避开 SQLite SQLITE_LIMIT_VARIABLE_NUMBER）。
  const conversationIds = convs.map(c => c.id as string);
  const messagesByConversation = new Map<string, Record<string, unknown>[]>();
  for (const id of conversationIds) messagesByConversation.set(id, []);

  for (const chunk of chunkArray(conversationIds, 500)) {
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM messages WHERE conversation_id IN (${placeholders}) ORDER BY created_at ASC, seq ASC`
    ).all(...chunk) as Record<string, unknown>[];
    for (const row of rows) {
      const bucket = messagesByConversation.get(row.conversation_id as string);
      if (bucket) bucket.push(row);
    }
  }

  return convs.map(conv => ({
    ...conv,
    messages: messagesByConversation.get(conv.id as string) ?? [],
  }));
}
