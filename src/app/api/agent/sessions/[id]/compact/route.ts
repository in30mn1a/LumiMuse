import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { publicErrorMessage } from '@/lib/public-error';
import { loadSettings } from '@/lib/settings';
import type { Settings } from '@/types';
import { compactAgentSession } from '@/lib/agent/loop';
import { finishAgentRun, startAgentRun } from '@/lib/agent/runs';
import { getAgentSession } from '@/lib/agent/store';
import { AGENT_TOOLS } from '@/lib/agent/tools';
import { redactCredentials } from '@/lib/agent/tools/credentials';
import { AGENT_SKILLS } from '@/lib/agent/skills/memory-review';

type RouteContext = { params: Promise<{ id: string }> };

/** 压缩空闲会话，包括刚完成的一轮；与聊天共用会话锁，不开始下一轮任务。 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const db = getDb();
  if (!getAgentSession(db, id)) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const run = startAgentRun(id);
  if (!run) {
    return NextResponse.json({ error: '这个会话正在运行，请等它结束或先停止', code: 'agent_busy' }, { status: 409 });
  }

  const abortRun = () => run.abort();
  request.signal.addEventListener('abort', abortRun, { once: true });
  if (request.signal.aborted) run.abort();
  let settings: Settings | undefined;
  try {
    settings = loadSettings();
    const result = await compactAgentSession({
      db,
      sessionId: id,
      tools: AGENT_TOOLS,
      skills: AGENT_SKILLS,
      settings,
      signal: run.signal,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (run.signal.aborted) {
      return NextResponse.json({ error: '上下文压缩已取消', code: 'agent_compaction_aborted' }, { status: 499 });
    }
    let message = '上下文压缩失败';
    try {
      const result = redactCredentials({ db, settings: settings ?? loadSettings(), sessionId: id }, {
        ok: false,
        error: publicErrorMessage(error, message),
      });
      if (!result.ok) message = result.error;
    } catch {
      // 脱敏失败时只返回固定文案。
    }
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    request.signal.removeEventListener('abort', abortRun);
    finishAgentRun(id, run);
  }
}
