import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { deleteLocalAssetUrls, filterUnreferencedLocalAssetUrls } from '@/lib/character-file-utils';
import {
  collectUniqueGeneratedImageItems,
  removeGeneratedImageReferences,
} from '@/lib/generated-image-assets';

type DeleteImageTarget = {
  url?: string;
  messageId?: string;
  imageId?: string;
  versionId?: string;
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      messages.id AS messageId,
      messages.created_at AS createdAt,
      messages.metadata AS metadata,
      conversations.id AS conversationId,
      conversations.title AS conversationTitle
    FROM messages
    INNER JOIN conversations ON conversations.id = messages.conversation_id
    WHERE conversations.character_id = ?
      AND messages.role = 'assistant'
    ORDER BY messages.created_at DESC, messages.seq DESC
  `).all(id) as Array<{
    messageId: string;
    createdAt: string;
    metadata: string;
    conversationId: string;
    conversationTitle: string;
  }>;

  const images = collectUniqueGeneratedImageItems(rows);

  return NextResponse.json(images);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json() as { items?: Array<DeleteImageTarget> };
  const items = body.items || [];

  if (items.length === 0) {
    return NextResponse.json({ error: '缺少待删除图片' }, { status: 400 });
  }

  const messageQuery = db.prepare(`
    SELECT messages.id, messages.metadata
    FROM messages
    INNER JOIN conversations ON conversations.id = messages.conversation_id
    WHERE messages.id = ?
      AND conversations.character_id = ?
  `);
  const updateMessage = db.prepare('UPDATE messages SET metadata = ? WHERE id = ?');

  const fileUrls = new Set<string>();
  let deletedCount = 0;
  const targetUrls = new Set(items.map(item => item.url).filter((url): url is string => typeof url === 'string' && url.length > 0));

  if (targetUrls.size > 0) {
    const rows = db.prepare(`
      SELECT messages.id, messages.metadata
      FROM messages
      INNER JOIN conversations ON conversations.id = messages.conversation_id
      WHERE conversations.character_id = ?
        AND messages.role = 'assistant'
    `).all(id) as Array<{ id: string; metadata: string }>;

    const cleanup = db.transaction(() => {
      for (const row of rows) {
        const result = removeGeneratedImageReferences(row.metadata, { urls: targetUrls });
        if (!result.changed) continue;
        for (const url of result.removedUrls) fileUrls.add(url);
        deletedCount += result.removedUrls.length;
        updateMessage.run(JSON.stringify(result.metadata), row.id);
      }
    });
    cleanup();
  } else {
    const targetsByMessage = new Map<string, Array<DeleteImageTarget>>();

    for (const item of items) {
      if (!item.messageId || !item.imageId || !item.versionId) continue;
      const grouped = targetsByMessage.get(item.messageId) || [];
      grouped.push(item);
      targetsByMessage.set(item.messageId, grouped);
    }

    const cleanup = db.transaction(() => {
      for (const [messageId, messageItems] of targetsByMessage) {
        const row = messageQuery.get(messageId, id) as { id: string; metadata: string } | undefined;
        if (!row) continue;

        let latestMetadata: unknown = row.metadata;
        let changed = false;
        for (const item of messageItems) {
          const result = removeGeneratedImageReferences(latestMetadata, {
            imageId: item.imageId,
            versionId: item.versionId,
          });
          latestMetadata = result.metadata;
          if (!result.changed) continue;
          changed = true;
          for (const url of result.removedUrls) fileUrls.add(url);
          deletedCount += result.removedUrls.length;
        }

        if (changed) {
          updateMessage.run(JSON.stringify(latestMetadata), messageId);
        }
      }
    });
    cleanup();
  }

  const deletedUrls = filterUnreferencedLocalAssetUrls(db, fileUrls);
  await deleteLocalAssetUrls(deletedUrls);

  return NextResponse.json({
    ok: true,
    deletedCount,
    deletedUrls,
  });
}
