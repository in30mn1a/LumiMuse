import { useCallback, useEffect, useRef, useState } from 'react';

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
  // 当前活跃的流式 convId ref（闭包内用来判断自己是否还是最新流，控制 streamingText 写入）
  const activeStreamConvRef = useRef<string | null>(null);
  // 停止生成用的 AbortController ref
  const abortControllerRef = useRef<AbortController | null>(null);
  // 每个对话独立的 AbortController（支持并发流时精确停止）
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const streamingFrameRef = useRef<number | null>(null);
  const pendingStreamingTextRef = useRef('');
  const activeStreamsRef = useRef<Set<string>>(activeStreams);
  const streamingTargetId = activeConvId ? regenerationTargetIdsByConv[activeConvId] ?? null : null;
  const hiddenMessageId = streamingTargetId;

  useEffect(() => {
    activeStreamsRef.current = activeStreams;
  }, [activeStreams]);

  // 竞态保护：用户切换对话时立即清空 streamingText / streamingConvId，
  // 避免上一段流尚未结束就把旧文字带到新对话。
  // 切到的目标对话若有后台流在跑（activeStreams 中），等其新 chunk 到达时会重新写回 streaming state。
  useEffect(() => {
    if (streamingConvId && streamingConvId !== activeConvId) {
      queueMicrotask(() => {
        setStreamingText('');
        setStreamingConvId(null);
      });
    }
  }, [activeConvId, streamingConvId]);

  const clearStreamingText = useCallback(() => {
    setStreamingText('');
  }, []);

  const scheduleStreamingText = useCallback((text: string) => {
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
    if (activeConvId && abortControllersRef.current.has(activeConvId)) {
      abortControllersRef.current.get(activeConvId)!.abort();
    } else {
      abortControllerRef.current?.abort();
    }
  }, [activeConvId]);

  const beginStream = useCallback((convId: string, options?: BeginStreamOptions) => {
    setIsLoading(true);
    setStreamingText('');
    setStreamingConvId(convId);
    activeStreamConvRef.current = convId;
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
    // 只有结束的流仍拥有当前可见流状态时才清理，避免后台流结束时打断另一个会话的流式显示。
    if (activeStreamConvRef.current === convId) {
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
