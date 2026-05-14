'use client';

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { Character, Conversation, Message, Memory } from '@/types';
import MessageBubble from './MessageBubble';
import ChatInput from './ChatInput';
import { useTranslation } from '@/lib/i18n-context';
import { estimateTokens } from '@/lib/token-counter';
import { formatDateLabel, formatDateTime, formatShortDate, getVersionInfo, isSameDay } from '@/lib/chat-view-utils';
import {
  ChevronDownIcon,
  ClockIcon,
  DuplicateIcon,
  ImageIcon,
  ListIcon,
  MemoryIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  SparkIcon,
  SummaryIcon,
  TrashIcon,
} from '@/components/ui/icons';

const PAGE_SIZE = 60; // 每次从后端加载的消息数

function buildClientTimePayload() {
  return {
    client_now_iso: new Date().toISOString(),
    client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    client_utc_offset_minutes: new Date().getTimezoneOffset(),
  };
}

/* ── 轻量 Toast ─────────────────────────────────────────── */
interface ToastItem { id: number; message: string; type: 'error' | 'info' }

function Toast({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map(item => (
        <div
          key={item.id}
          onClick={() => onDismiss(item.id)}
          className={`pointer-events-auto flex cursor-pointer items-center gap-2 rounded-2xl border px-4 py-2.5 text-sm shadow-lg backdrop-blur-xl transition-all ${
            item.type === 'error'
              ? 'border-red-200/60 bg-red-50/90 text-red-700'
              : 'border-accent/20 bg-white/90 text-text-primary'
          }`}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}

interface Props {
  character: Character | null;
  conversationId: string | null;
  targetMessageId?: string | null;
  onOpenSidebar?: () => void;
  onOpenSearch?: () => void;
}

type MessagesResponse = {
  messages: Message[];
  hasMore: boolean;
  oldestSeq: number | null;
};

function messagesUrl(conversationId: string, options?: { limit?: number; beforeSeq?: number | null; all?: boolean }): string {
  const params = new URLSearchParams({ conversation_id: conversationId });
  if (options?.all) params.set('all', '1');
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.beforeSeq !== undefined && options.beforeSeq !== null) params.set('before_seq', String(options.beforeSeq));
  return `/api/messages?${params}`;
}

async function fetchMessagesPage(conversationId: string, options?: { limit?: number; beforeSeq?: number | null; all?: boolean; signal?: AbortSignal }): Promise<MessagesResponse> {
  const response = await fetch(messagesUrl(conversationId, options), { signal: options?.signal });
  const data = await response.json();
  if (Array.isArray(data)) {
    return { messages: data, hasMore: false, oldestSeq: data[0]?.seq ?? null };
  }
  return data as MessagesResponse;
}

export default function ChatView({ character, conversationId, targetMessageId, onOpenSidebar, onOpenSearch }: Props) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [hiddenMessageId, setHiddenMessageId] = useState<string | null>(null);
  const [streamingTargetId, setStreamingTargetId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // 记录当前正在流式显示的对话 ID（最后一个发起流的对话）
  const [streamingConvId, setStreamingConvId] = useState<string | null>(null);
  // 所有正在生成中的对话 ID 集合（用于判断切回某对话时是否仍在生成）
  const [activeStreams, setActiveStreams] = useState<Set<string>>(new Set());
  // 当前活跃的流式 convId ref（闭包内用来判断自己是否还是最新流，控制 streamingText 写入）
  const activeStreamConvRef = useRef<string | null>(null);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(conversationId);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // 顶部哨兵：滚到顶时加载更多历史消息
  const topSentinelRef = useRef<HTMLDivElement>(null);
  // 高亮目标消息
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // 历史消息分页状态
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [oldestLoadedSeq, setOldestLoadedSeq] = useState<number | null>(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const hasCharacter = Boolean(character);

  // 停止生成用的 AbortController ref
  const abortControllerRef = useRef<AbortController | null>(null);
  // 每个对话独立的 AbortController（支持并发流时精确停止）
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // 连点新对话防重
  const [creating, setCreating] = useState(false);
  // 总结上下文
  const [summarizing, setSummarizing] = useState(false);
  // 复制对话
  const [duplicating, setDuplicating] = useState(false);
  // 重置提取状态弹窗
  const [resetExtractionOpen, setResetExtractionOpen] = useState(false);
  const [resetSelectedIds, setResetSelectedIds] = useState<Set<string>>(new Set());
  const RESET_PAGE_SIZE = 30;
  const [resetVisibleCount, setResetVisibleCount] = useState(RESET_PAGE_SIZE);
  // 移动端对话列表抽屉
  const [convDrawerOpen, setConvDrawerOpen] = useState(false);
  // 移动端工具栏展开（拉片）
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  // 图片管理弹窗
  const [imageManagerOpen, setImageManagerOpen] = useState(false);
  const [characterImages, setCharacterImages] = useState<Array<{
    messageId: string; conversationId: string; conversationTitle: string;
    createdAt: string; imageId: string; versionId: string; url: string;
  }>>([]);
  const [loadingCharacterImages, setLoadingCharacterImages] = useState(false);
  const [selectedImageKeys, setSelectedImageKeys] = useState<Set<string>>(new Set());
  const [previewImageIndex, setPreviewImageIndex] = useState<number | null>(null);
  const IMAGE_MANAGER_PAGE_SIZE = 12;
  const [imageManagerPage, setImageManagerPage] = useState(0);
  // 轻量 Toast
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);
  const seenMemoryTaskRef = useRef<Record<string, string>>({});
  const previousCharacterIdRef = useRef<string | null>(character?.id ?? null);
  const streamingFrameRef = useRef<number | null>(null);
  const pendingStreamingTextRef = useRef('');

  const isMessageListNearBottom = useCallback(() => {
    const end = messagesEndRef.current;
    const scroller = end?.parentElement;
    if (!scroller) return true;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 180;
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

  const showToast = useCallback((message: string, type: ToastItem['type'] = 'error') => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const activeConversation = useMemo(
    () => conversations.find(conversation => conversation.id === activeConvId) || null,
    [activeConvId, conversations],
  );

  const memoryCount = memories.length;
  const recentMemories = useMemo(() => memories.slice(0, 2), [memories]);
  const memoryCategoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const memory of memories) {
      map.set(memory.category, (map.get(memory.category) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [memories]);

  const messageTokens = useMemo(() => {
    // 有 summary 消息时，只计算最后一条 summary 及其之后的消息 token
    // 这样 token 数才能反映实际发送给 AI 的上下文大小
    const lastSummaryIdx = messages.findLastIndex(m => {
      const meta = (m.metadata || {}) as Record<string, unknown>;
      return meta.isSummary === true;
    });
    const relevant = lastSummaryIdx >= 0 ? messages.slice(lastSummaryIdx) : messages;
    return relevant.reduce((sum, m) => sum + (m.token_count || 0), 0);
  }, [messages]);

  const systemPromptTokens = useMemo(() => {
    if (!character) return 0;
    let text = '';
    if (character.system_prompt) text += character.system_prompt + '\n';
    if (character.personality) text += character.personality + '\n';
    if (character.scenario) text += character.scenario + '\n';
    if (character.example_dialogue) text += character.example_dialogue + '\n';
    const memText = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
    if (memText) text += memText + '\n';
    return estimateTokens(text);
  }, [character, memories]);

  const tokenCount = messageTokens + systemPromptTokens;

  // 未提取记忆的用户消息数
  const unextractedCount = useMemo(() => {
    return messages.filter(m => {
      if (m.role !== 'user') return false;
      const meta = m.metadata as Record<string, unknown> || {};
      return !meta.memory_extracted;
    }).length;
  }, [messages]);
  const loadCharacterState = async (characterId: string, preferredConversationId: string | null) => {
    setLoadingThread(true);
    try {
      const [conversationResponse, memoryResponse] = await Promise.all([
        fetch(`/api/conversations?character_id=${characterId}`),
        fetch(`/api/memories?character_id=${characterId}`),
      ]);

      const conversationList = await conversationResponse.json();
      const memoryList = await memoryResponse.json();
      setConversations(conversationList);
      setMemories(memoryList);

      const nextActive = preferredConversationId && conversationList.some((item: Conversation) => item.id === preferredConversationId)
        ? preferredConversationId
        : conversationList[0]?.id || null;
      setActiveConvId(nextActive);

      if (!nextActive) {
        setMessages([]);
        setStreamingText('');
      }
    } finally {
      setLoadingThread(false);
    }
  };

  useEffect(() => {
    queueMicrotask(() => setActiveConvId(conversationId));
  }, [conversationId]);

  useEffect(() => {
    if (!character) {
      queueMicrotask(() => {
        setConversations([]);
        setMemories([]);
        setMessages([]);
        setStreamingText('');
        setActiveConvId(null);
      });
      previousCharacterIdRef.current = null;
      return;
    }

    const isCharacterChanged = previousCharacterIdRef.current !== character.id;
    previousCharacterIdRef.current = character.id;

    if (isCharacterChanged) {
      queueMicrotask(() => {
        setMessages([]);
        setStreamingText('');
      });
    }

    const timer = setTimeout(() => {
      void loadCharacterState(character.id, conversationId);
    }, 0);

    return () => clearTimeout(timer);
  }, [character, conversationId]);

  // 待滚动的目标消息 id，等 DOM 渲染完后执行
  const pendingScrollRef = useRef<string | null>(null);
  // 标记当前是否处于"初始加载滚底"阶段，防止顶部哨兵误触发后丢失底部位置
  const scrollToBottomOnLoadRef = useRef(false);

  useEffect(() => {
    if (!activeConvId) return;
    const ctl = new AbortController();
    const needsTarget = Boolean(targetMessageId);
    fetchMessagesPage(activeConvId, { limit: PAGE_SIZE, all: needsTarget, signal: ctl.signal })
      .then(({ messages: msgs, hasMore, oldestSeq }) => {
        setMessages(msgs);
        setHasOlderMessages(hasMore);
        setOldestLoadedSeq(oldestSeq);

        if (targetMessageId) {
          const idx = msgs.findIndex(m => m.id === targetMessageId);
          if (idx !== -1) {
            // 记录待滚动目标，等 DOM 更新后的 useEffect 来执行
            pendingScrollRef.current = targetMessageId;
            setHighlightedId(targetMessageId);
          }
        } else {
          // 标记需要滚到底部，等 DOM 稳定后执行
          scrollToBottomOnLoadRef.current = true;
        }
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [activeConvId, targetMessageId]);

  // messages 变化后，处理两种滚动需求：
  // 1. 搜索跳转到目标消息
  // 2. 初始加载/切换对话后滚到底部（用 instant 避免 IntersectionObserver 扩展时的抖动）
  useEffect(() => {
    // 优先处理目标消息跳转
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

    // 初始加载阶段：messages 变化后滚到底部（instant 不产生动画）
    // 直到顶部哨兵不再触发为止（即内容已超出视口高度）
    if (scrollToBottomOnLoadRef.current) {
      const raf = requestAnimationFrame(() => {
        const end = messagesEndRef.current;
        if (!end) return;
        end.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
        // 检查顶部哨兵是否还在视口内，若已不可见说明内容足够长，初始加载完成
        const sentinel = topSentinelRef.current;
        if (sentinel) {
          const rect = sentinel.getBoundingClientRect();
          const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
          if (!inView) {
            scrollToBottomOnLoadRef.current = false;
          }
        }
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [messages]);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(s => setShowTimestamps(s.show_timestamps ?? true));
  }, []);

  useEffect(() => {
    // 流式生成时跟随滚动（smooth），初始加载由上面的 effect 处理
    // 只有当前对话就是正在生成的对话时才自动滚动
    if (streamingText && !streamingTargetId && streamingConvId === activeConvId && isMessageListNearBottom()) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeConvId, isMessageListNearBottom, streamingConvId, streamingTargetId, streamingText]);

  // 标记"本次 setMessages 不需要滚动"（用于生图等只更新 metadata 的场景）
  const skipScrollRef = useRef(false);
  // 用户主动发送消息后，无论新消息高度如何变化，都要在 DOM 更新后滚到底部
  const forceScrollToBottomRef = useRef(false);

  // 后台流完成时，如果用户正在看那个对话，刷新消息列表
  const prevActiveStreamsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevActiveStreamsRef.current;
    // 找到从 prev 中消失的 convId（即刚完成的流）
    if (activeConvId && prev.has(activeConvId) && !activeStreams.has(activeConvId)) {
      // 当前对话的流刚完成，刷新消息
      fetchMessagesPage(activeConvId, { limit: Math.max(PAGE_SIZE, messages.length) })
        .then(({ messages: freshMessages, hasMore, oldestSeq }) => {
          setMessages(freshMessages);
          setHasOlderMessages(hasMore);
          setOldestLoadedSeq(oldestSeq);
        })
        .catch(() => {});
    }
    prevActiveStreamsRef.current = activeStreams;
  }, [activeStreams, activeConvId, messages.length]);

  useEffect(() => {
    // 新消息发送/接收完成后滚到底部（非初始加载阶段）
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
    const forceScrollToBottom = forceScrollToBottomRef.current;
    if (forceScrollToBottom || (!scrollToBottomOnLoadRef.current && isMessageListNearBottom())) {
      const raf = requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: forceScrollToBottom ? 'instant' : 'smooth' });
        forceScrollToBottomRef.current = false;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [isMessageListNearBottom, messages]);

  const refreshMessages = useCallback(async () => {
    if (!activeConvId) return;
    const { messages: freshMessages, hasMore, oldestSeq } = await fetchMessagesPage(activeConvId, { limit: Math.max(PAGE_SIZE, messages.length) });
    setMessages(freshMessages);
    setHasOlderMessages(hasMore);
    setOldestLoadedSeq(oldestSeq);
  }, [activeConvId, messages.length]);

  const refreshMessagesForConversation = useCallback(async (conversationIdToRefresh: string) => {
    const { messages: freshMessages, hasMore, oldestSeq } = await fetchMessagesPage(conversationIdToRefresh, { limit: Math.max(PAGE_SIZE, messages.length) });
    setMessages(freshMessages);
    setHasOlderMessages(hasMore);
    setOldestLoadedSeq(oldestSeq);
  }, [messages.length]);

  const loadOlderMessages = useCallback(async () => {
    if (!activeConvId || !hasOlderMessages || oldestLoadedSeq === null || loadingOlderMessages) return;
    setLoadingOlderMessages(true);
    try {
      const { messages: olderMessages, hasMore, oldestSeq } = await fetchMessagesPage(activeConvId, {
        limit: PAGE_SIZE,
        beforeSeq: oldestLoadedSeq,
      });
      setMessages(prev => [...olderMessages, ...prev]);
      setHasOlderMessages(hasMore);
      setOldestLoadedSeq(oldestSeq);
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [activeConvId, hasOlderMessages, loadingOlderMessages, oldestLoadedSeq]);

  // 顶部哨兵：进入视口时追加一页历史消息
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && !scrollToBottomOnLoadRef.current) {
          // 初始加载阶段不响应哨兵，避免无限扩展
          void loadOlderMessages();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadOlderMessages, messages.length]); // messages 变化时重新绑定（对话切换后哨兵位置变了）

  const pollMemoryTask = useCallback(async (convId: string) => {
    const pollOnce = async (): Promise<boolean> => {
      const response = await fetch(`/api/memory-tasks?conversation_id=${encodeURIComponent(convId)}`);
      if (!response.ok) return false;

      const parsed = await response.json() as { status: string; mergeCount: number; updatedAt: string | null };
      if (parsed.status === 'extracting') {
        return false;
      }

      const taskKey = parsed.updatedAt ? `${parsed.status}:${parsed.updatedAt}` : parsed.status;
      if (parsed.status === 'done' && parsed.mergeCount > 0 && seenMemoryTaskRef.current[convId] !== taskKey) {
        seenMemoryTaskRef.current[convId] = taskKey;
        showToast(`TA 更新了关于你的 ${parsed.mergeCount} 条记忆`, 'info');
      }

      return parsed.status === 'done' || parsed.status === 'failed' || parsed.status === 'idle';
    };

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const finished = await pollOnce();
      if (finished) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }, [showToast]);

  const refreshConversationState = async (nextActiveId?: string | null) => {
    if (!character) return;
    const [conversationResponse, memoryResponse] = await Promise.all([
      fetch(`/api/conversations?character_id=${character.id}`),
      fetch(`/api/memories?character_id=${character.id}`),
    ]);
    const conversationList = await conversationResponse.json();
    const memoryList = await memoryResponse.json();
    setConversations(conversationList);
    setMemories(memoryList);
    // nextActiveId 为 undefined 表示"不改变当前 active"；传 null 或具体 id 才切换
    if (nextActiveId !== undefined) {
      setActiveConvId(nextActiveId && conversationList.some((item: Conversation) => item.id === nextActiveId)
        ? nextActiveId
        : conversationList[0]?.id || null);
    }
  };

  const handleNewChat = async () => {
    if (!character || creating) return;
    setCreating(true);
    try {
      const response = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: character.id }),
      });
      const conversation = await response.json();
      setConversations(prev => [conversation, ...prev]);
      setActiveConvId(conversation.id);

      if (character.greeting) {
        const greetingResponse = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversation.id, role: 'assistant', content: character.greeting, token_count: 0 }),
        });
        const greetingMessage = await greetingResponse.json();
        setMessages([greetingMessage]);
      } else {
        setMessages([]);
      }

      setStreamingText('');
      void refreshConversationState(conversation.id);
    } finally {
      setCreating(false);
    }
  };

  const openRename = () => {
    if (!activeConversation) return;
    setRenameValue(activeConversation.title);
    setRenameOpen(true);
  };

  const handleRenameConv = async () => {
    if (!activeConvId || !renameValue.trim()) return;
    await fetch(`/api/conversations/${activeConvId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: renameValue.trim() }),
    });
    setConversations(prev => prev.map(conversation => (
      conversation.id === activeConvId ? { ...conversation, title: renameValue.trim() } : conversation
    )));
    setRenameOpen(false);
  };

  const handleDeleteConv = async () => {
    if (!activeConvId) return;
    const next = conversations.find(conversation => conversation.id !== activeConvId) || null;
    // 先切换到下一个对话，避免删除时消息区闪白
    setActiveConvId(next?.id || null);
    if (!next) setMessages([]);
    setDeleteOpen(false);
    await fetch(`/api/conversations/${activeConvId}`, { method: 'DELETE' });
    setConversations(prev => prev.filter(conversation => conversation.id !== activeConvId));
    void refreshConversationState(next?.id || null);
  };

  const handleEditMessage = async (id: string, content: string, attachments?: Array<{ type: string; name: string; data?: string; url?: string; mimeType: string }>) => {
    await fetch(`/api/messages/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // attachments 始终传（空数组表示清除所有附件）
      body: JSON.stringify({ content, attachments: attachments ?? [] }),
    });
    await refreshMessages();
  };

  const handleDeleteMessage = async (id: string) => {
    const res = await fetch(`/api/messages/${id}`, { method: 'DELETE' });
    const data = await res.json() as { ok: boolean; deleted: 'message' | 'version'; message?: Message };
    if (data.deleted === 'version' && data.message) {
      // 只删了一个版本，用返回的更新后消息替换
      setMessages(prev => prev.map(m => m.id === id ? data.message! : m));
    } else {
      // 整条消息被删除
      setMessages(prev => prev.filter(m => m.id !== id));
    }
  };

  const handleStop = useCallback(() => {
    // 停止当前对话的流
    if (activeConvId && abortControllersRef.current.has(activeConvId)) {
      abortControllersRef.current.get(activeConvId)!.abort();
    } else {
      abortControllerRef.current?.abort();
    }
  }, [activeConvId]);

  const callChatStream = async (convId: string, userContent: string, regenerateAssistantId?: string, skipUserInsert?: boolean) => {
    setIsLoading(true);
    setStreamingText('');
    setStreamingConvId(convId);
    activeStreamConvRef.current = convId;
    setActiveStreams(prev => new Set(prev).add(convId));
    // 重新生成时隐藏原消息，避免流式气泡和原消息同时显示
    if (regenerateAssistantId) {
      setHiddenMessageId(regenerateAssistantId);
      setStreamingTargetId(regenerateAssistantId);
    } else {
      setStreamingTargetId(null);
    }

    // 每次生成创建新的 AbortController
    const ctl = new AbortController();
    abortControllerRef.current = ctl;
    abortControllersRef.current.set(convId, ctl);
    // 闭包内捕获本次流的 convId，用于判断是否仍是活跃流
    const myConvId = convId;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          content: userContent,
          ...buildClientTimePayload(),
          ...(regenerateAssistantId ? { regenerate_assistant_id: regenerateAssistantId } : {}),
          ...(skipUserInsert ? { skip_user_insert: true } : {}),
        }),
        signal: ctl.signal,
      });

      if (!response.ok || !response.body) {
        let errMsg = `HTTP ${response.status}`;
        try {
          // 尝试读取服务端返回的具体错误信息
          const errBody = await response.json();
          if (errBody.error || errBody.message) errMsg = errBody.error || errBody.message || errMsg;
        } catch { /* 响应体不是 JSON，保留状态码信息 */ }
        throw new Error(errMsg);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          let eventType = '';
          let eventData = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            if (line.startsWith('data: ')) eventData = line.slice(6);
          }

          if (!eventData) continue;

          try {
            const parsed = JSON.parse(eventData);
            if (eventType === 'chunk' && parsed.text) {
              fullText += parsed.text;
              if (activeStreamConvRef.current === myConvId) scheduleStreamingText(fullText);
            } else if (eventType === 'memory' && parsed.status === 'extracting') {
              void pollMemoryTask(myConvId);
            } else if (eventType === 'error') {
              throw new Error(parsed.message || t('chat.errorGeneral'));
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
              throw parseErr;
            }
          }
        }
      }

      if (buffer.trim()) {
        let eventData = '';
        for (const line of buffer.split('\n')) {
          if (line.startsWith('data: ')) eventData = line.slice(6);
        }
        if (eventData) {
          try {
            const parsed = JSON.parse(eventData);
            if (parsed.text) {
              fullText += parsed.text;
              if (activeStreamConvRef.current === myConvId) scheduleStreamingText(fullText);
            }
          } catch {
            // 忽略尾部碎片
          }
        }
      }

      if (regenerateAssistantId) skipScrollRef.current = true;
      await refreshMessages();
      if (activeStreamConvRef.current === myConvId) {
        setStreamingText('');
      }
      // 刷新列表但不重置 active
      void refreshConversationState(undefined);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // 用户主动停止，刷新消息（服务端可能已写入部分内容）
        await refreshMessages();
      } else {
        const isNetwork = error instanceof TypeError;
        if (isNetwork) {
          showToast(t('chat.errorNetwork'));
        } else {
          const msg = error instanceof Error ? error.message : String(error);
          showToast(msg || t('chat.errorGeneral'));
        }
      }
    } finally {
      // 只有自己仍是活跃流时才清理全局状态，避免覆盖新流
      if (activeStreamConvRef.current === myConvId) {
        setIsLoading(false);
        setStreamingText('');
        setStreamingConvId(null);
        activeStreamConvRef.current = null;
      }
      // hiddenMessageId/streamingTargetId 是 regeneration 专用，始终清理
      setHiddenMessageId(null);
      setStreamingTargetId(null);
      // 无论如何都从活跃流集合中移除
      setActiveStreams(prev => { const next = new Set(prev); next.delete(myConvId); return next; });
      abortControllersRef.current.delete(myConvId);
      abortControllerRef.current = null;
    }
  };

  const handleRegenerate = async (messageId: string) => {
    if (!activeConvId || activeStreams.has(activeConvId)) return;

    // 找到该 assistant 消息前方最近的 user 消息，而不是全局最后一条
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    const userMsg = [...messages.slice(0, idx)].reverse().find(m => m.role === 'user');
    if (!userMsg) return;

    // skipUserInsert=true：user 消息已在数据库，不重复插入
    await callChatStream(activeConvId, userMsg.content, messageId, true);
  };

  const handleRegenerateFromHere = async (userMessageId: string) => {
    if (!activeConvId || activeStreams.has(activeConvId)) return;

    const userMsgIndex = messages.findIndex(m => m.id === userMessageId);
    if (userMsgIndex === -1) return;
    const userContent = messages[userMsgIndex].content;

    const nextAssistant = messages.slice(userMsgIndex + 1).find(m => m.role === 'assistant');

    if (nextAssistant) {
      // 有后续 assistant 消息：替换它，同时跳过重新插入用户消息
      await callChatStream(activeConvId, userContent, nextAssistant.id, true);
    } else {
      // 没有后续 assistant 消息：直接生成新回复，但用户消息已在数据库里，跳过插入
      await callChatStream(activeConvId, userContent, undefined, true);
    }
  };

  const handleSwitchVersion = async (messageId: string, versionIndex: number) => {
    await fetch(`/api/messages/${messageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeVersion: versionIndex }),
    });
    await refreshMessages();
  };

  const handleSummarize = async () => {
    if (!activeConvId || activeStreams.has(activeConvId) || summarizing) return;

    // 检查是否有足够的消息可以总结
    const nonSummaryMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    if (nonSummaryMessages.length < 2) {
      showToast('消息太少，暂时不需要总结', 'info');
      return;
    }

    setSummarizing(true);
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: activeConvId }),
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error || t('chat.summarizeError'));
      }

      const data = await res.json() as { ok: boolean; message: Message; summarizedCount: number };
      // 刷新消息列表，让总结消息出现在正确位置
      await refreshMessages();
      // 确保滚动到底部看到新的 summary 消息
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
      showToast(t('chat.summarizeSuccess'), 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('chat.summarizeError'));
    } finally {
      setSummarizing(false);
    }
  };

  const handleDuplicateConv = async () => {
    if (!activeConvId || duplicating) return;
    setDuplicating(true);
    try {
      const res = await fetch(`/api/conversations/${activeConvId}/duplicate`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error || t('chat.duplicateError'));
      }
      const newConv = await res.json() as { id: string; title: string };
      // 刷新对话列表，并切换到新副本
      await refreshConversationState(newConv.id);
      showToast(t('chat.duplicateSuccess'), 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('chat.duplicateError'));
    } finally {
      setDuplicating(false);
    }
  };

  // 消息级别生图：取目标消息及之前共 4 条消息生成 prompt，然后生图并附加到该消息
  // existingPrompt 有值时直接用（重新生成场景），否则先让 AI 生成 prompt
  const handleGenerateImage = async (messageId: string, existingPrompt?: string, replaceImageId?: string, conversationIdOverride?: string) => {
    const targetConversationId = conversationIdOverride || activeConvId;
    if (!targetConversationId || !character) return;

    type ImageStatus = 'pending_prompt' | 'pending_image' | 'failed' | 'ready';
    type ImageEntry = {
      id: string;
      url?: string;
      prompt: string;
      status?: ImageStatus;
      error?: string;
      versions?: Array<{ url: string; prompt: string; id: string }>;
      activeVersion?: number;
    };

    const targetIdx = messages.findIndex(m => m.id === messageId);
    if (targetIdx < 0) return;

    const targetMsg = messages[targetIdx];
    let workingMeta = { ...(targetMsg.metadata as Record<string, unknown> || {}) };
    const placeholderId = replaceImageId || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const persistImages = async (updater: (images: ImageEntry[]) => ImageEntry[]) => {
      const currentImages = (workingMeta.generatedImages as ImageEntry[]) || [];
      const nextMeta = { ...workingMeta, generatedImages: updater(currentImages) };
      workingMeta = nextMeta;

      await fetch(`/api/messages/${messageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: nextMeta }),
      });

      skipScrollRef.current = true;
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, metadata: nextMeta } : m));
      return nextMeta;
    };

    const upsertPlaceholder = async (patch: Partial<ImageEntry>) => {
      await persistImages(images => {
        const existingIndex = images.findIndex(img => img.id === placeholderId);
        if (existingIndex >= 0) {
          return images.map(img => img.id === placeholderId ? { ...img, ...patch, id: placeholderId } : img);
        }
        return [...images, { id: placeholderId, prompt: '', ...patch }];
      });
    };

    try {
      let generatedPrompt = existingPrompt || '';

      const initialStatus: ImageStatus = generatedPrompt ? 'pending_image' : 'pending_prompt';
      await upsertPlaceholder({
        prompt: generatedPrompt,
        status: initialStatus,
        error: undefined,
      });

      if (!generatedPrompt) {
        const promptRes = await fetch('/api/image-gen/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: targetConversationId, message_id: messageId }),
        });
        const promptData = await promptRes.json();
        if (promptData.error) throw new Error(promptData.error);
        generatedPrompt = promptData.prompt || '';
        if (!generatedPrompt) throw new Error('AI 未能生成有效的提示词');

        await upsertPlaceholder({
          prompt: generatedPrompt,
          status: 'pending_image',
          error: undefined,
        });
      }

      const imgRes = await fetch('/api/image-gen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: generatedPrompt }),
      });
      const imgData = await imgRes.json();
      if (imgData.error) throw new Error(imgData.error);
      if (!imgData.url) throw new Error('生图未返回图片');

      const newImage = { url: imgData.url, prompt: generatedPrompt, id: placeholderId, status: 'ready' as const };
      await persistImages(images => {
        if (replaceImageId && images.some(img => img.id === replaceImageId && img.url)) {
          return images.map(img => {
            if (img.id !== replaceImageId) return img;
            const existingVersions = img.versions && img.versions.length > 0 ? img.versions : img.url ? [{ id: img.id, url: img.url, prompt: img.prompt }] : [];
            return {
              ...img,
              url: newImage.url,
              prompt: newImage.prompt,
              status: 'ready',
              error: undefined,
              versions: [...existingVersions, { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url: newImage.url, prompt: newImage.prompt }],
              activeVersion: existingVersions.length,
            };
          });
        }

        return images.map(img => img.id === placeholderId ? newImage : img);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '生图失败';
      await upsertPlaceholder({
        prompt: existingPrompt || undefined,
        status: 'failed',
        error: message,
      });
      showToast(message);
    }
  };
  // 删除消息中的某张生成图片
  const handleDeleteImage = async (messageId: string, imgId: string, versionId?: string) => {
    const targetMsg = messages.find(m => m.id === messageId);
    if (!targetMsg) return;
    const meta = { ...(targetMsg.metadata as Record<string, unknown> || {}) };
    const existingImages = (meta.generatedImages as Array<{ url?: string; prompt: string; id: string; status?: string; error?: string; versions?: Array<{ url: string; prompt: string; id: string }>; activeVersion?: number }>) || [];
    let toDeleteUrl: string | undefined;

    meta.generatedImages = existingImages.flatMap(img => {
      if (img.id !== imgId) return [img];

      const versions = img.versions && img.versions.length > 0 ? img.versions : img.url ? [{ id: img.id, url: img.url, prompt: img.prompt }] : [];
      const activeVersion = versionId
        ? versions.findIndex(version => version.id === versionId)
        : typeof img.activeVersion === 'number' && img.activeVersion >= 0 && img.activeVersion < versions.length
        ? img.activeVersion
        : Math.max(versions.findIndex(version => version.url === img.url && version.prompt === img.prompt), 0);
      if (activeVersion < 0) return [img];

      toDeleteUrl = versions[activeVersion]?.url;
      const remainingVersions = versions.filter((_, index) => index !== activeVersion);
      if (remainingVersions.length === 0) return [];

      const nextActiveVersion = Math.min(activeVersion, remainingVersions.length - 1);
      const nextVersion = remainingVersions[nextActiveVersion];

      return [{
        ...img,
        url: nextVersion.url,
        prompt: nextVersion.prompt,
        versions: remainingVersions,
        activeVersion: nextActiveVersion,
      }];
    });

    await fetch(`/api/messages/${messageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: meta }),
    });

    // 同步删除磁盘文件
    if (toDeleteUrl) {
      fetch('/api/image-gen/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: toDeleteUrl }),
      }).catch(() => {/* 删除失败不影响 UI */});
    }

    skipScrollRef.current = true;
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, metadata: meta } : m));
  };

  // 编辑图片的 prompt（保存到 metadata）
  const handleEditImagePrompt = async (messageId: string, imgId: string, newPrompt: string) => {
    const targetMsg = messages.find(m => m.id === messageId);
    if (!targetMsg) return;
    const meta = { ...(targetMsg.metadata as Record<string, unknown> || {}) };
    const existingImages = (meta.generatedImages as Array<{ url?: string; prompt: string; id: string; status?: string; error?: string; versions?: Array<{ url: string; prompt: string; id: string }>; activeVersion?: number }>) || [];
    meta.generatedImages = existingImages.map(img => {
      if (img.id !== imgId) return img;

      const versions = img.versions && img.versions.length > 0 ? [...img.versions] : [{ id: img.id, url: img.url, prompt: img.prompt }];
      const activeVersion = typeof img.activeVersion === 'number' && img.activeVersion >= 0 && img.activeVersion < versions.length
        ? img.activeVersion
        : Math.max(versions.findIndex(version => version.url === img.url && version.prompt === img.prompt), 0);
      versions[activeVersion] = { ...versions[activeVersion], prompt: newPrompt };

      return {
        ...img,
        prompt: newPrompt,
        versions,
        activeVersion,
      };
    });

    await fetch(`/api/messages/${messageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: meta }),
    });
    skipScrollRef.current = true;
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, metadata: meta } : m));
  };

  // 确认使用某张图：把它移到首位，作为该消息的主图展示
  const handleSetPrimaryImage = async (messageId: string, imgId: string, versionId: string) => {
    const targetMsg = messages.find(m => m.id === messageId);
    if (!targetMsg) return;
    const meta = { ...(targetMsg.metadata as Record<string, unknown> || {}) };
    const existingImages = (meta.generatedImages as Array<{ url?: string; prompt: string; id: string; status?: string; error?: string; versions?: Array<{ url: string; prompt: string; id: string }>; activeVersion?: number }>) || [];
    meta.generatedImages = existingImages.map(img => {
      if (img.id !== imgId) return img;

      const versions = img.versions && img.versions.length > 0 ? img.versions : img.url ? [{ id: img.id, url: img.url, prompt: img.prompt }] : [];
      const versionIndex = versions.findIndex(version => version.id === versionId);
      if (versionIndex < 0) return img;
      const selected = versions[versionIndex];

      return {
        ...img,
        url: selected.url,
        prompt: selected.prompt,
        versions,
        activeVersion: versionIndex,
      };
    });

    await fetch(`/api/messages/${messageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: meta }),
    });

    skipScrollRef.current = true;
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, metadata: meta } : m));
  };

  // 加载角色全部生成图片
  const loadCharacterImages = useCallback(async () => {
    if (!character) return;
    setLoadingCharacterImages(true);
    try {
      const res = await fetch(`/api/characters/${character.id}/images`);
      const data = await res.json();
      setCharacterImages(data);
    } catch {
      showToast('加载图片失败');
    } finally {
      setLoadingCharacterImages(false);
    }
  }, [character, showToast]);

  const openImageManager = useCallback(() => {
    setImageManagerOpen(true);
    setSelectedImageKeys(new Set());
    setPreviewImageIndex(null);
    setImageManagerPage(0);
    void loadCharacterImages();
  }, [loadCharacterImages]);

  const closeImageManager = useCallback(() => {
    setImageManagerOpen(false);
    setPreviewImageIndex(null);
    setSelectedImageKeys(new Set());
    setImageManagerPage(0);
  }, []);

  // 批量删除选中图片
  const handleBatchDeleteImages = useCallback(async () => {
    if (selectedImageKeys.size === 0 || !character) return;
    const items = [...selectedImageKeys].map(key => {
      const [messageId, imageId, versionId] = key.split('::');
      return { messageId, imageId, versionId };
    });
    try {
      const res = await fetch(`/api/characters/${character.id}/images`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json() as { ok: boolean; deletedUrls?: string[] };
      if (!data.ok) throw new Error('删除失败');
      // 同步删除磁盘文件
      for (const url of data.deletedUrls || []) {
        fetch('/api/image-gen/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        }).catch(() => {});
      }
      setSelectedImageKeys(new Set());
      setPreviewImageIndex(null);
      await loadCharacterImages();
      // 同步刷新消息列表（图片已从 metadata 删除）
      if (activeConvId) await refreshMessages();
      showToast(`已删除 ${items.length} 张图片`, 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败');
    }
  }, [selectedImageKeys, character, loadCharacterImages, activeConvId, showToast, refreshMessages]);

  // 重置提取状态：重置指定消息（传空表示全部重置）
  const handleResetExtraction = async (messageIds?: string[]) => {
    if (!activeConvId) return;
    try {
      const res = await fetch(`/api/conversations/${activeConvId}/reset-extraction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds }),
      });
      if (!res.ok) throw new Error('重置失败');
      const { resetCount } = await res.json() as { resetCount: number };
      // 更新本地消息的 metadata
      const targetSet = messageIds ? new Set(messageIds) : null;
      setMessages(prev => prev.map(m => {
        if (targetSet && !targetSet.has(m.id)) return m;
        const meta = { ...(m.metadata as Record<string, unknown> || {}) };
        delete meta.memory_extracted;
        return { ...m, metadata: meta };
      }));
      setResetExtractionOpen(false);
      setResetSelectedIds(new Set());
      showToast(`已重置 ${resetCount} 条消息的提取状态`, 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '重置失败');
    }
  };

  const handleSend = async (content: string, attachments?: import('@/lib/chat-engine').AttachmentItem[]) => {    if (!character) return;
    // 当前对话正在生成时不允许重复发送（但其他对话可以）
    if (activeConvId && activeStreams.has(activeConvId)) return;

    let convId = activeConvId;
    if (!convId) {
      const response = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: character.id }),
      });
      const conversation = await response.json();
      setConversations(prev => [conversation, ...prev]);
      setActiveConvId(conversation.id);
      convId = conversation.id;
    }

    // 每次生成创建新的 AbortController
    const ctl = new AbortController();
    abortControllerRef.current = ctl;
    abortControllersRef.current.set(convId!, ctl);

    setIsLoading(true);
    setStreamingText('');
    setStreamingConvId(convId!);
    activeStreamConvRef.current = convId!;
    setActiveStreams(prev => new Set(prev).add(convId!));
    // 闭包内捕获本次流的 convId
    const myConvId = convId!;

    const displayAttachments = attachments?.map(att => (
      att.type === 'image'
        ? { type: att.type, name: att.name, url: att.url || att.data, mimeType: att.mimeType }
        : att
    ));

    const tempUserMessage: Message = {
      id: 'temp-user',
      conversation_id: convId!,
      role: 'user',
      content,
      token_count: 0,
      created_at: new Date().toISOString(),
      metadata: displayAttachments && displayAttachments.length > 0 ? { attachments: displayAttachments } : {},
    };

    forceScrollToBottomRef.current = true;
    setMessages(prev => [...prev, tempUserMessage]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          content,
          ...buildClientTimePayload(),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
        signal: ctl.signal,
      });

      if (!response.ok || !response.body) {
        let errMsg = `HTTP ${response.status}`;
        try {
          // 尝试读取服务端返回的具体错误信息
          const errBody = await response.json();
          if (errBody.error || errBody.message) errMsg = errBody.error || errBody.message || errMsg;
        } catch { /* 响应体不是 JSON，保留状态码信息 */ }
        throw new Error(errMsg);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          let eventType = '';
          let eventData = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            if (line.startsWith('data: ')) eventData = line.slice(6);
          }

          if (!eventData) continue;

          try {
            const parsed = JSON.parse(eventData);
            if (eventType === 'chunk' && parsed.text) {
              fullText += parsed.text;
              if (activeStreamConvRef.current === myConvId) scheduleStreamingText(fullText);
            } else if (eventType === 'memory' && parsed.status === 'extracting') {
              void pollMemoryTask(myConvId);
            } else if (eventType === 'error') {
              throw new Error(parsed.message || t('chat.errorGeneral'));
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
              throw parseErr;
            }
          }
        }
      }

      if (buffer.trim()) {
        let eventData = '';
        for (const line of buffer.split('\n')) {
          if (line.startsWith('data: ')) eventData = line.slice(6);
        }
        if (eventData) {
          try {
            const parsed = JSON.parse(eventData);
            if (parsed.text) {
              fullText += parsed.text;
              if (activeStreamConvRef.current === myConvId) scheduleStreamingText(fullText);
            }
          } catch {
            // 忽略尾部碎片
          }
        }
      }

      await refreshMessagesForConversation(myConvId);
      if (activeStreamConvRef.current === myConvId) {
        setStreamingText('');
      }
      // 刷新列表但不重置 active
      void refreshConversationState(undefined);

      // 自动生图：检查用户消息是否包含触发关键词
      const autoImageConvId = convId;
      if (!autoImageConvId) return;
      void (async () => {
        try {
          const settingsRes = await fetch('/api/settings');
          const s = await settingsRes.json();
          const imgCfg = s.image_gen;
          if (!imgCfg?.enabled || !imgCfg?.auto_generate) return;
          const keywords = (imgCfg.auto_generate_keywords || '').split(',').map((k: string) => k.trim()).filter(Boolean);
          if (keywords.length === 0) return;
          const shouldTrigger = keywords.some((kw: string) => content.includes(kw));
          if (!shouldTrigger) return;
          // 找到最后一条 assistant 消息并对其生图
          const { messages: latestMsgs } = await fetchMessagesPage(autoImageConvId, { limit: Math.max(PAGE_SIZE, messages.length) });
          const lastAssistant = [...latestMsgs].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) {
            handleGenerateImage(lastAssistant.id, undefined, undefined, autoImageConvId);
          }
        } catch {
          // 自动生图失败不影响主流程
        }
      })();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // 用户主动停止，刷新消息
        await refreshMessages();
      } else {
        const isNetwork = error instanceof TypeError;
        if (isNetwork) {
          showToast(t('chat.errorNetwork'));
        } else {
          const msg = error instanceof Error ? error.message : String(error);
          showToast(msg || t('chat.errorGeneral'));
        }
        setMessages(prev => prev.filter(message => message.id !== 'temp-user'));
      }
    } finally {
      if (activeStreamConvRef.current === myConvId) {
        setIsLoading(false);
        setStreamingText('');
        setStreamingConvId(null);
        activeStreamConvRef.current = null;
      }
      // 无论如何都从活跃流集合中移除
      setActiveStreams(prev => { const next = new Set(prev); next.delete(myConvId); return next; });
      abortControllersRef.current.delete(myConvId);
      abortControllerRef.current = null;
    }
  };

  if (!hasCharacter) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-4 py-4">
        {/* 移动端侧边栏入口 */}
        {onOpenSidebar && (
          <div className="absolute left-4 top-4 md:hidden">
            <button
              onClick={onOpenSidebar}
              className="rounded-xl bg-white/80 p-2.5 text-text-secondary shadow-sm ring-1 ring-border-light backdrop-blur-sm hover:bg-white"
              aria-label="打开角色列表"
            >
              <MenuIcon className="h-5 w-5" />
            </button>
          </div>
        )}
        {/* glow 用 absolute + -translate-x/y-1/2 保证真正居中 */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="home-glow" />
        </div>
        <div className="relative flex flex-col items-center">
          <h1
            className="home-title bg-gradient-to-br from-accent-dark via-accent to-accent-light bg-clip-text text-5xl font-semibold tracking-tight text-transparent md:text-6xl"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            LumiMuse
          </h1>
          <p className="mt-5 text-base leading-relaxed text-text-muted md:text-lg">
            让TA慢慢填满你的房间。
          </p>
        </div>
      </div>
    );
  }

  const activeCharacter = character as Character;
  const memoryTypeLabel = memoryCategoryCounts[0]?.[0] || t('memory.empty');
  // 当前对话是否是最新的活跃流（可以显示流式文本）
  const isActiveStream = isLoading && streamingConvId === activeConvId;
  // 当前对话是否有后台流在跑（显示 loading 占位但无文本）
  const isBackgroundStream = !isActiveStream && (activeConvId ? activeStreams.has(activeConvId) : false);
  // 综合：当前对话是否正在生成中
  const isStreamingHere = isActiveStream || isBackgroundStream;
  const streamingMessage: Message = {
    id: 'streaming',
    conversation_id: '',
    role: 'assistant',
    content: isActiveStream ? streamingText : '',
    token_count: 0,
    created_at: new Date().toISOString(),
    metadata: {},
  };
  const streamingBubble = (
    <div className="mb-4">
      <MessageBubble
        message={streamingMessage}
        characterName={activeCharacter.name}
        avatarUrl={activeCharacter.avatar_url}
        showTimestamps={false}
        isStreaming
        isLoading={isActiveStream ? !streamingText : true}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-2 px-2 py-2 md:gap-4 md:px-4 md:py-4">
      {/* === 移动端：可收起的紧凑工具栏 === */}
      <section className="surface-hero px-3 py-2 md:hidden">
        {/* 收起状态：一行显示角色名 + 核心按钮 + 展开拉片 */}
        <div className="flex items-center gap-2">
          {/* 侧边栏入口 */}
          {onOpenSidebar && (
            <button
              onClick={onOpenSidebar}
              className="rounded-xl p-2 text-text-secondary hover:bg-warm-100"
              aria-label="打开角色列表"
            >
              <MenuIcon className="h-4 w-4" />
            </button>
          )}
          <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-accent/18 to-accent-light/28 ring-1 ring-accent/10">
            {activeCharacter.avatar_url ? (
              <img src={activeCharacter.avatar_url} alt={activeCharacter.name} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <span className="text-xs font-semibold text-accent-dark">{activeCharacter.name[0]}</span>
            )}
          </div>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{activeCharacter.name}</h2>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => setConvDrawerOpen(true)}
              className="rounded-xl p-2 text-text-secondary hover:bg-warm-100"
              aria-label="切换对话"
            >
              <ListIcon className="h-4 w-4" />
            </button>
            <button
              onClick={handleNewChat}
              disabled={creating}
              className="rounded-xl bg-accent p-2 text-white shadow-sm disabled:opacity-50"
              aria-label="新对话"
            >
              <PlusIcon className="h-4 w-4" />
            </button>
            {onOpenSearch && (
              <button
                onClick={onOpenSearch}
                className="rounded-xl p-2 text-text-secondary hover:bg-warm-100"
                aria-label="搜索"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  <circle cx="11" cy="11" r="6.5" /><path d="M16 16l5 5" />
                </svg>
              </button>
            )}
            <button
              onClick={() => setToolbarExpanded(!toolbarExpanded)}
              className="rounded-xl p-2 text-text-secondary hover:bg-warm-100"
              aria-label={toolbarExpanded ? '收起工具栏' : '展开工具栏'}
            >
              <ChevronDownIcon className={`h-4 w-4 transition-transform duration-200 ${toolbarExpanded ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>
        {/* 展开状态：显示更多操作按钮 */}
        {toolbarExpanded && (
          <div className="mt-1.5 border-t border-border-light/60 pt-1.5">
            {/* chip + 按钮同一行 */}
            <div className="flex items-center gap-1.5">
              <span className="chip whitespace-nowrap text-[10px]">{conversations.length} {t('chat.quickResume')}</span>
              <span className="chip whitespace-nowrap text-[10px]">{memoryCount} {t('memory.count')}</span>
              <div className="flex-1" />
              <button
                onClick={() => { openRename(); setToolbarExpanded(false); }}
                disabled={!activeConversation}
                className="rounded-xl p-2 text-text-secondary hover:bg-warm-100 disabled:opacity-40"
                aria-label={t('common.edit')}
              >
                <PencilIcon className="h-4 w-4" />
              </button>
              <button
                onClick={() => { handleSummarize(); setToolbarExpanded(false); }}
                disabled={!activeConversation || isStreamingHere || summarizing}
                className="rounded-xl p-2 text-text-secondary hover:bg-warm-100 disabled:opacity-40"
                aria-label={t('chat.summarize')}
              >
                <SummaryIcon className="h-4 w-4" />
              </button>
              <button
                onClick={() => { handleDuplicateConv(); setToolbarExpanded(false); }}
                disabled={!activeConversation || duplicating}
                className="rounded-xl p-2 text-text-secondary hover:bg-warm-100 disabled:opacity-40"
                aria-label={t('chat.duplicate')}
              >
                <DuplicateIcon className="h-4 w-4" />
              </button>
              <button
                onClick={() => { openImageManager(); setToolbarExpanded(false); }}
                className="rounded-xl p-2 text-text-secondary hover:bg-warm-100"
                aria-label="图片管理"
              >
                <ImageIcon className="h-4 w-4" />
              </button>
              <button
                onClick={() => { setDeleteOpen(true); setToolbarExpanded(false); }}
                disabled={!activeConversation}
                className="rounded-xl p-2 text-red-400 hover:bg-red-50 disabled:opacity-40"
                aria-label={t('common.delete')}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </section>

      {/* === PC 端：完整工具栏（保持原样） === */}
      <section className="surface-hero hidden px-5 py-5 md:block">
        <div className="flex items-center gap-3 lg:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[1.35rem] bg-gradient-to-br from-accent/18 to-accent-light/28 ring-1 ring-accent/10">
              {activeCharacter.avatar_url ? (
                <img src={activeCharacter.avatar_url} alt={activeCharacter.name} className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <span className="text-xl font-semibold text-accent-dark">{activeCharacter.name[0]}</span>
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-xl font-semibold text-text-primary">{activeCharacter.name}</h2>
                <span className="chip chip-active text-[11px]">{t('chat.profile')}</span>
                <span className="chip text-[11px]">{conversations.length} {t('chat.quickResume')}</span>
                <span className="chip text-[11px]">{memoryCount} {t('memory.count')}</span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button onClick={handleNewChat} disabled={creating} className="soft-button soft-button-primary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">
              <PlusIcon className="h-4 w-4" />
              <span>{t('chat.newChat')}</span>
            </button>
            <button
              onClick={openRename}
              disabled={!activeConversation}
              className="soft-button soft-button-secondary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PencilIcon className="h-4 w-4" />
              <span>{t('common.edit')}</span>
            </button>
            <button
              onClick={handleSummarize}
              disabled={!activeConversation || isStreamingHere || summarizing}
              className="soft-button soft-button-secondary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              title="总结当前上下文，之前的消息将不再发送给 AI"
            >
              <SummaryIcon className="h-4 w-4" />
              <span>{summarizing ? t('chat.summarizing') : t('chat.summarize')}</span>
            </button>
            <button
              onClick={handleDuplicateConv}
              disabled={!activeConversation || duplicating}
              className="soft-button soft-button-secondary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              title="复制这段对话为副本"
            >
              <DuplicateIcon className="h-4 w-4" />
              <span>{duplicating ? t('chat.duplicating') : t('chat.duplicate')}</span>
            </button>
            <button
              onClick={openImageManager}
              className="soft-button soft-button-secondary px-4 py-2 text-sm"
              title="查看和管理所有生成图片"
            >
              <ImageIcon className="h-4 w-4" />
              <span>图片管理</span>
            </button>
            <button
              onClick={() => setDeleteOpen(true)}
              disabled={!activeConversation}
              className="soft-button soft-button-danger px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <TrashIcon className="h-4 w-4" />
              <span>{t('common.delete')}</span>
            </button>
          </div>
        </div>
      </section>

      <div className="grid min-h-0 flex-1 gap-2 md:gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="surface-panel flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-border-light px-3 py-2.5 text-sm text-text-secondary md:px-5 md:py-4">
            <div className="flex min-w-0 items-center gap-2">
              <SparkIcon className="h-4 w-4 text-accent" />
              <span className="truncate text-xs md:text-sm">{activeConversation?.title || t('chat.noConversationTitle')}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
              {activeConversation?.ignore_memory ? (
                <button
                  onClick={() => { setResetExtractionOpen(true); setResetVisibleCount(RESET_PAGE_SIZE); }}
                  className="chip cursor-pointer text-[10px] md:text-xs text-text-muted border-border-light opacity-60 hover:opacity-90"
                  title="本对话已忽略记忆提取，点击管理"
                >
                  已忽略提取
                </button>
              ) : unextractedCount > 0 ? (
                <button
                  onClick={() => { setResetExtractionOpen(true); setResetVisibleCount(RESET_PAGE_SIZE); }}
                  className="chip cursor-pointer text-amber-600 border-amber-200 bg-amber-50/80 hover:bg-amber-100/80 text-[10px] md:text-xs"
                  title={t('chat.resetExtraction')}
                >
                  {unextractedCount} {t('chat.unextracted')}
                </button>
              ) : (
                <button
                  onClick={() => { setResetExtractionOpen(true); setResetVisibleCount(RESET_PAGE_SIZE); }}
                  className="chip cursor-pointer text-[10px] md:text-xs opacity-50 hover:opacity-80"
                  title={t('chat.resetExtraction')}
                >
                  {t('chat.manageExtraction')}
                </button>
              )}
              <span className="chip text-[10px] md:text-xs">≈{tokenCount} {t('status.tokens')}</span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-5 md:py-5">
            {messages.length === 0 && !streamingText && !isStreamingHere && (
              <div className="flex h-full min-h-[18rem] items-center justify-center">
                <div className="max-w-md text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[1.4rem] bg-gradient-to-br from-accent/15 to-accent-light/25 text-accent-dark empty-breathe">
                    <MemoryIcon className="h-6 w-6" />
                  </div>
                  <p className="text-base font-medium text-text-primary">{t('chat.emptyConversation')}</p>
                  <p className="mt-2 text-sm text-text-muted">{t('chat.emptyConversationBody')}</p>


                </div>
              </div>
            )}

            {(() => {
              const filtered = messages.filter(m => m.id !== hiddenMessageId || m.id === streamingTargetId);
              return (
                <>
                  {/* 顶部哨兵：进入视口时触发加载更多 */}
                  <div ref={topSentinelRef} className="h-px" />

                  {/* 还有更多历史消息时显示提示 */}
                  {hasOlderMessages && (
                    <div className="mb-4 flex items-center justify-center">
                      <button
                        onClick={() => void loadOlderMessages()}
                        disabled={loadingOlderMessages}
                        className="chip cursor-pointer text-xs hover:border-accent/30 hover:bg-accent/8 hover:text-accent-dark"
                      >
                        {loadingOlderMessages ? '正在加载更早消息...' : '↑ 加载更早消息'}
                      </button>
                    </div>
                  )}

                  {filtered.map((message, index, arr) => {
                    const prevMessage = index > 0 ? arr[index - 1] : null;
                    // 跨天分隔线：第一条已加载消息只在没有更早消息时显示
                    const isFirstVisible = index === 0;
                    const showDateDivider = isFirstVisible
                      ? !hasOlderMessages
                      : !isSameDay(prevMessage!.created_at, message.created_at);
                    const isStreamingTarget = isStreamingHere && streamingTargetId === message.id;
                    return (
                      <div key={message.id} id={`msg-${message.id}`} className={`mb-4 rounded-2xl transition-all duration-500 ${highlightedId === message.id ? 'ring-2 ring-accent/40 ring-offset-2 bg-accent/5' : ''}`}>
                        {showDateDivider && (
                          <div className="mb-4 flex items-center gap-3">
                            <div className="h-px flex-1 bg-border-light" />
                            <span className="text-[11px] text-text-muted">{formatDateLabel(message.created_at)}</span>
                            <div className="h-px flex-1 bg-border-light" />
                          </div>
                        )}
                        {isStreamingTarget ? streamingBubble : (
                          <MessageBubble
                            message={message}
                            characterName={activeCharacter.name}
                            avatarUrl={activeCharacter.avatar_url}
                            showTimestamps={showTimestamps}
                            versionInfo={getVersionInfo(message)}
                            onEdit={handleEditMessage}
                            onDelete={handleDeleteMessage}
                            onRegenerate={handleRegenerate}
                            onRegenerateFromHere={handleRegenerateFromHere}
                            onSwitchVersion={handleSwitchVersion}
                            onGenerateImage={handleGenerateImage}
                            onDeleteImage={handleDeleteImage}
                            onEditImagePrompt={handleEditImagePrompt}
                            onSetPrimaryImage={handleSetPrimaryImage}
                          />
                        )}
                      </div>
                    );
                  })}
                </>
              );
            })()}

            {/* 正在生成时显示占位气泡：无流式文字时三点跳动，有流式文字时显示内容 */}
            {isStreamingHere && !streamingTargetId && streamingBubble}

            <div ref={messagesEndRef} />
          </div>

          <ChatInput onSend={handleSend} onStop={handleStop} disabled={isStreamingHere} isGenerating={isStreamingHere} />
        </section>

        <aside className="hidden min-h-0 flex-col gap-4 lg:flex">
          <div className="surface-panel flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-border-light px-4 py-4">
              <p className="label-small">{t('chat.quickResume')}</p>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
              {conversations.map(conversation => (
                <button
                  key={conversation.id}
                  onClick={() => setActiveConvId(conversation.id)}
                  className={`w-full rounded-2xl border px-3 py-3 text-left transition-all duration-200 ${
                    activeConvId === conversation.id
                      ? 'border-accent/25 bg-[rgba(155,124,240,0.10)]'
                      : 'border-border-light bg-white/75 hover:bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">{conversation.title}</span>
                    <span className="text-[11px] text-text-muted">{formatShortDate(conversation.updated_at)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-text-muted">
                    <ClockIcon className="h-3.5 w-3.5" />
                    {formatDateTime(conversation.updated_at)}
                  </div>
                </button>
              ))}
              {conversations.length === 0 && (
                <div className="rounded-2xl border border-dashed border-border-light px-4 py-8 text-center text-sm text-text-muted">
                  {t('chat.noConversationBody')}
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

      {renameOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
          <div className="surface-panel w-full max-w-md p-5">
            <h3 className="section-title text-xl">{t('chat.renameTitle')}</h3>
            <input
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              placeholder={t('chat.renamePlaceholder')}
              className="input-rich mt-4"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setRenameOpen(false)} className="soft-button soft-button-secondary">
                {t('chat.cancel')}
              </button>
              <button onClick={handleRenameConv} className="soft-button soft-button-primary">
                {t('chat.renameConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
          <div className="surface-panel w-full max-w-md p-5">
            <h3 className="section-title text-xl">{t('chat.deleteTitle')}</h3>
            <p className="mt-3 section-copy">{t('chat.deleteConfirm')}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setDeleteOpen(false)} className="soft-button soft-button-secondary">
                {t('chat.cancel')}
              </button>
              <button onClick={handleDeleteConv} className="soft-button soft-button-danger">
                {t('chat.deleteAction')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重置提取状态弹窗 */}
      {resetExtractionOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
          <div className="surface-panel w-full max-w-md p-5">
            <h3 className="section-title text-xl">{t('chat.resetExtractionTitle')}</h3>
            <p className="mt-2 section-copy">{t('chat.resetExtractionDesc')}</p>

            {/* 全选 / 取消全选 */}
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-text-muted">
                {resetSelectedIds.size > 0
                  ? `已选 ${resetSelectedIds.size} 条`
                  : '点击消息多选'}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const userMsgs = messages.filter(m => m.role === 'user');
                    setResetSelectedIds(new Set(userMsgs.map(m => m.id)));
                  }}
                  className="text-xs text-accent-dark hover:underline"
                >
                  全选
                </button>
                <button
                  onClick={() => setResetSelectedIds(new Set())}
                  className="text-xs text-text-muted hover:underline"
                >
                  取消全选
                </button>
              </div>
            </div>

            {/* 消息列表（只显示用户消息，从新到旧，分页加载） */}
            {(() => {
              const userMsgs = messages.filter(m => m.role === 'user').reverse();
              const visible = userMsgs.slice(0, resetVisibleCount);
              const hasMore = userMsgs.length > resetVisibleCount;
              return (
                <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-border-light">
                  {visible.map(m => {
                    const meta = m.metadata as Record<string, unknown> || {};
                    const extracted = Boolean(meta.memory_extracted);
                    const selected = resetSelectedIds.has(m.id);
                    return (
                      <button
                        key={m.id}
                        onClick={() => {
                          setResetSelectedIds(prev => {
                            const next = new Set(prev);
                            next.has(m.id) ? next.delete(m.id) : next.add(m.id);
                            return next;
                          });
                        }}
                        className={`flex w-full items-start gap-3 border-b border-border-light px-4 py-3 text-left text-sm transition-colors ${
                          selected ? 'bg-accent/8' : 'hover:bg-accent/5'
                        }`}
                      >
                        {/* 复选框 */}
                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                          selected ? 'border-accent bg-accent text-white' : 'border-border-light bg-white'
                        }`}>
                          {selected && (
                            <svg viewBox="0 0 10 8" fill="none" className="h-2.5 w-2.5" aria-hidden="true">
                              <path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-text-primary">{m.content.slice(0, 60)}</span>
                          <span className="text-xs text-text-muted">{formatDateTime(m.created_at)}</span>
                        </span>
                        <span className={`mt-0.5 shrink-0 text-xs ${extracted ? 'text-green-500' : 'text-amber-500'}`}>
                          {extracted ? '✓' : '○'}
                        </span>
                      </button>
                    );
                  })}
                  {hasMore && (
                    <button
                      onClick={() => setResetVisibleCount(v => v + RESET_PAGE_SIZE)}
                      className="w-full px-4 py-3 text-center text-xs text-accent-dark hover:bg-accent/5"
                    >
                      加载更多（还有 {userMsgs.length - resetVisibleCount} 条）
                    </button>
                  )}
                </div>
              );
            })()}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {/* 忽略本对话开关 */}
              <button
                onClick={async () => {
                  if (!activeConvId) return;
                  const isIgnored = Boolean(activeConversation?.ignore_memory);
                  await fetch(`/api/conversations/${activeConvId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ignore_memory: !isIgnored }),
                  });
                  setConversations(prev => prev.map(c =>
                    c.id === activeConvId ? { ...c, ignore_memory: isIgnored ? 0 : 1 } : c
                  ));
                  showToast(isIgnored ? '已恢复记忆提取' : '已忽略本对话的记忆提取', 'info');
                }}
                className={`soft-button px-3 py-1.5 text-xs ${activeConversation?.ignore_memory ? 'soft-button-primary' : 'soft-button-secondary'}`}
                title="开启后，本对话不会触发记忆提取"
              >
                {activeConversation?.ignore_memory ? '✓ 已忽略' : '忽略提取'}
              </button>
              <div className="flex-1" />
              <button
                onClick={() => { setResetExtractionOpen(false); setResetSelectedIds(new Set()); setResetVisibleCount(RESET_PAGE_SIZE); }}
                className="soft-button soft-button-secondary px-3 py-1.5 text-sm"
              >
                {t('chat.cancel')}
              </button>
              <button
                onClick={() => handleResetExtraction()}
                className="soft-button soft-button-secondary px-3 py-1.5 text-sm"
              >
                {t('chat.resetAll')}
              </button>
              <button
                onClick={() => handleResetExtraction([...resetSelectedIds])}
                disabled={resetSelectedIds.size === 0}
                className="soft-button soft-button-primary px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                重置选中 ({resetSelectedIds.size})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 移动端对话列表抽屉（lg 以下显示） */}
      {convDrawerOpen && (
        <>
          {/* 遮罩 */}
          <div
            className="fixed inset-0 z-50 bg-black/35 lg:hidden"
            onClick={() => setConvDrawerOpen(false)}
          />
          {/* 底部抽屉 */}
          <div className="fixed bottom-0 left-0 right-0 z-50 lg:hidden">
            <div className="surface-panel rounded-b-none rounded-t-[28px] px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
              {/* 拖拽把手 */}
              <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border-light" />
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold text-text-primary">{t('chat.quickResume')}</p>
                <button
                  onClick={() => setConvDrawerOpen(false)}
                  className="rounded-full p-1.5 text-text-muted hover:bg-warm-100"
                  aria-label="关闭"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="max-h-[55dvh] space-y-2 overflow-y-auto pb-1">
                {conversations.map(conversation => (
                  <button
                    key={conversation.id}
                    onClick={() => {
                      setActiveConvId(conversation.id);
                      setConvDrawerOpen(false);
                    }}
                    className={`w-full rounded-2xl border px-3 py-3 text-left transition-all duration-200 ${
                      activeConvId === conversation.id
                        ? 'border-accent/25 bg-[rgba(155,124,240,0.10)]'
                        : 'border-border-light bg-white/75 hover:bg-white'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-text-primary">{conversation.title}</span>
                      <span className="shrink-0 text-[11px] text-text-muted">{formatShortDate(conversation.updated_at)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
                      <ClockIcon className="h-3.5 w-3.5" />
                      {formatDateTime(conversation.updated_at)}
                    </div>
                  </button>
                ))}
                {conversations.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-border-light px-4 py-8 text-center text-sm text-text-muted">
                    {t('chat.noConversationBody')}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* 全局 Toast 提示 */}
      <Toast items={toasts} onDismiss={dismissToast} />

      {/* 图片管理弹窗 */}
      {imageManagerOpen && (() => {
        const totalPages = Math.max(1, Math.ceil(characterImages.length / IMAGE_MANAGER_PAGE_SIZE));
        const currentPage = Math.min(imageManagerPage, totalPages - 1);
        const pageImages = characterImages.slice(currentPage * IMAGE_MANAGER_PAGE_SIZE, (currentPage + 1) * IMAGE_MANAGER_PAGE_SIZE);
        const previewImage = previewImageIndex !== null ? characterImages[previewImageIndex] : null;
        const canPrev = previewImageIndex !== null && previewImageIndex > 0;
        const canNext = previewImageIndex !== null && previewImageIndex < characterImages.length - 1;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={closeImageManager}>
            <div
              className="surface-panel flex w-full max-w-3xl flex-col overflow-hidden"
              style={{ maxHeight: '90dvh' }}
              onClick={e => e.stopPropagation()}
            >
              {/* 标题栏 */}
              <div className="flex shrink-0 items-center justify-between border-b border-border-light px-5 py-4">
                <div className="flex items-center gap-3">
                  <h3 className="section-title text-lg">图片管理</h3>
                  <span className="chip text-xs">{characterImages.length} 张</span>
                </div>
                <div className="flex items-center gap-2">
                  {selectedImageKeys.size > 0 && (
                    <button
                      onClick={handleBatchDeleteImages}
                      className="soft-button soft-button-danger px-3 py-1.5 text-sm"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                      <span>删除选中 ({selectedImageKeys.size})</span>
                    </button>
                  )}
                  {characterImages.length > 0 && (
                    <button
                      onClick={() => {
                        if (selectedImageKeys.size === characterImages.length) {
                          setSelectedImageKeys(new Set());
                        } else {
                          setSelectedImageKeys(new Set(characterImages.map(img => `${img.messageId}::${img.imageId}::${img.versionId}`)));
                        }
                      }}
                      className="soft-button soft-button-secondary px-3 py-1.5 text-sm"
                    >
                      {selectedImageKeys.size === characterImages.length ? '取消全选' : '全选'}
                    </button>
                  )}
                  <button onClick={closeImageManager} className="rounded-xl p-2 text-text-muted hover:bg-warm-100" aria-label="关闭">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* 图片网格 */}
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {loadingCharacterImages ? (
                  <div className="flex h-40 items-center justify-center text-sm text-text-muted">加载中...</div>
                ) : characterImages.length === 0 ? (
                  <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-text-muted">
                    <ImageIcon className="h-8 w-8 opacity-30" />
                    <span>还没有生成过图片</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-4 gap-3">
                    {pageImages.map((img, indexInPage) => {
                      const globalIndex = currentPage * IMAGE_MANAGER_PAGE_SIZE + indexInPage;
                      const key = `${img.messageId}::${img.imageId}::${img.versionId}`;
                      const selected = selectedImageKeys.has(key);
                      return (
                        <div key={key} className="group relative aspect-square overflow-hidden rounded-xl">
                          {/* 缩略图：点击 → 大图预览 */}
                          <button
                            className="block h-full w-full"
                            onClick={() => setPreviewImageIndex(globalIndex)}
                            aria-label="查看大图"
                          >
                            <img
                              src={img.url}
                              alt=""
                              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                              loading="lazy"
                            />
                          </button>
                          {/* 左上角复选框：点击 → 选中/取消 */}
                          <button
                            className={`absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-all ${
                              selected
                                ? 'border-accent bg-accent opacity-100'
                                : 'border-white/80 bg-black/25 opacity-0 group-hover:opacity-100'
                            }`}
                            onClick={e => {
                              e.stopPropagation();
                              setSelectedImageKeys(prev => {
                                const next = new Set(prev);
                                next.has(key) ? next.delete(key) : next.add(key);
                                return next;
                              });
                            }}
                            aria-label={selected ? '取消选中' : '选中'}
                          >
                            {selected && (
                              <svg viewBox="0 0 10 8" fill="none" className="h-2.5 w-2.5" aria-hidden="true">
                                <path d="M1 4l3 3 5-6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </button>
                          {/* 选中时整体高亮边框 */}
                          {selected && (
                            <div className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-accent ring-offset-1" />
                          )}
                          {/* 对话标题（hover 显示） */}
                          <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-4 opacity-0 transition-opacity group-hover:opacity-100">
                            <p className="truncate text-[10px] text-white/90">{img.conversationTitle}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 翻页栏 */}
              {!loadingCharacterImages && characterImages.length > IMAGE_MANAGER_PAGE_SIZE && (
                <div className="flex shrink-0 items-center justify-between border-t border-border-light px-5 py-3">
                  <button
                    onClick={() => setImageManagerPage(p => Math.max(0, p - 1))}
                    disabled={currentPage === 0}
                    className="soft-button soft-button-secondary px-3 py-1.5 text-sm disabled:opacity-40"
                  >
                    ‹ 上一页
                  </button>
                  <span className="text-sm text-text-muted">
                    第 {currentPage + 1} / {totalPages} 页
                  </span>
                  <button
                    onClick={() => setImageManagerPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={currentPage >= totalPages - 1}
                    className="soft-button soft-button-secondary px-3 py-1.5 text-sm disabled:opacity-40"
                  >
                    下一页 ›
                  </button>
                </div>
              )}
            </div>

            {/* 大图预览 Lightbox */}
            {previewImage && (
              <div
                className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80"
                onClick={() => setPreviewImageIndex(null)}
              >
                <div className="relative flex max-h-[90dvh] max-w-[90vw] items-center justify-center" onClick={e => e.stopPropagation()}>
                  {/* 左切换 */}
                  {canPrev && (
                    <button
                      onClick={() => setPreviewImageIndex(i => i !== null ? i - 1 : i)}
                      className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-white/90 backdrop-blur-sm hover:bg-black/60"
                      aria-label="上一张"
                    >
                      <span className="block text-xl leading-none">‹</span>
                    </button>
                  )}
                  <img
                    src={previewImage.url}
                    alt=""
                    className="max-h-[90dvh] max-w-[90vw] rounded-2xl shadow-2xl"
                  />
                  {/* 右切换 */}
                  {canNext && (
                    <button
                      onClick={() => setPreviewImageIndex(i => i !== null ? i + 1 : i)}
                      className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-white/90 backdrop-blur-sm hover:bg-black/60"
                      aria-label="下一张"
                    >
                      <span className="block text-xl leading-none">›</span>
                    </button>
                  )}
                  {/* 计数 + 关闭 */}
                  <div className="absolute right-3 top-3 flex items-center gap-2">
                    <span className="rounded-full bg-black/40 px-3 py-1 text-xs text-white/85 backdrop-blur-sm">
                      {previewImageIndex! + 1} / {characterImages.length}
                    </span>
                    <button
                      onClick={() => setPreviewImageIndex(null)}
                      className="rounded-full bg-black/40 p-2 text-white/90 backdrop-blur-sm hover:bg-black/60"
                      aria-label="关闭预览"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  {/* 对话来源 */}
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-xs text-white/85 backdrop-blur-sm">
                    {previewImage.conversationTitle}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}





