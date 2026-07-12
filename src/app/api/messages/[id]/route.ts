import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { parseMessageMetadata, serializeMessage } from '@/lib/messages';
import {
  collectLocalAssetUrlsFromContent,
  collectLocalAssetUrlsFromMetadata,
  deleteLocalAssetUrls,
  filterUnreferencedLocalAssetUrls,
} from '@/lib/character-file-utils';
import { messageUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';
import type { MessageAttachment, MessageMetadata } from '@/types';
import { createMessageTokenCount, metadataWithTokenCountProvenance } from '@/lib/message-token-provenance';

type MessageRecord = Record<string, unknown>;

/**
 * 收集单条消息所有版本（含当前 content 和 metadata）涉及的本地资源 URL。
 * 包含来源：
 *  - 当前 content 内嵌 URL
 *  - metadata.attachments / metadata.generatedImages
 *  - metadata.versions[i].content 内嵌 URL（非激活版本独占的 URL）
 *  - metadata.versions[i].attachments（兼容历史/扩展数据，类型层未声明但运行时可能存在）
 */
function collectMessageLocalAssetUrls(message: MessageRecord): Set<string> {
  const urls = collectLocalAssetUrlsFromMetadata(message.metadata);
  const contentUrls = collectLocalAssetUrlsFromContent(
    typeof message.content === 'string' ? message.content : null,
  );

  for (const url of contentUrls) {
    urls.add(url);
  }

  // 历史版本内嵌的 URL 也要算进来，否则多版本场景下会漏判
  const meta = parseMessageMetadata(message.metadata);
  const versions = meta.versions as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(versions)) {
    for (const version of versions) {
      if (!version || typeof version !== 'object') continue;
      const versionContent = typeof version.content === 'string' ? version.content : null;
      for (const url of collectLocalAssetUrlsFromContent(versionContent)) {
        urls.add(url);
      }
      // 兼容历史/扩展数据：版本内自带 attachments
      for (const url of collectLocalAssetUrlsFromMetadata({ attachments: version.attachments })) {
        urls.add(url);
      }
    }
  }

  return urls;
}

async function deleteUnreferencedLocalAssets(
  db: ReturnType<typeof getDb>,
  previousFileUrls: Set<string>,
): Promise<void> {
  if (previousFileUrls.size === 0) return;

  // 只对修改前出现过的 URL 做"是否仍被引用"检查，避免全表扫描所有资源。
  const orphanUrls = filterUnreferencedLocalAssetUrls(db, previousFileUrls);
  await deleteLocalAssetUrls(orphanUrls);
}

function mergeMessageMetadata(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, ...incoming };
}

function messageRole(value: unknown): 'user' | 'assistant' | 'system' {
  return value === 'assistant' || value === 'system' ? value : 'user';
}

function messageAttachments(metadata: MessageMetadata): MessageAttachment[] | undefined {
  return Array.isArray(metadata.attachments) ? metadata.attachments : undefined;
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
  const parsed = messageUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const previousFileUrls = collectMessageLocalAssetUrls(existing);

  // 用事务包裹多个 UPDATE，避免中途失败留下不一致状态
  db.transaction(() => {
    if (body.activeVersion !== undefined) {
      let meta: Record<string, unknown> = {};
      meta = parseMessageMetadata(existing.metadata);
      const versions = meta.versions as Array<{ content: string; token_count: number }> | undefined;
      if (versions && body.activeVersion >= 0 && body.activeVersion < versions.length) {
        meta.activeVersion = body.activeVersion;
        const target = versions[body.activeVersion];
        const tokenResult = createMessageTokenCount(
          target.content,
          messageRole(existing.role),
          messageAttachments(meta),
        );
        versions[body.activeVersion] = { ...target, token_count: tokenResult.tokenCount };
        meta.versions = versions;
        meta = metadataWithTokenCountProvenance(meta, tokenResult.provenance);
        db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
          .run(target.content, tokenResult.tokenCount, JSON.stringify(meta), id);
      }
    } else if (body.content !== undefined || body.attachments !== undefined) {
      // 同步更新 metadata.versions 里当前激活版本的内容，防止切换版本时覆盖编辑
      let meta: Record<string, unknown> = {};
      meta = parseMessageMetadata(existing.metadata);
      const versions = meta.versions as Array<{ content: string; token_count: number }> | undefined;
      const nextContent = body.content ?? String(existing.content ?? '');

      // 如果传了 attachments，更新 metadata 里的附件
      if (body.attachments !== undefined) {
        if (body.attachments && (body.attachments as unknown[]).length > 0) {
          meta.attachments = body.attachments;
        } else {
          delete meta.attachments;
        }
      }
      const tokenResult = createMessageTokenCount(
        nextContent,
        messageRole(existing.role),
        messageAttachments(meta),
      );
      const tokenCount = tokenResult.tokenCount;
      meta = metadataWithTokenCountProvenance(meta, tokenResult.provenance);

      if (versions && versions.length > 0) {
        const activeIdx = typeof meta.activeVersion === 'number' ? meta.activeVersion : 0;
        if (activeIdx >= 0 && activeIdx < versions.length) {
          versions[activeIdx] = { content: nextContent, token_count: tokenCount };
          meta.versions = versions;
        }
        db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
          .run(nextContent, tokenCount, JSON.stringify(meta), id);
      } else {
        db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
          .run(nextContent, tokenCount, JSON.stringify(meta), id);
      }

      // 注：不再自动 invalidate 消息编辑触发的记忆。编辑原因多样（改错别字/调语气/补内容），
      // 自动 supersede 会误伤有效记忆；用户可在记忆管理页手动标记失效。
    }

    const shouldMergeIncomingMetadata = body.metadata !== undefined && body.activeVersion === undefined;
    if (shouldMergeIncomingMetadata) {
      const latest = db.prepare('SELECT metadata FROM messages WHERE id = ?').get(id) as { metadata: unknown } | undefined;
      const currentMeta = parseMessageMetadata(latest?.metadata ?? existing.metadata);
      const incomingMeta = { ...(body.metadata ?? {}) };
      delete incomingMeta.token_count_provenance;
      // body.content !== undefined && body.metadata !== undefined 时，
      // currentMeta 已是上方刚写入的最新 versions/attachments。
      let mergedMeta = mergeMessageMetadata(currentMeta, incomingMeta);
      if (Object.hasOwn(incomingMeta, 'attachments')) {
        const latestRow = db.prepare('SELECT content, token_count FROM messages WHERE id = ?').get(id) as {
          content: string;
          token_count: number;
        };
        const tokenResult = createMessageTokenCount(
          latestRow.content,
          messageRole(existing.role),
          messageAttachments(mergedMeta),
        );
        mergedMeta = metadataWithTokenCountProvenance(mergedMeta, tokenResult.provenance);
        db.prepare('UPDATE messages SET token_count = ?, metadata = ? WHERE id = ?')
          .run(tokenResult.tokenCount, JSON.stringify(mergedMeta), id);
      } else {
        db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(mergedMeta), id);
      }
    }
  })();

  // deleteUnreferencedLocalAssets 涉及文件 IO，必须在事务外执行
  await deleteUnreferencedLocalAssets(db, previousFileUrls);
  const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>;
  return NextResponse.json(serializeMessage(updated));
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const previousFileUrls = collectMessageLocalAssetUrls(existing);

  // 如果消息有多个版本，只删除当前激活版本，保留其他版本
  let meta: Record<string, unknown> = {};
  meta = parseMessageMetadata(existing.metadata);
  const versions = meta.versions as Array<{ content: string; token_count: number }> | undefined;

  if (versions && versions.length > 1) {
    const activeIdx = typeof meta.activeVersion === 'number' ? meta.activeVersion : versions.length - 1;
    // 删除当前版本
    const newVersions = versions.filter((_, i) => i !== activeIdx);
    const newActiveIdx = Math.min(activeIdx, newVersions.length - 1);
    meta.versions = newVersions;
    meta.activeVersion = newActiveIdx;
    const target = newVersions[newActiveIdx];
    const tokenResult = createMessageTokenCount(
      target.content,
      messageRole(existing.role),
      messageAttachments(meta),
    );
    newVersions[newActiveIdx] = { ...target, token_count: tokenResult.tokenCount };
    meta = metadataWithTokenCountProvenance(meta, tokenResult.provenance);
    const updated = db.transaction(() => {
      db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
        .run(target.content, tokenResult.tokenCount, JSON.stringify(meta), id);
      return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>;
    })();
    await deleteUnreferencedLocalAssets(db, previousFileUrls);
    return NextResponse.json({
      ok: true,
      deleted: 'version',
      conversation_id: String(existing.conversation_id),
      message: serializeMessage(updated),
    });
  }

  // 只有一个版本（或无版本信息）：删整条消息
  // 注：不自动 invalidate 该消息支撑的记忆。删除消息可能只是清理对话历史，
  // 记忆事实仍然有效；用户可在记忆管理页手动标记失效。
  const result = db.transaction(() => {
    return db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  })();
  if (result.changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await deleteUnreferencedLocalAssets(db, previousFileUrls);
  return NextResponse.json({
    ok: true,
    deleted: 'message',
    conversation_id: String(existing.conversation_id),
  });
}
