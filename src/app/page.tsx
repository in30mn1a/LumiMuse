'use client';

import { useEffect, useRef, useState } from 'react';
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
  const characterRequestSeqRef = useRef(0);

  useEffect(() => {
    if (sessionStorage.getItem('lumimuse_open_sidebar') !== '1') return;
    sessionStorage.removeItem('lumimuse_open_sidebar');
    window.history.replaceState(null, '', window.location.pathname);
    requestAnimationFrame(() => setSidebarOpen(true));
  }, []);

  const handleCharacterSelect = (id: string, characterSnapshot?: Character) => {
    const requestSeq = ++characterRequestSeqRef.current;
    setSelectedCharacterId(id);
    setSelectedConversationId(null);
    setTargetMessageId(null);
    setSidebarOpen(false);
    // 乐观更新：先用列表里的快照立即渲染，让 UI 即时响应
    if (characterSnapshot) setSelectedCharacter(characterSnapshot);
    // 后台 fetch 完整数据（含 system_prompt 等大字段），静默补全
    fetch(`/api/characters/${id}`)
      .then(r => r.json())
      .then((full: Character) => {
        if (characterRequestSeqRef.current === requestSeq) setSelectedCharacter(full);
      })
      .catch(() => {/* 网络失败时保留快照数据 */});
  };

  const handleConversationSelect = async (characterId: string, conversationId: string, messageId?: string) => {
    const requestSeq = ++characterRequestSeqRef.current;
    setSelectedConversationId(conversationId);
    setTargetMessageId(messageId ?? null);
    if (characterId !== selectedCharacterId) {
      setSelectedCharacterId(characterId);
      const response = await fetch(`/api/characters/${characterId}`);
      const full = await response.json();
      if (characterRequestSeqRef.current === requestSeq) setSelectedCharacter(full);
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
