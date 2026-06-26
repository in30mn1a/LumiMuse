'use client';

import { useState, useEffect, useRef } from 'react';
import { Character } from '@/types';
import MemoryList from '@/components/memories/MemoryList';
import Link from 'next/link';
import { useTranslation } from '@/lib/i18n-context';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, MemoryIcon, SparkIcon } from '@/components/ui/icons';

interface MemoryAiReviewResult {
  ok: boolean;
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
  changes: Array<{ id: string; fields: string[] }>;
}

export default function MemoriesPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [memoryAiReviewRunning, setMemoryAiReviewRunning] = useState(false);
  const [lastMemoryAiReviewResult, setLastMemoryAiReviewResult] = useState<MemoryAiReviewResult | null>(null);
  const [showMemoryAiReviewChanges, setShowMemoryAiReviewChanges] = useState(false);
  const [memoryRefreshNonce, setMemoryRefreshNonce] = useState(0);
  const selectedCharIdRef = useRef<string | null>(null);
  const { t } = useTranslation();
  const { showToast } = useToast();

  useEffect(() => {
    fetch('/api/characters').then(r => r.json()).then((chars: Character[]) => {
      setCharacters(chars);
      if (chars.length > 0) {
        selectedCharIdRef.current = chars[0].id;
        setSelectedCharId(chars[0].id);
      }
    });
  }, []);

  useEffect(() => {
    selectedCharIdRef.current = selectedCharId;
  }, [selectedCharId]);

  const handleMemoryAiReview = async () => {
    if (!selectedCharId) return;
    const requestedCharacterId = selectedCharId;
    setMemoryAiReviewRunning(true);
    setShowMemoryAiReviewChanges(false);
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
    };
    try {
      let nextOffset: number | null = 0;

      while (nextOffset !== null) {
        const pageOffset = nextOffset;
        const response = await fetch('/api/memory-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ character_id: requestedCharacterId, offset: nextOffset }),
        });
        const result: MemoryAiReviewResult = await parseJsonResponse<MemoryAiReviewResult>(response);
        if (selectedCharIdRef.current !== requestedCharacterId) return;

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
        aggregateResult.changes.push(...(result.changes ?? []));

        if (!result.has_more) {
          nextOffset = null;
        } else if (typeof result.next_offset === 'number' && result.next_offset > pageOffset) {
          nextOffset = result.next_offset;
        } else {
          throw new Error('memory-review pagination did not advance');
        }
      }

      setLastMemoryAiReviewResult(aggregateResult);
      setMemoryRefreshNonce(prev => prev + 1);
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
      // 整页失败会中断后续页，但此前已成功的页其修正已落库；保留并展示已处理进度，避免表现为全盘失败、让已落库的修改对用户不可见。
      if (aggregateResult.reviewed > 0) {
        setLastMemoryAiReviewResult(aggregateResult);
        setMemoryRefreshNonce(prev => prev + 1);
        showToast(
          `${t('memory.aiReviewInterrupted')
            .replace('{reviewed}', String(aggregateResult.reviewed))
            .replace('{corrected}', String(aggregateResult.corrected))}: ${getErrorMessage(err)}`,
          'error',
        );
      } else {
        showToast(`${t('memory.aiReviewFailed')}: ${getErrorMessage(err)}`, 'error');
      }
    } finally {
      if (selectedCharIdRef.current === requestedCharacterId) {
        setMemoryAiReviewRunning(false);
      }
    }
  };

  return (
    <div className="app-shell min-h-screen px-4 py-4">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="surface-hero px-5 py-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <Link href="/" className="soft-button soft-button-secondary px-3 py-2">
                <ArrowLeftIcon className="h-4 w-4" />
                {t('memories.back')}
              </Link>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgba(155,124,240,0.12)] text-accent-dark">
                <MemoryIcon className="h-5 w-5" />
              </div>
              <div>
                <h1 className="section-title text-2xl">{t('memories.title')}</h1>
              </div>
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
                {memoryAiReviewRunning ? t('memory.aiReviewRunning') : t('memory.aiReview')}
              </button>
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
            {lastMemoryAiReviewResult.changes.length > 0 ? (
              <div className="space-y-2">
                {lastMemoryAiReviewResult.changes.map(change => (
                  <div key={change.id} className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                    <div className="font-medium text-text-primary">{change.id}</div>
                    <div className="mt-1 text-xs text-text-muted">
                      {t('memory.aiReviewChangedFields')}: {change.fields.join('；')}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">{t('memory.aiReviewNoChanges')}</p>
            )}
          </section>
        )}

        <main className="min-h-0">
          {selectedCharId ? (
            <MemoryList characterId={selectedCharId} refreshNonce={memoryRefreshNonce} />
          ) : (
            <div className="surface-panel px-6 py-20 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[1.4rem] bg-[rgba(155,124,240,0.12)] text-accent-dark">
                <MemoryIcon className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium text-text-primary">{t('memories.noCharacter')}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
