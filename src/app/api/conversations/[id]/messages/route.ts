import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getDb } from '@/lib/db';
import { Message, MessageAttachment } from '@/types';
import { serializeMessage, serializeTypedMessages } from '@/lib/messages';
import { conversationMessageCreateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { createMessageTokenCount, metadataWithTokenCountProvenance } from '@/lib/message-token-provenance';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const messages = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
  ).all(id) as Message[];

  return NextResponse.json(serializeTypedMessages(messages));
}

export async function POST(
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
  const parsed = conversationMessageCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const { role, content, metadata } = parsed.data;
  const db = getDb();
  const conversation = db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const msgId = crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();
  const baseMetadata = metadata ?? {};
  const attachments = Array.isArray(baseMetadata.attachments)
    ? baseMetadata.attachments as MessageAttachment[]
    : undefined;
  const tokenResult = createMessageTokenCount(content, role, attachments);
  const metaStr = JSON.stringify(metadataWithTokenCountProvenance(baseMetadata, tokenResult.provenance));

  // 用事务包裹 SELECT MAX(seq) + INSERT + UPDATE conversations，避免并发写入产生重复 seq
  db.transaction(() => {
    const nextSeq = ((db.prepare('SELECT MAX(seq) as m FROM messages WHERE conversation_id = ?').get(id) as { m: number | null }).m ?? 0) + 1;
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msgId, id, role, content, tokenResult.tokenCount, now, nextSeq, metaStr);

    // 更新对话的最新时间
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);
  })();

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId) as Record<string, unknown>;
  return NextResponse.json(serializeMessage(message), { status: 201 });
}
