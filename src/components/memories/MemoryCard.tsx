'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Memory, MEMORY_CATEGORIES } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { PencilIcon, TrashIcon } from '@/components/ui/icons';

interface Props {
  memory: Memory;
  onUpdate: (id: string, updates: Partial<Memory>) => void;
  onDelete: (id: string) => void;
  initialEditing?: boolean;
}

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export default function MemoryCard({ memory, onUpdate, onDelete, initialEditing = false }: Props) {
  const [editing, setEditing] = useState(initialEditing);
  const [editContent, setEditContent] = useState(memory.content);
  const [editCategory, setEditCategory] = useState(memory.category);
  const [editTags, setEditTags] = useState(Array.isArray(memory.tags) ? memory.tags.join(' ') : '');
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const contentRef = useRef<HTMLParagraphElement>(null);
  const { t } = useTranslation();

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

  const handleSave = () => {
    const nextTags = editTags
      .split(/[\s,，#]+/)
      .map(tag => tag.trim())
      .filter(Boolean);
    onUpdate(memory.id, { content: editContent, category: editCategory, tags: nextTags });
    setEditing(false);
    setExpanded(false);
  };

  const handleCancel = () => {
    setEditContent(memory.content);
    setEditCategory(memory.category);
    setEditTags(Array.isArray(memory.tags) ? memory.tags.join(' ') : '');
    setEditing(false);
    setExpanded(false);
  };

  const tags = Array.isArray(memory.tags) ? memory.tags : [];

  return (
    <div className={`group border-b border-border-light px-4 py-3 transition-colors last:border-b-0 hover:bg-white/70 ${editing ? 'bg-white/70' : ''}`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <select
                value={editCategory}
                onChange={e => setEditCategory(e.target.value as Memory['category'])}
                className="select-rich w-full max-w-xs"
              >
                {MEMORY_CATEGORIES.map(category => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            ) : (
              <span className="chip chip-active text-[11px]">
                {memory.category}
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
                    onClick={() => setExpanded(prev => !prev)}
                    className="mt-1 text-[11px] text-accent-dark/70 hover:text-accent-dark transition-colors"
                  >
                    {expanded ? '收起' : '展开全文'}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            {editing ? (
              <input
                value={editTags}
                onChange={e => setEditTags(e.target.value)}
                placeholder="用空格分隔标签"
                className="input-rich min-h-0 flex-1 rounded-full px-3 py-2 text-xs"
              />
            ) : tags.length > 0 ? (
              <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {tags.map(tag => (
                  <span key={tag} className="chip px-2 py-1 text-[11px]">
                    #{tag}
                  </span>
                ))}
              </div>
            ) : (
              <div className="flex-1" />
            )}
            {editing && (
              <div className="ml-auto flex shrink-0 items-center gap-1.5 lg:hidden">
                <button onClick={handleSave} className="soft-button soft-button-primary h-8 min-h-0 px-3 py-0 text-xs">
                  {t('memory.save')}
                </button>
                <button onClick={handleCancel} className="soft-button soft-button-secondary h-8 min-h-0 px-3 py-0 text-xs">
                  {t('memory.cancel')}
                </button>
              </div>
            )}
            {!editing && (
              <div className="ml-auto flex shrink-0 items-center gap-1.5 lg:hidden">
                <button
                  onClick={() => setEditing(true)}
                  aria-label={t('memory.edit')}
                  title={t('memory.edit')}
                  className="soft-button soft-button-secondary h-8 min-h-0 w-8 rounded-full px-0 py-0 text-xs"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onDelete(memory.id)}
                  aria-label={t('memory.delete')}
                  title={t('memory.delete')}
                  className="soft-button soft-button-danger h-8 min-h-0 w-8 rounded-full px-0 py-0 text-xs"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="hidden shrink-0 flex-wrap items-center gap-2 lg:flex lg:justify-end">
          {editing ? (
            <>
              <button onClick={handleSave} className="soft-button soft-button-primary px-3 py-2 text-xs">
                {t('memory.save')}
              </button>
              <button onClick={handleCancel} className="soft-button soft-button-secondary px-3 py-2 text-xs">
                {t('memory.cancel')}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)} className="soft-button soft-button-secondary px-3 py-2 text-xs">
                <PencilIcon className="h-3.5 w-3.5" />
                {t('memory.edit')}
              </button>
              <button onClick={() => onDelete(memory.id)} className="soft-button soft-button-danger px-3 py-2 text-xs">
                <TrashIcon className="h-3.5 w-3.5" />
                {t('memory.delete')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
