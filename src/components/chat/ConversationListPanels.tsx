'use client';

import {
  DndContext,
  type DragEndEvent,
  KeyboardCode,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Conversation } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { formatDateTime, formatShortDate } from '@/lib/chat-view-utils';
import { ClockIcon, PlusIcon } from '@/components/ui/icons';
import Modal from '@/components/ui/Modal';

interface ConversationItemProps {
  conversation: Conversation;
  active: boolean;
  reorderDisabled: boolean;
  onClick: () => void;
}

/** 可拖拽的对话卡片：卡片本体即拖拽手柄（鼠标移动 5px / 触屏长按 220ms 才进入拖拽），轻点仍是切换对话 */
function ConversationItem({ conversation, active, reorderDisabled, onClick }: ConversationItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: conversation.id, disabled: reorderDisabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 5 : 'auto',
    position: 'relative',
    touchAction: 'manipulation',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (isDragging) return;
        onClick();
      }}
      // Enter 保留切换语义；其余按键交给 dnd-kit 的 KeyboardSensor（Space 拿起/放下）
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (isDragging) return;
          e.preventDefault();
          onClick();
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
      className={`w-full select-none rounded-2xl border px-3 py-3 text-left transition-colors duration-200 ${
        active
          ? 'border-accent/25 bg-accent/10'
          : 'border-border-light bg-surface/75 hover:bg-surface'
      } ${isDragging ? 'cursor-grabbing shadow-lg' : reorderDisabled ? 'cursor-default' : 'cursor-grab'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-text-primary">{conversation.title}</span>
        <span className="shrink-0 text-xs text-text-muted">{formatShortDate(conversation.updated_at)}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
        <ClockIcon className="h-3.5 w-3.5" />
        {formatDateTime(conversation.updated_at)}
      </div>
    </div>
  );
}

interface DrawerProps {
  open: boolean;
  conversations: Conversation[];
  activeConvId: string | null;
  onSelect: (id: string) => void;
  onNewChat?: () => void;
  /** 拖拽结束：新顺序与拖拽前顺序（失败时用于回滚） */
  onReorder?: (orderedIds: string[], previousIds: string[]) => void;
  reorderPending?: boolean;
  onClose: () => void;
}

/**
 * 对话切换抽屉（全断点）：
 * <lg 从底部滑出的抽屉；lg+ 居中弹窗（入口是 ChatHeader 的标题与侧栏的「全部 N 个对话」）。
 */
export function ConversationDrawer({ open, conversations, activeConvId, onSelect, onNewChat, onReorder, reorderPending = false, onClose }: DrawerProps) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: {
        start: [KeyboardCode.Space],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Space],
      },
    }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (reorderPending || !over || active.id === over.id || !onReorder) return;
    const previousIds = conversations.map(c => c.id);
    const oldIndex = previousIds.indexOf(String(active.id));
    const newIndex = previousIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(previousIds, oldIndex, newIndex), previousIds);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={t('chat.quickResume')}
      padded={false}
      overlayClassName="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] animate-fadeIn"
      dialogClassName="fixed inset-x-0 bottom-0 z-50 animate-slideUp outline-none lg:bottom-auto lg:left-1/2 lg:right-auto lg:top-[16dvh] lg:w-[26rem] lg:max-w-[calc(100vw-3rem)] lg:-translate-x-1/2 lg:animate-fadeIn"
    >
      <div className="surface-panel rounded-b-none rounded-t-[28px] px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4 lg:rounded-3xl lg:pb-5">
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
          {onNewChat && (
            <button
              type="button"
              onClick={() => {
                onNewChat();
                onClose();
              }}
              className="flex min-h-11 w-full items-center gap-2 rounded-2xl border border-dashed border-accent/30 px-3 text-sm font-medium text-accent-dark transition-colors hover:bg-accent/10"
            >
              <PlusIcon className="h-4 w-4" />
              {t('chat.newChat')}
            </button>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={conversations.map(c => c.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {conversations.map(c => (
                  <ConversationItem
                    key={c.id}
                    conversation={c}
                    active={activeConvId === c.id}
                    reorderDisabled={reorderPending || !onReorder}
                    onClick={() => {
                      onSelect(c.id);
                      onClose();
                    }}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
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
