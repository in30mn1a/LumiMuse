'use client';

import { useEffect, useRef, useState } from 'react';
import { Character } from '@/types';
import Sidebar from '@/components/sidebar/Sidebar';
import ChatView from '@/components/chat/ChatView';
import GlobalSearch from '@/components/search/GlobalSearch';
import { parseJsonResponse } from '@/lib/http';

interface HomeSelection {
  characterId: string | null;
  character: Character | null;
  conversationId: string | null;
  targetMessageId: string | null;
}

export default function Home() {
  const [selection, setSelection] = useState<HomeSelection>({
    characterId: null,
    character: null,
    conversationId: null,
    targetMessageId: null,
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const selectionGenerationRef = useRef(0);
  const {
    characterId: selectedCharacterId,
    character: selectedCharacter,
    conversationId: selectedConversationId,
    targetMessageId,
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
        });
      })
      .catch(() => {/* 请求失败时保留上一组完整 selection 或当前快照 */});
  };

  const handleConversationSelect = async (characterId: string, conversationId: string, messageId?: string) => {
    const generation = ++selectionGenerationRef.current;
    const nextTargetMessageId = messageId ?? null;
    setSidebarOpen(false);

    if (characterId === selectedCharacterId && selectedCharacter?.id === characterId) {
      setSelection({
        characterId,
        character: selectedCharacter,
        conversationId,
        targetMessageId: nextTargetMessageId,
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
      });
    } catch {
      /* 请求失败时保留上一组完整 selection */
    }
  };

  // Ctrl+K / Cmd+K 打开全局搜索
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="app-shell flex h-dvh">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/35 backdrop-blur-[2px] md:hidden animate-fadeIn"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={`fixed z-40 h-full py-4 pl-4 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform md:static md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <Sidebar
          selectedCharacterId={selectedCharacterId}
          onCharacterSelect={handleCharacterSelect}
          onConversationSelect={handleConversationSelect}
          onSearchOpen={() => setSearchOpen(true)}
        />
      </div>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden md:min-h-[calc(100vh-2rem)]">
        <ChatView
          character={selectedCharacter}
          conversationId={selectedConversationId}
          targetMessageId={targetMessageId}
          onOpenSidebar={() => setSidebarOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
        />
      </main>

      {/* 全局搜索弹窗 */}
      <GlobalSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onConversationSelect={(characterId, conversationId, messageId) =>
          handleConversationSelect(characterId, conversationId, messageId)
        }
      />
    </div>
  );
}
