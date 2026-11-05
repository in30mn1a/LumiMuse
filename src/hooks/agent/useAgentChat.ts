'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentContextStatus } from '@/lib/agent/context';
import type { AgentMessageView } from '@/lib/agent/messages';
import type { AgentSession } from '@/lib/agent/store';
import { HttpResponseError, getErrorMessage, parseJsonResponse } from '@/lib/http';
import { readAgentStream, type AgentStreamEvent } from './agent-stream';

export interface AgentSessionDetail {
  session: AgentSession;
  messages: AgentMessageView[];
  /** 服务端仍有一轮在跑（例如刷新页面、或停止后服务端还没收尾） */
  running: boolean;
  /** 当前上下文占用；服务端算不出来时为 null */
  context?: AgentContextStatus | null;
}

export type LiveSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; arguments: string; state: 'running' | 'ok' | 'error'; error?: string }
  | { kind: 'note'; text: string }
  | { kind: 'compaction'; state: 'running' | 'done'; summary?: string; tokensBefore?: number };

/** 正在流式进行的一轮。结束后重新读取会话历史，以数据库为准。 */
export interface LiveTurn {
  sessionId: string;
  userContent: string;
  /**
   * 发送时已知的最大消息 id（id 自增且不复用）。服务端在一轮开头就写入主人的消息，
   * 这一轮进行中读到的历史里比它新的行（例如新会话导航后的首次读取）由实时内容显示，不再重复列出。
   */
  afterMessageId: number;
  segments: LiveSegment[];
  error: string | null;
  /** 本轮最近一次请求前的上下文占用；还没收到时为 null */
  context: AgentContextStatus | null;
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
    case 'tool_end': {
      // 前一回合已完成的同 ID 调用保持原状态，只结束当前运行的实例。
      const index = turn.segments.findIndex(segment => segment.kind === 'tool'
        && segment.id === event.id && segment.name === event.name && segment.state === 'running');
      if (index === -1) return turn;
      return {
        ...turn,
        segments: turn.segments.map((segment, current) => (current === index && segment.kind === 'tool'
          ? { ...segment, state: event.ok ? 'ok' : 'error', error: event.error }
          : segment)),
      };
    }
    case 'note':
      return { ...turn, segments: [...turn.segments, { kind: 'note', text: event.text }] };
    case 'context':
      return { ...turn, context: event.context };
    case 'compaction': {
      const index = turn.segments.findLastIndex(segment => segment.kind === 'compaction' && segment.state === 'running');
      if (event.phase === 'start') {
        return { ...turn, segments: [...turn.segments, { kind: 'compaction', state: 'running' }] };
      }
      // 失败时只撤下进行中的提示，失败原因由随后的 note 显示
      const rest = index === -1 ? turn.segments : turn.segments.filter((_, current) => current !== index);
      if (event.phase === 'failed') return { ...turn, segments: rest };
      const done: LiveSegment = { kind: 'compaction', state: 'done', summary: event.summary, tokensBefore: event.tokensBefore };
      return {
        ...turn,
        segments: index === -1 ? [...rest, done] : [...rest.slice(0, index), done, ...rest.slice(index)],
      };
    }
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
  /** 最近一次读到的历史，发送时据此确定实时内容从哪条消息之后开始 */
  const detailRef = useRef<AgentSessionDetail | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  /** 本页这条流属于哪个会话；停止当前会话时据此决定中止本地流还是请服务端停 */
  const streamSessionRef = useRef<string | null>(null);
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
      detailRef.current = next;
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
    streamSessionRef.current = targetId;
    // 发送前读取的历史不含这一轮，不能在它完成后回写旧消息或 running 状态。
    historyRequestRef.current += 1;
    const known = detailRef.current?.session.id === targetId ? detailRef.current.messages : [];
    const afterMessageId = known.reduce((max, message) => Math.max(max, message.id), 0);
    setLive({ sessionId: targetId, userContent: content, afterMessageId, segments: [], error: null, context: null });
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
      streamSessionRef.current = null;
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

  /**
   * 本页持有当前会话的流就直接中止；否则（切走后回来、刷新页面后）请服务端停止，
   * 再由 running 轮询等它收尾，中断记录会随历史一起出现。
   */
  const stop = useCallback(() => {
    const id = currentIdRef.current;
    if (controllerRef.current && streamSessionRef.current === id) {
      controllerRef.current.abort();
      return;
    }
    if (!id) return;
    // 写请求必须带 JSON Content-Type：设了访问密码时 proxy 的 CSRF 校验会以 415 拒绝其它类型
    void fetch(`/api/agent/sessions/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
      .catch(() => undefined)
      .finally(() => {
        if (currentIdRef.current === id) void load(id);
      });
  }, [load]);

  const visibleLive = live && live.sessionId === sessionId ? live : null;
  // 只依赖基线数字：流式文本每来一段都会换 live 对象，不能每次都重排整段历史
  const liveBaseline = visibleLive ? visibleLive.afterMessageId : null;
  const visibleDetail = useMemo(() => {
    if (!currentDetail || liveBaseline === null) return currentDetail;
    if (!currentDetail.messages.some(message => message.id > liveBaseline)) return currentDetail;
    return { ...currentDetail, messages: currentDetail.messages.filter(message => message.id <= liveBaseline) };
  }, [currentDetail, liveBaseline]);

  return {
    detail: visibleDetail,
    /** 当前会话的上下文占用：本轮进行中用实时值，否则用最近读到的历史里的值 */
    context: visibleLive?.context ?? currentDetail?.context ?? null,
    loadError: loadError && loadError.sessionId === sessionId ? loadError : null,
    live: visibleLive,
    /** 本页有一条流在进行（可能属于别的会话） */
    sending,
    serverRunning,
    send,
    stop,
    reload: () => (sessionId ? load(sessionId) : Promise.resolve()),
  };
}
