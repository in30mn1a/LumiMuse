'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Character } from '@/types';
import Sidebar from '@/components/sidebar/Sidebar';
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
  // 断点用 1024（lg）：iPad 竖屏 ~768–834 走抽屉；横屏 ≥1024 走常驻侧栏。
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
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
      <div className="hidden h-full min-h-0 py-4 pl-4 lg:block lg:static">
        <Sidebar
          selectedCharacterId={selectedCharacterId}
          onCharacterSelect={handleCharacterSelect}
          onConversationSelect={handleConversationSelect}
          onSearchOpen={() => openSearch(null)}
        />
      </div>

      <Modal
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        ariaLabel="角色列表"
        padded={false}
        overlayClassName="fixed inset-0 z-30 bg-black/35 backdrop-blur-[2px] animate-fadeIn lg:hidden"
        dialogClassName="fixed z-40 h-full min-h-0 py-4 pl-4 outline-none lg:hidden"
      >
        <Sidebar
          selectedCharacterId={selectedCharacterId}
          onCharacterSelect={handleCharacterSelect}
          onConversationSelect={handleConversationSelect}
          onSearchOpen={() => openSearch(null)}
        />
      </Modal>

      {/* 与侧栏同用父级 h-dvh + py-4 内边距由 ChatView 自管，避免 100vh/100dvh 混用导致底边错位 */}
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
