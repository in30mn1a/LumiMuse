import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { agentDocumentUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { readJsonObject } from '@/lib/request-json';
import {
  isAgentDocumentKey,
  listAgentDocumentVersions,
  readAgentDocument,
  restoreAgentDocumentVersion,
  saveAgentDocument,
} from '@/lib/agent/documents';

const VERSION_PAGE_SIZE = 20;

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

/** 保存新内容（`content`），或把某个旧版本恢复为当前内容（`restore_version_id`）。 */
export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { key } = await params;
  if (!isAgentDocumentKey(key)) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const parsed = agentDocumentUpdateSchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const db = getDb();
  const now = new Date().toISOString();
  if ('restore_version_id' in parsed.data) {
    const restored = restoreAgentDocumentVersion(db, key, parsed.data.restore_version_id, now);
    if (!restored) return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    return NextResponse.json({ document: restored });
  }
  return NextResponse.json({ document: saveAgentDocument(db, key, parsed.data.content, 'user', now) });
}
