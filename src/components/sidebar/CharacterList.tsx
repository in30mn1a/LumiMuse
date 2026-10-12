'use client';

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  DragEndEvent,
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
import { Character, Conversation } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { formatShortDate } from '@/lib/chat-view-utils';
import { parseJsonResponse } from '@/lib/http';
import {
  getCharacterListCache,
  loadCharacterList,
  setCharacterListCache,
  subscribeCharacterList,
} from '@/lib/character-list-cache';
import { PencilIcon, PlusIcon, SparkIcon } from '@/components/ui/icons';

/**
 * 列表滚动位置（模块级）：移动端抽屉每次打开都会重新挂载 CharacterList，
 * 进编辑页再返回首页也会重挂载；记住位置，重新打开时回到上次浏览处而不是顶部。
 */
let savedScrollTop = 0;

/** 选中角色卡下方直接列出的最近对话条数；其余走「全部 N 个对话」打开对话抽屉 */
const SIDEBAR_CONVERSATION_PREVIEW = 5;

/** 选中角色的对话列表；数据与操作都来自 ChatView，侧栏只负责展示 */
export interface SidebarChat {
  characterId: string;
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  onShowAll: () => void;
}

interface Props {
  selectedId: string | null;
  onSelect: (id: string, character: Character) => void;
  chat?: SidebarChat | null;
}

const CONVERSATION_ROW = 'flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors';

function ConversationRows({ chat }: { chat: SidebarChat }) {
  const { t } = useTranslation();
  const preview = chat.conversations.slice(0, SIDEBAR_CONVERSATION_PREVIEW);
  // 当前对话不在前几条里时也要看得到选中态
  const active = chat.conversations.find(item => item.id === chat.activeConversationId);
  const rows = active && !preview.includes(active) ? [...preview.slice(0, -1), active] : preview;
  return (
    <div className="ml-7 space-y-0.5 border-l border-border-light pl-2">
      <button type="button" onClick={chat.onNewChat} className={`${CONVERSATION_ROW} font-medium text-accent-dark hover:bg-accent/10`}>
        <PlusIcon className="h-4 w-4 shrink-0" />
        {t('chat.newChat')}
      </button>
      {rows.map(conversation => (
        <button
          key={conversation.id}
          type="button"
          onClick={() => chat.onSelectConversation(conversation.id)}
          aria-current={conversation.id === chat.activeConversationId ? 'true' : undefined}
          className={`${CONVERSATION_ROW} ${
            conversation.id === chat.activeConversationId
              ? 'bg-accent/12 font-medium text-accent-dark'
              : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
          }`}
        >
          <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
          <time className="shrink-0 text-xs font-normal text-text-muted">{formatShortDate(conversation.updated_at)}</time>
        </button>
      ))}
      {chat.conversations.length > rows.length && (
        <button type="button" onClick={chat.onShowAll} className={`${CONVERSATION_ROW} text-text-muted hover:bg-surface-2 hover:text-text-primary`}>
          {formatTemplate(t('sidebar.allConversations'), { count: chat.conversations.length })}
        </button>
      )}
    </div>
  );
}

interface CardProps {
  character: Character;
  selected: boolean;
  onSelect: (id: string, character: Character) => void;
  editLabel: string;
}

/** 单张可拖拽角色卡片：卡片本体作为拖拽手柄，右侧编辑按钮独立可点 */
function SortableCharacterCard({ character, selected, onSelect, editLabel }: CardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: character.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // 拖拽中的卡片轻微提亮，让其他卡片让位时视觉更清晰
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 5 : 'auto',
    touchAction: 'manipulation',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors duration-200 ${
        selected ? 'bg-accent/10' : 'hover:bg-surface-2'
      } ${isDragging ? 'cursor-grabbing bg-surface shadow-lg' : 'cursor-grab'}`}
      // 拖拽 listeners 只挂在卡片本体，编辑按钮自行 stopPropagation 即可豁免
      {...attributes}
      {...listeners}
      onClick={() => {
        if (isDragging) return;
        onSelect(character.id, character);
      }}
      // Enter 保留角色选择语义；其余按键继续交给 dnd-kit，避免覆盖 KeyboardSensor listener。
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (isDragging) return;
          e.preventDefault();
          onSelect(character.id, character);
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
      role="button"
      tabIndex={0}
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl ${
          selected ? 'bg-accent-solid text-white' : 'bg-surface-2 text-text-secondary'
        }`}
      >
        {character.avatar_url ? (
          <img
            src={character.avatar_url}
            alt={character.name}
            className="h-full w-full object-cover"
            loading="lazy"
            draggable={false}
          />
        ) : (
          <span className="text-sm font-semibold">{character.name[0]}</span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <span className={`block truncate text-[0.9375rem] text-text-primary ${selected ? 'font-semibold' : ''}`}>{character.name}</span>
      </div>

      <Link
        href={`/characters/${character.id}`}
        // 编辑按钮要避开拖拽手势：阻止 pointerdown 冒泡到卡片，否则 dnd-kit 会把按下当成开始拖
        onPointerDown={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        // 触控设备没有可靠 hover：始终显示编辑按钮，避免平板侧栏变窄后「消失」
        className="shrink-0 rounded-full p-2 text-text-muted opacity-80 transition-all duration-200 hover:bg-warm-100 hover:text-accent hover:opacity-100"
        aria-label={editLabel}
      >
        <PencilIcon className="h-4 w-4" />
      </Link>
    </div>
  );
}

export default function CharacterList({ selectedId, onSelect, chat }: Props) {
  const router = useRouter();
  // 优先用模块缓存做首屏，避免移动端 Modal 重挂载时空白闪一下
  const [characters, setCharacters] = useState<Character[]>(() => getCharacterListCache() ?? []);
  const [listError, setListError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  // 首帧已由模块缓存渲染出完整列表，绘制前恢复滚动位置，避免先闪顶部再跳走
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = savedScrollTop;
  }, []);

  // 桌面端鼠标按下后移动 5px 才进入拖拽，避免误触；
  // 移动端长按 220ms 进入拖拽，避免和列表纵向滚动冲突
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

  useEffect(() => subscribeCharacterList(setCharacters), []);

  useEffect(() => {
    let cancelled = false;
    loadCharacterList()
      .then(() => {
        if (!cancelled) setListError('');
      })
      .catch(() => {
        if (!cancelled) setListError(t('common.loadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleCreate = async () => {
    setListError('');
    try {
      const newCharacter = await parseJsonResponse<Character>(await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: t('char.newCharacterName') }),
      }));
      setCharacterListCache([newCharacter, ...(getCharacterListCache() ?? characters)]);
      // 新角色插在列表顶部，编辑完返回时要能直接看到它
      savedScrollTop = 0;
      sessionStorage.setItem('lumimuse_new_character_id', newCharacter.id);
      onSelect(newCharacter.id, newCharacter);
      router.push(`/characters/${newCharacter.id}`);
    } catch {
      setListError(t('common.operationFailed'));
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = characters.findIndex(c => c.id === active.id);
    const newIndex = characters.findIndex(c => c.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const previous = characters;
    const next = arrayMove(characters, oldIndex, newIndex);
    // 乐观更新：先改本地缓存（多实例同步），再 PUT；失败则回滚
    setCharacterListCache(next);
    try {
      const res = await fetch('/api/characters/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: next.map(c => c.id) }),
      });
      if (!res.ok) throw new Error('reorder failed');
    } catch (err) {
      console.warn('[character-reorder] 排序持久化失败，已回滚：', err);
      setListError(t('common.operationFailed'));
      setCharacterListCache(previous);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between pb-1 pl-5 pr-3">
        <span className="text-xs font-medium text-text-muted">{t('sidebar.characters')}</span>
        <button
          onClick={handleCreate}
          className="flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-accent-dark transition-colors hover:bg-accent/10"
        >
          <PlusIcon className="h-4 w-4" />
          {t('sidebar.create')}
        </button>
      </div>
      {listError && <p className="px-5 pb-2 text-xs text-red-500">{listError}</p>}

      <div
        ref={scrollRef}
        data-sidebar-scroll
        onScroll={e => { savedScrollTop = e.currentTarget.scrollTop; }}
        className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-3 pb-4"
      >
        {characters.length === 0 && (
          <div className="surface-panel-quiet mx-1 px-4 py-8 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-surface/80 text-accent-dark shadow-sm">
              <SparkIcon className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium text-text-primary">{t('sidebar.empty')}</p>
          </div>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={characters.map(c => c.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1">
              {characters.map(character => (
                <Fragment key={character.id}>
                  <SortableCharacterCard
                    character={character}
                    selected={selectedId === character.id}
                    onSelect={onSelect}
                    editLabel={t('char.edit')}
                  />
                  {chat && chat.characterId === character.id && selectedId === character.id && (
                    <ConversationRows chat={chat} />
                  )}
                </Fragment>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
