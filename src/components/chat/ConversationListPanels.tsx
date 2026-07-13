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

interface DesktopProps {
  conversations: Conversation[];
  activeConvId: string | null;
  onSelect: (id: string) => void;
}

/** 桌面侧栏：最近对话 */
export function ConversationDesktopAside({ conversations, activeConvId, onSelect }: DesktopProps) {
  const { t } = useTranslation();
  return (
    <aside className="hidden min-h-0 flex-col gap-4 lg:flex">
      <div className="surface-panel flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 border-b border-border-light px-4 py-4">
          <p className="label-small">{t('chat.quickResume')}</p>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
          {conversations.map(c => (
            <ConversationItem
              key={c.id}
              conversation={c}
              active={activeConvId === c.id}
              onClick={() => onSelect(c.id)}
            />
          ))}
          {conversations.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border-light px-4 py-8 text-center text-sm text-text-muted">
              {t('chat.noConversationBody')}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

interface DrawerProps {
  open: boolean;
  conversations: Conversation[];
  activeConvId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** 移动端底部抽屉：最近对话 */
export function ConversationMobileDrawer({ open, conversations, activeConvId, onSelect, onClose }: DrawerProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={t('chat.quickResume')}
      padded={false}
      overlayClassName="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] animate-fadeIn lg:hidden"
      dialogClassName="fixed bottom-0 left-0 right-0 z-50 animate-slideUp outline-none lg:hidden"
    >
      <div className="surface-panel rounded-b-none rounded-t-[28px] px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border-light" />
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold text-text-primary">{t('chat.quickResume')}</p>
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
