'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Memory, MEMORY_CATEGORIES } from '@/types';
import MemoryCard from './MemoryCard';
import { useTranslation } from '@/lib/i18n-context';
import { PlusIcon, SearchIcon, SparkIcon, TrashIcon } from '@/components/ui/icons';

interface Props {
  characterId: string | null;
}

type SortOrder = 'newest' | 'oldest';
const PAGE_SIZE = 20;

interface MemoriesResponse {
  memories: Memory[];
  total: number;
  hasMore: boolean;
}

export default function MemoryList({ characterId }: Props) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [totalMemories, setTotalMemories] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleteError, setBatchDeleteError] = useState('');
  const { t } = useTranslation();

  // 只保留当前页面中存在的选中 ID（切换角色/筛选后旧 ID 自动失效）
  const validSelectedIds = useMemo(() => {
    const idsOnPage = new Set(memories.map(m => m.id));
    return new Set([...selectedIds].filter(id => idsOnPage.has(id)));
  }, [selectedIds, memories]);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setBatchDeleteError('');
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setBatchDeleteError('');
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setBatchDeleteError('');
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(memories.map(m => m.id)));
  }, [memories]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const allSelected = memories.length > 0 && memories.every(m => validSelectedIds.has(m.id));

  const handleBatchDelete = async () => {
    const ids = Array.from(validSelectedIds);
    if (ids.length === 0) return;
    if (!window.confirm(t('memory.batchDeleteConfirm').replace('{count}', String(ids.length)))) return;
    setBatchDeleteError('');
    try {
      const response = await fetch('/api/memories', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, character_id: characterId || undefined }),
      });
      if (!response.ok) throw new Error('Delete failed');
      setSelectMode(false);
      setSelectedIds(new Set());
      const remaining = totalMemories - ids.length;
      const maxPage = Math.max(1, Math.ceil(remaining / PAGE_SIZE));
      if (page > maxPage) {
        setPage(maxPage);
      } else {
        fetchMemories(page);
      }
    } catch {
      setBatchDeleteError(t('memory.batchDeleteFailed'));
    }
  };

  const fetchMemories = useCallback(async (targetPage = page) => {
    const params = new URLSearchParams();
    if (characterId) params.set('character_id', characterId);
    if (categoryFilter) params.set('category', categoryFilter);
    if (keyword) params.set('keyword', keyword);
    params.set('sort', sortOrder);
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String((targetPage - 1) * PAGE_SIZE));

    const response = await fetch(`/api/memories?${params}`);
    const data = await response.json() as MemoriesResponse;
    setMemories(data.memories);
    setTotalMemories(data.total);
    setHasMore(data.hasMore);
  }, [characterId, categoryFilter, keyword, page, sortOrder]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (characterId) params.set('character_id', characterId);
    if (categoryFilter) params.set('category', categoryFilter);
    if (keyword) params.set('keyword', keyword);
    params.set('sort', sortOrder);
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String((page - 1) * PAGE_SIZE));

    fetch(`/api/memories?${params}`)
      .then(response => response.json() as Promise<MemoriesResponse>)
      .then(data => {
        setMemories(data.memories);
        setTotalMemories(data.total);
        setHasMore(data.hasMore);
        if (data.memories.length === 0 && page > 1) setPage(1);
      });
  }, [characterId, categoryFilter, keyword, page, sortOrder]);

  const summary = useMemo(() => {
    const total = totalMemories;
    return { total };
  }, [totalMemories]);

  const totalPages = Math.max(1, Math.ceil(totalMemories / PAGE_SIZE));

  const handleDelete = async (id: string) => {
    // 注意：proxy.ts 的 CSRF 校验会要求所有写方法（含 DELETE）带 application/json
    // Content-Type；缺这个头的 DELETE 会被拦截返回 415，UI 表现为"点击无反应"
    await fetch(`/api/memories/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    const nextPage = memories.length === 1 && page > 1 ? page - 1 : page;
    if (nextPage !== page) {
      setPage(nextPage);
    } else {
      fetchMemories(nextPage);
    }
  };

  const handleUpdate = async (id: string, updates: Partial<Memory>) => {
    await fetch(`/api/memories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    setMemories(prev => prev.map(memory => (memory.id === id ? { ...memory, ...updates } : memory)));
  };

  const handleAdd = async () => {
    if (!characterId) return;
    const response = await fetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        character_id: characterId,
        category: MEMORY_CATEGORIES[1],
        content: t('memory.newContent'),
        confidence: 0.9,
        tags: [],
      }),
    });
    const newMemory = await response.json();
    setSortOrder('newest');
    if (page !== 1) {
      setPage(1);
    } else {
      setMemories(prev => [newMemory, ...prev].slice(0, PAGE_SIZE));
      setTotalMemories(prev => prev + 1);
      setHasMore(totalMemories + 1 > PAGE_SIZE);
    }
    setEditingMemoryId(newMemory.id);
  };

  return (
    <div className="space-y-4">
      <div className="surface-panel px-4 py-4 md:px-5">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <label className="chip flex-1 min-w-0">
              <SearchIcon className="h-3.5 w-3.5 shrink-0" />
              <input
                value={keyword}
                onChange={e => {
                  setKeyword(e.target.value);
                  setPage(1);
                  exitSelectMode();
                }}
                placeholder={t('memory.search')}
                className="w-full border-none bg-transparent p-0 text-sm text-text-primary outline-none placeholder:text-text-muted"
              />
            </label>

            <select
              value={categoryFilter}
              onChange={e => {
                setCategoryFilter(e.target.value);
                setPage(1);
                exitSelectMode();
              }}
              className="select-rich lg:w-56"
            >
              <option value="">{t('memory.allCategories')}</option>
              {MEMORY_CATEGORIES.map(category => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>

            <select
              value={sortOrder}
              onChange={e => {
                setSortOrder(e.target.value as SortOrder);
                setPage(1);
                exitSelectMode();
              }}
              className="select-rich lg:w-36"
            >
              <option value="newest">{t('memory.sortNewest')}</option>
              <option value="oldest">{t('memory.sortOldest')}</option>
            </select>

            <button onClick={handleAdd} disabled={!characterId || selectMode} className="soft-button soft-button-primary whitespace-nowrap">
              <PlusIcon className="h-4 w-4" />
              {t('memory.add')}
            </button>

            <button
              onClick={() => {
                setSelectMode(prev => !prev);
                setSelectedIds(new Set());
                setBatchDeleteError('');
                setEditingMemoryId(null);
              }}
              disabled={!characterId || totalMemories === 0}
              className={`soft-button whitespace-nowrap ${selectMode ? 'soft-button-primary' : 'soft-button-secondary'}`}
            >
              {selectMode ? t('memory.exitSelect') : t('memory.select')}
            </button>
          </div>

          {selectMode && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button onClick={allSelected ? deselectAll : selectAll} className="chip chip-active cursor-pointer">
                {allSelected ? t('memory.deselectAll') : t('memory.selectAll')}
              </button>
              {validSelectedIds.size > 0 && (
                <span className="chip">
                  {t('memory.selectedCount').replace('{count}', String(validSelectedIds.size))}
                </span>
              )}
              {batchDeleteError && (
                <span className="rounded-full border border-red-200/70 bg-red-50/90 px-3 py-1 text-red-600">
                  {batchDeleteError}
                </span>
              )}
            </div>
          )}

          {!selectMode && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
              <span className="chip chip-active">
                {t('memory.summary')} {summary.total}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="surface-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-border-light px-4 py-3 text-xs text-text-muted">
          <span>{t('memory.title')}</span>
          <span>{totalMemories} {t('memory.count')}</span>
        </div>

        {memories.length > 0 ? (
          <div>
            {memories.map(memory => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                initialEditing={memory.id === editingMemoryId}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
                selectMode={selectMode}
                selected={selectedIds.has(memory.id)}
                onSelect={toggleSelect}
              />
            ))}

            {selectMode && validSelectedIds.size > 0 && (
              <div className="sticky bottom-0 flex items-center justify-between border-t border-border-light bg-surface-panel/95 px-4 py-3 text-xs backdrop-blur-sm">
                <span className="text-text-muted">
                  {batchDeleteError || t('memory.selectedCount').replace('{count}', String(validSelectedIds.size))}
                </span>
                <button onClick={handleBatchDelete} className="soft-button soft-button-danger px-3 py-2 text-xs">
                  <TrashIcon className="h-3.5 w-3.5" />
                  {t('memory.batchDelete')}
                </button>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-border-light px-4 py-3 text-xs text-text-muted">
              <span>
                {t('memory.pageStatus')
                  .replace('{page}', String(page))
                  .replace('{totalPages}', String(totalPages))
                  .replace('{pageSize}', String(PAGE_SIZE))}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => { clearSelection(); setPage(prev => Math.max(1, prev - 1)); }}
                  disabled={page <= 1}
                  className="soft-button px-3 py-2 text-xs"
                >
                  {t('memory.prevPage')}
                </button>
                <button
                  onClick={() => { clearSelection(); setPage(prev => prev + 1); }}
                  disabled={!hasMore}
                  className="soft-button px-3 py-2 text-xs"
                >
                  {t('memory.nextPage')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="px-6 py-12 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[1.4rem] bg-[rgba(155,124,240,0.12)] text-accent-dark">
              <SparkIcon className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-text-primary">{t('memory.emptyFiltered')}</p>
            <p className="mt-2 text-sm text-text-muted">{t('memory.subtitle')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
