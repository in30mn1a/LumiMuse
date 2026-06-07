import { RefreshIcon, SparkIcon, StopIcon } from '@/components/ui/icons';
import type { UseMemoryArchivePanelResult } from '@/hooks/settings/useMemoryArchivePanel';

interface MemoryArchivePanelProps {
  t: (key: string) => string;
  archive: UseMemoryArchivePanelResult;
  memoryManagementCharacterId: string;
}

export function MemoryArchivePanel({
  t,
  archive,
  memoryManagementCharacterId,
}: MemoryArchivePanelProps) {
  const { loadMemoryArchiveMemories } = archive;
  const memoryArchiveShownCount = Math.max(archive.memoryArchiveMemories.length, archive.memoryArchiveOffset);
  const handleLoadMoreMemoryArchiveMemories = () => {
    if (!memoryManagementCharacterId || archive.memoryArchiveListLoading) return;
    const memoryArchiveNextOffset = archive.memoryArchiveMemories.length;
    void loadMemoryArchiveMemories(memoryManagementCharacterId, { append: true, offset: memoryArchiveNextOffset });
  };

  return (
    <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
      <div className="mb-3">
        <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryArchiveTitle')}</h3>
        <p className="mt-1 text-xs text-text-muted">{t('settings.memoryArchiveHint')}</p>
      </div>
      <div>
        <div className="mb-2 text-sm font-medium text-text-secondary">
          {t('settings.memoryArchiveSelectMemories')}
        </div>
        <p className="mb-2 text-xs text-text-muted">
          {t('settings.memoryArchiveShownCount')
            .replace('{shown}', String(memoryArchiveShownCount))
            .replace('{total}', String(archive.memoryArchiveTotal))}
        </p>
        {archive.memoryArchiveMemories.length === 0 ? (
          <p className="rounded-xl border border-border-light bg-white/60 px-3 py-2 text-xs text-text-muted">
            {memoryManagementCharacterId ? t('settings.memoryArchiveNoMemories') : t('settings.memoryManagementChooseCharacter')}
          </p>
        ) : (
          <div className="max-h-64 space-y-2 overflow-auto rounded-xl border border-border-light bg-white/60 p-2">
            {archive.memoryArchiveMemories.map(memory => (
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
                    {memory.category} · {memory.status}{memory.pinned ? ` · ${t('common.current')}` : ''}
                  </span>
                  <span className="mt-1 block line-clamp-2 break-words">{memory.content}</span>
                </span>
              </label>
            ))}
          </div>
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
      </div>
      <div className="mt-3">
        <label className="mb-1.5 block text-sm font-medium text-text-secondary">
          {t('settings.memoryArchiveSelectBatch')}
        </label>
        <select
          value={archive.selectedMemoryArchiveBatchId}
          onChange={e => {
            archive.setSelectedMemoryArchiveBatchId(e.target.value);
            void archive.loadMemoryArchiveBatchDetail(e.target.value);
          }}
          className="select-rich"
        >
          <option value="">{t('settings.memoryArchiveNoBatches')}</option>
          {archive.memoryArchiveBatches.map(batch => (
            <option key={batch.batch_id} value={batch.batch_id}>
              {(batch.summary_content.length > 60 ? batch.summary_content.slice(0, 60) + '...' : batch.summary_content) || batch.batch_id} ({batch.covered_count})
            </option>
          ))}
        </select>
        {archive.memoryArchiveBatchDetail && (
          <div className="mt-2 max-h-32 overflow-auto rounded-lg border border-border-light bg-white/60 p-2 text-xs">
            {archive.memoryArchiveBatchDetail.summary && (
              <p className="mb-2 rounded bg-white/70 px-2 py-1 font-medium text-text-primary">
                {archive.memoryArchiveBatchDetail.summary.content}
              </p>
            )}
            {archive.memoryArchiveBatchDetail.covered.map(m => (
              <p key={m.id} className="flex gap-2 border-b border-border-light/50 px-2 py-1 last:border-0">
                <span className="shrink-0 text-text-muted">[{m.category}]</span>
                <span className="min-w-0 flex-1 text-text-secondary">{m.content}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <textarea
        value={archive.memoryArchiveSummary}
        onChange={e => archive.setMemoryArchiveSummary(e.target.value)}
        rows={3}
        className="textarea-rich mt-3 w-full resize-none rounded-xl border border-border-light bg-white/80 px-3 py-2 text-sm"
        placeholder={t('settings.memoryArchiveSummary')}
      />
      <div className="mt-3 flex flex-wrap gap-2">
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
          {archive.memoryArchiveAiRunning ? t('common.loading') : t('settings.memoryArchiveAi')}
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
        <button
          type="button"
          onClick={() => void archive.handleMemoryArchivePreview()}
          disabled={archive.memoryArchiveLoading || !memoryManagementCharacterId}
          className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('settings.memoryArchivePreview')}
        </button>
        <button
          type="button"
          onClick={() => void archive.handleMemoryArchiveExecute()}
          disabled={archive.memoryArchiveLoading || !memoryManagementCharacterId}
          className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('settings.memoryArchiveExecute')}
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
      {archive.memoryArchiveError && (
        <p className="mt-3 text-xs text-red-500">{archive.memoryArchiveError}</p>
      )}
      {archive.memoryArchivePlan && (
        <p className="mt-3 text-xs text-text-muted">
          {t('settings.memoryArchivePlanResult')
            .replace('{summary}', archive.memoryArchivePlan.summaryMemory.id)
            .replace('{count}', String(archive.memoryArchivePlan.coveredMemoryUpdates.length))}
        </p>
      )}
    </div>
  );
}
