import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { formatZodFieldErrors } from '@/lib/schemas';
import { readJsonObject } from '@/lib/request-json';
import { applyProposalDecision, proposalDecisionSchema, undoProposalItem } from '@/lib/agent/proposal-apply';
import { getProposalView } from '@/lib/agent/proposals';
import { isAgentRunActive } from '@/lib/agent/runs';

type RouteContext = { params: Promise<{ id: string }> };

function parseProposalId(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 提案和全部项（含修改前后与当前状态）。 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const id = parseProposalId((await params).id);
  const view = id === null ? null : getProposalView(getDb(), id);
  if (!view) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  return NextResponse.json(view);
}

/** 主人的决定：`apply` 批准勾选的项，其余 pending 项记为拒绝；`undo` 撤销一个已生效的项。 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const id = parseProposalId((await params).id);
  if (id === null) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const parsed = proposalDecisionSchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }

  const db = getDb();
  if (parsed.data.action === 'undo') {
    // 撤销不写会话消息，不需要等运行结束
    const undone = undoProposalItem(db, id, parsed.data.item_id, new Date().toISOString());
    if (!undone.ok) return NextResponse.json({ error: undone.error }, { status: undone.status });
    return NextResponse.json(getProposalView(db, id));
  }

  const sessionId = (db.prepare('SELECT session_id FROM agent_proposals WHERE id = ?').get(id) as
    | { session_id: string | null }
    | undefined)?.session_id;
  // 决定结果会写入会话；运行中插入消息会打断工具调用与结果的配对
  if (sessionId && isAgentRunActive(sessionId)) {
    return NextResponse.json({ error: '这个会话正在运行，请先停止', code: 'agent_busy' }, { status: 409 });
  }

  const outcome = applyProposalDecision(db, id, parsed.data, new Date().toISOString());
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  return NextResponse.json(getProposalView(db, id));
}
