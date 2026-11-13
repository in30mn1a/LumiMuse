import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { agentDocumentUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { readJsonObject } from '@/lib/request-json';
import {
  isAgentDocumentKey,
  listAgentDocumentVersions,
  readAgentDocument,
  restoreAgentDocumentVersion,
  saveAgentDocument,
  undoAgentMemory,
} from '@/lib/agent/documents';
import { appendAgentMessage, getAgentSession } from '@/lib/agent/store';
import { isAgentRunActive } from '@/lib/agent/runs';

const VERSION_PAGE_SIZE = 20;
// 学习笔记持续追加，完整保存不能沿用人格配置字段的长度校验。
const memoryDocumentUpdateSchema = z.union([
  z.object({ content: z.string(), expected_content: z.string().optional() }),
  agentDocumentUpdateSchema,
]);

type RouteContext = { params: Promise<{ key: string }> };

/** 文档当前内容和一页版本历史（`versions_offset` 翻页）。 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const { key } = await params;
  if (!isAgentDocumentKey(key)) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  const offset = Number(request.nextUrl.searchParams.get('versions_offset'));
  const db = getDb();
  return NextResponse.json({
    document: readAgentDocument(db, key),
    ...listAgentDocumentVersions(db, key, VERSION_PAGE_SIZE, Number.isInteger(offset) && offset > 0 ? offset : 0),
  });
}

/** 保存、恢复旧版本，或撤销最新一次 Agent 追加的笔记。 */
export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { key } = await params;
  if (!isAgentDocumentKey(key)) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const parsed = (key === 'memory' ? memoryDocumentUpdateSchema : agentDocumentUpdateSchema).safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const db = getDb();
  const now = new Date().toISOString();
  // 编辑器读取后可能发生 Agent 自动追加；同步核对与保存之间没有异步让出。
  if ('expected_content' in parsed.data && parsed.data.expected_content !== undefined
    && parsed.data.expected_content !== readAgentDocument(db, key).content) {
    return NextResponse.json({ error: '笔记已更新，草稿已保留。请重新打开该页签，核对最新内容和版本后再保存。' }, { status: 409 });
  }
  if ('undo_version_id' in parsed.data) {
    if (key !== 'memory') return NextResponse.json({ error: 'Only Agent memory can be undone' }, { status: 400 });
    const { undo_version_id: versionId, session_id: sessionId } = parsed.data;
    // 运行中的一轮会按自己的顺序写入会话消息，此时插入撤销事件会打乱对话记录
    if (sessionId && isAgentRunActive(sessionId)) {
      return NextResponse.json({ error: '这个会话正在运行，请先停止', code: 'agent_busy' }, { status: 409 });
    }
    const result = db.transaction(() => {
      const undone = undoAgentMemory(db, versionId, now);
      if (undone.ok && sessionId && getAgentSession(db, sessionId)) {
        appendAgentMessage(db, sessionId, {
          role: 'event', content: JSON.stringify({ kind: 'memory_undo', version_id: versionId }),
        }, now);
      }
      return undone;
    })();
    if (!result.ok) {
      return NextResponse.json({
        error: result.code === 'not_found' ? 'Agent note version not found' : '笔记之后已有编辑，请在 Agent 设置中查看和恢复版本。',
      }, { status: result.code === 'not_found' ? 404 : 409 });
    }
    return NextResponse.json({ document: result.document });
  }
  if ('restore_version_id' in parsed.data) {
    const restored = restoreAgentDocumentVersion(db, key, parsed.data.restore_version_id, now);
    if (!restored) return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    return NextResponse.json({ document: restored });
  }
  return NextResponse.json({ document: saveAgentDocument(db, key, parsed.data.content, 'user', now) });
}
