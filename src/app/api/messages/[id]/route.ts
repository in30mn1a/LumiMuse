import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/** 把从 SQLite 读出的 message 行统一序列化：metadata 解析为对象 */
function serializeMessage(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.metadata === 'string') {
    try { row.metadata = JSON.parse(row.metadata); } catch { row.metadata = {}; }
  }
  return row;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json() as { content?: string; metadata?: Record<string, unknown>; activeVersion?: number; attachments?: unknown[] };
  const db = getDb();

  const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (body.activeVersion !== undefined) {
    let meta: Record<string, unknown> = {};
    try { meta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : (existing.metadata as Record<string, unknown> || {}); } catch { meta = {}; }
    const versions = meta.versions as Array<{ content: string; token_count: number }> | undefined;
    if (versions && body.activeVersion >= 0 && body.activeVersion < versions.length) {
      meta.activeVersion = body.activeVersion;
      const target = versions[body.activeVersion];
      db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
        .run(target.content, target.token_count, JSON.stringify(meta), id);
    }
  } else if (body.content !== undefined) {
    const { estimateTokens } = await import('@/lib/token-counter');
    const tokenCount = estimateTokens(body.content);

    // 同步更新 metadata.versions 里当前激活版本的内容，防止切换版本时覆盖编辑
    let meta: Record<string, unknown> = {};
    try { meta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : (existing.metadata as Record<string, unknown> || {}); } catch { meta = {}; }
    const versions = meta.versions as Array<{ content: string; token_count: number }> | undefined;

    // 如果传了 attachments，更新 metadata 里的附件
    if (body.attachments !== undefined) {
      if (body.attachments && (body.attachments as unknown[]).length > 0) {
        meta.attachments = body.attachments;
      } else {
        delete meta.attachments;
      }
    }

    if (versions && versions.length > 0) {
      const activeIdx = typeof meta.activeVersion === 'number' ? meta.activeVersion : 0;
      if (activeIdx >= 0 && activeIdx < versions.length) {
        versions[activeIdx] = { content: body.content, token_count: tokenCount };
        meta.versions = versions;
      }
      db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
        .run(body.content, tokenCount, JSON.stringify(meta), id);
    } else {
      db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
        .run(body.content, tokenCount, JSON.stringify(meta), id);
    }
  }

  if (body.metadata !== undefined && body.activeVersion === undefined) {
    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(body.metadata), id);
  }

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

  // 如果消息有多个版本，只删除当前激活版本，保留其他版本
  let meta: Record<string, unknown> = {};
  try { meta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : (existing.metadata as Record<string, unknown> || {}); } catch { meta = {}; }
  const versions = meta.versions as Array<{ content: string; token_count: number }> | undefined;

  if (versions && versions.length > 1) {
    const activeIdx = typeof meta.activeVersion === 'number' ? meta.activeVersion : versions.length - 1;
    // 删除当前版本
    const newVersions = versions.filter((_, i) => i !== activeIdx);
    const newActiveIdx = Math.min(activeIdx, newVersions.length - 1);
    meta.versions = newVersions;
    meta.activeVersion = newActiveIdx;
    const target = newVersions[newActiveIdx];
    db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
      .run(target.content, target.token_count, JSON.stringify(meta), id);
    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>;
    return NextResponse.json({ ok: true, deleted: 'version', message: serializeMessage(updated) });
  }

  // 只有一个版本（或无版本信息）：删整条消息
  const result = db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  if (result.changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true, deleted: 'message' });
}
