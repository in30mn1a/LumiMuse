'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Character, Message, ReasoningEffort, Settings } from '@/types';
import MessageBubble from './MessageBubble';
import ChatInput from './ChatInput';
import ChatHeader from './ChatHeader';
import ChatToolbar from './ChatToolbar';
import ChatMessageList from './ChatMessageList';
import RenameConvModal from './RenameConvModal';
import DeleteConvModal from './DeleteConvModal';
import type { TokenBreakdownItem, RealUsage, MemoryInjectionInfo } from './TokenBreakdownModal';
import { ConversationDesktopAside, ConversationMobileDrawer } from './ConversationListPanels';
import { useTranslation } from '@/lib/i18n-context';
import { useConversationLoader } from '@/hooks/chat/useConversationLoader';
import { useChatStreaming } from '@/hooks/chat/useChatStreaming';
import { useMessagePaging } from '@/hooks/chat/useMessagePaging';
import { useChatScrollController, type UseChatScrollControllerResult } from '@/hooks/chat/useChatScrollController';
import { useMemoryTaskPolling } from '@/hooks/chat/useMemoryTaskPolling';
import { useChatImageGeneration } from '@/hooks/chat/useChatImageGeneration';
import { useChatMessageActions } from '@/hooks/chat/useChatMessageActions';
import { formatTemplate } from '@/lib/i18n';
import { estimateClientTokens } from '@/lib/token-counter-client';
import { getVersionInfo } from '@/lib/chat-view-utils';
import { stripInlinePrompt } from '@/lib/inline-image-prompt';
import { expectOkResponse, getErrorMessage, parseJsonResponse } from '@/lib/http';
import {
  buildClientTimePayload,
  fetchMessagesPage,
  readChatSseStream,
} from '@/lib/chat-stream-client';
import {
  clearCachedMessages,
  uniqueMessagesById,
  writeCachedMessages,
} from '@/lib/chat-message-cache';
import { MenuIcon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/Toast';
import ErrorBoundary from '@/components/ui/ErrorBoundary';

const PAGE_SIZE = 60; // 每次从后端加载的消息数

const ResetExtractionModal = dynamic(() => import('./ResetExtractionModal'));
const ImageManagerModal = dynamic(() => import('./ImageManagerModal'));
const TokenBreakdownModal = dynamic(() => import('./TokenBreakdownModal'));

interface Props {
  character: Character | null;
  conversationId: string | null;
  targetMessageId?: string | null;
  onOpenSidebar?: () => void;
  onOpenSearch?: () => void;
}

export default function ChatView({ character, conversationId, targetMessageId, onOpenSidebar, onOpenSearch }: Props) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [currentModel, setCurrentModel] = useState('');
  // 思考强度：'default' 时请求体不发送 reasoning_effort 字段
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('default');
  // 记忆包 token 预算（后端 trimByTokenBudget 的裁剪上限）与记忆注入开关，用于前端估算实际注入量
  const [memoryPackageBudget, setMemoryPackageBudget] = useState(12000);
  const [memoryInjectEnabled, setMemoryInjectEnabled] = useState(true);
  // limit_inject=false（关闭增强记忆）时全量注入 active 记忆，不受 budget 裁剪
  const [limitInject, setLimitInject] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const clearMessagesRef = useRef<() => void>(() => {});
  const clearStreamingTextRef = useRef<() => void>(() => {});
  const scrollControllerRef = useRef<Pick<UseChatScrollControllerResult, 'markTargetForScroll' | 'markScrollToBottomOnLoad'> | null>(null);
  const creatingConversationRef = useRef(false);
  const hasCharacter = Boolean(character);

  // 连点新对话防重
  const [creating, setCreating] = useState(false);
  // 总结上下文
  const [summarizing, setSummarizing] = useState(false);
  // 复制对话
  const [duplicating, setDuplicating] = useState(false);
  // 重置提取状态弹窗
  const [resetExtractionOpen, setResetExtractionOpen] = useState(false);
  // 移动端对话列表抽屉
  const [convDrawerOpen, setConvDrawerOpen] = useState(false);
  // 移动端工具栏展开（拉片）
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  // 图片管理弹窗（仅保留开关；列表/选中/分页等已下沉到 ImageManagerModal 内部）
  const [imageManagerOpen, setImageManagerOpen] = useState(false);

  // Token 拆分弹窗
  const [tokenBreakdownOpen, setTokenBreakdownOpen] = useState(false);
  // 本轮 SSE 实时上报的 usage（带 convId 防止切对话后残留）。
  // 与 visibleMessages 里落库的 last_usage 互补：SSE 上报在 refreshMessages 完成前就能显示，
  // 切对话后 convId 不匹配自动失效，fallback 到从消息派生的 persistedUsage。
  const [streamingUsage, setStreamingUsage] = useState<{ convId: string; usage: RealUsage } | null>(null);
  const {
    conversations,
    setConversations,
    memories,
    setMemories,
    activeConvId,
    activeConvIdRef,
    selectActiveConvId,
    activeConversation,
    loadingThread,
    conversationLoadError,
    characterRef,
    refreshConversationState,
  } = useConversationLoader({
    character,
    conversationId,
    clearMessagesRef,
    clearStreamingTextRef,
  });
  const {
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
  } = useChatStreaming({ activeConvId });
  const {
    messages,
    messagesRef,
    visibleMessages,
    hasOlderMessages,
    loadingOlderMessages,
    serverUnextractedCount,
    serverUnextractedCountRef,
    serverTotalTokens,
    applyMessagesResponse,
    updateMessagesForConversation,
    clearMessages,
    replaceMessages,
    refreshMessages,
    refreshMessagesForConversation,
    loadOlderMessages,
    updateServerCounts,
    setServerUnextractedCountValue,
  } = useMessagePaging({
    activeConvId,
    activeConvIdRef,
    targetMessageId,
    pageSize: PAGE_SIZE,
    onTargetMessageLoaded: id => scrollControllerRef.current?.markTargetForScroll(id),
    onInitialMessagesLoaded: () => scrollControllerRef.current?.markScrollToBottomOnLoad(),
    onError: message => showToast(`${t('chat.messageLoadFailed')}: ${message}`, 'error'),
  });
  // 用 useEffect 更新 ref 而非渲染期间直接赋值：React 19 禁止渲染期间更新 ref，
  // 否则可能导致渲染不一致（react-hooks/refs 规则）
  useEffect(() => {
    clearMessagesRef.current = clearMessages;
    clearStreamingTextRef.current = clearStreamingText;
  }, [clearMessages, clearStreamingText]);

  const {
    highlightedId,
    messagesEndRef,
    topSentinelRef,
    scrollContainerRef,
    markSkipNextScroll,
    requestScrollToBottom,
    markTargetForScroll,
    markScrollToBottomOnLoad,
    scrollToBottom,
  } = useChatScrollController({
    visibleMessages,
    messages,
    activeConvId,
    streamingText,
    streamingTargetId,
    streamingConvId,
    loadOlderMessages,
  });
  useEffect(() => {
    scrollControllerRef.current = { markTargetForScroll, markScrollToBottomOnLoad };
  }, [markTargetForScroll, markScrollToBottomOnLoad]);

  const { memoryExtractStatus, pollMemoryTask } = useMemoryTaskPolling({
    activeConvIdRef,
    characterRef,
    setMemories,
    showToast,
    t,
    getLoadedMessageCount: () => messagesRef.current.length,
    updateServerCounts,
    pageSize: PAGE_SIZE,
  });

  const {
    handleGenerateImage,
    maybeAutoGenerateImageFromMessages,
    handleDeleteImage,
    handleEditImagePrompt,
    handleSetPrimaryImage,
  } = useChatImageGeneration({
    activeConvId,
    activeConvIdRef,
    characterRef,
    messagesRef,
    updateMessagesForConversation,
    markSkipNextScroll,
    showToast,
    t,
  });

  const {
    handleEditMessage,
    handleDeleteMessage,
    handleRegenerate,
    handleRegenerateFromHere,
    handleSwitchVersion,
  } = useChatMessageActions({
    activeConvIdRef,
    activeStreamsRef,
    activeStreamConvRef,
    messagesRef,
    beginStream,
    finishStream,
    scheduleStreamingText,
    setStreamingUsage,
    pollMemoryTask,
    refreshMessages,
    refreshConversationState,
    updateMessagesForConversation,
    markSkipNextScroll,
    showToast,
    t,
  });

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
      systemPrompt: character.system_prompt ? estimateClientTokens(character.system_prompt) : 0,
      basicInfo: character.basic_info ? estimateClientTokens(character.basic_info) : 0,
      personality: character.personality ? estimateClientTokens(character.personality) : 0,
      scenario: character.scenario ? estimateClientTokens(character.scenario) : 0,
      otherInfo: character.other_info ? estimateClientTokens(character.other_info) : 0,
      exampleDialogue: character.example_dialogue ? estimateClientTokens(character.example_dialogue) : 0,
    };
  }, [character]);

  const memoriesTokens = useMemo(() => {
    if (!memoryInjectEnabled || memories.length === 0) return 0;
    const memText = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
    const fullTokens = estimateClientTokens(memText);
    // limit_inject=false（关闭增强记忆）时全量注入，后端不裁剪；
    // limit_inject=true 时受 memory_package_token_budget 裁剪
    return limitInject ? Math.min(fullTokens, memoryPackageBudget) : fullTokens;
  }, [memories, memoryInjectEnabled, memoryPackageBudget, limitInject]);

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

  // 估算总量（fallback 用）：当没有真实 usage 时（新对话/上游不支持）才显示
  const estimatedTokenCount = messageTokens + systemPromptTokens;

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

  // 从最近 assistant 消息 metadata.last_usage 派生真实统计。
  // 派生逻辑抽成纯函数（extractLastRealUsage），useMemo 只调用纯函数，
  // 避免 useMemo 回调里的复杂逻辑导致 React Compiler 放弃优化整个 ChatView 组件。
  const lastRealUsage = useMemo(
    () => extractLastRealUsage(streamingUsage, activeConvId, visibleMessages),
    [streamingUsage, activeConvId, visibleMessages],
  );
  // 从最近 assistant 消息 metadata.last_memory_injection 派生上轮记忆注入统计
  const lastMemoryInjection = useMemo(
    () => extractLastMemoryInjection(visibleMessages),
    [visibleMessages],
  );

  // chip 显示的 token 数：优先用上轮真实 prompt_tokens，无真实值时 fallback 到估算。
  // 真实值是模型已处理的上一个请求的输入 token 数，时序上属于「上一轮」，
  // 但比估算准确得多（估算对中文模型普遍高估 1.7-2 倍）。
  const tokenCount = lastRealUsage ? lastRealUsage.prompt_tokens : estimatedTokenCount;

  // 未提取记忆的用户消息数（使用服务端返回的真实数量，不受前端分页限制）
  const unextractedCount = serverUnextractedCount;

  useEffect(() => {
    fetch('/api/settings')
      .then(r => parseJsonResponse<Partial<Settings>>(r))
      .then(s => {
        setShowTimestamps(s.show_timestamps ?? true);
        setCurrentModel(s.model || '');
        setReasoningEffort(s.reasoning_effort ?? 'default');
        setMemoryPackageBudget(s.memory_engine?.memory_package_token_budget ?? 12000);
        setMemoryInjectEnabled(s.memory_inject ?? true);
        setLimitInject(s.limit_inject ?? false);
      })
      .catch(err => {
        showToast(`${t('settings.loadFailed')}: ${getErrorMessage(err)}`, 'error');
      });
  }, [showToast, t]);

  // 后台流完成时，如果用户正在看那个对话，刷新消息列表
  const prevActiveStreamsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevActiveStreamsRef.current;
    // 找到从 prev 中消失的 convId（即刚完成的流）
    if (activeConvId && prev.has(activeConvId) && !activeStreams.has(activeConvId)) {
      // 当前对话的流刚完成，刷新消息
      const cid = activeConvId;
      fetchMessagesPage(cid, { limit: Math.max(PAGE_SIZE, messages.length) })
        .then(response => {
          if (!applyMessagesResponse(cid, response)) return;
          // 自动生图：流刚完成，用服务端最新数据（含 metadata.inlineImagePrompt）直接触发，
          // 这里 freshMessages 已是权威数据，无需等 messagesRef 同步，规避了竞态。
          void maybeAutoGenerateImageFromMessages(cid, response.messages);
        })
        .catch(err => {
          showToast(`${t('chat.messageLoadFailed')}: ${getErrorMessage(err)}`, 'error');
        });
    }
    prevActiveStreamsRef.current = activeStreams;
  }, [activeStreams, activeConvId, applyMessagesResponse, maybeAutoGenerateImageFromMessages, messages.length, showToast, t]);

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
      selectActiveConvId(conversation.id);

      if (character.greeting) {
        const greetingResponse = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversation.id, role: 'assistant', content: character.greeting, token_count: 0 }),
        });
        const greetingMessage = await greetingResponse.json();
        applyMessagesResponse(conversation.id, {
          messages: [greetingMessage],
          hasMore: false,
          oldestSeq: typeof greetingMessage.seq === 'number' ? greetingMessage.seq : null,
          unextractedCount: 0,
          totalTokens: greetingMessage.token_count || 0,
        });
      } else {
        writeCachedMessages(conversation.id, {
          messages: [],
          hasMore: false,
          oldestSeq: null,
          unextractedCount: 0,
          totalTokens: 0,
        });
        clearMessages();
      }

      clearStreamingText();
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
    try {
      await expectOkResponse(await fetch(`/api/conversations/${activeConvId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: finalTitle }),
      }));
      setConversations(prev => prev.map(conversation => (
        conversation.id === activeConvId ? { ...conversation, title: finalTitle } : conversation
      )));
      setRenameOpen(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('common.operationFailed'), 'error');
    }
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
    selectActiveConvId(next?.id || null);
    if (!next) clearMessages();
    setDeleteOpen(false);
    try {
      // 关键点：DELETE 用上面快照下来的 targetConvId，
      // 即便用户在 await 期间又切到别的对话也只会删自己最初确认的那一条
      // 注意：proxy.ts 的 CSRF 校验要求写方法（含 DELETE）带 application/json 头
      await expectOkResponse(await fetch(`/api/conversations/${targetConvId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      }));
      clearCachedMessages(targetConvId);
      setConversations(prev => prev.filter(conversation => conversation.id !== targetConvId));
      void refreshConversationState(next?.id || null);
    } catch (err) {
      selectActiveConvId(previousActiveConvId);
      replaceMessages(previousMessages);
      setDeleteOpen(true);
      showToast(err instanceof Error ? err.message : t('chat.deleteError'), 'error');
    }
  };

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
      requestAnimationFrame(() => scrollToBottom('smooth'));
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
      // 更新服务端未提取数量
      const nextUnextractedCount = action === 'mark'
        ? Math.max(0, serverUnextractedCountRef.current - resetCount)
        : serverUnextractedCountRef.current + resetCount;
      updateMessagesForConversation(
        activeConvId,
        messages => messages.map(updateMeta),
        { unextractedCount: nextUnextractedCount },
      );
      setServerUnextractedCountValue(nextUnextractedCount);
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

  const handleSend = async (content: string, attachments?: import('@/lib/chat-engine').AttachmentItem[]) => {
    if (!character) return;
    // 当前对话正在生成时不允许重复发送（但其他对话可以）
    if (activeConvId && activeStreamsRef.current.has(activeConvId)) return;
    if (!activeConvId && creatingConversationRef.current) return;

    let convId = activeConvId;
    let createdNewConversation = false;
    try {
      if (!convId) {
        creatingConversationRef.current = true;
        createdNewConversation = true;
        const response = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ character_id: character.id }),
        });
        const conversation = await response.json();
        setConversations(prev => [conversation, ...prev]);
        selectActiveConvId(conversation.id);
        convId = conversation.id;
      }
    } catch (error) {
      creatingConversationRef.current = false;
      showToast(error instanceof Error ? error.message : t('chat.errorGeneral'));
      return;
    }

    const ctl = beginStream(convId!);
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

    requestScrollToBottom();
    updateMessagesForConversation(myConvId, messages => uniqueMessagesById([...messages, tempUserMessage]));

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
        onUsage: (usage) => {
          if (activeConvIdRef.current === myConvId) {
            setStreamingUsage({ convId: myConvId, usage });
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
        updateMessagesForConversation(myConvId, messages => messages.filter(message => message.id !== 'temp-user'));
      }
    } finally {
      finishStream(myConvId);
      if (createdNewConversation) {
        creatingConversationRef.current = false;
      }
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
    content: isActiveStream ? stripInlinePrompt(streamingText) : '',
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
            isRealTokenCount={!!lastRealUsage}
            onOpenResetExtraction={() => setResetExtractionOpen(true)}
            onOpenTokenBreakdown={() => setTokenBreakdownOpen(true)}
          />

          {conversationLoadError && (
            <div className="mx-3 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {t('chat.conversationLoadFailed')}: {conversationLoadError}
            </div>
          )}

          <ErrorBoundary>
            <ChatMessageList
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
              messagesEndRef={messagesEndRef}
              topSentinelRef={topSentinelRef}
              scrollContainerRef={scrollContainerRef}
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
          </ErrorBoundary>

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
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={async (effort: ReasoningEffort) => {
              const previousEffort = reasoningEffort;
              setReasoningEffort(effort);
              try {
                await parseJsonResponse<void>(await fetch('/api/settings', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ reasoning_effort: effort }),
                }));
              } catch (err) {
                setReasoningEffort(previousEffort);
                showToast(err instanceof Error ? err.message : t('settings.saveFailed'), 'error');
              }
            }}
          />
        </section>

        <ConversationDesktopAside
          conversations={conversations}
          activeConvId={activeConvId}
          onSelect={selectActiveConvId}
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
        onSelect={selectActiveConvId}
        onClose={() => setConvDrawerOpen(false)}
      />

      {/* 图片管理弹窗 */}
      {imageManagerOpen && (
        <ImageManagerModal
          open={imageManagerOpen}
          character={character}
          onClose={() => setImageManagerOpen(false)}
          onAfterBatchDelete={async () => {
            if (activeConvId) await refreshMessages();
          }}
          showToast={showToast}
        />
      )}

      {/* Token 拆分弹窗 */}
      {tokenBreakdownOpen && (
        <TokenBreakdownModal
          open={tokenBreakdownOpen}
          onClose={() => setTokenBreakdownOpen(false)}
          items={tokenBreakdownItems}
          lastRealUsage={lastRealUsage}
          lastMemoryInjection={lastMemoryInjection}
        />
      )}
    </div>
  );
}

/**
 * 从最近 assistant 消息 metadata.last_memory_injection 派生上轮记忆注入统计。
 * 与 extractLastRealUsage 同理：抽成纯函数避免 React Compiler 放弃优化整个组件。
 */
function extractLastMemoryInjection(messages: Message[]): MemoryInjectionInfo | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const meta = (msg.metadata || {}) as Record<string, unknown>;
    const injection = meta.last_memory_injection as { count?: number; tokens?: number; mode?: string } | undefined;
    if (injection && Number.isFinite(injection.count)) {
      return {
        count: Number(injection.count),
        tokens: Number.isFinite(injection.tokens) ? Number(injection.tokens) : 0,
        mode: injection.mode,
      };
    }
  }
  return null;
}

/**
 * 从 streamingUsage 或最近 assistant 消息 metadata.last_usage 派生真实 usage。
 *
 * 抽成纯函数（而非内联在 ChatView 的 useMemo 里）：React Compiler 对 useMemo 回调做静态分析，
 * 复杂的循环+条件+动态属性访问会让 Compiler 放弃优化整个组件，暴露 pre-existing 的 ref 错误。
 * 纯函数在独立作用域里，Compiler 只需优化 useMemo 的函数调用本身。
 */
function extractLastRealUsage(
  streamingUsage: { convId: string; usage: RealUsage } | null,
  activeConvId: string | null,
  messages: Message[],
): RealUsage | null {
  // 优先用本轮 SSE 实时上报的 streamingUsage（convId 匹配时）
  if (streamingUsage && streamingUsage.convId === activeConvId) {
    return streamingUsage.usage;
  }
  // 否则从最近 assistant 消息的 metadata.last_usage 派生
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const meta = (msg.metadata || {}) as Record<string, unknown>;
    const usage = meta.last_usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    if (usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)) {
      return {
        prompt_tokens: Number(usage.prompt_tokens),
        completion_tokens: Number(usage.completion_tokens),
        total_tokens: Number.isFinite(usage.total_tokens) ? Number(usage.total_tokens) : Number(usage.prompt_tokens) + Number(usage.completion_tokens),
      };
    }
  }
  return null;
}
