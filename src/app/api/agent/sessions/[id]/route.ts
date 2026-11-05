import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { agentSessionUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { readJsonObject } from '@/lib/request-json';
import { getAgentContextStatus } from '@/lib/agent/loop';
import { toAgentMessageView } from '@/lib/agent/messages';
import { isAgentRunActive } from '@/lib/agent/runs';
import { deleteAgentSession, getAgentSession, listAgentMessages, renameAgentSession } from '@/lib/agent/store';
import { AGENT_TOOLS } from '@/lib/agent/tools';
import { AGENT_SKILLS } from '@/lib/agent/skills/memory-review';
import { readLatestAgentTaskPlan } from '@/lib/agent/task-plan';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 会话与完整历史。`running` 表示服务端仍有一轮在跑（例如刷新页面后）。
 * `context` 是当前上下文占用；算不出来时为 null，不影响读取历史。
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const db = getDb();
  const session = getAgentSession(db, id);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  let context = null;
  try {
    context = getAgentContextStatus(db, id, { tools: AGENT_TOOLS, skills: AGENT_SKILLS });
  } catch {
    // 占用只是附加信息
  }
  const rows = listAgentMessages(db, id);
  return NextResponse.json({
    session,
    messages: rows.map(toAgentMessageView),
    task_plan: readLatestAgentTaskPlan(rows)?.plan ?? null,
    running: isAgentRunActive(id),
    context,
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
