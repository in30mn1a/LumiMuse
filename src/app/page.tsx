'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Character } from '@/types';
import Sidebar from '@/components/sidebar/Sidebar';
import type { SidebarChat } from '@/components/sidebar/CharacterList';
import ChatView from '@/components/chat/ChatView';
import GlobalSearch from '@/components/search/GlobalSearch';
import Modal from '@/components/ui/Modal';
import { parseJsonResponse } from '@/lib/http';
import type { TextHighlightRange } from '@/lib/text-highlight';

interface HomeSelection {
  characterId: string | null;
  character: Character | null;
  conversationId: string | null;
  targetMessageId: string | null;
  /** 区分同一消息的多次搜索跳转；普通对话选择没有请求 id */
  targetRequestId: number | null;
  /** 由搜索结果快照带入，只高亮后端确认命中的原文区间 */
  searchHighlightRanges: readonly TextHighlightRange[];
}

/** 上次打开的角色与对话（只存 id）：桌面端启动时直接回到那段对话，而不是空白首页 */
const LAST_CHAT_KEY = 'lumimuse_last_chat';

/** 侧栏常驻断点（lg）。以下走抽屉：iPad 竖屏 ~768–834 走抽屉，横屏 ≥1024 常驻 */
const DESKTOP_LAYOUT_QUERY = '(min-width: 1024px)';

function isDesktopLayout(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_LAYOUT_QUERY).matches;
}

function readLastChat(): { characterId: string; conversationId: string | null } | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LAST_CHAT_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return null;
    const { characterId, conversationId } = saved as { characterId?: unknown; conversationId?: unknown };
    if (typeof characterId !== 'string' || !characterId) return null;
    return { characterId, conversationId: typeof conversationId === 'string' ? conversationId : null };
  } catch {
    return null;
  }
}

export default function Home() {
  const [selection, setSelection] = useState<HomeSelection>({
    characterId: null,
    character: null,
    conversationId: null,
    targetMessageId: null,
    targetRequestId: null,
    searchHighlightRanges: [],
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // null = 全局搜索（侧栏 / Ctrl+K）；非空 = 只搜该角色（聊天页顶部搜索）
  const [searchCharacterId, setSearchCharacterId] = useState<string | null>(null);
  const selectionGenerationRef = useRef(0);
  const [sidebarChat, setSidebarChat] = useState<SidebarChat | null>(null);
  const {
    characterId: selectedCharacterId,
    character: selectedCharacter,
    conversationId: selectedConversationId,
    targetMessageId,
    targetRequestId,
    searchHighlightRanges,
  } = selection;

  useEffect(() => {
    if (sessionStorage.getItem('lumimuse_open_sidebar') !== '1') return;
    sessionStorage.removeItem('lumimuse_open_sidebar');
    window.history.replaceState(null, '', window.location.pathname);
    requestAnimationFrame(() => setSidebarOpen(true));
  }, []);

  useEffect(() => {
    // 抽屉布局（手机/平板竖屏）启动停在首页，由用户从角色列表自己挑；
    // 桌面侧栏常驻，回到上次对话不会挡住选择别的角色。
    if (!isDesktopLayout()) return;
    const last = readLastChat();
    if (!last) return;
    const generation = ++selectionGenerationRef.current;
    fetch(`/api/characters/${last.characterId}`)
      .then(response => parseJsonResponse<Character>(response))
      .then((full: Character) => {
        // 恢复期间用户已经自己选了别的：以用户的选择为准
        if (selectionGenerationRef.current !== generation) return;
        setSelection({
          characterId: full.id,
          character: full,
          conversationId: last.conversationId,
          targetMessageId: null,
          targetRequestId: null,
          searchHighlightRanges: [],
        });
      })
      .catch(() => {/* 角色已删除或离线：留在首页 */});
  }, []);

  const handleSidebarChatChange = useCallback((chat: SidebarChat | null) => {
    setSidebarChat(chat);
    if (!chat) return;
    try {
      localStorage.setItem(LAST_CHAT_KEY, JSON.stringify({
        characterId: chat.characterId,
        conversationId: chat.activeConversationId,
      }));
    } catch {
      /* 隐私模式等写不进去时只是下次不恢复 */
    }
  }, []);

  // 侧栏里的对话操作在移动端抽屉内触发，执行前先收起抽屉
  const sidebarChatProps: SidebarChat | null = sidebarChat && {
    ...sidebarChat,
    onSelectConversation: id => {
      setSidebarOpen(false);
      sidebarChat.onSelectConversation(id);
    },
    onNewChat: () => {
      setSidebarOpen(false);
      sidebarChat.onNewChat();
    },
    onShowAll: () => {
      setSidebarOpen(false);
      sidebarChat.onShowAll();
    },
  };

  const handleCharacterSelect = (id: string, characterSnapshot?: Character) => {
    const generation = ++selectionGenerationRef.current;
    setSidebarOpen(false);
    if (characterSnapshot) {
      setSelection({
        characterId: id,
        character: characterSnapshot,
        conversationId: null,
        targetMessageId: null,
        targetRequestId: null,
        searchHighlightRanges: [],
      });
    }
    fetch(`/api/characters/${id}`)
      .then(response => parseJsonResponse<Character>(response))
      .then((full: Character) => {
        if (selectionGenerationRef.current !== generation) return;
        setSelection({
          characterId: id,
          character: full,
          conversationId: null,
          targetMessageId: null,
          targetRequestId: null,
          searchHighlightRanges: [],
        });
      })
      .catch(() => {/* 请求失败时保留上一组完整 selection 或当前快照 */});
  };

  const openSearch = (scopeCharacterId: string | null) => {
    setSearchCharacterId(scopeCharacterId);
    setSearchOpen(true);
  };

  const handleConversationSelect = async (
    characterId: string,
    conversationId: string,
    messageId?: string,
    highlightRanges?: readonly TextHighlightRange[],
  ) => {
    const generation = ++selectionGenerationRef.current;
    const nextTargetMessageId = messageId ?? null;
    const nextTargetRequestId = nextTargetMessageId ? generation : null;
    const nextSearchHighlightRanges = nextTargetMessageId ? [...(highlightRanges ?? [])] : [];
    setSidebarOpen(false);

    if (characterId === selectedCharacterId && selectedCharacter?.id === characterId) {
      setSelection({
        characterId,
        character: selectedCharacter,
        conversationId,
        targetMessageId: nextTargetMessageId,
        targetRequestId: nextTargetRequestId,
        searchHighlightRanges: nextSearchHighlightRanges,
      });
      return;
    }

    try {
      const full = await parseJsonResponse<Character>(await fetch(`/api/characters/${characterId}`));
      if (selectionGenerationRef.current !== generation) return;
      setSelection({
        characterId,
        character: full,
        conversationId,
        targetMessageId: nextTargetMessageId,
        targetRequestId: nextTargetRequestId,
        searchHighlightRanges: nextSearchHighlightRanges,
      });
    } catch {
      /* 请求失败时保留上一组完整 selection */
    }
  };

  const handleSearchTargetConsumed = useCallback((requestId: number) => {
    setSelection(current => {
      if (current.targetRequestId !== requestId) return current;
      return {
        ...current,
        targetMessageId: null,
        targetRequestId: null,
        searchHighlightRanges: [],
      };
    });
  }, []);

  // Ctrl+K / Cmd+K 打开全局搜索
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(prev => {
          if (!prev) setSearchCharacterId(null);
          return !prev;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Modal 的焦点陷阱/Escape 只看 open，不看 CSS 断点。
  // 移动/平板竖屏打开侧栏后扩到 lg+ 时必须关掉，否则会「看不见 dialog 却困住 Tab」。
  // 文档级滚动锁只在移动端抽屉打开期间生效。抽屉关着时不能锁：iOS Safari 上
  // 页面会比可视区略高，用户要靠拖动整页把顶栏拉回来；常驻 overflow:hidden 会把顶栏钉死在状态栏后面。
  // 桌面常驻侧栏也不走这里，保留触控板左右滑动返回等浏览器手势。
  useEffect(() => {
    if (!sidebarOpen) return;
    const html = document.documentElement;
    const body = document.body;
    const previous = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      htmlOverscroll: html.style.overscrollBehavior,
      bodyOverscroll: body.style.overscrollBehavior,
    };
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    html.style.overscrollBehavior = 'none';
    body.style.overscrollBehavior = 'none';
    const onMove = (event: TouchEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      // 输入框保留原生触摸行为（选字、光标定位）
      if (element?.closest('input, textarea, [contenteditable="true"]')) return;
      // 真能滚动的列表整段手势都交给原生滚动，到边界由 overscroll-behavior: contain 截住、不串到页面。
      // 不在手势中途按「到顶/到底」preventDefault：打断 iOS 的惯性或回弹会让列表卡住拖不动。
      const scroller = element?.closest('[data-sidebar-scroll]');
      if (scroller instanceof HTMLElement && scroller.scrollHeight > scroller.clientHeight + 1) return;
      // 抽屉里其余不可滚动的区域（标题、底部入口、内容不满一屏的列表）不让页面跟着动
      if (event.cancelable) event.preventDefault();
    };
    document.addEventListener('touchmove', onMove, { passive: false });
    return () => {
      document.removeEventListener('touchmove', onMove);
      html.style.overflow = previous.htmlOverflow;
      body.style.overflow = previous.bodyOverflow;
      html.style.overscrollBehavior = previous.htmlOverscroll;
      body.style.overscrollBehavior = previous.bodyOverscroll;
    };
  }, [sidebarOpen]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(DESKTOP_LAYOUT_QUERY);
    const closeIfDesktop = () => {
      if (mq.matches) setSidebarOpen(false);
    };
    closeIfDesktop();
    mq.addEventListener('change', closeIfDesktop);
    return () => mq.removeEventListener('change', closeIfDesktop);
  }, []);

  return (
    <div className="app-shell flex h-dvh">
      {/* 桌面 lg+：static 侧栏。移动/平板竖屏抽屉仅在 sidebarOpen 时挂载，避免双 Sidebar 常驻分叉。 */}
      <div className="hidden h-full min-h-0 lg:block lg:static">
        <Sidebar
          selectedCharacterId={selectedCharacterId}
          onCharacterSelect={handleCharacterSelect}
          onConversationSelect={handleConversationSelect}
          chat={sidebarChatProps}
        />
      </div>

      {/* 打开时焦点落在抽屉本身而不是搜索框：触屏上程序化聚焦输入框会让搜索框一打开就处于激活态。
          遮罩不加 backdrop-filter，抽屉里的滚动列表不落进滤镜合成层。 */}
      <Modal
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        ariaLabel="角色列表"
        padded={false}
        initialFocus="dialog"
        overlayClassName="fixed inset-0 z-30 bg-black/35 animate-fadeIn lg:hidden"
        dialogClassName="fixed left-0 top-0 z-40 h-full min-h-0 outline-none lg:hidden"
      >
        <Sidebar
          selectedCharacterId={selectedCharacterId}
          onCharacterSelect={handleCharacterSelect}
          onConversationSelect={handleConversationSelect}
          chat={sidebarChatProps}
        />
      </Modal>

      {/* 与侧栏同用父级 h-dvh，避免 100vh/100dvh 混用导致底边错位 */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ChatView
          character={selectedCharacter}
          conversationId={selectedConversationId}
          targetMessageId={targetMessageId}
          targetRequestId={targetRequestId}
          searchHighlightRanges={searchHighlightRanges}
          onSearchTargetConsumed={handleSearchTargetConsumed}
          onOpenSidebar={() => setSidebarOpen(true)}
          onOpenSearch={() => openSearch(selectedCharacterId)}
          onSidebarChatChange={handleSidebarChatChange}
        />
      </main>

      {/* 全局搜索弹窗 */}
      <GlobalSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        characterId={searchCharacterId}
        onConversationSelect={(characterId, conversationId, messageId, highlightRanges) =>
          handleConversationSelect(characterId, conversationId, messageId, highlightRanges)
        }
      />
    </div>
  );
}
