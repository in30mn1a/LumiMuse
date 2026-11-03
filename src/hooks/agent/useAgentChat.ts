'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentMessageView } from '@/lib/agent/messages';
import type { AgentSession } from '@/lib/agent/store';
import { HttpResponseError, getErrorMessage, parseJsonResponse } from '@/lib/http';
import { readAgentStream, type AgentStreamEvent } from './agent-stream';

export interface AgentSessionDetail {
  session: AgentSession;
  messages: AgentMessageView[];
  /** 服务端仍有一轮在跑（例如刷新页面、或停止后服务端还没收尾） */
  running: boolean;
}

export type LiveSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; arguments: string; state: 'running' | 'ok' | 'error'; error?: string }
  | { kind: 'note'; text: string };

/** 正在流式进行的一轮。结束后重新读取会话历史，以数据库为准。 */
export interface LiveTurn {
  sessionId: string;
  userContent: string;
  segments: LiveSegment[];
  error: string | null;
}

export type AgentSendFailure = { kind: 'busy' } | { kind: 'error' | 'interrupted'; message: string };

/** 服务端仍在运行时的轮询间隔 */
const RUNNING_POLL_MS = 1500;

export function applyAgentStreamEvent(turn: LiveTurn, event: AgentStreamEvent): LiveTurn {
  switch (event.type) {
    case 'text': {
      const last = turn.segments[turn.segments.length - 1];
      if (last?.kind === 'text') {
        return { ...turn, segments: [...turn.segments.slice(0, -1), { kind: 'text', text: last.text + event.text }] };
      }
      return { ...turn, segments: [...turn.segments, { kind: 'text', text: event.text }] };
    }
    case 'tool_start':
      return {
        ...turn,
        segments: [...turn.segments, { kind: 'tool', id: event.id, name: event.name, arguments: event.arguments, state: 'running' }],
      };
    case 'tool_end':
      return {
        ...turn,
        segments: turn.segments.map(segment => (segment.kind === 'tool' && segment.id === event.id
          ? { ...segment, state: event.ok ? 'ok' : 'error', error: event.error }
          : segment)),
      };
    case 'note':
      return { ...turn, segments: [...turn.segments, { kind: 'note', text: event.text }] };
    case 'error':
      return { ...turn, error: event.error };
    default:
      return turn;
  }
}

async function fetchSessionDetail(sessionId: string): Promise<AgentSessionDetail> {
  return parseJsonResponse<AgentSessionDetail>(await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`));
}

/**
 * 一个 Agent 会话的历史与发送。同一时间只有一条流；切换会话不会中止正在进行的流，
 * 它照常在服务端跑完，界面只显示当前会话的内容。
 */
export function useAgentChat(sessionId: string | null, options: { onTurnFinished?: () => void } = {}) {
  const [detail, setDetail] = useState<AgentSessionDetail | null>(null);
  const [loadError, setLoadError] = useState<{ sessionId: string; message: string; notFound: boolean } | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const currentIdRef = useRef(sessionId);
  const historyRequestRef = useRef(0);
  const onTurnFinishedRef = useRef(options.onTurnFinished);

  useLayoutEffect(() => {
    currentIdRef.current = sessionId;
    historyRequestRef.current += 1;
    return () => { historyRequestRef.current += 1; };
  }, [sessionId]);

  useEffect(() => {
    onTurnFinishedRef.current = options.onTurnFinished;
  });

  const load = useCallback(async (id: string) => {
    const requestId = ++historyRequestRef.current;
    try {
      const next = await fetchSessionDetail(id);
      if (currentIdRef.current !== id || historyRequestRef.current !== requestId) return;
      setDetail(next);
      setLoadError(null);
    } catch (error) {
      if (currentIdRef.current !== id || historyRequestRef.current !== requestId) return;
      setLoadError({
        sessionId: id,
        message: getErrorMessage(error),
        notFound: error instanceof HttpResponseError && error.status === 404,
      });
    }
  }, []);

  useEffect(() => {
    // 状态写入都在请求返回之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (sessionId) void load(sessionId);
  }, [sessionId, load]);

  const sending = live !== null;
  const currentDetail = detail && detail.session.id === sessionId ? detail : null;
  const serverRunning = Boolean(currentDetail?.running) && !sending;

  // 刷新页面后、或停止后服务端还在收尾时，轮询到它结束为止
  useEffect(() => {
    if (!serverRunning || !sessionId) return;
    const timer = window.setTimeout(() => void load(sessionId), RUNNING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [serverRunning, sessionId, currentDetail, load]);

  /** 未接受的请求返回 error/busy；已接受后的流失败返回 interrupted，不恢复已发送的草稿。 */
  const send = useCallback(async (targetId: string, content: string): Promise<AgentSendFailure | null> => {
    if (controllerRef.current) return { kind: 'busy' };
    const controller = new AbortController();
    controllerRef.current = controller;
    // 发送前读取的历史不含这一轮，不能在它完成后回写旧消息或 running 状态。
    historyRequestRef.current += 1;
    setLive({ sessionId: targetId, userContent: content, segments: [], error: null });
    let failure: AgentSendFailure | null = null;
    let accepted = false;
    try {
      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: targetId, content }),
        signal: controller.signal,
      });
      if (!response.ok) {
        try {
          await parseJsonResponse<unknown>(response);
          failure = { kind: 'error', message: `HTTP ${response.status}` };
        } catch (error) {
          const busy = error instanceof HttpResponseError && error.status === 409;
          failure = busy ? { kind: 'busy' } : { kind: 'error', message: getErrorMessage(error) };
        }
        return failure;
      }
      accepted = true;
      if (!response.body) {
        failure = { kind: 'interrupted', message: '' };
        return failure;
      }
      let finished = false;
      await readAgentStream(response.body, event => {
        if (event.type === 'done') finished = true;
        setLive(prev => (prev ? applyAgentStreamEvent(prev, event) : prev));
      });
      if (!finished && !controller.signal.aborted) failure = { kind: 'interrupted', message: '' };
    } catch (error) {
      // 主动停止不算错误；服务端会把已完成的部分和中断记录写进历史
      if (!controller.signal.aborted) {
        const message = getErrorMessage(error);
        failure = { kind: accepted ? 'interrupted' : 'error', message };
        setLive(prev => (prev ? { ...prev, error: message } : prev));
      }
    } finally {
      controllerRef.current = null;
      if (currentIdRef.current === targetId) {
        if (accepted || !failure) await load(targetId);
        // 发送失败也要重启已失效的历史读取，但不能等 GET 才还原草稿和显示错误。
        else void load(targetId);
      }
      setLive(null);
      if (accepted || !failure) onTurnFinishedRef.current?.();
    }
    return failure;
  }, [load]);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return {
    detail: currentDetail,
    loadError: loadError && loadError.sessionId === sessionId ? loadError : null,
    live: live && live.sessionId === sessionId ? live : null,
    /** 本页有一条流在进行（可能属于别的会话） */
    sending,
    serverRunning,
    send,
    stop,
    reload: () => (sessionId ? load(sessionId) : Promise.resolve()),
  };
}
