import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { agentSessionUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { readJsonObject } from '@/lib/request-json';
import { toAgentMessageView } from '@/lib/agent/messages';
import { isAgentRunActive } from '@/lib/agent/runs';
import { deleteAgentSession, getAgentSession, listAgentMessages, renameAgentSession } from '@/lib/agent/store';

type RouteContext = { params: Promise<{ id: string }> };

/** 会话与完整历史。`running` 表示服务端仍有一轮在跑（例如刷新页面后）。 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const db = getDb();
  const session = getAgentSession(db, id);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json({
    session,
    messages: listAgentMessages(db, id).map(toAgentMessageView),
    running: isAgentRunActive(id),
  });
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const parsed = agentSessionUpdateSchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const db = getDb();
  if (!renameAgentSession(db, id, parsed.data.title, new Date().toISOString())) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json(getAgentSession(db, id));
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  if (isAgentRunActive(id)) {
    return NextResponse.json({ error: '这个会话正在运行，请先停止', code: 'agent_busy' }, { status: 409 });
  }
  if (!deleteAgentSession(getDb(), id, new Date().toISOString())) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
