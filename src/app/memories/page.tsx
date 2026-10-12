'use client';

import { useState, useEffect, useRef } from 'react';
import { Character } from '@/types';
import MemoryList from '@/components/memories/MemoryList';
import Link from 'next/link';
import Modal from '@/components/ui/Modal';
import { useTranslation } from '@/lib/i18n-context';
import { getErrorMessage, HttpResponseError, parseJsonArrayResponse, parseJsonResponse } from '@/lib/http';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, ChevronDownIcon, MemoryIcon, SparkIcon, StopIcon } from '@/components/ui/icons';
import ContentState from '@/components/ui/ContentState';

interface MemoryMergeSuggestionSource {
  id: string;
  content: string;
  category: string;
  tags: string[];
}

interface MemoryMergeSuggestion {
  source_ids: string[];
  merged_content: string;
  category?: string;
  tags?: string[];
  importance?: number;
  kind: 'merge' | 'conflict';
  reason?: string;
  sources: MemoryMergeSuggestionSource[];
}

type MemoryReviewChangeDiff =
  | { field: 'category'; before: string; after: string }
  | { field: 'tags'; before: string[]; after: string[] }
  | { field: 'importance'; before: number; after: number };

interface MemoryAiReviewResult {
  ok: boolean;
  plan_id?: string;
  batch_index?: number;
  batch_count?: number;
  next_batch_index?: number | null;
  reviewed: number;
  total_active: number;
  skipped_due_to_limit: number;
  reviewed_offset: number;
  next_offset: number | null;
  has_more: boolean;
  corrected: number;
  failed_batches: number;
  failed_messages: string[];
  indexing_queued: number;
  indexing_started: boolean;
  changes: Array<{ id: string; fields: string[]; content: string; diffs: MemoryReviewChangeDiff[] }>;
  merge_suggestions: MemoryMergeSuggestion[];
}

interface PendingMergeSuggestion extends MemoryMergeSuggestion {
  key: string;
  /** stale：源记忆在建议生成后已变化（被归档 / 合并 / 删除 / 钉选），无法再执行。 */
  status: 'pending' | 'accepted' | 'rejected' | 'failed' | 'stale';
  merge_batch_id?: string;
  error?: string;
}

const MERGE_SOURCE_ISSUES = ['not_found', 'not_active', 'pinned', 'reserved'] as const;

/** /api/memory-merge 在源记忆不可合并时返回的机器可读原因。 */
function readMergeSourceIssue(error: unknown): typeof MERGE_SOURCE_ISSUES[number] | null {
  if (!(error instanceof HttpResponseError)) return null;
  const reason = (error.data as { reason?: unknown } | null)?.reason;
  return MERGE_SOURCE_ISSUES.find(issue => issue === reason) ?? null;
}

interface MergeSourcesModalState {
  title: string;
  sources: MemoryMergeSuggestionSource[];
}

export default function MemoriesPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [charactersLoading, setCharactersLoading] = useState(true);
  const [charactersLoadError, setCharactersLoadError] = useState('');
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [memoryAiReviewRunning, setMemoryAiReviewRunning] = useState(false);
  const [memoryAiReviewProgress, setMemoryAiReviewProgress] = useState<{ reviewed: number; total: number } | null>(null);
  const [lastMemoryAiReviewResult, setLastMemoryAiReviewResult] = useState<MemoryAiReviewResult | null>(null);
  const [showMemoryAiReviewChanges, setShowMemoryAiReviewChanges] = useState(false);
  const [mergeSuggestions, setMergeSuggestions] = useState<PendingMergeSuggestion[]>([]);
  const [mergeBusyKey, setMergeBusyKey] = useState<string | null>(null);
  const [mergeSourcesModal, setMergeSourcesModal] = useState<MergeSourcesModalState | null>(null);
  const [memoryRefreshNonce, setMemoryRefreshNonce] = useState(0);
  const selectedCharIdRef = useRef<string | null>(null);
  const memoryAiReviewAbortRef = useRef<AbortController | null>(null);
  const { t } = useTranslation();
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const chars = await parseJsonArrayResponse<Character>(await fetch('/api/characters'));
        if (cancelled) return;
        setCharacters(chars);
        setCharactersLoadError('');
        if (chars.length > 0) {
          selectedCharIdRef.current = chars[0].id;
          setSelectedCharId(chars[0].id);
        }
      } catch (error) {
        if (!cancelled) {
          setCharactersLoadError(t('common.loadFailed'));
          showToast(`${t('common.loadFailed')}: ${getErrorMessage(error)}`, 'error');
        }
      } finally {
        if (!cancelled) setCharactersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showToast, t]);

  useEffect(() => {
    selectedCharIdRef.current = selectedCharId;
  }, [selectedCharId]);

  const handleMemoryAiReview = async () => {
    if (!selectedCharId) return;
    const requestedCharacterId = selectedCharId;
    const abortController = new AbortController();
    memoryAiReviewAbortRef.current = abortController;
    setMemoryAiReviewRunning(true);
    setMemoryAiReviewProgress(null);
    setShowMemoryAiReviewChanges(false);
    setMergeSuggestions([]);
    // 在 try 外声明，catch 块需读取已聚合的进度（前面已落库的页）来展示中断状态。
    const aggregateResult: MemoryAiReviewResult = {
      ok: true,
      reviewed: 0,
      total_active: 0,
      skipped_due_to_limit: 0,
      reviewed_offset: 0,
      next_offset: null,
      has_more: false,
      corrected: 0,
      failed_batches: 0,
      failed_messages: [],
      indexing_queued: 0,
      indexing_started: false,
      changes: [],
      merge_suggestions: [],
    };
    const pendingMerges: PendingMergeSuggestion[] = [];
    try {
      let planId: string | undefined;
      let nextBatchIndex: number | null = 0;

      while (nextBatchIndex !== null) {
        const body: Record<string, unknown> = {
          character_id: requestedCharacterId,
          batch_index: nextBatchIndex,
        };
        if (planId) body.plan_id = planId;

        const response = await fetch('/api/memory-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: abortController.signal,
        });
        if (response.status === 404) {
          const errBody = await response.json().catch(() => ({})) as { code?: string; error?: string };
          if (errBody.code === 'PLAN_NOT_FOUND') {
            throw new Error(t('memory.aiReviewPlanExpired'));
          }
        }
        const result: MemoryAiReviewResult = await parseJsonResponse<MemoryAiReviewResult>(response);
        if (selectedCharIdRef.current !== requestedCharacterId) return;

        if (result.plan_id) planId = result.plan_id;
        aggregateResult.plan_id = planId;
        aggregateResult.reviewed += result.reviewed ?? 0;
        aggregateResult.corrected += result.corrected ?? 0;
        aggregateResult.failed_batches += result.failed_batches ?? 0;
        if (Array.isArray(result.failed_messages)) aggregateResult.failed_messages.push(...result.failed_messages);
        aggregateResult.indexing_queued += result.indexing_queued ?? 0;
        aggregateResult.indexing_started = aggregateResult.indexing_started || result.indexing_started;
        aggregateResult.total_active = result.total_active ?? aggregateResult.total_active;
        aggregateResult.skipped_due_to_limit = result.skipped_due_to_limit ?? 0;
        aggregateResult.next_offset = result.next_offset;
        aggregateResult.has_more = result.has_more;
        aggregateResult.batch_count = result.batch_count ?? aggregateResult.batch_count;
        aggregateResult.changes.push(...(result.changes ?? []));
        if (Array.isArray(result.merge_suggestions)) {
          for (const suggestion of result.merge_suggestions) {
            const key = `${suggestion.kind}:${suggestion.source_ids.slice().sort().join('+')}`;
            if (pendingMerges.some(item => item.key === key)) continue;
            pendingMerges.push({ ...suggestion, key, status: 'pending' });
            aggregateResult.merge_suggestions.push(suggestion);
          }
        }
        setMemoryAiReviewProgress({ reviewed: aggregateResult.reviewed, total: aggregateResult.total_active });

        if (!result.has_more || result.next_batch_index === null || result.next_batch_index === undefined) {
          nextBatchIndex = null;
        } else if (typeof result.next_batch_index === 'number' && result.next_batch_index > (body.batch_index as number)) {
          nextBatchIndex = result.next_batch_index;
        } else {
          throw new Error('memory-review pagination did not advance');
        }
      }

      setLastMemoryAiReviewResult(aggregateResult);
      setMergeSuggestions(pendingMerges);
      setMemoryRefreshNonce(prev => prev + 1);
      setShowMemoryAiReviewChanges(true);
      const reviewSummary = t('memory.aiReviewDone')
        .replace('{reviewed}', String(aggregateResult.reviewed ?? 0))
        .replace('{corrected}', String(aggregateResult.corrected ?? 0));
      if (aggregateResult.failed_batches > 0) {
        // 部分批次因 API 报错被跳过，但其余批次已照常整理落库——明确告知用户跳过数量，而非静默成功。
        showToast(
          `${reviewSummary}（${t('memory.aiReviewPartial').replace('{failed}', String(aggregateResult.failed_batches))}）`,
          'error',
        );
      } else {
        showToast(reviewSummary, 'success');
      }
    } catch (err) {
      if (selectedCharIdRef.current !== requestedCharacterId) return;
      // 用户主动点了停止：不是故障，不按错误提示。
      const stoppedByUser = abortController.signal.aborted;
      // 整页失败会中断后续页，但此前已成功的页其修正已落库；保留并展示已处理进度，避免表现为全盘失败、让已落库的修改对用户不可见。
      if (aggregateResult.reviewed > 0) {
        setLastMemoryAiReviewResult(aggregateResult);
        setMergeSuggestions(pendingMerges);
        setMemoryRefreshNonce(prev => prev + 1);
        setShowMemoryAiReviewChanges(true);
        const progressSummary = t(stoppedByUser ? 'memory.aiReviewStopped' : 'memory.aiReviewInterrupted')
          .replace('{reviewed}', String(aggregateResult.reviewed))
          .replace('{corrected}', String(aggregateResult.corrected));
        showToast(
          stoppedByUser ? progressSummary : `${progressSummary}: ${getErrorMessage(err)}`,
          stoppedByUser ? 'info' : 'error',
        );
      } else if (stoppedByUser) {
        showToast(t('memory.aiReviewStoppedEmpty'), 'info');
      } else {
        showToast(`${t('memory.aiReviewFailed')}: ${getErrorMessage(err)}`, 'error');
      }
    } finally {
      if (selectedCharIdRef.current === requestedCharacterId) {
        setMemoryAiReviewRunning(false);
      }
    }
  };

  const handleAcceptMerge = async (suggestion: PendingMergeSuggestion) => {
    if (
      !selectedCharId
      || suggestion.kind !== 'merge'
      || suggestion.status === 'accepted'
      || suggestion.status === 'stale'
    ) return;
    setMergeBusyKey(suggestion.key);
    try {
      const response = await fetch('/api/memory-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'execute',
          character_id: selectedCharId,
          source_ids: suggestion.source_ids,
          merged_content: suggestion.merged_content,
          category: suggestion.category,
          tags: suggestion.tags,
          importance: suggestion.importance,
          kind: suggestion.kind,
        }),
      });
      const payload = await parseJsonResponse<{ ok: boolean; batch_id?: string; error?: string }>(response);
      setMergeSuggestions(prev => prev.map(item => (
        item.key === suggestion.key
          ? { ...item, status: 'accepted', merge_batch_id: payload.batch_id, error: undefined }
          : item
      )));
      setMemoryRefreshNonce(prev => prev + 1);
      showToast(t('memory.mergeAccepted').replace('{count}', '1'), 'success');
    } catch (error) {
      // 源记忆在建议生成后被归档 / 合并 / 删除 / 钉选：重试也不会成功，标记为失效并说明原因。
      const sourceIssue = readMergeSourceIssue(error);
      const message = sourceIssue ? t(`memory.mergeStale.${sourceIssue}`) : getErrorMessage(error);
      setMergeSuggestions(prev => prev.map(item => (
        item.key === suggestion.key
          ? { ...item, status: sourceIssue ? 'stale' : 'failed', error: message }
          : item
      )));
      // 列表里的源记忆也已过时，刷新出它们现在的状态。
      if (sourceIssue) setMemoryRefreshNonce(prev => prev + 1);
      showToast(`${t('memory.mergeFailed')}: ${message}`, 'error');
    } finally {
      setMergeBusyKey(null);
    }
  };

  const handleRejectMerge = (suggestion: PendingMergeSuggestion) => {
    setMergeSuggestions(prev => prev.map(item => (
      item.key === suggestion.key ? { ...item, status: 'rejected' } : item
    )));
  };

  const handleUndoMerge = async (suggestion: PendingMergeSuggestion) => {
    if (!selectedCharId || !suggestion.merge_batch_id) return;
    setMergeBusyKey(suggestion.key);
    try {
      await parseJsonResponse(await fetch('/api/memory-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'undo',
          character_id: selectedCharId,
          batch_id: suggestion.merge_batch_id,
        }),
      }));
      setMergeSuggestions(prev => prev.map(item => (
        item.key === suggestion.key
          ? { ...item, status: 'pending', merge_batch_id: undefined }
          : item
      )));
      setMemoryRefreshNonce(prev => prev + 1);
      showToast(t('memory.mergeUndoDone'), 'success');
    } catch (error) {
      showToast(`${t('memory.mergeFailed')}: ${getErrorMessage(error)}`, 'error');
    } finally {
      setMergeBusyKey(null);
    }
  };

  const visibleMerges = mergeSuggestions.filter(item => item.status !== 'rejected');
  const formatReviewDiffValue = (value: string | string[] | number): string => {
    if (Array.isArray(value)) return value.length > 0 ? value.join('、') : t('memory.aiReviewEmptyValue');
    return String(value);
  };

  return (
    <div className="app-shell min-h-dvh px-4 py-4">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="border-b border-border-light pb-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <Link href="/" className="soft-button soft-button-secondary px-3 py-2">
                <ArrowLeftIcon className="h-4 w-4" />
                {t('memories.back')}
              </Link>
              <h1 className="section-title text-xl">{t('memories.title')}</h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleMemoryAiReview()}
                disabled={!selectedCharId || memoryAiReviewRunning}
                className="soft-button soft-button-primary whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50"
              >
                {memoryAiReviewRunning ? (
                  <span className="spinner-sm" aria-hidden="true" />
                ) : (
                  <SparkIcon className="h-4 w-4" />
                )}
                {!memoryAiReviewRunning
                  ? t('memory.aiReview')
                  : memoryAiReviewProgress
                    ? t('memory.aiReviewProgress')
                      .replace('{reviewed}', String(memoryAiReviewProgress.reviewed))
                      .replace('{total}', String(memoryAiReviewProgress.total))
                    : t('memory.aiReviewRunning')}
              </button>
              {memoryAiReviewRunning && (
                <button
                  type="button"
                  onClick={() => memoryAiReviewAbortRef.current?.abort()}
                  className="soft-button soft-button-danger whitespace-nowrap"
                >
                  <StopIcon className="h-4 w-4" />
                  {t('memory.aiReviewStop')}
                </button>
              )}
              {lastMemoryAiReviewResult && (
                <button
                  type="button"
                  onClick={() => setShowMemoryAiReviewChanges(prev => !prev)}
                  className="soft-button soft-button-secondary whitespace-nowrap"
                >
                  {showMemoryAiReviewChanges ? t('memory.hideLatestAiReviewChanges') : t('memory.viewLatestAiReviewChanges')}
                </button>
              )}
              <span className="chip">{characters.length} {t('sidebar.characters')}</span>
              <select
                value={selectedCharId || ''}
                onChange={e => {
                  const nextCharacterId = e.target.value || null;
                  selectedCharIdRef.current = nextCharacterId;
                  setSelectedCharId(nextCharacterId);
                  setMemoryAiReviewRunning(false);
                  setLastMemoryAiReviewResult(null);
                  setShowMemoryAiReviewChanges(false);
                  setMergeSuggestions([]);
                }}
                className="select-rich min-w-56"
              >
                {characters.map(character => (
                  <option key={character.id} value={character.id}>{character.name}</option>
                ))}
              </select>
            </div>
          </div>

        </header>

        {lastMemoryAiReviewResult && showMemoryAiReviewChanges && (
          <section className="surface-panel px-4 py-4 text-sm">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="chip chip-active">
                {t('memory.aiReviewDone')
                  .replace('{reviewed}', String(lastMemoryAiReviewResult.reviewed ?? 0))
                  .replace('{corrected}', String(lastMemoryAiReviewResult.corrected ?? 0))}
              </span>
              {lastMemoryAiReviewResult.indexing_queued > 0 && (
                <span className="chip">
                  {t('memory.aiReviewIndexQueued').replace('{count}', String(lastMemoryAiReviewResult.indexing_queued))}
                </span>
              )}
            </div>
            {lastMemoryAiReviewResult.failed_messages.length > 0 && (
              <div className="mb-3 rounded-xl border border-red-300/60 bg-red-500/5 px-3 py-2 text-xs text-red-600">
                <p className="font-medium">
                  {t('memory.aiReviewFailedBatches').replace('{failed}', String(lastMemoryAiReviewResult.failed_batches))}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {lastMemoryAiReviewResult.failed_messages.map((message, index) => (
                    <li key={index} className="break-words">{message}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 合并建议需要用户逐条决定，放在只读的修正明细之前，免得被长列表压到页面底部。 */}
            {visibleMerges.length > 0 && (
              <div className="mb-4 border-b border-border-light pb-4">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('memory.mergeSuggestions')} ({visibleMerges.length})
                </h2>
                <p className="mb-2 mt-1 text-xs text-text-muted">{t('memory.mergeSuggestionsHint')}</p>
                <div className="space-y-2">
                  {visibleMerges.map(suggestion => (
                    <div
                      key={suggestion.key}
                      className={`rounded-xl border border-border-light bg-surface-2 px-3 py-2 ${suggestion.status === 'stale' ? 'border-dashed' : ''}`}
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                        <span className="chip">
                          {suggestion.kind === 'conflict' ? t('memory.mergeConflict') : t('memory.mergeSuggestions')}
                        </span>
                        {suggestion.status === 'accepted' && (
                          <span className="chip chip-active">{t('memory.mergeAcceptedBadge')}</span>
                        )}
                        {suggestion.status === 'stale' && (
                          <span className="chip">{t('memory.mergeStaleBadge')}</span>
                        )}
                      </div>
                      {suggestion.reason && (
                        <p className="mt-1 text-xs text-text-muted">{suggestion.reason}</p>
                      )}
                      <div className="mt-2 text-xs font-medium text-text-secondary">
                        {t('memory.mergeSources')} ×{suggestion.source_ids.length}
                      </div>
                      <ul className="mt-1 space-y-1">
                        {suggestion.sources.map(source => (
                          <li
                            key={source.id}
                            className="memory-snippet break-words border-l-2 border-border-light pl-2 text-xs leading-5 text-text-secondary"
                          >
                            {source.content}
                          </li>
                        ))}
                      </ul>
                      <div className="mt-2 text-xs font-medium text-text-secondary">{t('memory.mergeResult')}</div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">
                        {suggestion.merged_content}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {suggestion.sources.length > 0 && (
                          <button
                            type="button"
                            disabled={mergeBusyKey === suggestion.key}
                            onClick={() => setMergeSourcesModal({
                              title: `${t('memory.mergeSources')} ×${suggestion.sources.length}`,
                              sources: suggestion.sources,
                            })}
                            className="soft-button soft-button-secondary px-3 py-1 text-xs disabled:opacity-50"
                          >
                            {t('memory.mergeViewSources')}
                          </button>
                        )}
                        {suggestion.kind === 'merge' && (suggestion.status === 'pending' || suggestion.status === 'failed') && (
                          <button
                            type="button"
                            disabled={mergeBusyKey === suggestion.key}
                            onClick={() => void handleAcceptMerge(suggestion)}
                            className="soft-button soft-button-primary px-3 py-1 text-xs disabled:opacity-50"
                          >
                            {t('memory.mergeAccept')}
                          </button>
                        )}
                        {suggestion.status !== 'accepted' && (
                          <button
                            type="button"
                            disabled={mergeBusyKey === suggestion.key}
                            onClick={() => handleRejectMerge(suggestion)}
                            className="soft-button soft-button-secondary px-3 py-1 text-xs disabled:opacity-50"
                          >
                            {t('memory.mergeReject')}
                          </button>
                        )}
                        {suggestion.status === 'accepted' && suggestion.merge_batch_id && (
                          <button
                            type="button"
                            disabled={mergeBusyKey === suggestion.key}
                            onClick={() => void handleUndoMerge(suggestion)}
                            className="soft-button soft-button-secondary px-3 py-1 text-xs disabled:opacity-50"
                          >
                            {t('memory.mergeUndo')}
                          </button>
                        )}
                      </div>
                      {suggestion.error && (
                        <p className="mt-1 text-xs text-red-600">{suggestion.error}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {lastMemoryAiReviewResult.changes.length > 0 ? (
              <>
                <h2 className="mb-2 text-sm font-semibold text-text-primary">
                  {t('memory.aiReviewCorrections')} ({lastMemoryAiReviewResult.changes.length})
                </h2>
                <div className="max-h-[32rem] space-y-2 overflow-y-auto">
                  {lastMemoryAiReviewResult.changes.map(change => (
                    <div key={change.id} className="rounded-xl border border-border-light bg-surface-2 px-3 py-2">
                      <details className="group">
                        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-text-primary marker:hidden">
                          <ChevronDownIcon className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
                          <span className="min-w-0 flex-1 truncate group-open:hidden">{change.content}</span>
                          <span className="hidden text-xs font-medium group-open:inline">{t('memory.aiReviewMemoryContent')}</span>
                        </summary>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">{change.content}</p>
                      </details>
                      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-text-muted">
                        <span>{t('memory.aiReviewChangedFields')}:</span>
                        {change.diffs.map(diff => (
                          <span key={diff.field}>
                            {t(`memory.${diff.field}`)}{' '}
                            <span className="line-through">{formatReviewDiffValue(diff.before)}</span>
                            {' → '}
                            <span className="font-medium text-text-primary">{formatReviewDiffValue(diff.after)}</span>
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 break-all font-mono text-xs text-text-muted">{change.id}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-text-muted">{t('memory.aiReviewNoChanges')}</p>
            )}
          </section>
        )}

        <main className="min-h-0" aria-busy={charactersLoading}>
          {charactersLoading ? (
            <div className="surface-panel"><ContentState mode="loading" title={t('common.loading')} /></div>
          ) : charactersLoadError ? (
            <div className="surface-panel"><ContentState mode="error" title={charactersLoadError} /></div>
          ) : selectedCharId ? (
            <MemoryList characterId={selectedCharId} refreshNonce={memoryRefreshNonce} />
          ) : (
            <div className="surface-panel">
              <ContentState mode="empty" title={t('memories.noCharacter')} icon={<MemoryIcon className="h-5 w-5" />} />
            </div>
          )}
        </main>
      </div>

      <Modal
        open={mergeSourcesModal !== null}
        onClose={() => setMergeSourcesModal(null)}
        title={mergeSourcesModal?.title}
        maxWidth="max-w-2xl"
        padded={false}
        dialogClassName="flex w-full max-w-2xl max-h-[80vh] flex-col overflow-hidden rounded-2xl bg-surface shadow-xl outline-none"
      >
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {mergeSourcesModal?.sources.map(source => (
            <div key={source.id} className="rounded-xl border border-border-light bg-surface-2 px-3 py-2">
              <div className="text-xs text-text-muted">
                {source.category}
                {source.tags.length > 0 ? ` · ${source.tags.join(',')}` : ''}
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">
                {source.content}
              </p>
              <div className="mt-1 break-all font-mono text-xs text-text-muted">{source.id}</div>
            </div>
          ))}
        </div>
        <div className="flex shrink-0 justify-end border-t border-border-light px-5 py-3">
          <button
            type="button"
            onClick={() => setMergeSourcesModal(null)}
            className="soft-button soft-button-secondary px-4 py-2 text-sm"
          >
            {t('common.close')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
