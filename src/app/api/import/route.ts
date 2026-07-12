import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getDb } from '@/lib/db';
import { inferMemoryDefaults, normalizeMemoryCategory } from '@/lib/memory-category';
import { normalizeCharacterCard, type CharacterDraft } from '@/lib/character-card-import';
import { requireAuth } from '@/lib/route-auth';
import { remapJsonStringIds } from '@/lib/character-file-utils';
import { EXPORT_VERSION } from '@/lib/export-version';
import { MEMORY_KINDS, MEMORY_STATUSES } from '@/types';
import { parseMessageMetadata } from '@/lib/messages';
import { createMessageTokenCount, metadataWithTokenCountProvenance } from '@/lib/message-token-provenance';

interface ImportPayload {
  version?: number;
  // 单角色导出格式
  character?: Record<string, unknown>;
  memories?: Record<string, unknown>[];
  conversations?: ConversationWithMessages[];
  // 单角色导出：画像为单个对象或 null；画像版本和 embedding 为数组
  memory_profile?: Record<string, unknown> | null;
  memory_profile_versions?: Record<string, unknown>[];
  memory_embeddings?: Record<string, unknown>[];
  // 全量导出格式
  characters?: Record<string, unknown>[];
  // 全量导出：画像、画像版本、embedding 均为数组
  memory_profiles?: Record<string, unknown>[];
  // memory_profile_versions 和 memory_embeddings 在两种格式下字段名相同
}

interface ConversationWithMessages {
  id: string;
  character_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  ignore_memory?: unknown;
  messages?: Record<string, unknown>[];
}

const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;

interface ImportEnumValidationError {
  collection: string;
  index: number;
  field: 'role' | 'status' | 'memory_kind';
  value: unknown;
}

/**
 * 安全提取字符串字段：拒绝非字符串值，避免 JSON 中注入对象 / 数组导致后续
 * 直接绑定到 SQLite 参数时抛出 TypeError 或写入异常数据。
 */
function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * 安全提取数组字段：非数组一律视为空数组。
 */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function invalidEnumValue(
  record: Record<string, unknown>,
  field: ImportEnumValidationError['field'],
  allowed: readonly string[],
): unknown | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, field)) return undefined;
  const value = record[field];
  return typeof value === 'string' && allowed.includes(value) ? undefined : value;
}

function findImportEnumValidationError(
  conversations: ConversationWithMessages[],
  memories: Record<string, unknown>[],
): ImportEnumValidationError | undefined {
  for (let conversationIndex = 0; conversationIndex < conversations.length; conversationIndex++) {
    const messages = asArray<Record<string, unknown>>(conversations[conversationIndex].messages);
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const value = invalidEnumValue(messages[messageIndex], 'role', MESSAGE_ROLES);
      if (value !== undefined) {
        return {
          collection: `conversations[${conversationIndex}].messages`,
          index: messageIndex,
          field: 'role',
          value,
        };
      }
    }
  }

  for (let memoryIndex = 0; memoryIndex < memories.length; memoryIndex++) {
    const memory = memories[memoryIndex];
    const status = invalidEnumValue(memory, 'status', MEMORY_STATUSES);
    if (status !== undefined) {
      return { collection: 'memories', index: memoryIndex, field: 'status', value: status };
    }
    const memoryKind = invalidEnumValue(memory, 'memory_kind', MEMORY_KINDS);
    if (memoryKind !== undefined) {
      return { collection: 'memories', index: memoryIndex, field: 'memory_kind', value: memoryKind };
    }
  }

  return undefined;
}

function asFlag(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = asNumber(v);
  return n && n !== 0 ? 1 : 0;
}

function jsonArrayString(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? JSON.stringify(parsed) : '[]';
    } catch {
      return '[]';
    }
  }
  return JSON.stringify(asArray<unknown>(value));
}

/**
 * 将 open_threads 字段规范化为 JSON 字符串。
 * 接受：JSON 字符串（DB 格式）、字符串数组（导出格式）、其他（返回 '[]'）。
 */
function jsonStringArray(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.filter(item => typeof item === 'string'));
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return JSON.stringify(parsed.filter(item => typeof item === 'string'));
      }
    } catch {
      // 非法 JSON，返回空数组
    }
  }
  return '[]';
}

/**
 * 从序列化后的 embedding_blob 还原 Buffer。
 * better-sqlite3 的 Buffer 在 JSON.stringify 后变成 { type: 'Buffer', data: [...] }。
 * 也接受 Buffer / Uint8Array / number[] 等格式。
 */
function bufferFromSerialized(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) {
    return value.length > 0 ? Buffer.from(value as number[]) : null;
  }
  if (value && typeof value === 'object' && value !== null) {
    const obj = value as { type?: string; data?: unknown };
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return Buffer.from(obj.data as number[]);
    }
  }
  return null;
}

function jsonRecordString(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      const record = asRecord(parsed);
      return record ? JSON.stringify(record) : '{}';
    } catch {
      return '{}';
    }
  }
  return JSON.stringify(asRecord(value) || {});
}

function remapSourceMessageIds(value: unknown, messageIdMap: Map<string, string>): string {
  const remapped = remapJsonStringIds(jsonArrayString(value), messageIdMap);
  try {
    const parsed = JSON.parse(remapped) as unknown;
    if (!Array.isArray(parsed)) return '[]';
    const importedMessageIds = new Set(messageIdMap.values());
    return JSON.stringify(parsed.filter(item => typeof item === 'string' && importedMessageIds.has(item)));
  } catch {
    return '[]';
  }
}

function includeParam(value: string | null): boolean {
  return value !== '0';
}

function getCharacterDraft(payload: ImportPayload): CharacterDraft | null {
  const draft = normalizeCharacterCard(payload);
  if (draft) return draft;

  const firstCharacter = asArray<Record<string, unknown>>(payload.characters)[0];
  return firstCharacter ? normalizeCharacterCard({ character: firstCharacter }) : null;
}

function getCharactersToImport(payload: ImportPayload, includeCharacter: boolean): Record<string, unknown>[] {
  if (!includeCharacter) return [];

  const normalizedCard = normalizeCharacterCard(payload);
  const singleCharacter = asRecord(payload.character);
  const characters = asArray<Record<string, unknown>>(payload.characters);

  if (characters.length > 0) return characters;
  if (singleCharacter) return [singleCharacter];
  return normalizedCard ? [normalizedCard as unknown as Record<string, unknown>] : [];
}

function createEmptyResults() {
  return {
    imported: 0,
    skipped: 0,
    memoriesImported: 0,
    conversationsImported: 0,
    conversationsSkipped: 0,
    messagesImported: 0,
    profilesImported: 0,
    profileVersionsImported: 0,
    embeddingsImported: 0,
    // 同名冲突重命名后的角色列表，便于前端提示用户「这些角色已重命名导入」。
    warnings: [] as { type: 'character_renamed'; originalName: string; newName: string }[],
  };
}

/**
 * POST /api/import  — 导入角色、记忆和对话
 * Body: JSON 文件内容（单角色或全量格式）
 * 策略：
 *   - 角色：按名称去重，已存在同名角色则跳过（不覆盖），记录 id 映射
 *   - 记忆：全量追加
 *   - 对话：导入时重建对话和消息 ID，避免和现有数据冲突
 */
// 导入文件体积上限：200MB。
// 合法的大库备份（多角色 + 长期对话 + 记忆）可能接近或超过 100MB；
// 200MB 在现代服务器内存下可安全解析，同时仍能挡住明显异常的请求。
const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  // 提前用 Content-Length 拒绝超大请求，避免先把整个 body 读进内存才发现超限。
  // 注：恶意 client 可能伪造 / 省略 Content-Length，因此这只是第一道闸门。
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > MAX_IMPORT_BYTES) {
    return NextResponse.json({ error: '导入文件过大' }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: '读取请求体失败' }, { status: 400 });
  }

  // 二次校验：即使缺失 Content-Length，也要在解析 JSON 前拦截超大 body。
  if (Buffer.byteLength(raw, 'utf8') > MAX_IMPORT_BYTES) {
    return NextResponse.json({ error: '导入文件过大' }, { status: 413 });
  }

  let payload: ImportPayload;
  try {
    payload = JSON.parse(raw) as ImportPayload;
  } catch {
    return NextResponse.json({ error: '无效的 JSON 格式' }, { status: 400 });
  }

  // ── 版本号校验 ──────────────────────────────────────────────
  // 拒绝读不懂的未来版本，避免新格式字段被旧代码忽略后写出半成品数据。
  // 没有 version 字段视为 v1 兼容，老导出文件继续可用。
  if (typeof payload.version === 'number' && payload.version > EXPORT_VERSION) {
    return NextResponse.json(
      {
        error: `导出文件版本（v${payload.version}）高于当前应用支持的版本（v${EXPORT_VERSION}），请升级应用后再导入`,
      },
      { status: 400 },
    );
  }

  const { searchParams } = request.nextUrl;
  const target_character_id = searchParams.get('target_character_id')?.trim() || '';
  const includeCharacter = includeParam(searchParams.get('include_character'));
  const includeMemories = includeParam(searchParams.get('include_memories'));
  const includeConversations = includeParam(searchParams.get('include_conversations'));
  const includeProfiles = includeParam(searchParams.get('include_profiles'));
  // embedding 默认不导入：与导出端对称，向量索引可重建且体积庞大。
  // 需要导入索引的用户可显式传 include_embeddings=1。
  const includeEmbeddings = includeMemories && searchParams.get('include_embeddings') === '1';
  const characterDraft = target_character_id && includeCharacter ? getCharacterDraft(payload) : null;

  const memoriesToImport: Record<string, unknown>[] = includeMemories
    ? asArray<Record<string, unknown>>(payload.memories)
    : [];
  const conversationsToImport: ConversationWithMessages[] = includeConversations
    ? asArray<ConversationWithMessages>(payload.conversations)
    : [];
  const charactersToImport: Record<string, unknown>[] = target_character_id
    ? []
    : getCharactersToImport(payload, includeCharacter);

  // 画像：单角色格式是单个对象（memory_profile），全量格式是数组（memory_profiles）。
  // 统一收集成数组，导入时按 character_id 重映射。
  const profilesToImport: Record<string, unknown>[] = includeProfiles
    ? [
        ...asArray<Record<string, unknown>>(payload.memory_profiles),
        ...(payload.memory_profile ? [payload.memory_profile] : []),
      ]
    : [];
  const profileVersionsToImport: Record<string, unknown>[] = includeProfiles
    ? asArray<Record<string, unknown>>(payload.memory_profile_versions)
    : [];
  const embeddingsToImport: Record<string, unknown>[] = includeEmbeddings
    ? asArray<Record<string, unknown>>(payload.memory_embeddings)
    : [];

  const enumValidationError = findImportEnumValidationError(conversationsToImport, memoriesToImport);
  if (enumValidationError) {
    return NextResponse.json(
      { error: '导入数据包含非法枚举值', ...enumValidationError },
      { status: 400 },
    );
  }

  if (
    target_character_id &&
    !characterDraft &&
    memoriesToImport.length === 0 &&
    conversationsToImport.length === 0 &&
    profilesToImport.length === 0 &&
    profileVersionsToImport.length === 0 &&
    embeddingsToImport.length === 0
  ) {
    return NextResponse.json({ error: '没有可导入的内容' }, { status: 400 });
  }

  const db = getDb();
  const findCharacterById = db.prepare('SELECT id FROM characters WHERE id = ?');
  const characterExists = (id: string) => Boolean(findCharacterById.get(id));
  if (target_character_id) {
    if (!characterExists(target_character_id)) {
      return NextResponse.json({ error: '目标角色不存在' }, { status: 404 });
    }
  }

  const results = importPayload({
    db,
    characterExists,
    charactersToImport,
    memoriesToImport,
    conversationsToImport,
    profilesToImport,
    profileVersionsToImport,
    embeddingsToImport,
    target_character_id,
  });

  return NextResponse.json({
    ok: true,
    ...results,
    ...(characterDraft ? { characterDraft } : {}),
  });
}

/**
 * 同名角色追加后缀，确保导入不会把不同来源的同名角色静默合并到同一目标。
 * 例：「艾莉丝」存在时，导入新角色会变成「艾莉丝（导入-1717000000000）」。
 */
function makeUniqueCharacterName(characterExistsByName: (name: string) => boolean, baseName: string): string {
  const safeBase = baseName || '导入角色';
  const candidate = `${safeBase}（导入-${Date.now()}）`;
  // 极端情况下时间戳碰撞，附加短随机串兜底
  if (!characterExistsByName(candidate)) return candidate;
  return `${candidate}-${Math.random().toString(36).slice(2, 6)}`;
}

function importPayload({
  db,
  characterExists,
  charactersToImport,
  memoriesToImport,
  conversationsToImport,
  profilesToImport,
  profileVersionsToImport,
  embeddingsToImport,
  target_character_id,
}: {
  db: ReturnType<typeof getDb>;
  characterExists: (id: string) => boolean;
  charactersToImport: Record<string, unknown>[];
  memoriesToImport: Record<string, unknown>[];
  conversationsToImport: ConversationWithMessages[];
  profilesToImport: Record<string, unknown>[];
  profileVersionsToImport: Record<string, unknown>[];
  embeddingsToImport: Record<string, unknown>[];
  target_character_id?: string;
}) {
  const now = new Date().toISOString();
  const results = createEmptyResults();
  const idMap = new Map<string, string>(); // 原 character id → 新 id
  const messageIdMap = new Map<string, string>(); // 原消息 id → 新消息 id
  const memoryIdMap = new Map<string, string>(); // 原记忆 id → 新记忆 id（embedding 导入需要）

  const findCharacterByName = db.prepare('SELECT id FROM characters WHERE name = ?');
  const characterExistsByName = (name: string) => Boolean(findCharacterByName.get(name));
  const insertCharacter = db.prepare(`
    INSERT INTO characters (id, name, avatar_url, basic_info, personality, scenario, greeting, example_dialogue, system_prompt, other_info, image_tags, user_image_tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertConversation = db.prepare(`
    INSERT INTO conversations (id, character_id, title, ignore_memory, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, metadata, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMemory = db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertProfile = db.prepare(`
    INSERT INTO character_memory_profiles (
      character_id, profile_name, relationship_state, recent_story_state,
      emotional_baseline, open_threads, user_profile_summary, pinned_summary, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      profile_name = excluded.profile_name,
      relationship_state = excluded.relationship_state,
      recent_story_state = excluded.recent_story_state,
      emotional_baseline = excluded.emotional_baseline,
      open_threads = excluded.open_threads,
      user_profile_summary = excluded.user_profile_summary,
      pinned_summary = excluded.pinned_summary,
      updated_at = excluded.updated_at
  `);
  const findProfileVersion = db.prepare(
    'SELECT id FROM character_memory_profile_versions WHERE character_id = ? AND version_number = ?',
  );
  const insertProfileVersion = db.prepare(`
    INSERT INTO character_memory_profile_versions (
      character_id, version_number, snapshot_json, reason, task_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const upsertEmbedding = db.prepare(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, error_message, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id, provider, model, dimension) DO UPDATE SET
      embedding_blob = excluded.embedding_blob,
      normalized = excluded.normalized,
      embedding_text_hash = excluded.embedding_text_hash,
      status = excluded.status,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at
  `);

  const importAll = db.transaction(() => {
    // ── 导入角色 ────────────────────────────────────────────────
    // 用 asString / asArray 替换原先的 `as string` 断言，确保即使输入 JSON
    // 把字段类型恶意改成对象 / 数字，也不会污染 SQLite 参数或导致运行时异常。
    for (const char of charactersToImport) {
      const charName = asString(char.name);
      const charId = asString(char.id);

      // 重要：原先「同名跳过 + 复用现有 id」会把不同来源的同名角色静默合并到同一目标，
      // 导致后续记忆 / 对话被错误地挂到不属于它们的角色上。
      // 现在改为：检测到同名时，给新导入的角色追加后缀创建独立记录，并在 warnings 里告知调用方。
      const existingByName = charName
        ? findCharacterByName.get(charName) as { id: string } | undefined
        : undefined;

      const finalName = existingByName
        ? makeUniqueCharacterName(characterExistsByName, charName)
        : (charName || '导入角色');

      if (existingByName) {
        results.warnings.push({
          type: 'character_renamed',
          originalName: charName,
          newName: finalName,
        });
      }

      const newId = crypto.randomUUID().slice(0, 12);
      if (charId) idMap.set(charId, newId);

      insertCharacter.run(
        newId,
        finalName,
        asString(char.avatar_url) || null,
        asString(char.basic_info),
        asString(char.personality),
        asString(char.scenario),
        asString(char.greeting),
        asString(char.example_dialogue),
        asString(char.system_prompt),
        asString(char.other_info),
        asString(char.image_tags),
        asString(char.user_image_tags),
        asString(char.created_at) || now,
        now,
      );
      results.imported++;
    }

    // ── 导入对话和消息 ──────────────────────────────────────────
    for (const conv of conversationsToImport) {
      // 解析 character_id：优先用 idMap 映射后的新 id
      const convCharId = asString(conv.character_id);
      const newCharId = target_character_id || idMap.get(convCharId) || convCharId;

      // 确认角色存在
      if (!characterExists(newCharId)) {
        results.conversationsSkipped++;
        continue;
      }

      const newConvId = crypto.randomUUID().slice(0, 12);

      insertConversation.run(
        newConvId,
        newCharId,
        asString(conv.title) || '导入的对话',
        asFlag(conv.ignore_memory),
        asString(conv.created_at) || now,
        asString(conv.updated_at) || now,
      );
      results.conversationsImported++;

      // 导入该对话的消息
      const messages = asArray<Record<string, unknown>>(conv.messages);
      let fallbackSeq = 1;
      for (const msg of messages) {
        const newMsgId = crypto.randomUUID().slice(0, 12);
        const originalMsgId = asString(msg.id);
        if (originalMsgId) messageIdMap.set(originalMsgId, newMsgId);

        // 导入包属于外部信任边界：不复用其中的 token_count/provenance，按当前
        // 服务端算法和实际 content/attachments 重新生成可信计数。
        const role = (asString(msg.role) || 'user') as (typeof MESSAGE_ROLES)[number];
        const content = asString(msg.content);
        const metadata = parseMessageMetadata(msg.metadata);
        const tokenResult = createMessageTokenCount(content, role, metadata.attachments);
        const metaStr = JSON.stringify(metadataWithTokenCountProvenance(metadata, tokenResult.provenance));

        insertMessage.run(
          newMsgId,
          newConvId,
          role,
          content,
          tokenResult.tokenCount,
          asString(msg.created_at) || now,
          metaStr,
          asNumber(msg.seq) ?? fallbackSeq++,
        );
        results.messagesImported++;
      }
    }

    // ── 导入记忆 ────────────────────────────────────────────────
    // 同时建立 memoryIdMap，供后续 embedding 导入关联新记忆 id。
    for (const mem of memoriesToImport) {
      const originalCharId = asString(mem.character_id);
      const newCharId = target_character_id || idMap.get(originalCharId) || originalCharId;

      if (!characterExists(newCharId)) continue;

      const newMemId = crypto.randomUUID().slice(0, 12);
      const originalMemId = asString(mem.id);
      if (originalMemId) memoryIdMap.set(originalMemId, newMemId);

      const category = normalizeMemoryCategory(asString(mem.category) || '话题历史');
      const defaults = inferMemoryDefaults(category);
      insertMemory.run(
        newMemId,
        newCharId,
        category,
        asString(mem.content),
        asNumber(mem.confidence) ?? 0.8,
        jsonArrayString(mem.tags),
        remapSourceMessageIds(mem.source_msg_ids, messageIdMap),
        asString(mem.memory_kind) || defaults.memory_kind,
        asNumber(mem.importance) ?? defaults.importance,
        asNumber(mem.emotional_weight) ?? defaults.emotional_weight,
        asString(mem.status) || 'active',
        asFlag(mem.pinned),
        asString(mem.last_used_at) || null,
        asNumber(mem.usage_count) ?? 0,
        jsonRecordString(mem.metadata),
        asString(mem.created_at) || now,
        now,
      );
      results.memoriesImported++;
    }

    // ── 导入记忆画像 ────────────────────────────────────────────
    // 画像跟角色绑定，character_id 重映射到新 id。
    // open_threads 在 DB 里是 JSON 字符串，导出时保持字符串形式，这里直接透传。
    for (const profile of profilesToImport) {
      const originalCharId = asString(profile.character_id);
      const newCharId = target_character_id || idMap.get(originalCharId) || originalCharId;

      if (!characterExists(newCharId)) continue;

      // 用 UPSERT 避免重复导入时主键冲突
      upsertProfile.run(
        newCharId,
        asString(profile.profile_name),
        asString(profile.relationship_state),
        asString(profile.recent_story_state),
        asString(profile.emotional_baseline),
        // open_threads 必须是合法 JSON 字符串，否则导入后读取会报错
        jsonStringArray(profile.open_threads),
        asString(profile.user_profile_summary),
        asString(profile.pinned_summary),
        asString(profile.updated_at) || now,
      );
      results.profilesImported++;
    }

    // ── 导入画像版本历史 ────────────────────────────────────────
    // 版本历史跟角色绑定，character_id 重映射。
    // snapshot_json 是画像快照的 JSON 字符串，直接透传。
    // version_number 用原值，避免历史版本号断裂；导入后若与现有版本号冲突则跳过。
    for (const version of profileVersionsToImport) {
      const originalCharId = asString(version.character_id);
      const newCharId = target_character_id || idMap.get(originalCharId) || originalCharId;

      if (!characterExists(newCharId)) continue;

      const versionNumber = asNumber(version.version_number);
      if (versionNumber === undefined) continue;

      // 检查是否已存在同版本号，避免重复导入
      const existing = findProfileVersion.get(newCharId, versionNumber);
      if (existing) continue;

      insertProfileVersion.run(
        newCharId,
        versionNumber,
        asString(version.snapshot_json) || '{}',
        asString(version.reason) || 'imported',
        asNumber(version.task_id) ?? null,
        asString(version.created_at) || now,
      );
      results.profileVersionsImported++;
    }

    // ── 导入记忆向量索引 ────────────────────────────────────────
    // embedding 跟记忆绑定，memory_id 必须能映射到新记忆 id，否则跳过（孤儿向量）。
    // embedding_blob 在导出时是 { type: 'Buffer', data: [...] } 对象，用 Buffer.from() 还原。
    for (const embedding of embeddingsToImport) {
      const originalMemId = asString(embedding.memory_id);
      const newMemId = memoryIdMap.get(originalMemId);
      if (!newMemId) continue; // 记忆没导入或没映射，跳过

      const originalCharId = asString(embedding.character_id);
      const newCharId = target_character_id || idMap.get(originalCharId) || originalCharId;

      if (!characterExists(newCharId)) continue;

      const embeddingBlob = bufferFromSerialized(embedding.embedding_blob);
      if (!embeddingBlob) continue;

      // 用 UPSERT 避免重复导入时唯一索引冲突
      upsertEmbedding.run(
        newMemId,
        newCharId,
        asString(embedding.provider) || 'openai-compatible',
        asString(embedding.model) || 'unknown',
        asNumber(embedding.dimension) ?? 0,
        embeddingBlob,
        asFlag(embedding.normalized) || 1,
        asString(embedding.embedding_text_hash) || '',
        asString(embedding.status) || 'ready',
        asString(embedding.error_message) || null,
        asString(embedding.created_at) || now,
        asString(embedding.updated_at) || now,
      );
      results.embeddingsImported++;
    }
  });

  importAll();

  return results;
}
