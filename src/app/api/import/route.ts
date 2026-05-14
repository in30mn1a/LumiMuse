import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeMemoryCategory } from '@/lib/memory-category';
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
 * POST /api/import  — 导入角色、记忆和对话
 * Body: JSON 文件内容（单角色或全量格式）
 * 策略：
 *   - 角色：按名称去重，已存在同名角色则跳过（不覆盖），记录 id 映射
 *   - 记忆：全量追加
 *   - 对话：按 id 去重，已存在则跳过；消息同理
 */
export async function POST(request: NextRequest) {
  let payload: ImportPayload;
  try {
    payload = await request.json() as ImportPayload;
  } catch {
    return NextResponse.json({ error: '无效的 JSON 格式' }, { status: 400 });
  }

  const db = getDb();
  const now = new Date().toISOString();
  const results = {
    imported: 0,
    skipped: 0,
    memoriesImported: 0,
    conversationsImported: 0,
    conversationsSkipped: 0,
    messagesImported: 0,
  };

  // 统一成数组处理
  const charactersToImport: Record<string, unknown>[] = payload.characters
    ?? (payload.character ? [payload.character] : []);
  const memoriesToImport: Record<string, unknown>[] = payload.memories ?? [];
  const conversationsToImport: ConversationWithMessages[] = payload.conversations ?? [];

  // ── 导入角色 ────────────────────────────────────────────────
  const idMap = new Map<string, string>(); // 原 id → 新 id

  for (const char of charactersToImport) {
    const existingByName = db.prepare('SELECT id FROM characters WHERE name = ?').get(char.name as string) as { id: string } | undefined;

    if (existingByName) {
      idMap.set(char.id as string, existingByName.id);
      results.skipped++;
      continue;
    }

    const newId = uuidv4().slice(0, 8);
    idMap.set(char.id as string, newId);

    db.prepare(`
      INSERT INTO characters (id, name, avatar_url, personality, scenario, greeting, example_dialogue, system_prompt, image_tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId,
      char.name || '导入角色',
      char.avatar_url || null,
      char.personality || '',
      char.scenario || '',
      char.greeting || '',
      char.example_dialogue || '',
      char.system_prompt || '',
      char.image_tags || '',
      char.created_at || now,
      now,
    );
    results.imported++;
  }

  // ── 导入记忆 ────────────────────────────────────────────────
  for (const mem of memoriesToImport) {
    const originalCharId = mem.character_id as string;
    const newCharId = idMap.get(originalCharId) ?? originalCharId;

    const charExists = db.prepare('SELECT id FROM characters WHERE id = ?').get(newCharId);
    if (!charExists) continue;

    const newMemId = uuidv4().slice(0, 8);
    db.prepare(`
      INSERT INTO memories (id, character_id, category, content, confidence, tags, source_msg_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)
    `).run(
      newMemId,
      newCharId,
      normalizeMemoryCategory(String(mem.category || '话题历史')),
      mem.content || '',
      typeof mem.confidence === 'number' ? mem.confidence : 0.8,
      JSON.stringify(Array.isArray(mem.tags) ? mem.tags : []),
      mem.created_at || now,
      now,
    );
    results.memoriesImported++;
  }

  // ── 导入对话和消息 ──────────────────────────────────────────
  const importConversations = db.transaction((convs: ConversationWithMessages[]) => {
    for (const conv of convs) {
      // 解析 character_id：优先用 idMap 映射后的新 id
      const newCharId = idMap.get(conv.character_id) ?? conv.character_id;

      // 确认角色存在
      const charExists = db.prepare('SELECT id FROM characters WHERE id = ?').get(newCharId);
      if (!charExists) continue;

      // 对话按 id 去重（同一份备份重复导入时跳过）
      const convExists = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conv.id);
      if (convExists) {
        results.conversationsSkipped++;
        continue;
      }

      db.prepare(`
        INSERT INTO conversations (id, character_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        conv.id,
        newCharId,
        conv.title || '导入的对话',
        conv.created_at || now,
        conv.updated_at || now,
      );
      results.conversationsImported++;

      // 导入该对话的消息
      const messages = conv.messages ?? [];
      let seq = 1;
      for (const msg of messages) {
        const msgExists = db.prepare('SELECT id FROM messages WHERE id = ?').get(msg.id as string);
        if (msgExists) continue;

        // metadata 可能是对象或字符串，统一序列化为字符串存储
        const metaStr = typeof msg.metadata === 'string'
          ? msg.metadata
          : JSON.stringify(msg.metadata ?? {});

        db.prepare(`
          INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, metadata, seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          msg.id,
          conv.id,
          msg.role,
          msg.content,
          typeof msg.token_count === 'number' ? msg.token_count : 0,
          msg.created_at || now,
          metaStr,
          seq++,
        );
        results.messagesImported++;
      }
    }
  });

  importConversations(conversationsToImport);

  return NextResponse.json({ ok: true, ...results });
}
