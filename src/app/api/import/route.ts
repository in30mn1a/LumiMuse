import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeMemoryCategory } from '@/lib/memory-category';
import { normalizeCharacterCard, type CharacterDraft } from '@/lib/character-card-import';
import { EXPORT_VERSION } from '@/lib/export-version';
import { v4 as uuidv4 } from 'uuid';

interface ImportPayload {
  version?: number;
  // 单角色导出格式
  character?: Record<string, unknown>;
  memories?: Record<string, unknown>[];
  conversations?: ConversationWithMessages[];
  // 全量导出格式
  characters?: Record<string, unknown>[];
}

interface ConversationWithMessages {
  id: string;
  character_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages?: Record<string, unknown>[];
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
export async function POST(request: NextRequest) {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: '读取请求体失败' }, { status: 400 });
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

  if (target_character_id && !characterDraft && memoriesToImport.length === 0 && conversationsToImport.length === 0) {
    return NextResponse.json({ error: '没有可导入的内容' }, { status: 400 });
  }

  const db = getDb();
  if (target_character_id) {
    const targetExists = db.prepare('SELECT id FROM characters WHERE id = ?').get(target_character_id);
    if (!targetExists) return NextResponse.json({ error: '目标角色不存在' }, { status: 404 });
  }

  const results = importPayload({
    charactersToImport,
    memoriesToImport,
    conversationsToImport,
    target_character_id,
  });

  return NextResponse.json({
    ok: true,
    ...results,
    ...(characterDraft ? { characterDraft } : {}),
  });
}

function importPayload({
  charactersToImport,
  memoriesToImport,
  conversationsToImport,
  target_character_id,
}: {
  charactersToImport: Record<string, unknown>[];
  memoriesToImport: Record<string, unknown>[];
  conversationsToImport: ConversationWithMessages[];
  target_character_id?: string;
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const results = createEmptyResults();
  const idMap = new Map<string, string>(); // 原 id → 新 id

  const importAll = db.transaction(() => {
    // ── 导入角色 ────────────────────────────────────────────────
    // 用 asString / asArray 替换原先的 `as string` 断言，确保即使输入 JSON
    // 把字段类型恶意改成对象 / 数字，也不会污染 SQLite 参数或导致运行时异常。
    for (const char of charactersToImport) {
      const charName = asString(char.name);
      const charId = asString(char.id);

      const existingByName = charName
        ? db.prepare('SELECT id FROM characters WHERE name = ?').get(charName) as { id: string } | undefined
        : undefined;

      if (existingByName) {
        if (charId) idMap.set(charId, existingByName.id);
        results.skipped++;
        continue;
      }

      const newId = uuidv4().slice(0, 8);
      if (charId) idMap.set(charId, newId);

      db.prepare(`
        INSERT INTO characters (id, name, avatar_url, basic_info, personality, scenario, greeting, example_dialogue, system_prompt, other_info, image_tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId,
        charName || '导入角色',
        asString(char.avatar_url) || null,
        asString(char.basic_info),
        asString(char.personality),
        asString(char.scenario),
        asString(char.greeting),
        asString(char.example_dialogue),
        asString(char.system_prompt),
        asString(char.other_info),
        asString(char.image_tags),
        asString(char.created_at) || now,
        now,
      );
      results.imported++;
    }

    // ── 导入记忆 ────────────────────────────────────────────────
    for (const mem of memoriesToImport) {
      const originalCharId = asString(mem.character_id);
      const newCharId = target_character_id || idMap.get(originalCharId) || originalCharId;

      const charExists = db.prepare('SELECT id FROM characters WHERE id = ?').get(newCharId);
      if (!charExists) continue;

      const newMemId = uuidv4().slice(0, 8);
      db.prepare(`
        INSERT INTO memories (id, character_id, category, content, confidence, tags, source_msg_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)
      `).run(
        newMemId,
        newCharId,
        normalizeMemoryCategory(asString(mem.category) || '话题历史'),
        asString(mem.content),
        typeof mem.confidence === 'number' ? mem.confidence : 0.8,
        JSON.stringify(asArray<unknown>(mem.tags)),
        asString(mem.created_at) || now,
        now,
      );
      results.memoriesImported++;
    }

    // ── 导入对话和消息 ──────────────────────────────────────────
    for (const conv of conversationsToImport) {
      // 解析 character_id：优先用 idMap 映射后的新 id
      const convCharId = asString(conv.character_id);
      const newCharId = target_character_id || idMap.get(convCharId) || convCharId;

      // 确认角色存在
      const charExists = db.prepare('SELECT id FROM characters WHERE id = ?').get(newCharId);
      if (!charExists) {
        results.conversationsSkipped++;
        continue;
      }

      const newConvId = uuidv4().slice(0, 8);

      db.prepare(`
        INSERT INTO conversations (id, character_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        newConvId,
        newCharId,
        asString(conv.title) || '导入的对话',
        asString(conv.created_at) || now,
        asString(conv.updated_at) || now,
      );
      results.conversationsImported++;

      // 导入该对话的消息
      const messages = asArray<Record<string, unknown>>(conv.messages);
      let seq = 1;
      for (const msg of messages) {
        const newMsgId = uuidv4().slice(0, 8);

        // metadata 可能是对象或字符串，统一序列化为字符串存储
        const metaStr = typeof msg.metadata === 'string'
          ? msg.metadata
          : JSON.stringify(msg.metadata ?? {});

        db.prepare(`
          INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, metadata, seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newMsgId,
          newConvId,
          asString(msg.role),
          asString(msg.content),
          typeof msg.token_count === 'number' ? msg.token_count : 0,
          asString(msg.created_at) || now,
          metaStr,
          seq++,
        );
        results.messagesImported++;
      }
    }
  });

  importAll();

  return results;
}
