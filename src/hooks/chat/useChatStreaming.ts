import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

type UseChatStreamingOptions = {
  activeConvId: string | null;
};

type BeginStreamOptions = {
  regenerateAssistantId?: string;
};

type FinishStreamOptions = {
  clearRegenerationState?: boolean;
};

type RegenerationTargetsByConversation = Record<string, string>;

export function useChatStreaming({ activeConvId }: UseChatStreamingOptions) {
  const [streamingText, setStreamingText] = useState('');
  const [regenerationTargetIdsByConv, setRegenerationTargetIdsByConv] = useState<RegenerationTargetsByConversation>({});
  const [isLoading, setIsLoading] = useState(false);
  // 记录当前正在流式显示的对话 ID（最后一个发起流的对话）
  const [streamingConvId, setStreamingConvId] = useState<string | null>(null);
  // 所有正在生成中的对话 ID 集合（用于判断切回某对话时是否仍在生成）
  const [activeStreams, setActiveStreams] = useState<Set<string>>(new Set());
  // 网络流会持有启动时的 callback；同步 ref 始终指向当前对话，避免旧闭包污染可见状态。
  const currentActiveConvIdRef = useRef(activeConvId);
  // 当前活跃的流式 convId ref（闭包内用来判断自己是否还是最新流，控制 streamingText 写入）
  const activeStreamConvRef = useRef<string | null>(null);
  // 停止生成用的 AbortController ref
  const abortControllerRef = useRef<AbortController | null>(null);
  // 每个对话独立的 AbortController（支持并发流时精确停止）
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const streamingFrameRef = useRef<number | null>(null);
  const pendingStreamingTextRef = useRef('');
  const streamingBuffersRef = useRef<Map<string, string>>(new Map());
  const activeStreamsRef = useRef<Set<string>>(activeStreams);
  const streamingTargetId = activeConvId ? regenerationTargetIdsByConv[activeConvId] ?? null : null;
  const hiddenMessageId = streamingTargetId;

  useLayoutEffect(() => {
    currentActiveConvIdRef.current = activeConvId;
  }, [activeConvId]);

  useEffect(() => {
    activeStreamsRef.current = activeStreams;
  }, [activeStreams]);

  // 切换对话时从对应 buffer 恢复正在生成的文本；没有活跃流则清空可见状态。
  useEffect(() => {
    const hasActiveStream = Boolean(activeConvId && activeStreamsRef.current.has(activeConvId));
    const bufferedText = hasActiveStream && activeConvId
      ? streamingBuffersRef.current.get(activeConvId) ?? ''
      : '';
    if (streamingFrameRef.current !== null) {
      cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
    activeStreamConvRef.current = hasActiveStream ? activeConvId : null;
    pendingStreamingTextRef.current = bufferedText;
    setStreamingText(bufferedText);
    setStreamingConvId(hasActiveStream ? activeConvId : null);
    setIsLoading(hasActiveStream);
  }, [activeConvId]);

  const clearStreamingText = useCallback(() => {
    setStreamingText('');
  }, []);

  const scheduleStreamingText = useCallback((convId: string, text: string) => {
    streamingBuffersRef.current.set(convId, text);
    if (currentActiveConvIdRef.current !== convId) return;
    pendingStreamingTextRef.current = text;
    if (streamingFrameRef.current !== null) return;
    streamingFrameRef.current = requestAnimationFrame(() => {
      streamingFrameRef.current = null;
      setStreamingText(pendingStreamingTextRef.current);
    });
  }, []);

  useEffect(() => () => {
    if (streamingFrameRef.current !== null) {
      cancelAnimationFrame(streamingFrameRef.current);
    }
  }, []);

  const handleStop = useCallback(() => {
    // 停止当前对话的流
    const currentActiveConvId = currentActiveConvIdRef.current;
    if (currentActiveConvId && abortControllersRef.current.has(currentActiveConvId)) {
      abortControllersRef.current.get(currentActiveConvId)!.abort();
    } else {
      abortControllerRef.current?.abort();
    }
  }, []);

  const beginStream = useCallback((convId: string, options?: BeginStreamOptions) => {
    streamingBuffersRef.current.set(convId, '');
    if (currentActiveConvIdRef.current === convId) {
      activeStreamConvRef.current = convId;
      setIsLoading(true);
      setStreamingText('');
      setStreamingConvId(convId);
    }
    const next = new Set(activeStreamsRef.current).add(convId);
    activeStreamsRef.current = next;
    setActiveStreams(next);
    const targetId = options?.regenerateAssistantId;
    if (targetId) {
      setRegenerationTargetIdsByConv(prev => ({
        ...prev,
        [convId]: targetId,
      }));
    } else {
      setRegenerationTargetIdsByConv(prev => {
        if (!prev[convId]) return prev;
        const next = { ...prev };
        delete next[convId];
        return next;
      });
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    abortControllersRef.current.set(convId, controller);
    return controller;
  }, []);

  const finishStream = useCallback((convId: string, options?: FinishStreamOptions) => {
    streamingBuffersRef.current.delete(convId);
    // 只有结束的流仍拥有当前可见流状态时才清理，避免后台流结束时打断另一个会话的流式显示。
    if (currentActiveConvIdRef.current === convId) {
      activeStreamConvRef.current = null;
      setIsLoading(false);
      setStreamingText('');
      setStreamingConvId(null);
    }
    if (options?.clearRegenerationState) {
      setRegenerationTargetIdsByConv(prev => {
        if (!prev[convId]) return prev;
        const next = { ...prev };
        delete next[convId];
        return next;
      });
    }
    const next = new Set(activeStreamsRef.current);
    next.delete(convId);
    activeStreamsRef.current = next;
    setActiveStreams(next);
    abortControllersRef.current.delete(convId);
    abortControllerRef.current = null;
  }, []);

  return {
    streamingText,
    hiddenMessageId,
    streamingTargetId,
    isLoading,
    streamingConvId,
    activeStreams,
    activeStreamsRef,
    activeStreamConvRef,
    clearStreamingText,
    scheduleStreamingText,
    handleStop,
    beginStream,
    finishStream,
  };
}

export type UseChatStreamingResult = ReturnType<typeof useChatStreaming>;
