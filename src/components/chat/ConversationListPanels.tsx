'use client';

import type { Conversation } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { formatDateTime, formatShortDate } from '@/lib/chat-view-utils';
import { ClockIcon } from '@/components/ui/icons';
import Modal from '@/components/ui/Modal';

interface ConversationItemProps {
  conversation: Conversation;
  active: boolean;
  onClick: () => void;
}

function ConversationItem({ conversation, active, onClick }: ConversationItemProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-2xl border px-3 py-3 text-left transition-all duration-200 ${
        active
          ? 'border-accent/25 bg-[rgba(155,124,240,0.10)]'
          : 'border-border-light bg-white/75 hover:bg-white'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-text-primary">{conversation.title}</span>
        <span className="shrink-0 text-[11px] text-text-muted">{formatShortDate(conversation.updated_at)}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
        <ClockIcon className="h-3.5 w-3.5" />
        {formatDateTime(conversation.updated_at)}
      </div>
    </button>
  );
}

interface DrawerProps {
  open: boolean;
  conversations: Conversation[];
  activeConvId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

/**
 * 对话切换抽屉（全断点）：
 * <lg 从底部滑出的抽屉；lg+ 居中弹窗（入口在 ChatHeader 的「最近对话」按钮）。
 */
export function ConversationDrawer({ open, conversations, activeConvId, onSelect, onClose }: DrawerProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={t('chat.quickResume')}
      padded={false}
      overlayClassName="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] animate-fadeIn"
      dialogClassName="fixed inset-x-0 bottom-0 z-50 animate-slideUp outline-none lg:bottom-auto lg:left-1/2 lg:right-auto lg:top-[16dvh] lg:w-[26rem] lg:max-w-[calc(100vw-3rem)] lg:-translate-x-1/2 lg:animate-fadeIn"
    >
      <div className="surface-panel rounded-b-none rounded-t-[28px] px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4 lg:rounded-[28px] lg:pb-5">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border-light lg:hidden" />
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold text-text-primary">
            {t('chat.quickResume')}
            <span className="ml-1.5 font-normal text-text-muted">({conversations.length})</span>
          </p>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-text-muted hover:bg-warm-100"
            aria-label={t('chat.closeDrawer')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[55dvh] space-y-2 overflow-y-auto pb-1">
          {conversations.map(c => (
            <ConversationItem
              key={c.id}
              conversation={c}
              active={activeConvId === c.id}
              onClick={() => {
                onSelect(c.id);
                onClose();
              }}
            />
          ))}
          {conversations.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border-light px-4 py-8 text-center text-sm text-text-muted">
              {t('chat.noConversationBody')}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
