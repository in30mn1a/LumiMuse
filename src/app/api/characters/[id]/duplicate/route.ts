import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Character, Message } from '@/types';
import { copyLocalAssetUrl, deleteLocalAssetUrls, duplicateCharacterFilesInMetadata, remapJsonStringIds } from '@/lib/character-file-utils';
import { v4 as uuidv4 } from 'uuid';

type ConversationRow = {
  id: string;
  character_id: string;
  title: string;
  ignore_memory?: number;
  created_at: string;
  updated_at: string;
};

type MemoryRow = {
  id: string;
  character_id: string;
  category: string;
  content: string;
  confidence: number;
  tags: string;
  source_msg_ids: string;
  created_at: string;
  updated_at: string;
};

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
  const newCharacterId = uuidv4().slice(0, 8);
  const newName = `${original.name}（副本）`;
  try {
    const newAvatarUrl = await copyLocalAssetUrl(original.avatar_url, copiedUrls) as string | null;

  const conversations = db.prepare(
    'SELECT * FROM conversations WHERE character_id = ? ORDER BY created_at ASC, updated_at ASC'
  ).all(id) as ConversationRow[];

  const messagesByConversation = new Map<string, Message[]>();
  for (const conversation of conversations) {
    const messages = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
    ).all(conversation.id) as Message[];
    messagesByConversation.set(conversation.id, messages);
  }

  const memories = db.prepare(
    'SELECT * FROM memories WHERE character_id = ? ORDER BY created_at ASC, updated_at ASC'
  ).all(id) as MemoryRow[];

  const preparedConversations = conversations.map(conversation => ({
    originalId: conversation.id,
    newId: uuidv4().slice(0, 8),
    title: conversation.title,
    ignoreMemory: conversation.ignore_memory ? 1 : 0,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
  }));

  const newMessageIdMap = new Map<string, string>();
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

  for (const preparedConversation of preparedConversations) {
    const messages = messagesByConversation.get(preparedConversation.originalId) || [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const newMessageId = uuidv4().slice(0, 8);
      newMessageIdMap.set(message.id, newMessageId);
      preparedMessages.push({
        id: newMessageId,
        conversationId: preparedConversation.newId,
        role: message.role,
        content: message.content,
        tokenCount: message.token_count,
        createdAt: message.created_at,
        seq: index + 1,
        metadata: await duplicateCharacterFilesInMetadata(message.metadata, copiedUrls),
      });
    }
  }

  const preparedMemories = memories.map(memory => ({
    id: uuidv4().slice(0, 8),
    category: memory.category,
    content: memory.content,
    confidence: memory.confidence,
    tags: memory.tags,
    sourceMsgIds: remapJsonStringIds(memory.source_msg_ids, newMessageIdMap),
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
  }));

  const copyAll = db.transaction(() => {
    db.prepare(`
      INSERT INTO characters (id, name, avatar_url, basic_info, personality, scenario, greeting, example_dialogue, system_prompt, other_info, image_tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newCharacterId,
      newName,
      newAvatarUrl,
      original.personality,
      original.scenario,
      original.greeting,
      original.example_dialogue,
      original.system_prompt,
      original.other_info || '',
      original.image_tags || '',
      now,
      now,
    );

    const insertConversation = db.prepare(`
      INSERT INTO conversations (id, character_id, title, ignore_memory, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const conversation of preparedConversations) {
      insertConversation.run(conversation.newId, newCharacterId, conversation.title, conversation.ignoreMemory, conversation.createdAt, conversation.updatedAt);
    }

    const insertMessage = db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const message of preparedMessages) {
      insertMessage.run(message.id, message.conversationId, message.role, message.content, message.tokenCount, message.createdAt, message.seq, message.metadata);
    }

    const insertMemory = db.prepare(`
      INSERT INTO memories (id, character_id, category, content, confidence, tags, source_msg_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const memory of preparedMemories) {
      insertMemory.run(memory.id, newCharacterId, memory.category, memory.content, memory.confidence, memory.tags, memory.sourceMsgIds, memory.createdAt, memory.updatedAt);
    }
  });

  copyAll();

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(newCharacterId);
    return NextResponse.json(character, { status: 201 });
  } catch (err) {
    await deleteLocalAssetUrls(copiedUrls.values());
    return NextResponse.json({ error: err instanceof Error ? err.message : '复制角色失败' }, { status: 500 });
  }
}