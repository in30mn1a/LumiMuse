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
  // 角色 fetch 的请求序列号：handleCharacterSelect 用，避免快速切角色时旧请求覆盖新请求
  const characterRequestSeqRef = useRef(0);
  // 对话切换时也独立维护一个序列号，避免 await fetch character 期间用户又切到别的对话，
  // 让较慢的旧请求把状态覆盖回错误的角色。与上方 ref 区分：character 选择和 conversation 选择
  // 是两条互相独立的赛道，共享同一序列会让选角色时误废弃合法的对话切换响应。
  const conversationSelectSeqRef = useRef(0);

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
    // 入口 ++seq 并捕获本地 mySeq；fetch 完成后只有 mySeq 仍是最新值才允许 setState，
    // 否则用户已切到别处，旧响应直接丢弃。
    const mySeq = ++conversationSelectSeqRef.current;
    setSelectedConversationId(conversationId);
    setTargetMessageId(messageId ?? null);
    if (characterId !== selectedCharacterId) {
      setSelectedCharacterId(characterId);
      try {
        const response = await fetch(`/api/characters/${characterId}`);
        const full = await response.json();
        if (mySeq === conversationSelectSeqRef.current) {
          setSelectedCharacter(full);
        }
      } catch {
        /* 网络失败时保持现状，不破坏 UI */
      }
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
