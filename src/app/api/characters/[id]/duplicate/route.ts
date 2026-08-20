import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getDb } from '@/lib/db';
import type { Character, Message } from '@/types';
import {
  collectLocalAssetUrlsFromContent,
  copyLocalAssetUrl,
  deleteLocalAssetUrls,
  duplicateCharacterFilesInMetadata,
} from '@/lib/character-file-utils';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';
import { parseMessageMetadata } from '@/lib/messages';
import {
  createMessageTokenCount,
  metadataWithTokenCountProvenance,
} from '@/lib/message-token-provenance';

type ConversationRow = {
  id: string;
  character_id: string;
  title: string;
  ignore_memory?: number;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: Message['role'];
  content: string;
  token_count: number;
  created_at: string;
  seq: number;
  metadata: string;
};

type MemoryRow = {
  id: string;
  character_id: string;
  category: string;
  content: string;
  confidence: number;
  tags: string;
  source_msg_ids: string;
  memory_kind: string;
  importance: number;
  emotional_weight: number;
  status: string;
  pinned: number;
  last_used_at: string | null;
  usage_count: number;
  metadata: string;
  created_at: string;
  updated_at: string;
};

type MemoryEmbeddingRow = {
  memory_id: string;
  character_id: string;
  provider: string;
  model: string;
  dimension: number;
  embedding_blob: Buffer;
  normalized: number;
  embedding_text_hash: string;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type MemoryProfileRow = {
  character_id: string;
  profile_name: string;
  relationship_state: string;
  recent_story_state: string;
  emotional_baseline: string;
  open_threads: string;
  user_profile_summary: string;
  pinned_summary: string;
  updated_at: string;
};

type MemoryProfileVersionRow = {
  id: number;
  character_id: string;
  version_number: number;
  snapshot_json: string;
  reason: string;
  task_id: number | null;
  created_at: string;
};

type CharacterMemoryConfigRow = {
  character_id: string;
  enabled: number | null;
  memory_package_token_budget: number | null;
  profile_token_budget: number | null;
  pinned_token_budget: number | null;
  open_threads_token_budget: number | null;
  retrieval_token_budget: number | null;
  memory_max_inject_override: number | null;
  vector_enabled_override: number | null;
  reranker_enabled_override: number | null;
  vector_top_k_override: number | null;
  reranker_top_k_override: number | null;
  embedding_model_override: string | null;
  reranker_model_override: string | null;
  updated_at: string;
};

type TextRange = {
  start: number;
  end: number;
};

function collectExternalUrlRanges(content: string): TextRange[] {
  const ranges: TextRange[] = [];
  const pattern = /(?:(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/|www\.)[^\s<>"'`]+/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function isInsideRange(index: number, ranges: readonly TextRange[]): boolean {
  return ranges.some(range => index >= range.start && index < range.end);
}

function replaceLocalOccurrences(content: string, url: string, replacement: string): string {
  const externalRanges = collectExternalUrlRanges(content);
  let cursor = 0;
  let copiedUntil = 0;
  let result = '';

  while (cursor < content.length) {
    const index = content.indexOf(url, cursor);
    if (index < 0) break;
    result += content.slice(copiedUntil, index);
    result += isInsideRange(index, externalRanges) ? url : replacement;
    copiedUntil = index + url.length;
    cursor = copiedUntil;
  }

  return copiedUntil === 0 ? content : result + content.slice(copiedUntil);
}

async function duplicateCharacterFilesInContent(
  content: string,
  copiedUrls: Map<string, string>,
  generatedCharacterId: string,
): Promise<string> {
  let duplicated = content;
  for (const url of collectLocalAssetUrlsFromContent(content)) {
    // 同一路径可能既独立出现，又出现在完整外链的 path/query 中；只复制并
    // 重写独立本地 URL 的出现位置，外链中的同名子串保持原样。
    const copied = await copyLocalAssetUrl(url, copiedUrls, { generatedCharacterId });
    if (typeof copied === 'string' && copied !== url) {
      duplicated = replaceLocalOccurrences(duplicated, url, copied);
    }
  }
  return duplicated;
}

function remapNestedIds(
  value: unknown,
  messageIdMap: ReadonlyMap<string, string>,
  memoryIdMap: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === 'string') {
    return messageIdMap.get(value) ?? memoryIdMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(item => remapNestedIds(item, messageIdMap, memoryIdMap));
  }
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const remappedKey = messageIdMap.get(key) ?? memoryIdMap.get(key) ?? key;
    result[remappedKey] = remapNestedIds(item, messageIdMap, memoryIdMap);
  }
  return result;
}

function remapJsonIds(
  value: string,
  messageIdMap: ReadonlyMap<string, string>,
  memoryIdMap: ReadonlyMap<string, string>,
): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return JSON.stringify(remapNestedIds(parsed, messageIdMap, memoryIdMap));
  } catch {
    return value;
  }
}

function remapProfileSnapshotCharacterId(snapshotJson: string, characterId: string): string {
  try {
    const parsed = JSON.parse(snapshotJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return snapshotJson;
    return JSON.stringify({
      ...(parsed as Record<string, unknown>),
      character_id: characterId,
    });
  } catch {
    return snapshotJson;
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const original = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as Character | undefined;

  if (!original) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const copiedUrls = new Map<string, string>();
  const now = new Date().toISOString();
  const newCharacterId = crypto.randomUUID().slice(0, 12);
  const newName = `${original.name}（副本）`;
  const fileCopyOptions = { generatedCharacterId: newCharacterId };
  let committed = false;
  let indexingQueued = 0;

  try {
    const conversations = db.prepare(
      'SELECT * FROM conversations WHERE character_id = ? ORDER BY created_at ASC, updated_at ASC'
    ).all(id) as ConversationRow[];

    const messagesByConversation = new Map<string, MessageRow[]>();
    if (conversations.length > 0) {
      const conversationIds = conversations.map(conversation => conversation.id);
      const placeholders = conversationIds.map(() => '?').join(', ');
      const allMessages = db.prepare(
        `SELECT * FROM messages WHERE conversation_id IN (${placeholders}) ORDER BY created_at ASC, seq ASC`
      ).all(...conversationIds) as MessageRow[];
      for (const conversation of conversations) {
        messagesByConversation.set(conversation.id, []);
      }
      for (const message of allMessages) {
        messagesByConversation.get(message.conversation_id)?.push(message);
      }
    }

    const memories = db.prepare(
      'SELECT * FROM memories WHERE character_id = ? ORDER BY created_at ASC, updated_at ASC'
    ).all(id) as MemoryRow[];
    const embeddings = db.prepare(`
      SELECT * FROM memory_embeddings
      WHERE character_id = ? AND status = 'ready'
      ORDER BY memory_id, provider, model, dimension
    `).all(id) as MemoryEmbeddingRow[];
    const profile = db.prepare(
      'SELECT * FROM character_memory_profiles WHERE character_id = ?'
    ).get(id) as MemoryProfileRow | undefined;
    const profileVersions = db.prepare(`
      SELECT * FROM character_memory_profile_versions
      WHERE character_id = ?
      ORDER BY version_number ASC, id ASC
    `).all(id) as MemoryProfileVersionRow[];
    const memoryConfig = db.prepare(
      'SELECT * FROM character_memory_configs WHERE character_id = ?'
    ).get(id) as CharacterMemoryConfigRow | undefined;
    const modelPresetBindings = db.prepare(
      `SELECT model, preset_id, sort_order
       FROM character_model_preset_bindings
       WHERE character_id = ?
       ORDER BY sort_order ASC, model ASC`,
    ).all(id) as Array<{ model: string; preset_id: string; sort_order: number }>;

    const preparedConversations = conversations.map(conversation => ({
      originalId: conversation.id,
      newId: crypto.randomUUID().slice(0, 12),
      title: conversation.title,
      ignoreMemory: conversation.ignore_memory ? 1 : 0,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
    }));

    const newMessageIdMap = new Map<string, string>();
    for (const conversation of preparedConversations) {
      for (const message of messagesByConversation.get(conversation.originalId) || []) {
        newMessageIdMap.set(message.id, crypto.randomUUID().slice(0, 12));
      }
    }
    const newMemoryIdMap = new Map(
      memories.map(memory => [memory.id, crypto.randomUUID().slice(0, 12)]),
    );

    const newAvatarUrl = await copyLocalAssetUrl(
      original.avatar_url,
      copiedUrls,
      fileCopyOptions,
    ) as string | null;

    const preparedMessages: Array<{
      id: string;
      conversationId: string;
      role: Message['role'];
      content: string;
      tokenCount: number;
      createdAt: string;
      seq: number;
      metadata: string;
    }> = [];
    for (const conversation of preparedConversations) {
      const messages = messagesByConversation.get(conversation.originalId) || [];
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const duplicatedMetadata = await duplicateCharacterFilesInMetadata(
          message.metadata,
          copiedUrls,
          fileCopyOptions,
        );
        const duplicatedContent = await duplicateCharacterFilesInContent(
          message.content,
          copiedUrls,
          newCharacterId,
        );
        const remappedMetadata = parseMessageMetadata(
          remapJsonIds(duplicatedMetadata, newMessageIdMap, newMemoryIdMap),
        );
        const tokenResult = createMessageTokenCount(
          duplicatedContent,
          message.role,
          Array.isArray(remappedMetadata.attachments) ? remappedMetadata.attachments : undefined,
        );
        preparedMessages.push({
          id: newMessageIdMap.get(message.id) as string,
          conversationId: conversation.newId,
          role: message.role,
          content: duplicatedContent,
          tokenCount: tokenResult.tokenCount,
          createdAt: message.created_at,
          seq: index + 1,
          metadata: JSON.stringify(
            metadataWithTokenCountProvenance(remappedMetadata, tokenResult.provenance),
          ),
        });
      }
    }

    const preparedMemories = memories.map(memory => ({
      ...memory,
      id: newMemoryIdMap.get(memory.id) as string,
      source_msg_ids: remapJsonIds(memory.source_msg_ids, newMessageIdMap, newMemoryIdMap),
      metadata: remapJsonIds(memory.metadata, newMessageIdMap, newMemoryIdMap),
    }));
    const preparedEmbeddings = embeddings.flatMap(embedding => {
      const memoryId = newMemoryIdMap.get(embedding.memory_id);
      return memoryId ? [{ ...embedding, memory_id: memoryId }] : [];
    });
    const memoryIdsWithReadyEmbeddings = new Set(
      preparedEmbeddings.map(embedding => embedding.memory_id),
    );
    const memoryIdsNeedingFreshIndexWork = preparedMemories
      .filter(memory => memory.status === 'active' && !memoryIdsWithReadyEmbeddings.has(memory.id))
      .map(memory => memory.id);

    const copyAll = db.transaction(() => {
      db.prepare(`
        INSERT INTO characters (
          id, name, avatar_url, basic_info, personality, scenario, greeting,
          example_dialogue, system_prompt, other_info, image_tags, user_image_tags,
          active_preset_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newCharacterId,
        newName,
        newAvatarUrl,
        original.basic_info || '',
        original.personality,
        original.scenario,
        original.greeting,
        original.example_dialogue,
        original.system_prompt,
        original.other_info || '',
        original.image_tags || '',
        original.user_image_tags || '',
        original.active_preset_id ?? null,
        now,
        now,
      );

      const insertConversation = db.prepare(`
        INSERT INTO conversations (id, character_id, title, ignore_memory, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const conversation of preparedConversations) {
        insertConversation.run(
          conversation.newId,
          newCharacterId,
          conversation.title,
          conversation.ignoreMemory,
          conversation.createdAt,
          conversation.updatedAt,
        );
      }

      const insertMessage = db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const message of preparedMessages) {
        insertMessage.run(
          message.id,
          message.conversationId,
          message.role,
          message.content,
          message.tokenCount,
          message.createdAt,
          message.seq,
          message.metadata,
        );
      }

      const insertMemory = db.prepare(`
        INSERT INTO memories (
          id, character_id, category, content, confidence, tags, source_msg_ids,
          memory_kind, importance, emotional_weight, status, pinned, last_used_at,
          usage_count, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const memory of preparedMemories) {
        insertMemory.run(
          memory.id,
          newCharacterId,
          memory.category,
          memory.content,
          memory.confidence,
          memory.tags,
          memory.source_msg_ids,
          memory.memory_kind,
          memory.importance,
          memory.emotional_weight,
          memory.status,
          memory.pinned,
          memory.last_used_at,
          memory.usage_count,
          memory.metadata,
          memory.created_at,
          memory.updated_at,
        );
      }

      if (profile) {
        db.prepare(`
          INSERT INTO character_memory_profiles (
            character_id, profile_name, relationship_state, recent_story_state,
            emotional_baseline, open_threads, user_profile_summary, pinned_summary, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newCharacterId,
          profile.profile_name,
          profile.relationship_state,
          profile.recent_story_state,
          profile.emotional_baseline,
          profile.open_threads,
          profile.user_profile_summary,
          profile.pinned_summary,
          profile.updated_at,
        );
      }

      const insertProfileVersion = db.prepare(`
        INSERT INTO character_memory_profile_versions (
          character_id, version_number, snapshot_json, reason, task_id, created_at
        ) VALUES (?, ?, ?, ?, NULL, ?)
      `);
      for (const version of profileVersions) {
        insertProfileVersion.run(
          newCharacterId,
          version.version_number,
          remapProfileSnapshotCharacterId(version.snapshot_json, newCharacterId),
          version.reason,
          version.created_at,
        );
      }

      const insertEmbedding = db.prepare(`
        INSERT INTO memory_embeddings (
          memory_id, character_id, provider, model, dimension, embedding_blob,
          normalized, embedding_text_hash, status, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const embedding of preparedEmbeddings) {
        insertEmbedding.run(
          embedding.memory_id,
          newCharacterId,
          embedding.provider,
          embedding.model,
          embedding.dimension,
          embedding.embedding_blob,
          embedding.normalized,
          embedding.embedding_text_hash,
          embedding.status,
          embedding.error_message,
          embedding.created_at,
          embedding.updated_at,
        );
      }

      if (modelPresetBindings.length > 0) {
        const insertBinding = db.prepare(`
          INSERT INTO character_model_preset_bindings (
            character_id, model, preset_id, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const binding of modelPresetBindings) {
          insertBinding.run(
            newCharacterId,
            binding.model,
            binding.preset_id,
            binding.sort_order,
            now,
            now,
          );
        }
      }

      if (memoryConfig) {
        db.prepare(`
          INSERT INTO character_memory_configs (
            character_id, enabled, memory_package_token_budget, profile_token_budget,
            pinned_token_budget, open_threads_token_budget, retrieval_token_budget,
            memory_max_inject_override, vector_enabled_override, reranker_enabled_override,
            vector_top_k_override, reranker_top_k_override, embedding_model_override,
            reranker_model_override, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newCharacterId,
          memoryConfig.enabled,
          memoryConfig.memory_package_token_budget,
          memoryConfig.profile_token_budget,
          memoryConfig.pinned_token_budget,
          memoryConfig.open_threads_token_budget,
          memoryConfig.retrieval_token_budget,
          memoryConfig.memory_max_inject_override,
          memoryConfig.vector_enabled_override,
          memoryConfig.reranker_enabled_override,
          memoryConfig.vector_top_k_override,
          memoryConfig.reranker_top_k_override,
          memoryConfig.embedding_model_override,
          memoryConfig.reranker_model_override,
          memoryConfig.updated_at,
        );
      }

      // 只保留可直接复用的 ready embedding。原角色的 pending/processing/failed
      // task 带有旧 claim、租约与重试历史，不能克隆；为仍无可用索引的 active
      // 记忆创建全新的 pending rebuild task，并与角色副本在同一事务提交。
      for (const memoryId of memoryIdsNeedingFreshIndexWork) {
        if (enqueueMemoryEmbeddingTask(memoryId, newCharacterId, 'rebuild', db)) {
          indexingQueued += 1;
        }
      }
    });

    copyAll();
    committed = true;
    if (indexingQueued > 0) {
      triggerMemoryIndexProcessing();
    }

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(newCharacterId) as Record<string, unknown>;
    const copiedBindings = db.prepare(
      `SELECT model, preset_id
       FROM character_model_preset_bindings
       WHERE character_id = ?
       ORDER BY sort_order ASC, model ASC`,
    ).all(newCharacterId);
    return NextResponse.json(
      { ...character, model_preset_bindings: copiedBindings },
      { status: 201 },
    );
  } catch (err) {
    if (!committed) {
      await deleteLocalAssetUrls(copiedUrls.values());
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '复制角色失败' },
      { status: 500 },
    );
  }
}
