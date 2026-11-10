import type Database from 'better-sqlite3';
import { parseMessageMetadata } from '@/lib/messages';
import { createMessageTokenCount, metadataWithTokenCountProvenance } from '@/lib/message-token-provenance';
import type { MessageAttachment } from '@/types';

/**
 * 修改消息正文和（可选的）附件：重算 token，并同步 metadata.versions 里当前激活的版本，
 * 防止切换版本时覆盖编辑。消息 PUT 路由与 Agent 提案批准共用；调用方负责事务。
 *
 * 不自动 invalidate 该消息支撑的记忆：编辑原因多样（改错别字/调语气/补内容），
 * 自动 supersede 会误伤有效记忆；用户可在记忆管理页手动标记失效。
 */
export function applyMessageEdit(
  db: Database.Database,
  existing: Record<string, unknown>,
  edit: { content?: string; attachments?: unknown[] },
): void {
  let meta: Record<string, unknown> = parseMessageMetadata(existing.metadata);
  const versions = meta.versions as Array<{ content: string; token_count: number }> | undefined;
  const nextContent = edit.content ?? String(existing.content ?? '');

  if (edit.attachments !== undefined) {
    if (edit.attachments.length > 0) {
      meta.attachments = edit.attachments;
    } else {
      delete meta.attachments;
    }
  }
  const role = existing.role === 'assistant' || existing.role === 'system' ? existing.role : 'user';
  const tokenResult = createMessageTokenCount(
    nextContent,
    role,
    Array.isArray(meta.attachments) ? meta.attachments as MessageAttachment[] : undefined,
  );
  meta = metadataWithTokenCountProvenance(meta, tokenResult.provenance);

  if (versions && versions.length > 0) {
    const activeIdx = typeof meta.activeVersion === 'number' ? meta.activeVersion : 0;
    if (activeIdx >= 0 && activeIdx < versions.length) {
      versions[activeIdx] = { content: nextContent, token_count: tokenResult.tokenCount };
      meta.versions = versions;
    }
  }
  db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
    .run(nextContent, tokenResult.tokenCount, JSON.stringify(meta), existing.id);
}
