import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Character } from '@/types';
import {
  collectCharacterLocalAssetUrls,
  deleteLocalAssetUrls,
  filterUnreferencedLocalAssetUrls,
} from '@/lib/character-file-utils';
import { presentCharacter, serializePromptMap, serializeReasoningMap } from '@/lib/character-task-models';
import { characterUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';
import {
  attachCharacterPresetBindings,
  findMissingBindingPresetId,
  PRESET_ID_NONE,
  replaceCharacterModelPresetBindings,
} from '@/lib/prompt-presets';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as { id: string } | undefined;
  if (!character) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(presentCharacter(attachCharacterPresetBindings(character) as Record<string, unknown>));
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = characterUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as Character | undefined;
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (body.model_preset_bindings !== undefined) {
    const missingPresetId = findMissingBindingPresetId(body.model_preset_bindings);
    if (missingPresetId) {
      return NextResponse.json(
        { error: 'Invalid request body', fieldErrors: { model_preset_bindings: `preset not found: ${missingPresetId}` } },
        { status: 400 },
      );
    }
  }

  // 同毫秒内保存也必须区别于创建时间，条件清理不能把已保存角色当空白草稿。
  const now = new Date(Math.max(Date.now(), Date.parse(existing.updated_at) + 1)).toISOString();
  const saveCharacter = db.transaction(() => {
    db.prepare(`
      UPDATE characters SET
        name = ?, avatar_url = ?, basic_info = ?, personality = ?, scenario = ?,
        greeting = ?, example_dialogue = ?, system_prompt = ?, other_info = ?, image_tags = ?, user_image_tags = ?,
        active_preset_id = ?, memory_chat_injection_mode = ?,
        background_model = ?, image_prompt_model = ?, background_provider_id = ?,
        background_reasoning_by_model = ?, image_prompt_reasoning_by_model = ?,
        background_system_prompt_by_model = ?, image_prompt_system_prompt_by_model = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      body.name ?? existing.name,
      body.avatar_url ?? existing.avatar_url,
      body.basic_info ?? existing.basic_info ?? '',
      body.personality ?? existing.personality,
      body.scenario ?? existing.scenario,
      body.greeting ?? existing.greeting,
      body.example_dialogue ?? existing.example_dialogue,
      body.system_prompt ?? existing.system_prompt,
      body.other_info ?? existing.other_info ?? '',
      body.image_tags ?? existing.image_tags ?? '',
      body.user_image_tags ?? existing.user_image_tags ?? '',
      // 预设绑定：未传 active_preset_id 时保留旧值；显式 null/''/'__none__' 表示不使用预设
      body.active_preset_id !== undefined
        ? (body.active_preset_id === null || body.active_preset_id === '' ? null : body.active_preset_id)
        : ((existing as Character & { active_preset_id?: string | null }).active_preset_id ?? null),
      body.memory_chat_injection_mode ?? existing.memory_chat_injection_mode ?? 'full',
      body.background_model !== undefined ? body.background_model : (existing.background_model ?? ''),
      body.image_prompt_model !== undefined ? body.image_prompt_model : (existing.image_prompt_model ?? ''),
      body.background_provider_id !== undefined ? body.background_provider_id : (existing.background_provider_id ?? ''),
      body.background_reasoning_by_model !== undefined
        ? serializeReasoningMap(body.background_reasoning_by_model)
        : serializeReasoningMap(existing.background_reasoning_by_model),
      body.image_prompt_reasoning_by_model !== undefined
        ? serializeReasoningMap(body.image_prompt_reasoning_by_model)
        : serializeReasoningMap(existing.image_prompt_reasoning_by_model),
      body.background_system_prompt_by_model !== undefined
        ? serializePromptMap(body.background_system_prompt_by_model)
        : serializePromptMap(existing.background_system_prompt_by_model),
      body.image_prompt_system_prompt_by_model !== undefined
        ? serializePromptMap(body.image_prompt_system_prompt_by_model)
        : serializePromptMap(existing.image_prompt_system_prompt_by_model),
      now,
      id,
    );

    if (body.model_preset_bindings !== undefined) {
      replaceCharacterModelPresetBindings(id, body.model_preset_bindings);
    }
  });
  saveCharacter();

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as { id: string };
  return NextResponse.json(presentCharacter(attachCharacterPresetBindings(updated) as Record<string, unknown>));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const cleanupCreatedAt = request.headers?.get('X-Character-Cleanup');
  const fileUrls = collectCharacterLocalAssetUrls(db, id);

  const deleteCharacter = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return 0;

    if (cleanupCreatedAt !== null && cleanupCreatedAt !== undefined) {
      const emptyFields = [
        'avatar_url', 'basic_info', 'personality', 'scenario', 'greeting', 'example_dialogue',
        'system_prompt', 'other_info', 'image_tags', 'user_image_tags',
        'background_model', 'image_prompt_model', 'background_provider_id',
      ];
      const mapFields = [
        'background_reasoning_by_model', 'image_prompt_reasoning_by_model',
        'background_system_prompt_by_model', 'image_prompt_system_prompt_by_model',
      ];
      if (!cleanupCreatedAt || existing.created_at !== cleanupCreatedAt
        || existing.updated_at !== existing.created_at
        || emptyFields.some(field => existing[field] !== '' && existing[field] !== null)
        || mapFields.some(field => existing[field] !== '{}')
        || existing.active_preset_id !== PRESET_ID_NONE
        || existing.memory_chat_injection_mode !== 'full') return -1;

      // 在同一事务内检查全部角色关联表；未来新增关联数据也默认保留而非误删。
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
      for (const { name } of tables) {
        const quotedName = `"${name.replaceAll('"', '""')}"`;
        const columns = db.prepare(`PRAGMA table_info(${quotedName})`).all() as Array<{ name: string }>;
        if (columns.some(column => column.name === 'character_id')
          && db.prepare(`SELECT 1 FROM ${quotedName} WHERE character_id = ? LIMIT 1`).get(id)) return -1;
      }
    }

    // 级联删除：记忆任务、消息、对话、记忆、画像、向量索引
    // 注：这些表大多有 ON DELETE CASCADE 外键，理论上删 characters 行会自动级联。
    // 但显式删除更安全：避免未来某处临时关掉 foreign_keys 时留下孤儿数据，
    // 也让删除顺序清晰可控（先删依赖项，最后删 characters）。
    db.prepare('DELETE FROM memory_tasks WHERE character_id = ? OR conversation_id IN (SELECT id FROM conversations WHERE character_id = ?)').run(id, id);
    db.prepare('DELETE FROM memory_embedding_tasks WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM memory_embeddings WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM memory_extraction_candidates WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM character_memory_profile_update_tasks WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM character_memory_profile_versions WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM character_memory_profiles WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE character_id = ?)').run(id);
    db.prepare('DELETE FROM conversations WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM memories WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM character_model_preset_bindings WHERE character_id = ?').run(id);
    const result = db.prepare('DELETE FROM characters WHERE id = ?').run(id);
    return result.changes;
  });

  const changes = deleteCharacter();
  if (changes === -1) return NextResponse.json({ ok: true, deleted: false });
  if (changes === 0 && cleanupCreatedAt !== null && cleanupCreatedAt !== undefined) {
    return NextResponse.json({ ok: true, deleted: false });
  }
  if (changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const orphanUrls = filterUnreferencedLocalAssetUrls(db, fileUrls);
  const deletedUrls = await deleteLocalAssetUrls(orphanUrls);
  return NextResponse.json({ ok: true, ...(cleanupCreatedAt !== null && cleanupCreatedAt !== undefined ? { deleted: true } : {}), deletedUrls });
}
