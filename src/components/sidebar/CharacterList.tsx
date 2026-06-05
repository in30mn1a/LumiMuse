'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  DragEndEvent,
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
import { parseJsonResponse } from '@/lib/http';
import { PencilIcon, PlusIcon, SparkIcon } from '@/components/ui/icons';

interface Props {
  selectedId: string | null;
  onSelect: (id: string, character: Character) => void;
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
        onSelect(character.id, character);
      }}
      // role="button" + tabIndex=0 让 div 进入 Tab 序列，但语义上是按钮，
      // 因此必须自己绑定 Enter/Space → 触发 onClick，否则键盘用户无法激活
      // (WAI-ARIA: 自定义按钮控件需复刻原生 button 的键盘行为)
      onKeyDown={(e) => {
        if (isDragging) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onSelect(character.id, character);
        } else if (e.key === ' ') {
          // Space 默认会让页面滚动，需 preventDefault；但仅在 keyup 时触发更接近原生 button
          e.preventDefault();
          onSelect(character.id, character);
        }
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
  const [listError, setListError] = useState('');
  const { t } = useTranslation();

  // 桌面端鼠标按下后移动 5px 才进入拖拽，避免误触；
  // 移动端长按 220ms 进入拖拽，避免和列表纵向滚动冲突
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    fetch('/api/characters')
      .then(r => parseJsonResponse<Character[]>(r))
      .then(data => {
        setListError('');
        setCharacters(data);
      })
      .catch(() => setListError(t('common.loadFailed')));
  }, [t]);

  const handleCreate = async () => {
    setListError('');
    try {
      const newCharacter = await parseJsonResponse<Character>(await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: t('char.newCharacterName') }),
      }));
      setCharacters(prev => [newCharacter, ...prev]);
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
    // 乐观更新：先改本地，再 PUT；失败则回滚
    setCharacters(next);
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
        {listError && <p className="mt-2 text-xs text-red-500">{listError}</p>}
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

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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
        </DndContext>
      </div>
    </div>
  );
}
