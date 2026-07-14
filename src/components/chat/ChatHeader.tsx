'use client';

import { memo } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import {
  ChevronDownIcon,
  DuplicateIcon,
  ImageIcon,
  ListIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  SummaryIcon,
  TrashIcon,
} from '@/components/ui/icons';
import type { Character, Conversation } from '@/types';

interface Props {
  character: Character;
  activeConversation: Conversation | null;
  conversationsCount: number;
  memoryCount: number;
  isStreamingHere: boolean;
  creating: boolean;
  summarizing: boolean;
  duplicating: boolean;
  toolbarExpanded: boolean;
  onToggleToolbar: () => void;
  onOpenSidebar?: () => void;
  onOpenSearch?: () => void;
  onOpenConvDrawer: () => void;
  onNewChat: () => void;
  onRename: () => void;
  onSummarize: () => void;
  onDuplicate: () => void;
  onOpenImageManager: () => void;
  onRequestDelete: () => void;
}

/**
 * 聊天页顶部工具栏。
 * 移动/平板竖屏(<lg ≈1024)：紧凑栏 + 默认展开的二级操作（可手动收起） + 对话抽屉入口。
 * 桌面/平板横屏(lg+)：完整工具栏；按钮文字仅 2xl+ 显示（更窄时只留图标，避免 iPad 横屏挤压）；
 * 「最近对话」按钮打开对话切换抽屉（ConversationDrawer）。
 * 数据来自 ChatView，所有交互通过 props 回调，无内部状态（除 toolbarExpanded 由父级管理）。
 */
function ChatHeaderImpl({
  character,
  activeConversation,
  conversationsCount,
  memoryCount,
  isStreamingHere,
  creating,
  summarizing,
  duplicating,
  toolbarExpanded,
  onToggleToolbar,
  onOpenSidebar,
  onOpenSearch,
  onOpenConvDrawer,
  onNewChat,
  onRename,
  onSummarize,
  onDuplicate,
  onOpenImageManager,
  onRequestDelete,
}: Props) {
  const { t } = useTranslation();

  return (
    <>
      {/* === 移动/平板竖屏：紧凑工具栏（可折叠展开） === */}
      <section className="surface-hero px-3 py-2 lg:hidden">
        <div className="flex items-center gap-2">
          {onOpenSidebar && (
            <button
              onClick={onOpenSidebar}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-xl p-2 text-text-secondary hover:bg-warm-100"
              aria-label={t('chat.openCharacterList')}
            >
              <MenuIcon className="h-4 w-4" />
            </button>
          )}
          <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-accent/18 to-accent-light/28 ring-1 ring-accent/10">
            {character.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={character.avatar_url} alt={character.name} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <span className="text-xs font-semibold text-accent-dark">{character.name[0]}</span>
            )}
          </div>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{character.name}</h2>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={onOpenConvDrawer}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-xl p-2 text-text-secondary hover:bg-warm-100"
              aria-label={t('chat.switchConversation')}
            >
              <ListIcon className="h-4 w-4" />
            </button>
            <button
              onClick={onNewChat}
              disabled={creating}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-xl bg-accent p-2 text-white shadow-sm disabled:opacity-50"
              aria-label={t('chat.newConversation')}
            >
              {creating ? <span className="spinner-sm" aria-hidden="true" /> : <PlusIcon className="h-4 w-4" />}
            </button>
            {onOpenSearch && (
              <button
                onClick={onOpenSearch}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-xl p-2 text-text-secondary hover:bg-warm-100"
                aria-label={t('chat.searchMessages')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  <circle cx="11" cy="11" r="6.5" /><path d="M16 16l5 5" />
                </svg>
              </button>
            )}
            <button
              onClick={onToggleToolbar}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-xl p-2 text-text-secondary hover:bg-warm-100"
              aria-label={toolbarExpanded ? t('chat.collapseToolbar') : t('chat.expandToolbar')}
              aria-expanded={toolbarExpanded}
            >
              <ChevronDownIcon className={`h-4 w-4 transition-transform duration-200 ${toolbarExpanded ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>
        {/* 展开区：高度过渡动画，避免突兀显隐 */}
        <div
          className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out ${
            toolbarExpanded ? 'mt-1.5 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0">
            <div className="border-t border-border-light/60 pt-1.5">
              <div className="flex items-center gap-1.5">
                <span className="chip whitespace-nowrap text-[10px]">{conversationsCount} {t('chat.quickResume')}</span>
                <span className="chip whitespace-nowrap text-[10px]">{memoryCount} {t('memory.count')}</span>
                <div className="flex-1" />
                <button
                  onClick={onRename}
                  disabled={!activeConversation}
                  className="rounded-xl p-2 text-text-secondary hover:bg-warm-100 disabled:opacity-40"
                  aria-label={t('common.edit')}
                >
                  <PencilIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={onSummarize}
                  disabled={!activeConversation || isStreamingHere || summarizing}
                  className="rounded-xl p-2 text-text-secondary hover:bg-warm-100 disabled:opacity-40"
                  aria-label={t('chat.summarize')}
                >
                  {summarizing ? <span className="spinner-sm" aria-hidden="true" /> : <SummaryIcon className="h-4 w-4" />}
                </button>
                <button
                  onClick={onDuplicate}
                  disabled={!activeConversation || duplicating}
                  className="rounded-xl p-2 text-text-secondary hover:bg-warm-100 disabled:opacity-40"
                  aria-label={t('chat.duplicate')}
                >
                  {duplicating ? <span className="spinner-sm" aria-hidden="true" /> : <DuplicateIcon className="h-4 w-4" />}
                </button>
                <button
                  onClick={onOpenImageManager}
                  className="rounded-xl p-2 text-text-secondary hover:bg-warm-100"
                  aria-label={t('chat.imageManagerTitle')}
                >
                  <ImageIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={onRequestDelete}
                  disabled={!activeConversation}
                  className="rounded-xl p-2 text-red-400 hover:bg-red-50 disabled:opacity-40"
                  aria-label={t('common.delete')}
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* === 桌面/平板横屏(lg+)：完整工具栏 === */}
      <section className="surface-hero hidden px-5 py-5 lg:block">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[1.35rem] bg-gradient-to-br from-accent/18 to-accent-light/28 ring-1 ring-accent/10">
              {character.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={character.avatar_url} alt={character.name} className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <span className="text-xl font-semibold text-accent-dark">{character.name[0]}</span>
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-xl font-semibold text-text-primary">{character.name}</h2>
                <span className="chip chip-active text-[11px]">{t('chat.profile')}</span>
                <span className="chip text-[11px]">{memoryCount} {t('memory.count')}</span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              onClick={onOpenConvDrawer}
              className="soft-button soft-button-secondary px-4 py-2 text-sm"
              title={t('chat.quickResume')}
              aria-label={t('chat.quickResume')}
            >
              <ListIcon className="h-4 w-4" />
              <span className="hidden 2xl:inline">{t('chat.quickResume')} ({conversationsCount})</span>
            </button>
            <button
              onClick={onNewChat}
              disabled={creating}
              className="soft-button soft-button-primary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              title={t('chat.newChat')}
              aria-label={t('chat.newChat')}
            >
              {creating ? <span className="spinner-sm" aria-hidden="true" /> : <PlusIcon className="h-4 w-4" />}
              <span className="hidden 2xl:inline">{t('chat.newChat')}</span>
            </button>
            <button
              onClick={onRename}
              disabled={!activeConversation}
              className="soft-button soft-button-secondary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              title={t('common.edit')}
              aria-label={t('common.edit')}
            >
              <PencilIcon className="h-4 w-4" />
              <span className="hidden 2xl:inline">{t('common.edit')}</span>
            </button>
            <button
              onClick={onSummarize}
              disabled={!activeConversation || isStreamingHere || summarizing}
              className="soft-button soft-button-secondary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              title={t('chat.summarizeTitle')}
              aria-label={t('chat.summarize')}
            >
              {summarizing ? <span className="spinner-sm" aria-hidden="true" /> : <SummaryIcon className="h-4 w-4" />}
              <span className="hidden 2xl:inline">{summarizing ? t('chat.summarizing') : t('chat.summarize')}</span>
            </button>
            <button
              onClick={onDuplicate}
              disabled={!activeConversation || duplicating}
              className="soft-button soft-button-secondary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              title={t('chat.duplicateTitle')}
              aria-label={t('chat.duplicate')}
            >
              {duplicating ? <span className="spinner-sm" aria-hidden="true" /> : <DuplicateIcon className="h-4 w-4" />}
              <span className="hidden 2xl:inline">{duplicating ? t('chat.duplicating') : t('chat.duplicate')}</span>
            </button>
            <button
              onClick={onOpenImageManager}
              className="soft-button soft-button-secondary px-4 py-2 text-sm"
              title={t('chat.imageManagerTitleHint')}
              aria-label={t('chat.imageManagerTitle')}
            >
              <ImageIcon className="h-4 w-4" />
              <span className="hidden 2xl:inline">{t('chat.imageManagerTitle')}</span>
            </button>
            <button
              onClick={onRequestDelete}
              disabled={!activeConversation}
              className="soft-button soft-button-danger px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              title={t('common.delete')}
              aria-label={t('common.delete')}
            >
              <TrashIcon className="h-4 w-4" />
              <span className="hidden 2xl:inline">{t('common.delete')}</span>
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

const ChatHeader = memo(ChatHeaderImpl);
export default ChatHeader;
