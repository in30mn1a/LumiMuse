import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { abortAgentRun } from '@/lib/agent/runs';
import { getAgentSession } from '@/lib/agent/store';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 停止会话正在后台运行的一轮。只发出中止信号：已完成的回合与中断记录由那一轮自己写入，
 * `running` 要等它收尾后才变 false，调用方照常轮询会话详情。没有在运行时 `stopped` 为 false。
 */
export async function POST(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  if (!getAgentSession(getDb(), id)) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json({ stopped: abortAgentRun(id) });
}
