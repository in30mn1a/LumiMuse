import { useMemo, useState } from 'react';
import { RefreshIcon, SparkIcon, StopIcon } from '@/components/ui/icons';
import type { MemoryArchiveAiProposal, UseMemoryArchivePanelResult } from '@/hooks/settings/useMemoryArchivePanel';

interface MemoryArchivePanelProps {
  t: (key: string) => string;
  archive: UseMemoryArchivePanelResult;
  memoryManagementCharacterId: string;
}

export function MemoryArchivePanel(props: MemoryArchivePanelProps) {
  return <MemoryArchivePanelContent key={props.memoryManagementCharacterId} {...props} />;
}

function isExecutableAiProposal(proposal: MemoryArchiveAiProposal): boolean {
  return (proposal.status === 'pending' || proposal.status === 'failed')
    && proposal.selectedIds.length > 0
    && proposal.summary.trim().length > 0;
}

function MemoryArchivePanelContent({
  t,
  archive,
  memoryManagementCharacterId,
}: MemoryArchivePanelProps) {
  const { loadMemoryArchiveMemories } = archive;
  const [filterKeyword, setFilterKeyword] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const memoryArchiveShownCount = Math.max(archive.memoryArchiveMemories.length, archive.memoryArchiveOffset);
  const handleLoadMoreMemoryArchiveMemories = () => {
    if (!memoryManagementCharacterId || archive.memoryArchiveListLoading) return;
    const memoryArchiveNextOffset = archive.memoryArchiveMemories.length;
    void loadMemoryArchiveMemories(memoryManagementCharacterId, { append: true, offset: memoryArchiveNextOffset });
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of archive.memoryArchiveMemories) {
      if (m.category) set.add(m.category);
    }
    return Array.from(set);
  }, [archive.memoryArchiveMemories]);

  if (filterCategory && !categories.includes(filterCategory)) {
    setFilterCategory('');
  }

  const filteredMemories = useMemo(() => {
    const kw = filterKeyword.trim().toLowerCase();
    return archive.memoryArchiveMemories.filter(memory => {
      if (filterCategory && memory.category !== filterCategory) return false;
      if (kw && !memory.content.toLowerCase().includes(kw) && !memory.category.toLowerCase().includes(kw)) {
        return false;
      }
      return true;
    });
  }, [archive.memoryArchiveMemories, filterCategory, filterKeyword]);

  const handleSelectAllFiltered = () => {
    const visibleIds = filteredMemories.map(m => m.id);
    archive.selectMemoryArchiveIds(visibleIds);
  };

  const handleClearSelection = () => {
    archive.clearMemoryArchiveSelection();
  };

  const executableAiProposalKeys = archive.memoryArchiveAiProposals
    .filter(isExecutableAiProposal)
    .map(proposal => proposal.key);
  const manualArchiveReady = archive.selectedMemoryArchiveIds.length > 0 && archive.memoryArchiveSummary.trim().length > 0;

  return (
    <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
      <div className="mb-3">
        <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryArchiveTitle')}</h3>
        <p className="mt-1 text-xs text-text-muted">{t('settings.memoryArchiveHint')}</p>
      </div>
      {archive.memoryArchiveError && (
        <p role="alert" className="mb-3 text-xs text-red-500">{archive.memoryArchiveError}</p>
      )}

      {/* ── AI 归档建议：AI 只出方案，逐组确认后才执行 ── */}
      <section>
        <h4 className="text-sm font-medium text-text-secondary">{t('settings.memoryArchiveAiSection')}</h4>
        <p className="mt-1 text-xs text-text-muted">{t('settings.memoryArchiveAiHint')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void archive.handleMemoryArchiveAi()}
            disabled={archive.memoryArchiveLoading || archive.memoryArchiveAiRunning || !memoryManagementCharacterId}
            className="soft-button soft-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {archive.memoryArchiveAiRunning ? (
              <span className="spinner-sm" aria-hidden="true" />
            ) : (
              <SparkIcon className="h-3.5 w-3.5" />
            )}
            {archive.memoryArchiveAiRunning ? t('settings.memoryArchiveAiRunning') : t('settings.memoryArchiveAi')}
          </button>
          {archive.memoryArchiveAiRunning && (
            <button
              type="button"
              onClick={archive.handleStopMemoryArchiveAi}
              className="soft-button soft-button-danger px-2.5 py-1 text-xs"
            >
              <StopIcon className="h-3.5 w-3.5" />
              {t('settings.memoryArchiveAiStop')}
            </button>
          )}
          {executableAiProposalKeys.length > 1 && (
            <button
              type="button"
              onClick={() => void archive.handleExecuteMemoryArchiveAiProposals(executableAiProposalKeys)}
              disabled={archive.memoryArchiveLoading}
              className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('settings.memoryArchiveAiExecuteAll').replace('{count}', String(executableAiProposalKeys.length))}
            </button>
          )}
        </div>
        {archive.memoryArchiveAiProposals.length > 0 && (
          <ul className="mt-3 space-y-3">
            {archive.memoryArchiveAiProposals.map((proposal, index) => {
              const settled = proposal.status === 'archived' || proposal.status === 'stale';
              const summaryInputId = `memory-archive-ai-summary-${proposal.key}`;
              return (
                <li
                  key={proposal.key}
                  className={`rounded-xl border border-border-light bg-white/60 p-3 ${settled ? 'opacity-70' : ''}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">
                      {proposal.title || t('settings.memoryArchiveAiGroup').replace('{index}', String(index + 1))}
                    </span>
                    {proposal.status === 'archived' && (
                      <span className="chip chip-active text-[11px]">{t('settings.memoryArchiveAiArchivedBadge')}</span>
                    )}
                    {proposal.status === 'stale' && (
                      <span className="chip text-[11px]">{t('settings.memoryArchiveAiStaleBadge')}</span>
                    )}
                  </div>
                  {settled ? (
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text-secondary">{proposal.summary}</p>
                  ) : (
                    <>
                      <label htmlFor={summaryInputId} className="mt-2 block text-xs font-medium text-text-secondary">
                        {t('settings.memoryArchiveSummary')}
                      </label>
                      <textarea
                        id={summaryInputId}
                        value={proposal.summary}
                        onChange={e => archive.setMemoryArchiveAiProposalSummary(proposal.key, e.target.value)}
                        disabled={archive.memoryArchiveLoading}
                        rows={4}
                        className="textarea-rich mt-1 w-full rounded-xl border border-border-light bg-white/80 px-3 py-2 text-sm disabled:opacity-70"
                      />
                      <div className="mt-2 text-xs font-medium text-text-secondary">
                        {t('settings.memoryArchiveAiCovered')
                          .replace('{selected}', String(proposal.selectedIds.length))
                          .replace('{total}', String(proposal.memories.length))}
                      </div>
                      <div className="mt-1 max-h-48 space-y-1 overflow-auto">
                        {proposal.memories.map(memory => (
                          <label
                            key={memory.id}
                            className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-xs text-text-secondary hover:bg-white/70"
                          >
                            <input
                              type="checkbox"
                              checked={proposal.selectedIds.includes(memory.id)}
                              onChange={() => archive.toggleMemoryArchiveAiProposalMemory(proposal.key, memory.id)}
                              disabled={archive.memoryArchiveLoading}
                              className="mt-0.5"
                            />
                            <span className="min-w-0 flex-1 break-words">
                              <span className="mr-1 text-text-muted">[{memory.category}]</span>
                              {memory.content}
                            </span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                  {proposal.error && (
                    <p role="alert" className="mt-2 text-xs text-red-500">{proposal.error}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {!settled && (
                      <button
                        type="button"
                        onClick={() => void archive.handleExecuteMemoryArchiveAiProposals([proposal.key])}
                        disabled={archive.memoryArchiveLoading || !isExecutableAiProposal(proposal)}
                        className="soft-button soft-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t('settings.memoryArchiveAiExecuteGroup').replace('{count}', String(proposal.selectedIds.length))}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => archive.dismissMemoryArchiveAiProposal(proposal.key)}
                      disabled={archive.memoryArchiveLoading}
                      className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {settled ? t('settings.memoryArchiveAiRemove') : t('settings.memoryArchiveAiDismiss')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── 手动归档：自己挑记忆、自己写摘要 ── */}
      <section className="mt-4 border-t border-border-light pt-4">
        <h4 className="text-sm font-medium text-text-secondary">{t('settings.memoryArchiveManualSection')}</h4>
        <p className="mb-2 mt-1 text-xs text-text-muted">
          {t('settings.memoryArchiveSelectMemories')}
          {' · '}
          {t('settings.memoryArchiveShownCount')
            .replace('{shown}', String(memoryArchiveShownCount))
            .replace('{total}', String(archive.memoryArchiveTotal))}
        </p>
        {archive.memoryArchiveMemories.length === 0 ? (
          <p className="rounded-xl border border-border-light bg-white/60 px-3 py-2 text-xs text-text-muted">
            {memoryManagementCharacterId ? t('settings.memoryArchiveNoMemories') : t('settings.memoryManagementChooseCharacter')}
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={filterKeyword}
                onChange={e => setFilterKeyword(e.target.value)}
                placeholder={t('settings.memoryArchiveFilterPlaceholder')}
                aria-label={t('settings.memoryArchiveFilterPlaceholder')}
                className="input-rich min-w-[12rem] flex-1 rounded-xl border border-border-light bg-white/80 px-3 py-1.5 text-xs"
              />
              {categories.length > 0 && (
                <select
                  value={filterCategory}
                  onChange={e => setFilterCategory(e.target.value)}
                  aria-label={t('settings.memoryArchiveAllCategories')}
                  className="select-rich w-auto rounded-xl border border-border-light bg-white/80 px-2.5 py-1.5 text-xs"
                >
                  <option value="">{t('settings.memoryArchiveAllCategories')}</option>
                  {categories.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={handleSelectAllFiltered}
                disabled={filteredMemories.length === 0}
                className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('settings.memoryArchiveSelectAll')}
              </button>
              {archive.selectedMemoryArchiveIds.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="soft-button soft-button-secondary px-2.5 py-1 text-xs"
                >
                  {t('settings.memoryArchiveClearSelection')} ({archive.selectedMemoryArchiveIds.length})
                </button>
              )}
            </div>
            <div className="max-h-64 space-y-2 overflow-auto rounded-xl border border-border-light bg-white/60 p-2">
              {filteredMemories.map(memory => (
                <label
                  key={memory.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-xs text-text-secondary hover:bg-white/70"
                >
                  <input
                    type="checkbox"
                    checked={archive.selectedMemoryArchiveIds.includes(memory.id)}
                    onChange={() => archive.toggleMemoryArchiveSelection(memory.id)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-text-primary">
                      {memory.category}{memory.pinned ? ` · ${t('settings.memoryArchivePinned')}` : ''}
                    </span>
                    <span className="mt-1 block line-clamp-2 break-words">{memory.content}</span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        {archive.memoryArchiveHasMore && memoryManagementCharacterId && (
          <button
            type="button"
            onClick={handleLoadMoreMemoryArchiveMemories}
            disabled={archive.memoryArchiveListLoading}
            className="mt-2 soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {archive.memoryArchiveListLoading ? (
              <span className="spinner-sm" aria-hidden="true" />
            ) : (
              <RefreshIcon className="h-3.5 w-3.5" />
            )}
            {t('settings.memoryArchiveLoadMore')}
          </button>
        )}
        <label htmlFor="memory-archive-manual-summary" className="mt-3 block text-xs font-medium text-text-secondary">
          {t('settings.memoryArchiveSummary')}
        </label>
        <textarea
          id="memory-archive-manual-summary"
          value={archive.memoryArchiveSummary}
          onChange={e => archive.setMemoryArchiveSummary(e.target.value)}
          rows={3}
          className="textarea-rich mt-1 w-full resize-none rounded-xl border border-border-light bg-white/80 px-3 py-2 text-sm"
          placeholder={t('settings.memoryArchiveSummaryPlaceholder')}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void archive.handleMemoryArchivePreview()}
            disabled={archive.memoryArchiveLoading || !manualArchiveReady}
            className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('settings.memoryArchivePreview')}
          </button>
          <button
            type="button"
            onClick={() => void archive.handleMemoryArchiveExecute()}
            disabled={archive.memoryArchiveLoading || !manualArchiveReady}
            className="soft-button soft-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('settings.memoryArchiveExecute')}
          </button>
          {!manualArchiveReady && (
            <span className="text-xs text-text-muted">{t('settings.memoryArchiveRequired')}</span>
          )}
        </div>
        {archive.memoryArchivePlan && (
          <p className="mt-2 text-xs text-text-muted">
            {t('settings.memoryArchivePlanResult')
              .replace('{count}', String(archive.memoryArchivePlan.coveredMemoryUpdates.length))}
          </p>
        )}
      </section>

      {/* ── 归档记录：查看某次归档覆盖了什么，或撤销它 ── */}
      <section className="mt-4 border-t border-border-light pt-4">
        <h4 className="text-sm font-medium text-text-secondary">{t('settings.memoryArchiveHistorySection')}</h4>
        {archive.memoryArchiveBatches.length === 0 ? (
          <p className="mt-1 text-xs text-text-muted">{t('settings.memoryArchiveNoBatches')}</p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={archive.selectedMemoryArchiveBatchId}
                onChange={e => {
                  archive.setSelectedMemoryArchiveBatchId(e.target.value);
                  void archive.loadMemoryArchiveBatchDetail(e.target.value);
                }}
                aria-label={t('settings.memoryArchiveSelectBatch')}
                className="select-rich min-w-0 flex-1"
              >
                <option value="">{t('settings.memoryArchiveSelectBatch')}</option>
                {archive.memoryArchiveBatches.map(batch => (
                  <option key={batch.batch_id} value={batch.batch_id}>
                    {(batch.summary_content.length > 60 ? batch.summary_content.slice(0, 60) + '...' : batch.summary_content) || batch.batch_id} ({batch.covered_count})
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void archive.loadMemoryArchiveBatchDetail(archive.selectedMemoryArchiveBatchId)}
                disabled={!archive.selectedMemoryArchiveBatchId}
                className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('settings.memoryArchiveViewBatch')}
              </button>
              <button
                type="button"
                onClick={() => void archive.handleMemoryArchiveUndo()}
                disabled={archive.memoryArchiveLoading || !memoryManagementCharacterId || !archive.selectedMemoryArchiveBatchId}
                className="soft-button soft-button-danger px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('settings.memoryArchiveUndo')}
              </button>
            </div>
            {archive.memoryArchiveBatchDetail && (
              <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border-light bg-white/60 p-2 text-xs">
                {archive.memoryArchiveBatchDetail.summary && (
                  <>
                    <div className="px-2 font-medium text-text-secondary">{t('settings.memoryArchiveSummary')}</div>
                    <p className="mb-2 mt-1 whitespace-pre-wrap break-words rounded bg-white/70 px-2 py-1 text-text-primary">
                      {archive.memoryArchiveBatchDetail.summary.content}
                    </p>
                  </>
                )}
                <div className="px-2 font-medium text-text-secondary">
                  {t('settings.memoryArchiveBatchCovered')
                    .replace('{count}', String(archive.memoryArchiveBatchDetail.covered.length))}
                </div>
                {archive.memoryArchiveBatchDetail.covered.map(m => (
                  <p key={m.id} className="flex gap-2 border-b border-border-light/50 px-2 py-1 last:border-0">
                    <span className="shrink-0 text-text-muted">[{m.category}]</span>
                    <span className="min-w-0 flex-1 break-words text-text-secondary">{m.content}</span>
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
