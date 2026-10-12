'use client';

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import {
  ChevronDownIcon,
  DuplicateIcon,
  ImageIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SummaryIcon,
  TrashIcon,
} from '@/components/ui/icons';
import type { Character, Conversation } from '@/types';

interface Props {
  character: Character;
  activeConversation: Conversation | null;
  memoryCount: number;
  isStreamingHere: boolean;
  creating: boolean;
  summarizing: boolean;
  duplicating: boolean;
  /** 状态条（待提取 / token）：<lg 换行成顶栏下方的细条，lg+ 与标题同一行 */
  status?: ReactNode;
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

const ICON_BUTTON = 'flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';
const MENU_ITEM = 'flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm text-text-primary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * 聊天页顶栏（全断点同一份 DOM）。
 * <lg：☰ + 头像 + 角色名/对话标题（点击切换对话）+ 搜索 + 图片管理 + ⋯，状态条换行到下方。
 * lg+：对话标题为主、角色名与记忆数为辅，状态条、搜索/总结/图片管理与 ⋯ 同排。
 * 次要操作统一收进带文字的 ⋯ 菜单；总结在 lg+ 已有常驻按钮，菜单里只在 <lg 出现。
 */
function ChatHeaderImpl({
  character,
  activeConversation,
  memoryCount,
  isStreamingHere,
  creating,
  summarizing,
  duplicating,
  status,
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
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false);
        moreTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [moreOpen]);

  const conversationTitle = activeConversation?.title || t('chat.noConversationTitle');
  const runMenuAction = (action: () => void) => {
    // 菜单项即将卸载，先让弹窗记录仍存在的焦点恢复目标。
    moreTriggerRef.current?.focus();
    setMoreOpen(false);
    action();
  };

  return (
    <header className="relative z-10 flex flex-none flex-wrap items-center border-b border-border-light bg-surface lg:gap-2 lg:pl-4 lg:pr-3">
      <div className="order-1 flex h-14 min-w-0 flex-1 items-center pl-1 lg:h-[3.75rem] lg:pl-0">
        {onOpenSidebar && (
          <button onClick={onOpenSidebar} className={`${ICON_BUTTON} lg:hidden`} aria-label={t('chat.openCharacterList')}>
            <MenuIcon className="h-5 w-5" />
          </button>
        )}
        <button
          onClick={onOpenConvDrawer}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1.5 text-left transition-colors hover:bg-surface-2 lg:flex-none lg:max-w-full lg:px-2"
          aria-label={t('chat.switchConversation')}
          title={t('chat.switchConversation')}
        >
          <span className="flex h-[2.125rem] w-[2.125rem] shrink-0 items-center justify-center overflow-hidden rounded-xl bg-accent/12 lg:hidden">
            {character.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={character.avatar_url} alt="" className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <span className="text-sm font-semibold text-accent-dark">{character.name[0]}</span>
            )}
          </span>
          <span className="min-w-0 lg:hidden">
            <span className="block truncate text-base font-semibold leading-tight text-text-primary">{character.name}</span>
            <span className="flex items-center gap-0.5 text-xs leading-snug text-text-muted">
              <span className="truncate">{conversationTitle}</span>
              <ChevronDownIcon className="h-3 w-3 shrink-0" />
            </span>
          </span>
          <span className="hidden min-w-0 lg:block">
            <span className="flex items-center gap-1 text-base font-semibold leading-tight text-text-primary">
              <span className="truncate">{conversationTitle}</span>
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            </span>
            <span className="block truncate text-xs leading-snug text-text-muted">
              {character.name} · {memoryCount} {t('memory.count')}
            </span>
          </span>
        </button>
      </div>

      {status && <div className="order-3 basis-full lg:order-2 lg:basis-auto">{status}</div>}

      <div className="order-2 flex shrink-0 items-center pr-1 lg:order-3 lg:pr-0">
        <span className="mx-1 hidden h-5 w-px bg-border-light lg:block" aria-hidden="true" />
        {onOpenSearch && (
          <button onClick={onOpenSearch} className={ICON_BUTTON} title={t('chat.searchMessages')} aria-label={t('chat.searchMessages')}>
            <SearchIcon className="h-5 w-5" />
          </button>
        )}
        <button
          onClick={onSummarize}
          disabled={!activeConversation || isStreamingHere || summarizing}
          className={`${ICON_BUTTON} hidden lg:flex`}
          title={t('chat.summarizeTitle')}
          aria-label={summarizing ? t('chat.summarizing') : t('chat.summarize')}
        >
          {summarizing ? <span className="spinner-sm" aria-hidden="true" /> : <SummaryIcon className="h-5 w-5" />}
        </button>
        <button
          onClick={onOpenImageManager}
          className={ICON_BUTTON}
          title={t('chat.imageManagerTitleHint')}
          aria-label={t('chat.imageManagerTitle')}
        >
          <ImageIcon className="h-5 w-5" />
        </button>
        <div className="relative" ref={moreMenuRef}>
          <button
            ref={moreTriggerRef}
            type="button"
            onClick={() => setMoreOpen(prev => !prev)}
            className={ICON_BUTTON}
            title={t('common.more')}
            aria-label={t('common.more')}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
          >
            <span aria-hidden="true" className="text-xl leading-none">⋯</span>
          </button>
          {moreOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-50 mt-1 min-w-[12rem] overflow-hidden rounded-2xl border border-border-light bg-surface py-1 shadow-lg"
            >
              <button type="button" role="menuitem" onClick={() => runMenuAction(onNewChat)} disabled={creating} className={MENU_ITEM}>
                {creating ? <span className="spinner-sm" aria-hidden="true" /> : <PlusIcon className="h-4 w-4 text-text-muted" />}
                <span>{t('chat.newChat')}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => runMenuAction(onRename)} disabled={!activeConversation} className={MENU_ITEM}>
                <PencilIcon className="h-4 w-4 text-text-muted" />
                <span>{t('chat.renameTitle')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => runMenuAction(onSummarize)}
                disabled={!activeConversation || isStreamingHere || summarizing}
                className={`${MENU_ITEM} lg:hidden`}
              >
                {summarizing ? <span className="spinner-sm" aria-hidden="true" /> : <SummaryIcon className="h-4 w-4 text-text-muted" />}
                <span>{summarizing ? t('chat.summarizing') : t('chat.summarize')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => runMenuAction(onDuplicate)}
                disabled={!activeConversation || isStreamingHere || duplicating}
                className={MENU_ITEM}
              >
                {duplicating ? <span className="spinner-sm" aria-hidden="true" /> : <DuplicateIcon className="h-4 w-4 text-text-muted" />}
                <span>{duplicating ? t('chat.duplicating') : t('chat.duplicate')}</span>
              </button>
              <div className="my-1 h-px bg-border-light" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() => runMenuAction(onRequestDelete)}
                disabled={!activeConversation}
                className={`${MENU_ITEM} !text-danger`}
              >
                <TrashIcon className="h-4 w-4" />
                <span>{t('common.delete')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

const ChatHeader = memo(ChatHeaderImpl);
export default ChatHeader;
