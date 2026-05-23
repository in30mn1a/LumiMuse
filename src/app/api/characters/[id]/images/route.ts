import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

type GeneratedImageVersion = {
  id: string;
  url: string;
  prompt: string;
};

type GeneratedImage = GeneratedImageVersion & {
  versions?: Array<GeneratedImageVersion>;
  activeVersion?: number;
};

type CharacterImageItem = {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  createdAt: string;
  imageId: string;
  versionId: string;
  url: string;
};

type DeleteImageTarget = {
  messageId: string;
  imageId: string;
  versionId: string;
};

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return (value as Record<string, unknown>) || {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeVersions(image: GeneratedImage): Array<GeneratedImageVersion> {
  return image.versions && image.versions.length > 0
    ? image.versions
    : [{ id: image.id, url: image.url, prompt: image.prompt }];
}

function getActiveVersionIndex(image: GeneratedImage, versions: Array<GeneratedImageVersion>): number {
  if (typeof image.activeVersion === 'number' && image.activeVersion >= 0 && image.activeVersion < versions.length) {
    return image.activeVersion;
  }
  const matchedIndex = versions.findIndex(version => version.id === image.id || version.url === image.url);
  return matchedIndex >= 0 ? matchedIndex : 0;
}

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

  const images: Array<CharacterImageItem> = [];

  for (const row of rows) {
    const meta = parseMetadata(row.metadata);
    const generatedImages = (meta.generatedImages as Array<GeneratedImage> | undefined) || [];
    for (const image of generatedImages) {
      const versions = normalizeVersions(image);
      const activeVersion = getActiveVersionIndex(image, versions);
      for (let index = 0; index < versions.length; index += 1) {
        const version = versions[index];
        images.push({
          messageId: row.messageId,
          conversationId: row.conversationId,
          conversationTitle: row.conversationTitle,
          createdAt: row.createdAt,
          imageId: image.id,
          versionId: version.id,
          url: version.url,
        });
      }
    }
  }

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
  const targetsByMessage = new Map<string, Array<DeleteImageTarget>>();

  for (const item of items) {
    const grouped = targetsByMessage.get(item.messageId) || [];
    grouped.push(item);
    targetsByMessage.set(item.messageId, grouped);
  }

  for (const [messageId, messageItems] of targetsByMessage) {
    const row = messageQuery.get(messageId, id) as { id: string; metadata: string } | undefined;
    if (!row) continue;

    const meta = parseMetadata(row.metadata);
    const generatedImages = (meta.generatedImages as Array<GeneratedImage> | undefined) || [];

    meta.generatedImages = generatedImages.flatMap(image => {
      const deleteVersionIds = new Set(messageItems.filter(target => target.imageId === image.id).map(target => target.versionId));
      if (deleteVersionIds.size === 0) return [image];

      const versions = normalizeVersions(image);
      for (const version of versions) {
        if (deleteVersionIds.has(version.id)) {
          fileUrls.add(version.url);
          deletedCount += 1;
        }
      }

      const remainingVersions = versions.filter(version => !deleteVersionIds.has(version.id));
      if (remainingVersions.length === versions.length) return [image];
      if (remainingVersions.length === 0) return [];

      const nextActive = Math.min(
        typeof image.activeVersion === 'number' ? image.activeVersion : 0,
        remainingVersions.length - 1,
      );
      const current = remainingVersions[nextActive];

      return [{
        ...image,
        id: image.id,
        url: current.url,
        prompt: current.prompt,
        versions: remainingVersions,
        activeVersion: nextActive,
      }];
    });

    updateMessage.run(JSON.stringify(meta), messageId);
  }

  return NextResponse.json({
    ok: true,
    deletedCount,
    deletedUrls: [...fileUrls],
  });
}
