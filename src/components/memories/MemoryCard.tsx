'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Memory, MEMORY_CATEGORIES, MEMORY_KINDS, MEMORY_STATUSES } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { PencilIcon, PinIcon, TrashIcon } from '@/components/ui/icons';

interface Props {
  memory: Memory;
  onUpdate: (id: string, updates: Partial<Memory>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  initialEditing?: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onSelect?: (id: string) => void;
  onTagClick?: (tag: string) => void;
}

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function parseBoundedNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

export default function MemoryCard({ memory, onUpdate, onDelete, initialEditing = false, selectMode = false, selected = false, onSelect, onTagClick }: Props) {
  const [editing, setEditing] = useState(initialEditing);
  const [editContent, setEditContent] = useState(memory.content);
  const [editCategory, setEditCategory] = useState(memory.category);
  const [editTags, setEditTags] = useState(Array.isArray(memory.tags) ? memory.tags.join(' ') : '');
  const [editMemoryKind, setEditMemoryKind] = useState(memory.memory_kind);
  const [editImportance, setEditImportance] = useState(String(memory.importance));
  const [editEmotionalWeight, setEditEmotionalWeight] = useState(String(memory.emotional_weight));
  const [editConfidence, setEditConfidence] = useState(String(memory.confidence));
  const [editStatus, setEditStatus] = useState(memory.status);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const [pendingAction, setPendingAction] = useState<'save' | 'delete' | 'pin' | null>(null);
  const contentRef = useRef<HTMLParagraphElement>(null);
  const memoryRef = useRef(memory);
  const { t } = useTranslation();
  const isPending = pendingAction !== null;

  const updateCanExpand = useCallback(() => {
    const contentElement = contentRef.current;
    if (!contentElement || expanded) return;
    setCanExpand(contentElement.scrollHeight > contentElement.clientHeight + 1);
  }, [expanded]);

  useEffect(() => {
    requestAnimationFrame(updateCanExpand);

    window.addEventListener('resize', updateCanExpand);
    return () => window.removeEventListener('resize', updateCanExpand);
  }, [memory.content, updateCanExpand]);

  const syncEditDraft = useCallback((source: Memory) => {
    setEditContent(source.content);
    setEditCategory(source.category);
    setEditTags(Array.isArray(source.tags) ? source.tags.join(' ') : '');
    setEditMemoryKind(source.memory_kind);
    setEditImportance(String(source.importance));
    setEditEmotionalWeight(String(source.emotional_weight));
    setEditConfidence(String(source.confidence));
    setEditStatus(source.status);
  }, []);

  const startEditing = useCallback(() => {
    syncEditDraft(memory);
    setEditing(true);
  }, [memory, syncEditDraft]);

  const handleSave = async () => {
    if (isPending) return;
    const nextTags = editTags
      .split(/[\s,，#]+/)
      .map(tag => tag.trim())
      .filter(Boolean);
    setPendingAction('save');
    try {
      await onUpdate(memory.id, {
        content: editContent,
        category: editCategory,
        tags: nextTags,
        memory_kind: editMemoryKind,
        importance: parseBoundedNumber(editImportance, memory.importance),
        emotional_weight: parseBoundedNumber(editEmotionalWeight, memory.emotional_weight),
        confidence: parseBoundedNumber(editConfidence, memory.confidence),
        status: editStatus,
      });
      setEditing(false);
      setExpanded(false);
    } catch {
      // 父组件负责展示写入错误；卡片只负责恢复按钮状态。
    } finally {
      setPendingAction(null);
    }
  };

  const handlePinToggle = async () => {
    if (isPending) return;
    setPendingAction('pin');
    try {
      await onUpdate(memory.id, { pinned: !memory.pinned });
    } catch {
      // 父组件负责展示写入错误；卡片只负责恢复按钮状态。
    } finally {
      setPendingAction(null);
    }
  };

  const handleDelete = async () => {
    if (isPending) return;
    setPendingAction('delete');
    try {
      await onDelete(memory.id);
    } catch {
      // 父组件负责展示写入错误；卡片只负责恢复按钮状态。
    } finally {
      setPendingAction(null);
    }
  };

  const handleCancel = () => {
    syncEditDraft(memory);
    setEditing(false);
    setExpanded(false);
  };

  useEffect(() => {
    memoryRef.current = memory;
  }, [memory]);

  useEffect(() => {
    if (selectMode) {
      const currentMemory = memoryRef.current;
      syncEditDraft(currentMemory);
      setEditing(false);
      setExpanded(false);
      return;
    }
    setEditing(initialEditing);
  }, [initialEditing, selectMode, syncEditDraft]);

  const tags = Array.isArray(memory.tags) ? memory.tags : [];
  // selectMode 用 label 包裹整行，让鼠标点击非交互区域与键盘操作 checkbox 等价；
  // 嵌套 button 自身接收点击，不会触发 label 关联控件。
  const Root = selectMode ? 'label' : 'div';

  return (
    <Root
      className={`group border-b border-border-light px-4 py-3 transition-colors last:border-b-0 ${selectMode ? 'cursor-pointer' : 'hover:bg-white/70 dark:hover:bg-white/10'} ${editing ? 'bg-white/70 dark:bg-white/10' : ''} ${selectMode && selected ? 'bg-[rgba(155,124,240,0.06)] dark:bg-[rgba(155,124,240,0.15)]' : ''}`}
    >
      <div className="flex gap-3">
        {selectMode && (
          <div className="flex shrink-0 items-start pt-0.5">
            <input
              type="checkbox"
              checked={selected}
              aria-label={memory.content}
              onChange={() => onSelect?.(memory.id)}
              className="h-5 w-5 rounded-md border-2 border-border-heavy accent-accent-dark"
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {editing ? (
                  <div className="grid w-full gap-2 md:grid-cols-2 xl:grid-cols-3">
                    <label className="text-xs text-text-muted">
                      <span className="mb-1 block">{t('memory.category')}</span>
                      <select
                        value={editCategory}
                        onChange={e => setEditCategory(e.target.value as Memory['category'])}
                        className="select-rich"
                      >
                        {MEMORY_CATEGORIES.map(category => (
                          <option key={category} value={category}>{category}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-text-muted">
                      <span className="mb-1 block">{t('memory.kind')}</span>
                      <select
                        value={editMemoryKind}
                        onChange={e => setEditMemoryKind(e.target.value as Memory['memory_kind'])}
                        className="select-rich"
                      >
                        {MEMORY_KINDS.map(kind => (
                          <option key={kind} value={kind}>{kind}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-text-muted">
                      <span className="mb-1 block">{t('memory.status')}</span>
                      <select
                        value={editStatus}
                        onChange={e => setEditStatus(e.target.value as Memory['status'])}
                        className="select-rich"
                      >
                        {MEMORY_STATUSES.map(status => (
                          <option key={status} value={status}>{t(`memory.status.${status}`)}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : (
                  <span className="chip chip-active text-[11px]">
                    {memory.category}
                  </span>
                )}
                {memory.pinned && !editing && (
                  <span className="chip chip-pinned text-[11px]" title={t('memory.pin')}>
                    <PinIcon className="mr-0.5 inline h-3 w-3" />
                    {t('memory.pin')}
                  </span>
                )}

                <span className="text-[11px] text-text-muted">
                  {formatShortDate(memory.created_at)}
                </span>
              </div>

              <div className="mt-2">
                {editing ? (
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    rows={3}
                    className="textarea-rich min-h-[6rem]"
                  />
                ) : (
                  <div>
                    <p ref={contentRef} className={`text-sm leading-relaxed text-text-primary ${expanded ? '' : 'memory-snippet'}`}>
                      {memory.content}
                    </p>
                    {canExpand && (
                      <button
                        type="button"
                        onClick={e => { e.preventDefault(); e.stopPropagation(); setExpanded(prev => !prev); }}
                        className="mt-1 text-[11px] text-accent-dark/70 hover:text-accent-dark transition-colors"
                      >
                        {expanded ? t('memory.collapse') : t('memory.expand')}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="mt-2 flex items-center gap-1.5">
                {editing ? (
                  <div className="grid w-full gap-2 lg:grid-cols-[1fr_repeat(3,8rem)]">
                    <input
                      value={editTags}
                      onChange={e => setEditTags(e.target.value)}
                      placeholder={t('memory.tagsPlaceholder')}
                      className="input-rich min-h-0 rounded-full px-3 py-2 text-xs"
                    />
                    <label className="text-[11px] text-text-muted">
                      <span className="mb-1 block">{t('memory.importance')}</span>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        value={editImportance}
                        onChange={e => setEditImportance(e.target.value)}
                        className="input-rich min-h-0 px-2 py-2 text-xs"
                      />
                    </label>
                    <label className="text-[11px] text-text-muted">
                      <span className="mb-1 block">{t('memory.emotionalWeight')}</span>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        value={editEmotionalWeight}
                        onChange={e => setEditEmotionalWeight(e.target.value)}
                        className="input-rich min-h-0 px-2 py-2 text-xs"
                      />
                    </label>
                    <label className="text-[11px] text-text-muted">
                      <span className="mb-1 block">{t('memory.confidence')}</span>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        value={editConfidence}
                        onChange={e => setEditConfidence(e.target.value)}
                        className="input-rich min-h-0 px-2 py-2 text-xs"
                      />
                    </label>
                  </div>
                ) : tags.length > 0 ? (
                  <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    {tags.map(tag => (
                      <button
                        key={tag}
                        type="button"
                        onClick={e => { e.preventDefault(); e.stopPropagation(); onTagClick?.(tag); }}
                        title={t('memory.filterByTag').replace('{tag}', tag)}
                        className="chip px-2 py-1 text-[11px] transition-colors hover:border-accent-dark/40 hover:text-accent-dark"
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="flex-1" />
                )}
                {editing && (
                  <div className="ml-auto flex shrink-0 items-center gap-1.5 lg:hidden">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); void handleSave(); }}
                      disabled={isPending}
                      aria-busy={pendingAction === 'save'}
                      className="soft-button soft-button-primary h-8 min-h-0 px-3 py-0 text-xs"
                    >
                      {pendingAction === 'save' ? t('memory.saving') : t('memory.save')}
                    </button>
                    <button type="button" onClick={e => { e.stopPropagation(); handleCancel(); }} disabled={isPending} className="soft-button soft-button-secondary h-8 min-h-0 px-3 py-0 text-xs">
                      {t('memory.cancel')}
                    </button>
                  </div>
                )}
                {!editing && !selectMode && (
                  <div className="ml-auto flex shrink-0 items-center gap-1.5 lg:hidden">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); void handlePinToggle(); }}
                      disabled={isPending}
                      aria-busy={pendingAction === 'pin'}
                      aria-label={pendingAction === 'pin' ? t('memory.updating') : (memory.pinned ? t('memory.unpin') : t('memory.pin'))}
                      title={memory.pinned ? t('memory.unpin') : t('memory.pin')}
                      className={`soft-button h-8 min-h-0 w-8 rounded-full px-0 py-0 text-xs ${memory.pinned ? 'soft-button-primary' : 'soft-button-secondary'}`}
                    >
                      <PinIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); startEditing(); }}
                      disabled={isPending}
                      aria-label={t('memory.edit')}
                      title={t('memory.edit')}
                      className="soft-button soft-button-secondary h-8 min-h-0 w-8 rounded-full px-0 py-0 text-xs"
                    >
                      <PencilIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); void handleDelete(); }}
                      disabled={isPending}
                      aria-busy={pendingAction === 'delete'}
                      aria-label={pendingAction === 'delete' ? t('memory.deleting') : t('memory.delete')}
                      title={t('memory.delete')}
                      className="soft-button soft-button-danger h-8 min-h-0 w-8 rounded-full px-0 py-0 text-xs"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {!selectMode && (
              <div className="hidden shrink-0 flex-wrap items-center gap-2 lg:flex lg:justify-end">
                {editing ? (
                  <>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); void handleSave(); }}
                      disabled={isPending}
                      aria-busy={pendingAction === 'save'}
                      className="soft-button soft-button-primary px-3 py-2 text-xs"
                    >
                      {pendingAction === 'save' ? t('memory.saving') : t('memory.save')}
                    </button>
                    <button type="button" onClick={e => { e.stopPropagation(); handleCancel(); }} disabled={isPending} className="soft-button soft-button-secondary px-3 py-2 text-xs">
                      {t('memory.cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); void handlePinToggle(); }}
                      disabled={isPending}
                      aria-busy={pendingAction === 'pin'}
                      className={`soft-button px-3 py-2 text-xs ${memory.pinned ? 'soft-button-primary' : 'soft-button-secondary'}`}
                    >
                      <PinIcon className="h-3.5 w-3.5" />
                      {pendingAction === 'pin' ? t('memory.updating') : (memory.pinned ? t('memory.unpin') : t('memory.pin'))}
                    </button>
                    <button type="button" onClick={e => { e.stopPropagation(); startEditing(); }} disabled={isPending} className="soft-button soft-button-secondary px-3 py-2 text-xs">
                      <PencilIcon className="h-3.5 w-3.5" />
                      {t('memory.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); void handleDelete(); }}
                      disabled={isPending}
                      aria-busy={pendingAction === 'delete'}
                      className="soft-button soft-button-danger px-3 py-2 text-xs"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                      {pendingAction === 'delete' ? t('memory.deleting') : t('memory.delete')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Root>
  );
}
