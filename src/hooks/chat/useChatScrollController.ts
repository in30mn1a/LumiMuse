import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

type IdentifiedMessage = {
  id: string;
};

type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

type PrependAnchorOptions = {
  currentScrollTop: number;
  previousFirstId: string | null;
  previousTotalSize: number;
  nextFirstId: string | null;
  nextIds: readonly string[];
  nextTotalSize: number;
};

type UseChatScrollControllerOptions = {
  visibleMessages: readonly IdentifiedMessage[];
  messages: readonly IdentifiedMessage[];
  activeConvId: string | null;
  streamingText: string;
  streamingTargetId: string | null;
  streamingConvId: string | null;
  loadOlderMessages: () => void | Promise<void>;
};

type UsePrependScrollAnchorOptions<T extends IdentifiedMessage> = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  items: readonly T[];
  totalSize: number;
};

type UseScrollTargetVirtualizerOptions<T extends IdentifiedMessage> = {
  targetMessageId: string | null;
  items: readonly T[];
  scrollToIndex: (index: number, options: { align: 'center' }) => void;
  isTargetRendered?: (targetMessageId: string) => boolean;
};

export function isScrollMetricsNearBottom(metrics: ScrollMetrics, threshold = 180): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold;
}

export function getTargetMessageIndex<T extends IdentifiedMessage>(
  messages: readonly T[],
  targetMessageId: string | null,
): number {
  if (!targetMessageId) return -1;
  return messages.findIndex(message => message.id === targetMessageId);
}

export function getPrependAnchorScrollTop({
  currentScrollTop,
  previousFirstId,
  previousTotalSize,
  nextFirstId,
  nextIds,
  nextTotalSize,
}: PrependAnchorOptions): number {
  if (!previousFirstId || !nextFirstId || previousFirstId === nextFirstId) return currentScrollTop;
  if (nextIds.indexOf(previousFirstId) <= 0) return currentScrollTop;
  const delta = nextTotalSize - previousTotalSize;
  return delta > 0 ? currentScrollTop + delta : currentScrollTop;
}

export function usePrependScrollAnchor<T extends IdentifiedMessage>({
  scrollContainerRef,
  items,
  totalSize,
}: UsePrependScrollAnchorOptions<T>): void {
  const lastFirstIdRef = useRef<string | null>(null);
  const lastTotalSizeRef = useRef(0);

  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current;
    const firstId = items[0]?.id ?? null;
    if (!scroller) {
      lastFirstIdRef.current = firstId;
      lastTotalSizeRef.current = totalSize;
      return;
    }

    const nextScrollTop = getPrependAnchorScrollTop({
      currentScrollTop: scroller.scrollTop,
      previousFirstId: lastFirstIdRef.current,
      previousTotalSize: lastTotalSizeRef.current,
      nextFirstId: firstId,
      nextIds: items.map(item => item.id),
      nextTotalSize: totalSize,
    });
    if (nextScrollTop !== scroller.scrollTop) {
      scroller.scrollTop = nextScrollTop;
    }

    lastFirstIdRef.current = firstId;
    lastTotalSizeRef.current = totalSize;
  }, [items, scrollContainerRef, totalSize]);
}

export function useScrollTargetVirtualizer<T extends IdentifiedMessage>({
  targetMessageId,
  items,
  scrollToIndex,
  isTargetRendered,
}: UseScrollTargetVirtualizerOptions<T>): void {
  useEffect(() => {
    const idx = getTargetMessageIndex(items, targetMessageId);
    if (idx === -1 || !targetMessageId) return;
    if (isTargetRendered?.(targetMessageId)) return;
    scrollToIndex(idx, { align: 'center' });
  }, [isTargetRendered, items, scrollToIndex, targetMessageId]);
}

export function useChatScrollController({
  visibleMessages,
  messages,
  activeConvId,
  streamingText,
  streamingTargetId,
  streamingConvId,
  loadOlderMessages,
}: UseChatScrollControllerOptions) {
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const topSentinelNodeRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [topSentinelElement, setTopSentinelElement] = useState<HTMLDivElement | null>(null);
  const pendingScrollRef = useRef<string | null>(null);
  const scrollToBottomOnLoadRef = useRef(false);
  const skipScrollRef = useRef(false);
  const forceScrollToBottomRef = useRef(false);
  const loadOlderMessagesRef = useRef(loadOlderMessages);

  useEffect(() => {
    loadOlderMessagesRef.current = loadOlderMessages;
  }, [loadOlderMessages]);

  const topSentinelRef = useCallback((node: HTMLDivElement | null) => {
    topSentinelNodeRef.current = node;
    setTopSentinelElement(node);
  }, []);

  const isMessageListNearBottom = useCallback(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller) return true;
    return isScrollMetricsNearBottom(scroller);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const markSkipNextScroll = useCallback(() => {
    skipScrollRef.current = true;
  }, []);

  const requestScrollToBottom = useCallback(() => {
    forceScrollToBottomRef.current = true;
  }, []);

  const markTargetForScroll = useCallback((messageId: string) => {
    pendingScrollRef.current = messageId;
    setHighlightedId(messageId);
  }, []);

  const markScrollToBottomOnLoad = useCallback(() => {
    scrollToBottomOnLoadRef.current = true;
  }, []);

  useEffect(() => {
    const id = pendingScrollRef.current;
    if (id) {
      const raf = requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          pendingScrollRef.current = null;
          setTimeout(() => setHighlightedId(null), 2500);
        }
      });
      return () => cancelAnimationFrame(raf);
    }

    if (!scrollToBottomOnLoadRef.current) return;
    const end = messagesEndRef.current;
    const scroller = scrollContainerRef.current;
    if (!end || !scroller) return;

    let cancelled = false;
    let resizeObs: ResizeObserver | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      scrollToBottomOnLoadRef.current = false;
      if (resizeObs) resizeObs.disconnect();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      scroller.removeEventListener('load', onAssetLoad, true);
    };

    const scheduleSettle = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (cancelled) return;
        end.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
        finish();
      }, 300);
    };

    const tryScroll = () => {
      if (cancelled || !scrollToBottomOnLoadRef.current) return;
      end.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
      const sentinel = topSentinelNodeRef.current;
      if (!sentinel) return;
      const rect = sentinel.getBoundingClientRect();
      const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
      if (!inView) {
        scheduleSettle();
      } else if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
    };

    function onAssetLoad() {
      if (cancelled) return;
      requestAnimationFrame(tryScroll);
    }

    resizeObs = new ResizeObserver(() => {
      if (cancelled) return;
      requestAnimationFrame(tryScroll);
    });
    Array.from(scroller.children).forEach(child => resizeObs!.observe(child as Element));
    scroller.addEventListener('load', onAssetLoad, true);

    const rafId = requestAnimationFrame(tryScroll);
    fallbackTimer = setTimeout(() => {
      tryScroll();
      finish();
    }, 3000);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (resizeObs) resizeObs.disconnect();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (settleTimer) clearTimeout(settleTimer);
      scroller.removeEventListener('load', onAssetLoad, true);
    };
  }, [visibleMessages]);

  useEffect(() => {
    if (streamingText && !streamingTargetId && streamingConvId === activeConvId && isMessageListNearBottom()) {
      scrollToBottom('smooth');
    }
  }, [activeConvId, isMessageListNearBottom, scrollToBottom, streamingConvId, streamingTargetId, streamingText]);

  useEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
    const forceScrollToBottom = forceScrollToBottomRef.current;
    if (forceScrollToBottom || (!scrollToBottomOnLoadRef.current && isMessageListNearBottom())) {
      const raf = requestAnimationFrame(() => {
        scrollToBottom(forceScrollToBottom ? 'instant' as ScrollBehavior : 'smooth');
        forceScrollToBottomRef.current = false;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [isMessageListNearBottom, messages, scrollToBottom]);

  useEffect(() => {
    const sentinel = topSentinelElement;
    if (!sentinel) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !scrollToBottomOnLoadRef.current) {
        void loadOlderMessagesRef.current();
      }
    }, { threshold: 0.1 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [topSentinelElement]);

  return {
    highlightedId,
    messagesEndRef,
    topSentinelRef,
    scrollContainerRef,
    pendingScrollRef,
    scrollToBottomOnLoadRef,
    setHighlightedId,
    markSkipNextScroll,
    requestScrollToBottom,
    markTargetForScroll,
    markScrollToBottomOnLoad,
    isMessageListNearBottom,
    scrollToBottom,
  };
}

export type UseChatScrollControllerResult = ReturnType<typeof useChatScrollController>;
