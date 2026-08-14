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
  /**
   * 目标是否已就位 —— 既挂上了 DOM，也真的落进了滚动视口。
   * 只判「已挂载」不够：虚拟列表会先把行渲染在视口外，此时停手用户仍然看不到目标。
   */
  isTargetSettled?: (targetMessageId: string) => boolean;
  /**
   * 通知虚拟列表「容器滚动位置已变」。
   * scrollToIndex 是直接给 scrollTop 赋值的：当赋的值与当前值相同（重试时必然如此），
   * 浏览器不会派发 scroll 事件，虚拟列表的内部 offset 就再也追不上真实 DOM，
   * 从而卡在「DOM 已滚到目标、渲染窗口却停在开头」的死锁里。
   */
  syncScrollOffset?: () => void;
};

/**
 * 搜索跳转定位的重试上限（单位：帧）。
 * 虚拟列表行高是 estimateSize 估算值，scrollToIndex 落点会随 measureElement 重测而漂移，
 * 单次调用常常滚不到目标；重试到目标真正挂上 DOM 为止，上限用于兜底避免无限循环。
 */
const SCROLL_TO_INDEX_MAX_ATTEMPTS = 60;
/**
 * 等目标行出现后再 scrollIntoView 精确居中的重试上限（单位：帧）。
 * 必须比 SCROLL_TO_INDEX_MAX_ATTEMPTS 宽裕：要先等上面那轮把目标滚进视口，这一步才有节点可用。
 */
const PENDING_SCROLL_MAX_ATTEMPTS = 180;

type ActiveScrollTarget = {
  id: string;
  requestId: number;
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
  isTargetSettled,
  syncScrollOffset,
}: UseScrollTargetVirtualizerOptions<T>): void {
  // 尝试次数跨 render 累计（本 effect 的依赖含内联回调，每次 render 都会重跑），
  // 切换目标时归零，避免一次跳转的重试预算被后续跳转继承。
  const attemptsRef = useRef(0);
  const attemptedTargetRef = useRef<string | null>(null);

  useEffect(() => {
    if (!targetMessageId) {
      // null 是一次定位生命周期的明确结束；之后即使再次定位同一 ID，也必须重新获得完整预算。
      attemptedTargetRef.current = null;
      attemptsRef.current = 0;
      return;
    }
    const idx = getTargetMessageIndex(items, targetMessageId);
    if (idx === -1) return;

    if (attemptedTargetRef.current !== targetMessageId) {
      attemptedTargetRef.current = targetMessageId;
      attemptsRef.current = 0;
    }
    if (isTargetSettled?.(targetMessageId)) return;

    let raf = 0;
    const scrollUntilTargetSettled = () => {
      if (isTargetSettled?.(targetMessageId)) return;
      if (attemptsRef.current >= SCROLL_TO_INDEX_MAX_ATTEMPTS) return;
      attemptsRef.current += 1;
      scrollToIndex(idx, { align: 'center' });
      // 让虚拟列表把内部 offset 对齐到刚写入的 scrollTop，否则下一帧仍按旧 offset 重算同一个值。
      syncScrollOffset?.();
      raf = requestAnimationFrame(scrollUntilTargetSettled);
    };
    scrollUntilTargetSettled();

    return () => cancelAnimationFrame(raf);
  }, [isTargetSettled, items, scrollToIndex, syncScrollOffset, targetMessageId]);
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
  const [activeScrollTarget, setActiveScrollTarget] = useState<ActiveScrollTarget | null>(null);
  const [topSentinelElement, setTopSentinelElement] = useState<HTMLDivElement | null>(null);
  const pendingScrollRef = useRef<string | null>(null);
  const scrollTargetRequestIdRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeConvIdRef = useRef(activeConvId);
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

  const clearHighlightTimer = useCallback(() => {
    if (highlightTimerRef.current === null) return;
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (activeConvIdRef.current === activeConvId) return;
    activeConvIdRef.current = activeConvId;
    scrollTargetRequestIdRef.current += 1;
    pendingScrollRef.current = null;
    // 旧会话尚未完成的滚底请求同样失效；新会话加载完成后会重新显式标记。
    scrollToBottomOnLoadRef.current = false;
    clearHighlightTimer();
    setHighlightedId(null);
    setActiveScrollTarget(null);
  }, [activeConvId, clearHighlightTimer]);

  const markTargetForScroll = useCallback((messageId: string) => {
    clearHighlightTimer();
    const requestId = scrollTargetRequestIdRef.current + 1;
    scrollTargetRequestIdRef.current = requestId;
    pendingScrollRef.current = messageId;
    setActiveScrollTarget({ id: messageId, requestId });
    setHighlightedId(messageId);
  }, [clearHighlightTimer]);

  const markScrollToBottomOnLoad = useCallback(() => {
    scrollToBottomOnLoadRef.current = true;
  }, []);

  useEffect(() => {
    const target = activeScrollTarget;
    if (target) {
      const { id, requestId } = target;
      // 目标行由虚拟列表异步挂载（见 useScrollTargetVirtualizer），首帧通常还取不到节点。
      // 逐帧重试到节点出现为止；超出上限就放弃并清空 pending，避免长时间后才突然跳转。
      let raf = 0;
      let attempts = 0;
      const scrollToTargetWhenRendered = () => {
        if (scrollTargetRequestIdRef.current !== requestId) return;
        const el = document.getElementById(`msg-${id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          pendingScrollRef.current = null;
          setActiveScrollTarget(current => current?.requestId === requestId ? null : current);
          clearHighlightTimer();
          const timer = setTimeout(() => {
            if (scrollTargetRequestIdRef.current !== requestId) return;
            setHighlightedId(current => current === id ? null : current);
            if (highlightTimerRef.current === timer) highlightTimerRef.current = null;
          }, 2500);
          highlightTimerRef.current = timer;
          return;
        }
        if (attempts >= PENDING_SCROLL_MAX_ATTEMPTS) {
          pendingScrollRef.current = null;
          setHighlightedId(current => current === id ? null : current);
          setActiveScrollTarget(current => current?.requestId === requestId ? null : current);
          return;
        }
        attempts += 1;
        raf = requestAnimationFrame(scrollToTargetWhenRendered);
      };
      raf = requestAnimationFrame(scrollToTargetWhenRendered);
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
  }, [activeScrollTarget, clearHighlightTimer, visibleMessages]);

  useEffect(() => () => {
    scrollTargetRequestIdRef.current += 1;
    clearHighlightTimer();
  }, [clearHighlightTimer]);

  // 流式跟随：直接写 scrollTop 而非 scrollIntoView('smooth')。
  // 每帧发起平滑动画会与流式内容的高度增长竞态（目标位置每帧都在变，动画可能停在过时偏移，
  // 移动端浏览器上表现为回跳到上一条气泡）；直接赋值每帧小步跟随，增量小、视觉上依然平滑。
  // 赋值超出范围时浏览器会自动钳制到 scrollHeight - clientHeight，即真正的底部。
  useEffect(() => {
    if (!streamingText || streamingTargetId || streamingConvId !== activeConvId || !isMessageListNearBottom()) {
      return;
    }
    const scroller = scrollContainerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [activeConvId, isMessageListNearBottom, scrollContainerRef, streamingConvId, streamingTargetId, streamingText]);

  useEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
    // 搜索跳转进行中：消息刚灌进来时列表还没撑开，isMessageListNearBottom 会误判为「在底部」
    // 而滚到底，把正在重试的目标定位冲掉。定位期间不参与自动滚底。
    if (pendingScrollRef.current) return;
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
    activeScrollTargetId: activeScrollTarget?.id ?? null,
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
