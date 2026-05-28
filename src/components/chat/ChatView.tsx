'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Character, Conversation, Message, Memory } from '@/types';
import MessageBubble from './MessageBubble';
import ChatInput from './ChatInput';
import ChatHeader from './ChatHeader';
import ChatToolbar from './ChatToolbar';
import ChatMessageList from './ChatMessageList';
import RenameConvModal from './RenameConvModal';
import DeleteConvModal from './DeleteConvModal';
import ResetExtractionModal from './ResetExtractionModal';
import ImageManagerModal from './ImageManagerModal';
import TokenBreakdownModal, { type TokenBreakdownItem } from './TokenBreakdownModal';
import { ConversationDesktopAside, ConversationMobileDrawer } from './ConversationListPanels';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { estimateTokens } from '@/lib/token-counter';
import { getVersionInfo } from '@/lib/chat-view-utils';
import { expectOkResponse, parseJsonResponse } from '@/lib/http';
import { MenuIcon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/Toast';

const PAGE_SIZE = 60; // 每次从后端加载的消息数

function buildClientTimePayload() {
  return {
    client_now_iso: new Date().toISOString(),
    client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    client_utc_offset_minutes: new Date().getTimezoneOffset(),
  };
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
  unextractedCount?: number;
  /** 整对话（自最后一条 summary 起，无 summary 则全量）的 token_count 总和，用于分页未加载完时正确显示 */
  totalTokens?: number;
};

function messagesUrl(conversationId: string, options?: { limit?: number; beforeSeq?: number | null; all?: boolean }): string {
  const params = new URLSearchParams({ conversation_id: conversationId });
  if (options?.all) params.set('all', '1');
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.beforeSeq !== undefined && options.beforeSeq !== null) params.set('before_seq', String(options.beforeSeq));
  return `/api/messages?${params}`;
}

function uniqueMessagesById(messages: Message[]): Message[] {
  const seen = new Set<string>();
  return messages.filter(message => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

async function fetchMessagesPage(conversationId: string, options?: { limit?: number; beforeSeq?: number | null; all?: boolean; signal?: AbortSignal }): Promise<MessagesResponse> {
  const response = await fetch(messagesUrl(conversationId, options), { signal: options?.signal });
  const data = await parseJsonResponse<MessagesResponse | Message[]>(response);
  if (Array.isArray(data)) {
    const oldestSeq = typeof data[0]?.seq === 'number' ? data[0].seq : null;
    return { messages: data, hasMore: false, oldestSeq };
  }
  return data as MessagesResponse;
}

type ChatSseHandlers = {
  onChunk: (text: string) => void;
  onMemoryExtracting: () => void;
  getErrorMessage: () => string;
};

function parseChatSsePart(part: string): { eventType: string; eventData: string } {
  let eventType = '';
  const eventDataLines: string[] = [];

  for (const line of part.split('\n')) {
    if (line.startsWith('event: ')) eventType = line.slice(7).trim();
    if (line.startsWith('data: ')) eventDataLines.push(line.slice(6));
  }

  return { eventType, eventData: eventDataLines.join('\n') };
}

function handleChatSseEvent(eventType: string, eventData: string, handlers: ChatSseHandlers): void {
  if (!eventData) return;

  let parsed: { text?: unknown; status?: unknown; message?: unknown };
  try {
    parsed = JSON.parse(eventData) as typeof parsed;
  } catch (parseErr) {
    if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
      throw parseErr;
    }
    return;
  }

  if ((eventType === 'chunk' || eventType === '') && typeof parsed.text === 'string' && parsed.text) {
    handlers.onChunk(parsed.text);
  } else if (eventType === 'memory' && parsed.status === 'extracting') {
    handlers.onMemoryExtracting();
  } else if (eventType === 'error') {
    throw new Error(typeof parsed.message === 'string' ? parsed.message : handlers.getErrorMessage());
  }
}

async function readChatSseStream(body: ReadableStream<Uint8Array>, handlers: ChatSseHandlers): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const { eventType, eventData } = parseChatSsePart(part);
      handleChatSseEvent(eventType, eventData, handlers);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const { eventType, eventData } = parseChatSsePart(buffer);
    handleChatSseEvent(eventType, eventData, handlers);
  }
}

export default function ChatView({ character, conversationId, targetMessageId, onOpenSidebar, onOpenSearch }: Props) {
  const { t } = useTranslation();
  const { showToast } = useToast();
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
  const [currentModel, setCurrentModel] = useState('');
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
  // 服务端返回的真实未提取消息数量（不受前端分页限制）
  const [serverUnextractedCount, setServerUnextractedCount] = useState<number>(0);
  // 服务端返回的整对话 token 总和（自最后一条 summary 起，无 summary 则全量），用于分页未加载完时正确显示。
  // 带 convId 是为了切换对话时能识别"旧值过期"，避免新对话短暂显示旧对话的 token 数。
  const [serverTotalTokens, setServerTotalTokens] = useState<{ convId: string; value: number } | null>(null);
  // 记忆提取状态：'idle' | 'extracting' | 'done' | 'failed'
  const [memoryExtractStatus, setMemoryExtractStatus] = useState<'idle' | 'extracting' | 'done' | 'failed'>('idle');
  // 提取状态自动隐藏定时器
  const extractStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 移动端对话列表抽屉
  const [convDrawerOpen, setConvDrawerOpen] = useState(false);
  // 移动端工具栏展开（拉片）
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  // 图片管理弹窗（仅保留开关；列表/选中/分页等已下沉到 ImageManagerModal 内部）
  const [imageManagerOpen, setImageManagerOpen] = useState(false);

  // Token 拆分弹窗
  const [tokenBreakdownOpen, setTokenBreakdownOpen] = useState(false);
  const seenMemoryTaskRef = useRef<Record<string, string>>({});
  const previousCharacterIdRef = useRef<string | null>(character?.id ?? null);
  const streamingFrameRef = useRef<number | null>(null);
  const pendingStreamingTextRef = useRef('');
  // 跟踪当前选中的对话 ID。
  // 删除对话是异步流程：从弹窗确认到 fetch 完成中间用户可能切换对话，
  // 直接读取闭包内 activeConvId 会导致删错对象。Ref 保证 handleDeleteConv 拿到的是"最新"值，
  // 而本地变量 targetConvId 用于"快照确认时刻"，避免删除中途又被切换覆盖。
  const activeConvIdRef = useRef<string | null>(activeConvId);
  useEffect(() => {
    activeConvIdRef.current = activeConvId;
  }, [activeConvId]);

  // 同步 messages / character 到 ref，让传给 MessageBubble 的回调闭包内能读最新值，
  // 同时保持自身依赖数组为空，引用稳定 → React.memo(MessageBubble) 不会因父级 re-render 而失效。
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const activeStreamsRef = useRef<Set<string>>(activeStreams);
  useEffect(() => {
    activeStreamsRef.current = activeStreams;
  }, [activeStreams]);
  const characterRef = useRef<Character | null>(character);
  useEffect(() => {
    characterRef.current = character;
  }, [character]);

  // 竞态保护：用户切换对话时立即清空 streamingText / streamingConvId，
  // 避免上一段流尚未结束就把旧文字带到新对话。
  // 切到的目标对话若有后台流在跑（activeStreams 中），等其新 chunk 到达时会重新写回 streaming state。
  useEffect(() => {
    if (streamingConvId && streamingConvId !== activeConvId) {
      // SSE 清理：用户切换对话时必须立即重置流式 UI 状态，避免旧对话的流式文本泄漏到新对话
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStreamingText('');
      setStreamingConvId(null);
    }
    // 仅依赖 activeConvId：streamingConvId 在流启动时被设置，无需作为依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId]);

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

  const activeConversation = useMemo(
    () => conversations.find(conversation => conversation.id === activeConvId) || null,
    [activeConvId, conversations],
  );
  const visibleMessages = useMemo(
    () => activeConvId ? messages.filter(message => message.conversation_id === activeConvId) : [],
    [activeConvId, messages],
  );
  const versionInfoByMessageId = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getVersionInfo>>();
    for (const message of visibleMessages) {
      map.set(message.id, getVersionInfo(message));
    }
    return map;
  }, [visibleMessages]);

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
    const lastSummaryIdx = visibleMessages.findLastIndex(m => {
      const meta = (m.metadata || {}) as Record<string, unknown>;
      return meta.isSummary === true;
    });
    const relevant = lastSummaryIdx >= 0 ? visibleMessages.slice(lastSummaryIdx) : visibleMessages;
    const localSum = relevant.reduce((sum, m) => sum + (m.token_count || 0), 0);
    // 取本地求和与服务端总量的较大值：
    // - 分页未加载完时，服务端总量包含未加载的旧消息（localSum 偏小）→ 取服务端
    // - 本地刚发送新消息但服务端总量还未刷新时，localSum 暂时领先 → 取 localSum
    // - 全加载完且服务端已同步时，两者相等
    // serverTotalTokens 带 convId 是为了识别"切对话后旧值未清"的过渡态：
    // convId 不匹配时视为 0，避免短暂显示别的对话的 token 数
    const serverValue = serverTotalTokens && serverTotalTokens.convId === activeConvId ? serverTotalTokens.value : 0;
    return Math.max(localSum, serverValue);
  }, [visibleMessages, serverTotalTokens, activeConvId]);

  // 把 system prompt 拆分到字段粒度，方便点击 token chip 时弹窗展示占比。
  // 这里只覆盖 ChatView 自身的 token 估算口径（与 ChatToolbar chip 显示一致），
  // 真正发给 LLM 的拼接细节仍由 chat-engine 的 buildSystemPrompt 决定。
  const systemPromptParts = useMemo(() => {
    if (!character) {
      return { systemPrompt: 0, basicInfo: 0, personality: 0, scenario: 0, otherInfo: 0, exampleDialogue: 0 };
    }
    return {
      systemPrompt: character.system_prompt ? estimateTokens(character.system_prompt) : 0,
      basicInfo: character.basic_info ? estimateTokens(character.basic_info) : 0,
      personality: character.personality ? estimateTokens(character.personality) : 0,
      scenario: character.scenario ? estimateTokens(character.scenario) : 0,
      otherInfo: character.other_info ? estimateTokens(character.other_info) : 0,
      exampleDialogue: character.example_dialogue ? estimateTokens(character.example_dialogue) : 0,
    };
  }, [character]);

  const memoriesTokens = useMemo(() => {
    if (memories.length === 0) return 0;
    const memText = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
    return estimateTokens(memText);
  }, [memories]);

  const systemPromptTokens = useMemo(() => {
    return (
      systemPromptParts.systemPrompt
      + systemPromptParts.basicInfo
      + systemPromptParts.personality
      + systemPromptParts.scenario
      + systemPromptParts.otherInfo
      + systemPromptParts.exampleDialogue
      + memoriesTokens
    );
  }, [systemPromptParts, memoriesTokens]);

  const tokenCount = messageTokens + systemPromptTokens;

  // 弹窗展示用的拆分项。fields 顺序按"出现在 system prompt 中的顺序"排列，
  // 让用户读起来和角色卡编辑界面对得上。零 token 项也保留，避免缺失误以为统计有 bug。
  const tokenBreakdownItems = useMemo<TokenBreakdownItem[]>(() => {
    return [
      { labelKey: 'token.systemPrompt', tokens: systemPromptParts.systemPrompt },
      { labelKey: 'token.basicInfo', tokens: systemPromptParts.basicInfo },
      { labelKey: 'token.personality', tokens: systemPromptParts.personality },
      { labelKey: 'token.scenario', tokens: systemPromptParts.scenario },
      { labelKey: 'token.otherInfo', tokens: systemPromptParts.otherInfo },
      { labelKey: 'token.exampleDialogue', tokens: systemPromptParts.exampleDialogue },
      {
        labelKey: 'token.memories',
        tokens: memoriesTokens,
        detail: formatTemplate(t('token.memoriesDetail'), { count: memories.length }),
      },
      { labelKey: 'token.messages', tokens: messageTokens },
    ];
  }, [systemPromptParts, memoriesTokens, messageTokens, memories.length, t]);

  // 未提取记忆的用户消息数（使用服务端返回的真实数量，不受前端分页限制）
  const unextractedCount = serverUnextractedCount;
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
    const loadingConvId = activeConvId;
    fetchMessagesPage(loadingConvId, { limit: PAGE_SIZE, all: needsTarget, signal: ctl.signal })
      .then(({ messages: msgs, hasMore, oldestSeq, unextractedCount: uc, totalTokens: tt }) => {
        setMessages(uniqueMessagesById(msgs));
        setHasOlderMessages(hasMore);
        setOldestLoadedSeq(oldestSeq);
        if (uc !== undefined) setServerUnextractedCount(uc);
        if (tt !== undefined) setServerTotalTokens({ convId: loadingConvId, value: tt });

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

  // 页面重新可见时刷新未提取数量（处理后台提取完成但前端不知道的情况）
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && activeConvId) {
        const cid = activeConvId;
        fetchMessagesPage(cid, { limit: Math.max(PAGE_SIZE, messages.length) })
          .then(({ unextractedCount: uc, totalTokens: tt }) => {
            if (uc !== undefined) setServerUnextractedCount(uc);
            if (tt !== undefined) setServerTotalTokens({ convId: cid, value: tt });
          })
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [activeConvId, messages.length]);

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
    //
    // 虚拟列表特殊处理：初次渲染时 virtualizer 还没测量任何 row，totalSize 是用 estimateSize(120)
    // 估算的值，scrollIntoView 会滚到错误位置；待 ResizeObserver 测完真实高度后 totalSize 才会更新。
    // 因此用 ResizeObserver 监听 scroller 子节点（含 virtualizer inner 容器）的尺寸变化，
    // 在每次高度变化后反复 scrollIntoView，直到 sentinel 离开视口为止。
    if (scrollToBottomOnLoadRef.current) {
      const end = messagesEndRef.current;
      if (!end) return;
      const scroller = end.parentElement;
      if (!scroller) return;

      let cancelled = false;
      let resizeObs: ResizeObserver | null = null;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      // 静置计时：内容看似已撑满视口后，给图片等异步资源留 300ms 缓冲。
      // 期间任何 ResizeObserver / 图片 load 触发的 tryScroll 都会重置该计时，
      // 直到 300ms 内不再有高度变化才真正退出。
      let settleTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = () => {
        scrollToBottomOnLoadRef.current = false;
        if (resizeObs) resizeObs.disconnect();
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        scroller.removeEventListener('load', onAssetLoad, true);
      };

      const scheduleSettle = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          if (cancelled) return;
          // 静置期满前再滚一次，吃掉静置开始到现在期间的最终高度
          end.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
          finish();
        }, 300);
      };

      const tryScroll = () => {
        if (cancelled || !scrollToBottomOnLoadRef.current) return;
        end.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
        const sentinel = topSentinelRef.current;
        if (sentinel) {
          const rect = sentinel.getBoundingClientRect();
          const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
          if (!inView) {
            // 哨兵已离开视口：进入/重置静置计时，等异步图片落定再退出。
            // 这是修复刷新后首次进入对话「离最底部还差一段」的关键：
            // 之前直接 finish() 会在图片加载前关闭监听，导致后续高度增长无人响应。
            scheduleSettle();
          } else if (settleTimer) {
            // 哨兵又回到视口（例如 totalSize 缩水），取消静置继续观察
            clearTimeout(settleTimer);
            settleTimer = null;
          }
        }
      };

      // 图片加载完成会改变 row 真实高度。ResizeObserver 只监听了 scroller 直接子节点的快照，
      // 这里用捕获阶段的 load 事件作为补充信号，覆盖头像 / 附件 / 生成图片首次加载的场景。
      function onAssetLoad() {
        if (cancelled) return;
        requestAnimationFrame(tryScroll);
      }

      // ResizeObserver 监听 scroller 直接子元素：virtualizer inner 的 height 由 inline style 设置，
      // 每次 totalSize 变化都会触发 contentRect 变化 → 回调被调用。
      resizeObs = new ResizeObserver(() => {
        if (cancelled) return;
        requestAnimationFrame(tryScroll);
      });
      Array.from(scroller.children).forEach(child => resizeObs!.observe(child as Element));
      scroller.addEventListener('load', onAssetLoad, true);

      const rafId = requestAnimationFrame(tryScroll);
      // 兜底：3s 后强制结束，弱网下首次加载图片可能需要 1-2s，原 1.5s 不够
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
    }
  }, [visibleMessages]);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(s => {
        setShowTimestamps(s.show_timestamps ?? true);
        setCurrentModel(s.model || '');
      });
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
      const cid = activeConvId;
      fetchMessagesPage(cid, { limit: Math.max(PAGE_SIZE, messages.length) })
        .then(({ messages: freshMessages, hasMore, oldestSeq, unextractedCount: uc, totalTokens: tt }) => {
          setMessages(uniqueMessagesById(freshMessages));
          setHasOlderMessages(hasMore);
          setOldestLoadedSeq(oldestSeq);
          if (uc !== undefined) setServerUnextractedCount(uc);
          if (tt !== undefined) setServerTotalTokens({ convId: cid, value: tt });
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
    const convId = activeConvIdRef.current;
    if (!convId) return;
    // 用 ref 读取最新 messages 长度，避免 callback 引用因 messages 变化而频繁重建
    const { messages: freshMessages, hasMore, oldestSeq, unextractedCount: uc, totalTokens: tt } = await fetchMessagesPage(convId, { limit: Math.max(PAGE_SIZE, messagesRef.current.length) });
    setMessages(uniqueMessagesById(freshMessages));
    setHasOlderMessages(hasMore);
    setOldestLoadedSeq(oldestSeq);
    if (uc !== undefined) setServerUnextractedCount(uc);
    if (tt !== undefined) setServerTotalTokens({ convId, value: tt });
  }, []);

  const refreshMessagesForConversation = useCallback(async (conversationIdToRefresh: string) => {
    const { messages: freshMessages, hasMore, oldestSeq, unextractedCount: uc, totalTokens: tt } = await fetchMessagesPage(conversationIdToRefresh, { limit: Math.max(PAGE_SIZE, messagesRef.current.length) });
    setMessages(uniqueMessagesById(freshMessages));
    setHasOlderMessages(hasMore);
    setOldestLoadedSeq(oldestSeq);
    if (uc !== undefined) setServerUnextractedCount(uc);
    if (tt !== undefined) setServerTotalTokens({ convId: conversationIdToRefresh, value: tt });
  }, []);

  const loadOlderMessages = useCallback(async () => {
    if (!activeConvId || !hasOlderMessages || oldestLoadedSeq === null || loadingOlderMessages) return;
    setLoadingOlderMessages(true);
    try {
      const { messages: olderMessages, hasMore, oldestSeq } = await fetchMessagesPage(activeConvId, {
        limit: PAGE_SIZE,
        beforeSeq: oldestLoadedSeq,
      });
      setMessages(prev => uniqueMessagesById([...olderMessages, ...prev]));
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
    // 只有当当前活跃的对话确实是本任务对话时，才显示“提取中”状态喵
    if (activeConvIdRef.current === convId) {
      setMemoryExtractStatus('extracting');
    }
    if (extractStatusTimerRef.current) { clearTimeout(extractStatusTimerRef.current); extractStatusTimerRef.current = null; }

    const pollOnce = async (): Promise<{ finished: boolean; status: string }> => {
      const response = await fetch(`/api/memory-tasks?conversation_id=${encodeURIComponent(convId)}`);
      if (!response.ok) return { finished: false, status: 'error' };

      const parsed = await response.json() as { status: string; mergeCount: number; updatedAt: string | null };
      const isFinished = parsed.status === 'done' || parsed.status === 'failed' || parsed.status === 'idle';

      if (parsed.status === 'done' && parsed.mergeCount > 0) {
        const taskKey = parsed.updatedAt ? `${parsed.status}:${parsed.updatedAt}` : parsed.status;
        if (seenMemoryTaskRef.current[convId] !== taskKey) {
          seenMemoryTaskRef.current[convId] = taskKey;
          showToast(formatTemplate(t('chat.memoryUpdated'), { count: parsed.mergeCount }), 'info');
        }
      }

      return { finished: isFinished, status: parsed.status };
    };

    // 增加轮询次数至 60 次（约 90 秒，每次 1.5 秒），给大模型（LLM）记忆提取留出充足的处理时间喵
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { finished, status } = await pollOnce();
      if (finished) {
        // 竞态保护：只有当用户当前仍然看着本对话时，才更新 UI 状态和计数，避免数据错乱覆盖喵
        if (activeConvIdRef.current === convId) {
          if (status === 'done') {
            setMemoryExtractStatus('done');
          } else if (status === 'failed') {
            setMemoryExtractStatus('failed');
          } else {
            setMemoryExtractStatus('idle');
          }

          // 刷新未提取消息数量
          fetchMessagesPage(convId, { limit: Math.max(PAGE_SIZE, messages.length) })
            .then(({ unextractedCount: uc, totalTokens: tt }) => {
              if (uc !== undefined) setServerUnextractedCount(uc);
              if (tt !== undefined) setServerTotalTokens({ convId, value: tt });
            })
            .catch(() => {});

          extractStatusTimerRef.current = setTimeout(() => setMemoryExtractStatus('idle'), 3000);
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // 超时处理：同样需要用 activeConvIdRef 保护
    if (activeConvIdRef.current === convId) {
      setMemoryExtractStatus('failed');
      // 即使轮询超时了，也尝试在最后刷新一次未提取数量，防止后台任务在最后一刻成功喵
      fetchMessagesPage(convId, { limit: Math.max(PAGE_SIZE, messages.length) })
        .then(({ unextractedCount: uc, totalTokens: tt }) => {
          if (uc !== undefined) setServerUnextractedCount(uc);
          if (tt !== undefined) setServerTotalTokens({ convId, value: tt });
        })
        .catch(() => {});
      extractStatusTimerRef.current = setTimeout(() => setMemoryExtractStatus('idle'), 3000);
    }
  }, [showToast, messages.length, t]);

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
        setMessages(uniqueMessagesById([greetingMessage]));
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

  const handleRenameConv = async (nextTitle?: string) => {
    const finalTitle = (nextTitle ?? renameValue).trim();
    if (!activeConvId || !finalTitle) return;
    await fetch(`/api/conversations/${activeConvId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: finalTitle }),
    });
    setConversations(prev => prev.map(conversation => (
      conversation.id === activeConvId ? { ...conversation, title: finalTitle } : conversation
    )));
    setRenameOpen(false);
  };

  const handleDeleteConv = async () => {
    // 用 ref 取最新 activeConvId，避免被组件 re-render 之间的旧闭包污染
    const targetConvId = activeConvIdRef.current;
    if (!targetConvId) return;
    const previousActiveConvId = activeConvIdRef.current;
    const previousMessages = messagesRef.current;
    // 关闭弹窗 + 决定下一段对话（基于 targetConvId 而不是闭包变量）
    const next = conversations.find(conversation => conversation.id !== targetConvId) || null;
    // 先切换到下一个对话，避免删除时消息区闪白
    setActiveConvId(next?.id || null);
    if (!next) setMessages([]);
    setDeleteOpen(false);
    try {
      // 关键点：DELETE 用上面快照下来的 targetConvId，
      // 即便用户在 await 期间又切到别的对话也只会删自己最初确认的那一条
      // 注意：proxy.ts 的 CSRF 校验要求写方法（含 DELETE）带 application/json 头
      await expectOkResponse(await fetch(`/api/conversations/${targetConvId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      }));
      setConversations(prev => prev.filter(conversation => conversation.id !== targetConvId));
      void refreshConversationState(next?.id || null);
    } catch (err) {
      setActiveConvId(previousActiveConvId);
      setMessages(previousMessages);
      setDeleteOpen(true);
      showToast(err instanceof Error ? err.message : t('chat.deleteError'), 'error');
    }
  };

  const handleEditMessage = useCallback(async (id: string, content: string, attachments?: Array<{ type: string; name: string; data?: string; url?: string; mimeType: string }>) => {
    await fetch(`/api/messages/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // attachments 始终传（空数组表示清除所有附件）
      body: JSON.stringify({ content, attachments: attachments ?? [] }),
    });
    await refreshMessages();
  }, [refreshMessages]);

  const handleDeleteMessage = useCallback(async (id: string) => {
    // 注意：proxy.ts 的 CSRF 校验要求写方法（含 DELETE）带 application/json 头
    const res = await fetch(`/api/messages/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await parseJsonResponse<{ ok: boolean; deleted: 'message' | 'version'; message?: Message }>(res);
    if (!data.ok) throw new Error(t('message.deleteFailed'));
    if (data.deleted === 'version' && data.message) {
      // 只删了一个版本，用返回的更新后消息替换
      setMessages(prev => prev.map(m => m.id === id ? data.message! : m));
    } else {
      // 整条消息被删除
      setMessages(prev => prev.filter(m => m.id !== id));
    }
  }, [t]);

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

      let fullText = '';
      await readChatSseStream(response.body, {
        onChunk: text => {
          fullText += text;
          // 竞态保护：仅当本流仍是「最后启动的流」且「用户当前正在看本对话」时才更新 UI 文本。
          // 用户切到别的对话后，本流剩余 chunk 不再写入 streamingText（避免在错误的对话上残留文字）。
          // fullText 在闭包内继续累积，保证后端持久化的内容完整。
          if (activeStreamConvRef.current === myConvId && activeConvIdRef.current === myConvId) {
            scheduleStreamingText(fullText);
          }
        },
        onMemoryExtracting: () => {
          void pollMemoryTask(myConvId);
        },
        getErrorMessage: () => t('chat.errorGeneral'),
      });

      if (regenerateAssistantId) skipScrollRef.current = true;
      await refreshMessages();
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
      // 竞态保护：finally 阶段不再依赖闭包 myConvId 决定是否清理全局 streaming state。
      // 之前的实现是「只有自己仍是活跃流时才清理」，但若用户中途切走又切回原对话，
      // streamingConvId / streamingText 可能停留在旧值，导致界面上出现幽灵气泡。
      // 现在统一无条件清空：若有其他流并发跑，它们自己的 chunk 处理逻辑会再次写回正确的 streaming state。
      if (activeStreamConvRef.current === myConvId) {
        activeStreamConvRef.current = null;
      }
      setIsLoading(false);
      setStreamingText('');
      setStreamingConvId(null);
      // hiddenMessageId/streamingTargetId 是 regeneration 专用，始终清理
      setHiddenMessageId(null);
      setStreamingTargetId(null);
      // 无论如何都从活跃流集合中移除
      setActiveStreams(prev => { const next = new Set(prev); next.delete(myConvId); return next; });
      abortControllersRef.current.delete(myConvId);
      abortControllerRef.current = null;
    }
  };

  const handleRegenerate = useCallback(async (messageId: string) => {
    const convId = activeConvIdRef.current;
    if (!convId || activeStreamsRef.current.has(convId)) return;

    // 找到该 assistant 消息前方最近的 user 消息，而不是全局最后一条
    const currentMessages = messagesRef.current;
    const idx = currentMessages.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    const userMsg = [...currentMessages.slice(0, idx)].reverse().find(m => m.role === 'user');
    if (!userMsg) return;

    // skipUserInsert=true：user 消息已在数据库，不重复插入
    await callChatStream(convId, userMsg.content, messageId, true);
    // callChatStream 在外层闭包内捕获引用，但本身没用 useCallback —— 用 ref 模式无需把它放进依赖
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRegenerateFromHere = useCallback(async (userMessageId: string) => {
    const convId = activeConvIdRef.current;
    if (!convId || activeStreamsRef.current.has(convId)) return;

    const currentMessages = messagesRef.current;
    const userMsgIndex = currentMessages.findIndex(m => m.id === userMessageId);
    if (userMsgIndex === -1) return;
    const userContent = currentMessages[userMsgIndex].content;

    const nextAssistant = currentMessages.slice(userMsgIndex + 1).find(m => m.role === 'assistant');

    if (nextAssistant) {
      // 有后续 assistant 消息：替换它，同时跳过重新插入用户消息
      await callChatStream(convId, userContent, nextAssistant.id, true);
    } else {
      // 没有后续 assistant 消息：直接生成新回复，但用户消息已在数据库里，跳过插入
      await callChatStream(convId, userContent, undefined, true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSwitchVersion = useCallback(async (messageId: string, versionIndex: number) => {
    await fetch(`/api/messages/${messageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeVersion: versionIndex }),
    });
    await refreshMessages();
  }, [refreshMessages]);

  const handleSummarize = async () => {
    if (!activeConvId || activeStreams.has(activeConvId) || summarizing) return;

    // 检查是否有足够的消息可以总结
    const nonSummaryMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    if (nonSummaryMessages.length < 2) {
      showToast(t('chat.summarizeTooFew'), 'info');
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
      // 注意：proxy.ts 的 CSRF 校验要求写方法带 application/json 头
      const res = await fetch(`/api/conversations/${activeConvId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
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
  const handleGenerateImage = useCallback(async (messageId: string, existingPrompt?: string, replaceImageId?: string, conversationIdOverride?: string) => {
    const targetConversationId = conversationIdOverride || activeConvIdRef.current;
    if (!targetConversationId || !characterRef.current) return;
    showToast(t('chat.imageGenStart'), 'info');

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

    const currentMessages = messagesRef.current;
    const targetIdx = currentMessages.findIndex(m => m.id === messageId);
    if (targetIdx < 0) return;

    const targetMsg = currentMessages[targetIdx];
    let workingMeta = { ...(targetMsg.metadata as Record<string, unknown> || {}) };
    const placeholderId = replaceImageId || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const persistImages = async (updater: (images: ImageEntry[]) => ImageEntry[]) => {
      const currentImages = (workingMeta.generatedImages as ImageEntry[]) || [];
      const nextMeta = { ...workingMeta, generatedImages: updater(currentImages) };
      workingMeta = nextMeta;

      // 先更新本地 state，确保即使后端 PUT 失败（断网/超时），prompt 也不会从 UI 上丢失，
      // 用户点击重试时仍能拿到上一阶段已生成的 prompt。
      skipScrollRef.current = true;
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, metadata: nextMeta } : m));

      try {
        await fetch(`/api/messages/${messageId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metadata: nextMeta }),
        });
      } catch (err) {
        // 持久化失败仅记录，不抛出 —— 让生图流程继续，本地 state 已是最新的
        console.warn('[image-gen] 元数据持久化失败，已保留本地状态：', err);
      }
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

    let generatedPrompt = existingPrompt || '';

    try {

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
        if (!generatedPrompt) throw new Error(t('chat.imageGenPromptFail'));

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
      if (!imgData.url) throw new Error(t('chat.imageGenNoUrl'));

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
      const message = err instanceof Error ? err.message : t('chat.imageGenGeneric');
      await upsertPlaceholder({
        prompt: generatedPrompt,
        status: 'failed',
        error: message,
      });
      showToast(message);

      if (replaceImageId) {
        setTimeout(async () => {
          const currentMsg = messagesRef.current.find(m => m.id === messageId);
          if (!currentMsg) return;
          const currentMeta = { ...(currentMsg.metadata as Record<string, unknown> || {}) };
          const currentImages = (currentMeta.generatedImages as ImageEntry[]) || [];
          const targetImg = currentImages.find((img: ImageEntry) => img.id === replaceImageId);
          if (targetImg && targetImg.status === 'failed') {
            await persistImages(images =>
              images.map(img =>
                img.id === replaceImageId
                  ? { ...img, status: 'ready' as const, error: undefined }
                  : img
              )
            );
          }
        }, 5000);
      }
    }
  }, [showToast, t]);
  // 删除消息中的某张生成图片
  const handleDeleteImage = useCallback(async (messageId: string, imgId: string, versionId?: string) => {
    const targetMsg = messagesRef.current.find(m => m.id === messageId);
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
  }, []);

  // 编辑图片的 prompt（保存到 metadata）
  const handleEditImagePrompt = useCallback(async (messageId: string, imgId: string, newPrompt: string) => {
    const targetMsg = messagesRef.current.find(m => m.id === messageId);
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
  }, []);

  // 确认使用某张图：把它移到首位，作为该消息的主图展示
  const handleSetPrimaryImage = useCallback(async (messageId: string, imgId: string, versionId: string) => {
    const targetMsg = messagesRef.current.find(m => m.id === messageId);
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
  }, []);

  // 图片管理弹窗的加载、选中、批量删除等已下沉到 ImageManagerModal 内部。
  // 这里只保留打开/关闭开关与「删除完成后刷新主消息列表」的桥接。

  // 切换提取状态弹窗逻辑（加载、选中、分页）已下沉到 ResetExtractionModal 内部。

  // 切换提取状态：重置或标记指定消息
  const handleResetExtraction = async (messageIds?: string[], action: 'reset' | 'mark' = 'reset') => {
    if (!activeConvId) return;
    try {
      const res = await fetch(`/api/conversations/${activeConvId}/reset-extraction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds, action }),
      });
      if (!res.ok) throw new Error(t('chat.resetExtractionFail'));
      const { resetCount } = await res.json() as { resetCount: number };
      // 更新本地消息的 metadata
      const targetSet = messageIds ? new Set(messageIds) : null;
      const updateMeta = (m: Message) => {
        if (m.role !== 'user') return m;
        if (targetSet && !targetSet.has(m.id)) return m;
        const meta = { ...(m.metadata as Record<string, unknown> || {}) };
        if (action === 'mark') {
          meta.memory_extracted = true;
        } else {
          delete meta.memory_extracted;
        }
        return { ...m, metadata: meta };
      };
      setMessages(prev => prev.map(updateMeta));
      // 更新服务端未提取数量
      if (action === 'mark') {
        setServerUnextractedCount(prev => Math.max(0, prev - resetCount));
      } else {
        setServerUnextractedCount(prev => prev + resetCount);
      }
      setResetExtractionOpen(false);
      const actionText = action === 'mark' ? t('chat.resetActionMark') : t('chat.resetActionReset');
      showToast(formatTemplate(t('chat.resetActionDone'), { action: actionText, count: resetCount }), 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('chat.resetExtractionFail'));
    }
  };

  // 手动触发记忆提取
  const handleManualExtract = async () => {
    if (!activeConvId || memoryExtractStatus === 'extracting') return;
    try {
      const res = await fetch('/api/memory-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: activeConvId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || t('chat.manualExtractFail'));
        return;
      }
      // 开始轮询提取状态
      void pollMemoryTask(activeConvId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('chat.manualExtractFail'));
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
    setMessages(prev => uniqueMessagesById([...prev, tempUserMessage]));

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

      let fullText = '';
      await readChatSseStream(response.body, {
        onChunk: text => {
          fullText += text;
          // 同 callChatStream：双重守卫，避免在用户切走后写到错误的对话上
          if (activeStreamConvRef.current === myConvId && activeConvIdRef.current === myConvId) {
            scheduleStreamingText(fullText);
          }
        },
        onMemoryExtracting: () => {
          void pollMemoryTask(myConvId);
        },
        getErrorMessage: () => t('chat.errorGeneral'),
      });

      await refreshMessagesForConversation(myConvId);
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
      // 同 callChatStream：finally 阶段无条件清空全局 streaming state，
      // 避免「中途切走 → 切回」时残留旧 streamingText 的幽灵气泡。
      if (activeStreamConvRef.current === myConvId) {
        activeStreamConvRef.current = null;
      }
      setIsLoading(false);
      setStreamingText('');
      setStreamingConvId(null);
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
              aria-label={t('chat.openCharacterList')}
            >
              <MenuIcon className="h-5 w-5" />
            </button>
          </div>
        )}
        {/* glow 用 absolute + -translate-x/y-1/2 保证真正居中 */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="home-glow" />
        </div>
        <div className="relative flex -translate-y-16 flex-col items-center md:translate-y-0">
          <h1
            className="home-title bg-gradient-to-br from-accent-dark via-accent to-accent-light bg-clip-text text-5xl font-semibold tracking-tight text-transparent md:text-6xl"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            LumiMuse
          </h1>
          <p className="mt-5 text-base leading-relaxed text-text-muted md:text-lg">
            {t('chat.homeTagline')}
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
      <ChatHeader
        character={activeCharacter}
        activeConversation={activeConversation}
        conversationsCount={conversations.length}
        memoryCount={memoryCount}
        isStreamingHere={isStreamingHere}
        creating={creating}
        summarizing={summarizing}
        duplicating={duplicating}
        toolbarExpanded={toolbarExpanded}
        onToggleToolbar={() => setToolbarExpanded(!toolbarExpanded)}
        onOpenSidebar={onOpenSidebar}
        onOpenSearch={onOpenSearch}
        onOpenConvDrawer={() => setConvDrawerOpen(true)}
        onNewChat={handleNewChat}
        onRename={() => { openRename(); setToolbarExpanded(false); }}
        onSummarize={() => { handleSummarize(); setToolbarExpanded(false); }}
        onDuplicate={() => { handleDuplicateConv(); setToolbarExpanded(false); }}
        onOpenImageManager={() => { setImageManagerOpen(true); setToolbarExpanded(false); }}
        onRequestDelete={() => { setDeleteOpen(true); setToolbarExpanded(false); }}
      />

      <div className="grid min-h-0 flex-1 gap-2 md:gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="surface-panel flex min-h-0 flex-col overflow-hidden">
          <ChatToolbar
            activeConversation={activeConversation}
            unextractedCount={unextractedCount}
            memoryExtractStatus={memoryExtractStatus}
            tokenCount={tokenCount}
            onOpenResetExtraction={() => setResetExtractionOpen(true)}
            onOpenTokenBreakdown={() => setTokenBreakdownOpen(true)}
          />

          <ChatMessageList
            ref={messagesEndRef}
            visibleMessages={visibleMessages}
            hiddenMessageId={hiddenMessageId}
            streamingTargetId={streamingTargetId}
            highlightedId={highlightedId}
            isStreamingHere={isStreamingHere}
            hasOlderMessages={hasOlderMessages}
            loadingOlderMessages={loadingOlderMessages}
            showTimestamps={showTimestamps}
            activeConvId={activeConvId}
            streamingText={streamingText}
            character={activeCharacter}
            streamingBubble={streamingBubble}
            versionInfoByMessageId={versionInfoByMessageId}
            topSentinelRef={topSentinelRef}
            onLoadOlder={() => void loadOlderMessages()}
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

          <ChatInput
            onSend={handleSend}
            onStop={handleStop}
            disabled={isStreamingHere}
            isGenerating={isStreamingHere}
            currentModel={currentModel}
            onModelChange={async (model: string) => {
              const previousModel = currentModel;
              setCurrentModel(model);
              try {
                await parseJsonResponse<void>(await fetch('/api/settings', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model }),
                }));
              } catch (err) {
                setCurrentModel(previousModel);
                showToast(err instanceof Error ? err.message : t('settings.saveFailed'), 'error');
              }
            }}
          />
        </section>

        <ConversationDesktopAside
          conversations={conversations}
          activeConvId={activeConvId}
          onSelect={setActiveConvId}
        />
      </div>

      {renameOpen && (
        <RenameConvModal
          open={renameOpen}
          initialValue={renameValue}
          onClose={() => setRenameOpen(false)}
          onConfirm={async (newTitle) => {
            setRenameValue(newTitle);
            await handleRenameConv(newTitle);
          }}
        />
      )}

      {deleteOpen && (
        <DeleteConvModal
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onConfirm={handleDeleteConv}
        />
      )}

      {/* 重置提取状态弹窗 */}
      {resetExtractionOpen && (
        <ResetExtractionModal
          open={resetExtractionOpen}
          conversationId={activeConvId}
          conversation={activeConversation}
          serverUnextractedCount={serverUnextractedCount}
          memoryExtractStatus={memoryExtractStatus}
          onClose={() => setResetExtractionOpen(false)}
          onSubmit={async (messageIds, action) => {
            await handleResetExtraction(messageIds, action);
          }}
          onToggleIgnore={async () => {
            if (!activeConvId) return;
            const isIgnored = Boolean(activeConversation?.ignore_memory);
            try {
              await expectOkResponse(await fetch(`/api/conversations/${activeConvId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ignore_memory: !isIgnored }),
              }));
              setConversations(prev => prev.map(c =>
                c.id === activeConvId ? { ...c, ignore_memory: isIgnored ? 0 : 1 } : c
              ));
              showToast(isIgnored ? t('chat.ignoreOff') : t('chat.ignoreOn'), 'info');
            } catch (err) {
              showToast(err instanceof Error ? err.message : t('chat.ignoreToggleFail'), 'error');
            }
          }}
          onManualExtract={handleManualExtract}
          loadAllMessages={async (cid) => {
            const { messages: msgs } = await fetchMessagesPage(cid, { all: true });
            return msgs;
          }}
        />
      )}

      {/* 移动端对话列表抽屉（lg 以下显示） */}
      <ConversationMobileDrawer
        open={convDrawerOpen}
        conversations={conversations}
        activeConvId={activeConvId}
        onSelect={setActiveConvId}
        onClose={() => setConvDrawerOpen(false)}
      />

      {/* 图片管理弹窗 */}
      <ImageManagerModal
        open={imageManagerOpen}
        character={character}
        onClose={() => setImageManagerOpen(false)}
        onAfterBatchDelete={async () => {
          if (activeConvId) await refreshMessages();
        }}
        showToast={showToast}
      />

      {/* Token 拆分弹窗 */}
      <TokenBreakdownModal
        open={tokenBreakdownOpen}
        onClose={() => setTokenBreakdownOpen(false)}
        items={tokenBreakdownItems}
      />
    </div>
  );
}
