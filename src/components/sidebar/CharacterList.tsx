'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
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
import { Character } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { PencilIcon, PlusIcon, SparkIcon } from '@/components/ui/icons';

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface CardProps {
  character: Character;
  selected: boolean;
  onSelect: (id: string) => void;
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
    // 拖拽中原卡片隐藏（opacity:0），由 DragOverlay 渲染浮动幽灵
    opacity: isDragging ? 0 : 1,
    zIndex: isDragging ? 5 : 'auto',
    touchAction: 'manipulation',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex w-full items-center gap-3 rounded-[1.25rem] border px-3 py-3 text-left transition-colors duration-200 ${
        selected
          ? 'border-accent/26 bg-[rgba(155,124,240,0.10)] shadow-sm'
          : 'border-transparent bg-white/48 hover:border-border-light hover:bg-white/78'
      } ${isDragging ? 'cursor-grabbing shadow-lg' : 'cursor-grab'}`}
      // 拖拽 listeners 只挂在卡片本体，编辑按钮自行 stopPropagation 即可豁免
      {...attributes}
      {...listeners}
      onClick={() => {
        if (isDragging) return;
        onSelect(character.id);
      }}
      role="button"
      tabIndex={0}
    >
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl ring-1 transition-all duration-200 ${
          selected
            ? 'bg-gradient-to-br from-accent to-accent-dark text-white ring-accent/20'
            : 'bg-warm-100 text-text-secondary ring-border-light'
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
        <span className="truncate text-sm font-medium text-text-primary">{character.name}</span>
      </div>

      <Link
        href={`/characters/${character.id}`}
        // 编辑按钮要避开拖拽手势：阻止 pointerdown 冒泡到卡片，否则 dnd-kit 会把按下当成开始拖
        onPointerDown={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        className="rounded-full p-2 text-text-muted transition-all duration-200 hover:bg-warm-100 hover:text-accent opacity-60 md:opacity-0 md:group-hover:opacity-100"
        aria-label={editLabel}
      >
        <PencilIcon className="h-4 w-4" />
      </Link>
    </div>
  );
}

export default function CharacterList({ selectedId, onSelect }: Props) {
  const router = useRouter();
  const [characters, setCharacters] = useState<Character[]>([]);
  const { t } = useTranslation();
  // 正在拖拽的角色 ID（用于渲染 DragOverlay 幽灵卡）
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingCharacter = characters.find(c => c.id === draggingId) || null;

  // 桌面端鼠标按下后移动 5px 才进入拖拽，避免误触；
  // 移动端长按 220ms 进入拖拽，避免和列表纵向滚动冲突
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    fetch('/api/characters').then(r => r.json()).then(setCharacters);
  }, []);

  const handleCreate = async () => {
    const response = await fetch('/api/characters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t('char.newCharacterName') }),
    });
    const newCharacter = await response.json();
    setCharacters(prev => [newCharacter, ...prev]);
    onSelect(newCharacter.id);
    router.push(`/characters/${newCharacter.id}`);
  };

  const handleDragStart = (event: DragStartEvent) => {
    setDraggingId(String(event.active.id));
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = characters.findIndex(c => c.id === active.id);
    const newIndex = characters.findIndex(c => c.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const previous = characters;
    const next = arrayMove(characters, oldIndex, newIndex);
    // 乐观更新：先改本地，再 PUT；失败则回滚
    setCharacters(next);
    setDraggingId(null);
    try {
      const res = await fetch('/api/characters/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: next.map(c => c.id) }),
      });
      if (!res.ok) throw new Error('reorder failed');
    } catch (err) {
      console.warn('[character-reorder] 排序持久化失败，已回滚：', err);
      setCharacters(previous);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-4">
        <button onClick={handleCreate} className="soft-button soft-button-primary w-full justify-center">
          <PlusIcon className="h-4 w-4" />
          {t('sidebar.create')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {characters.length === 0 && (
          <div className="surface-panel-quiet mx-1 px-4 py-8 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/80 text-accent-dark shadow-sm">
              <SparkIcon className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium text-text-primary">{t('sidebar.empty')}</p>
          </div>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <SortableContext items={characters.map(c => c.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {characters.map(character => (
                <SortableCharacterCard
                  key={character.id}
                  character={character}
                  selected={selectedId === character.id}
                  onSelect={onSelect}
                  editLabel={t('char.edit')}
                />
              ))}
            </div>
          </SortableContext>

          {/* 拖拽幽灵卡：浮动克隆，放大 + 深阴影增强拖拽感 */}
          <DragOverlay dropAnimation={{ duration: 180, easing: 'ease' }}>
            {draggingCharacter ? (
              <div className="flex w-full items-center gap-3 rounded-[1.25rem] border border-accent/30 bg-white px-3 py-3 shadow-xl ring-2 ring-accent/20" style={{ transform: 'scale(1.03)', opacity: 0.96 }}>
                <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-accent to-accent-dark text-white ring-1 ring-accent/20">
                  {draggingCharacter.avatar_url ? (
                    <img src={draggingCharacter.avatar_url} alt={draggingCharacter.name} className="h-full w-full object-cover" draggable={false} />
                  ) : (
                    <span className="text-sm font-semibold">{draggingCharacter.name[0]}</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="truncate text-sm font-medium text-text-primary">{draggingCharacter.name}</span>
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}
