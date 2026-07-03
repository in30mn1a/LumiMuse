'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Memory, MEMORY_CATEGORIES } from '@/types';
import MemoryCard from './MemoryCard';
import { useTranslation } from '@/lib/i18n-context';
import { expectOkResponse, parseJsonResponse } from '@/lib/http';
import { PlusIcon, SearchIcon, SparkIcon, TrashIcon } from '@/components/ui/icons';

interface Props {
  characterId: string | null;
  refreshNonce?: number;
}

type SortOrder = 'newest' | 'oldest';
const PAGE_SIZE = 20;

interface MemoriesResponse {
  memories: Memory[];
  total: number;
  hasMore: boolean;
}

export default function MemoryList({ characterId, refreshNonce = 0 }: Props) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [totalMemories, setTotalMemories] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [showArchived, setShowArchived] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleteError, setBatchDeleteError] = useState('');
  const [addingMemory, setAddingMemory] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [listError, setListError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const requestSeqRef = useRef(0);
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
    if (ids.length === 0 || batchDeleting) return;
    if (!window.confirm(t('memory.batchDeleteConfirm').replace('{count}', String(ids.length)))) return;
    setBatchDeleteError('');
    setMutationError('');
    setBatchDeleting(true);
    try {
      const response = await fetch('/api/memories', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, character_id: characterId || undefined }),
      });
      await expectOkResponse(response);
      setSelectMode(false);
      setSelectedIds(new Set());
      const remaining = totalMemories - ids.length;
      const maxPage = Math.max(1, Math.ceil(remaining / PAGE_SIZE));
      if (page > maxPage) {
        setPage(maxPage);
      } else {
        await fetchMemories(page);
      }
    } catch {
      setBatchDeleteError(t('memory.batchDeleteFailed'));
    } finally {
      setBatchDeleting(false);
    }
  };

  const fetchMemories = useCallback(async (targetPage = page, signal?: AbortSignal) => {
    setListError('');
    const requestSeq = ++requestSeqRef.current;
    const params = new URLSearchParams();
    if (characterId) params.set('character_id', characterId);
    if (categoryFilter) params.set('category', categoryFilter);
    tagFilters.forEach(tag => params.append('tag', tag));
    if (keyword) params.set('keyword', keyword);
    params.set('sort', sortOrder);
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String((targetPage - 1) * PAGE_SIZE));
    // 「显示已归档」开启时只展示非 active 状态（archived/summarized/superseded），
    // 不与 active 混在一起，避免视觉混乱。复用 status 多值过滤，后端命中 statusFilter 时跳过默认过滤。
    if (showArchived) params.set('status', 'archived,summarized,superseded');

    try {
      const data = await parseJsonResponse<MemoriesResponse>(await fetch(`/api/memories?${params}`, { signal }));
      if (signal?.aborted || requestSeq !== requestSeqRef.current) return;
      setMemories(data.memories);
      setTotalMemories(data.total);
      setHasMore(data.hasMore);
      if (data.memories.length === 0 && targetPage > 1) setPage(1);
    } catch (error) {
      if (
        signal?.aborted ||
        requestSeq !== requestSeqRef.current ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        return;
      }
      setListError(t('common.loadFailed'));
    }
  }, [characterId, categoryFilter, tagFilters, keyword, page, sortOrder, showArchived, t]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchMemories(page, controller.signal);
    return () => controller.abort();
  }, [fetchMemories, page, refreshNonce]);

  const summary = useMemo(() => {
    const total = totalMemories;
    return { total };
  }, [totalMemories]);

  const totalPages = Math.max(1, Math.ceil(totalMemories / PAGE_SIZE));

  const handleTagFilterClick = useCallback((tag: string) => {
    setTagFilters(prev => (prev.includes(tag) ? prev : [...prev, tag]));
    setPage(1);
    exitSelectMode();
  }, [exitSelectMode]);

  const clearTagFilter = useCallback((tag: string) => {
    setTagFilters(prev => prev.filter(item => item !== tag));
    setPage(1);
    exitSelectMode();
  }, [exitSelectMode]);

  const handleDelete = async (id: string) => {
    setMutationError('');
    try {
      // 注意：proxy.ts 的 CSRF 校验会要求所有写方法（含 DELETE）带 application/json
      // Content-Type；缺这个头的 DELETE 会被拦截返回 415，UI 表现为"点击无反应"
      await expectOkResponse(await fetch(`/api/memories/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: characterId || undefined }),
      }));
      const nextPage = memories.length === 1 && page > 1 ? page - 1 : page;
      if (nextPage !== page) {
        setPage(nextPage);
      } else {
        await fetchMemories(nextPage);
      }
    } catch {
      setMutationError(t('common.operationFailed'));
    }
  };

  const handleUpdate = async (id: string, updates: Partial<Memory>) => {
    setMutationError('');
    try {
      await parseJsonResponse<Memory>(await fetch(`/api/memories/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...updates, character_id: characterId || undefined }),
      }));
      await fetchMemories(page);
    } catch {
      setMutationError(t('common.operationFailed'));
      throw new Error(t('common.operationFailed'));
    }
  };

  const handleAdd = async () => {
    if (!characterId || addingMemory) return;
    setMutationError('');
    setAddingMemory(true);
    try {
      const newMemory = await parseJsonResponse<Memory>(await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          character_id: characterId,
          category: MEMORY_CATEGORIES[1],
          content: t('memory.newContent'),
          confidence: 0.9,
          tags: [],
        }),
      }));
      setEditingMemoryId(newMemory.id);
      if (page !== 1) setPage(1);
      await fetchMemories(1);
    } catch {
      setMutationError(t('common.operationFailed'));
    } finally {
      setAddingMemory(false);
    }
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

            <label className="flex items-center gap-1.5 text-xs text-text-muted whitespace-nowrap">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={e => { setShowArchived(e.target.checked); setPage(1); exitSelectMode(); }}
              />
              {t('memory.showArchived')}
            </label>

            <button
              onClick={handleAdd}
              disabled={!characterId || selectMode || addingMemory}
              aria-busy={addingMemory}
              className="soft-button soft-button-primary whitespace-nowrap"
            >
              <PlusIcon className="h-4 w-4" />
              {addingMemory ? t('memory.adding') : t('memory.add')}
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
              {tagFilters.map(tag => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => clearTagFilter(tag)}
                  className="chip cursor-pointer px-2 py-1 text-[11px] transition-colors hover:border-accent-dark/40 hover:text-accent-dark"
                  aria-label={t('memory.clearTagFilter').replace('{tag}', tag)}
                  title={t('memory.clearTagFilter').replace('{tag}', tag)}
                >
                  <span aria-hidden="true">×</span>
                  <span>#{tag}</span>
                </button>
              ))}
            </div>
          )}

          {(listError || mutationError) && (
            <p className="text-xs text-red-500">{mutationError || listError}</p>
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
                onTagClick={handleTagFilterClick}
              />
            ))}

            {selectMode && validSelectedIds.size > 0 && (
              <div className="sticky bottom-0 flex items-center justify-between border-t border-border-light bg-surface-panel/95 px-4 py-3 text-xs backdrop-blur-sm">
                <span className="text-text-muted">
                  {batchDeleteError || t('memory.selectedCount').replace('{count}', String(validSelectedIds.size))}
                </span>
                <button
                  onClick={handleBatchDelete}
                  disabled={batchDeleting}
                  aria-busy={batchDeleting}
                  className="soft-button soft-button-danger px-3 py-2 text-xs"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                  {batchDeleting ? t('memory.deleting') : t('memory.batchDelete')}
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
