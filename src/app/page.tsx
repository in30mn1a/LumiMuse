'use client';

import { useEffect, useState } from 'react';
import { Character } from '@/types';
import Sidebar from '@/components/sidebar/Sidebar';
import ChatView from '@/components/chat/ChatView';
import GlobalSearch from '@/components/search/GlobalSearch';

export default function Home() {
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem('lumimuse_open_sidebar') !== '1') return;
    sessionStorage.removeItem('lumimuse_open_sidebar');
    window.history.replaceState(null, '', window.location.pathname);
    requestAnimationFrame(() => setSidebarOpen(true));
  }, []);

  const handleCharacterSelect = async (id: string) => {
    setSelectedCharacterId(id);
    setSelectedConversationId(null);
    setTargetMessageId(null);
    const response = await fetch(`/api/characters/${id}`);
    setSelectedCharacter(await response.json());
    setSidebarOpen(false);
  };

  const handleConversationSelect = async (characterId: string, conversationId: string, messageId?: string) => {
    setSelectedConversationId(conversationId);
    setTargetMessageId(messageId ?? null);
    if (characterId !== selectedCharacterId) {
      setSelectedCharacterId(characterId);
      const response = await fetch(`/api/characters/${characterId}`);
      setSelectedCharacter(await response.json());
    }
    setSidebarOpen(false);
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
          className="fixed inset-0 z-30 bg-black/35 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={`fixed z-40 h-full py-4 pl-4 transition-transform duration-300 ease-out md:static md:translate-x-0 ${
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
