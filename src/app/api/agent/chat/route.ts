import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { agentChatRequestSchema, formatZodFieldErrors } from '@/lib/schemas';
import { publicErrorMessage } from '@/lib/public-error';
import { readJsonObject } from '@/lib/request-json';
import { runAgentTurn } from '@/lib/agent/loop';
import { finishAgentRun, startAgentRun } from '@/lib/agent/runs';
import { getAgentSession } from '@/lib/agent/store';
import { AGENT_TOOLS } from '@/lib/agent/tools';

/**
 * 运行一轮 Agent 对话，以 SSE 推送进度。事件：
 * text、tool_start、tool_end、note、usage、error，最后总是 done（带本轮结束状态）。
 * 连接断开即中止本轮；已完成的回合已经入库。
 */
export async function POST(request: NextRequest) {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const parsed = agentChatRequestSchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const { session_id: sessionId, content } = parsed.data;
  const db = getDb();
  if (!getAgentSession(db, sessionId)) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const run = startAgentRun(sessionId);
  if (!run) {
    return NextResponse.json({ error: '这个会话正在运行，请等它结束或先停止', code: 'agent_busy' }, { status: 409 });
  }

  const abortRun = () => run.abort();
  request.signal.addEventListener('abort', abortRun, { once: true });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        const result = await runAgentTurn({
          db,
          sessionId,
          userContent: content,
          tools: AGENT_TOOLS,
          signal: run.signal,
          events: {
            onText: text => send('text', { text }),
            onToolStart: call => send('tool_start', call),
            onToolEnd: ({ id, name, result: toolResult }) => send('tool_end', {
              id,
              name,
              ok: toolResult.ok,
              ...(toolResult.ok ? {} : { error: toolResult.error }),
            }),
            onUsage: usage => send('usage', usage),
            onNote: text => send('note', { text }),
          },
        });
        if (result.status === 'error') send('error', { error: result.error });
        send('done', { status: result.status, rounds: result.rounds });
      } catch (error) {
        send('error', { error: publicErrorMessage(error, 'Agent 运行失败') });
        send('done', { status: 'error', rounds: 0 });
      } finally {
        request.signal.removeEventListener('abort', abortRun);
        finishAgentRun(sessionId, run);
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      }
    },
    cancel() {
      run.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
