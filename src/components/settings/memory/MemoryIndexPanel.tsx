import { formatTemplate } from '@/lib/i18n';
import { RefreshIcon } from '@/components/ui/icons';
import type { MemoryIndexStatus } from '@/hooks/settings/useMemoryIndexPanel';

interface MemoryIndexPanelProps {
  t: (key: string) => string;
  status: MemoryIndexStatus | null;
  loading: boolean;
  rebuilding: boolean;
  retrying: boolean;
  indexingUnindexed: boolean;
  clearing: boolean;
  clearingOther: boolean;
  stopping: boolean;
  error: string | null;
  activeTasks: number;
  blockedReason: string | null;
  embeddingModel: string;
  onRetryFailed: () => void;
  onRebuild: () => void;
  onIndexUnindexed: () => void;
  onClear: () => void;
  onClearOtherTargets: () => void;
  onStopCurrent: () => void;
}

export function MemoryIndexPanel({
  t,
  status,
  loading,
  rebuilding,
  retrying,
  indexingUnindexed,
  clearing,
  clearingOther,
  stopping,
  error,
  activeTasks,
  blockedReason,
  embeddingModel,
  onRetryFailed,
  onRebuild,
  onIndexUnindexed,
  onClear,
  onClearOtherTargets,
  onStopCurrent,
}: MemoryIndexPanelProps) {
  const busy = loading || rebuilding || retrying || indexingUnindexed || clearing || clearingOther || stopping;
  const otherTargetReady = status?.other_target_ready ?? 0;
  const embeddingRows = status?.embedding_rows ?? 0;
  const targetLabel = status?.target_model
    ? formatTemplate(t('settings.memoryIndexCurrentTarget'), {
        model: status.target_model,
        dimension: String(status.target_dimension ?? 0),
      })
    : null;

  return (
    <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryIndexStatus')}</h3>
          {targetLabel && (
            <p className="mt-1 text-xs text-text-muted">{targetLabel}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRetryFailed}
            disabled={busy || (status?.failed ?? 0) === 0}
            className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {retrying ? (
              <span className="spinner-sm" aria-hidden="true" />
            ) : (
              <RefreshIcon className="h-3.5 w-3.5" />
            )}
            {retrying ? t('settings.memoryIndexRetrying') : t('settings.memoryIndexRetryFailed')}
          </button>
          <button
            type="button"
            onClick={onRebuild}
            disabled={busy}
            className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {rebuilding ? (
              <span className="spinner-sm" aria-hidden="true" />
            ) : (
              <RefreshIcon className="h-3.5 w-3.5" />
            )}
            {rebuilding ? t('settings.memoryIndexRebuilding') : t('settings.memoryIndexRebuild')}
          </button>
          <button
            type="button"
            onClick={onIndexUnindexed}
            disabled={busy || !embeddingModel.trim()}
            className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {indexingUnindexed ? (
              <span className="spinner-sm" aria-hidden="true" />
            ) : (
              <RefreshIcon className="h-3.5 w-3.5" />
            )}
            {indexingUnindexed ? t('settings.memoryIndexIndexingUnindexed') : t('settings.memoryIndexIndexUnindexed')}
          </button>
          <button
            type="button"
            onClick={onClearOtherTargets}
            disabled={busy || otherTargetReady === 0}
            className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {clearingOther ? (
              <span className="spinner-sm" aria-hidden="true" />
            ) : (
              <RefreshIcon className="h-3.5 w-3.5" />
            )}
            {clearingOther ? t('settings.memoryIndexClearingOther') : t('settings.memoryIndexClearOther')}
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={busy || embeddingRows === 0}
            className="soft-button soft-button-danger text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {clearing ? (
              <span className="spinner-sm" aria-hidden="true" />
            ) : (
              <RefreshIcon className="h-3.5 w-3.5" />
            )}
            {clearing ? t('settings.memoryIndexClearing') : t('settings.memoryIndexClear')}
          </button>
          <button
            type="button"
            onClick={onStopCurrent}
            disabled={busy || activeTasks === 0}
            className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stopping ? (
              <span className="spinner-sm" aria-hidden="true" />
            ) : (
              <RefreshIcon className="h-3.5 w-3.5" />
            )}
            {stopping ? t('settings.memoryIndexStopping') : t('settings.memoryIndexStopCurrent')}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryIndexIndexed')}</span>
          <span className="text-sm font-medium text-text-primary">{loading ? '...' : status?.indexed ?? 0}</span>
        </div>
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryIndexTotal')}</span>
          <span className="text-sm font-medium text-text-primary">{loading ? '...' : status?.total ?? 0}</span>
        </div>
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryIndexFailed')}</span>
          <span className="text-sm font-medium text-text-primary">{loading ? '...' : status?.failed ?? 0}</span>
        </div>
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryIndexQueued')}</span>
          <span className="text-sm font-medium text-text-primary">{loading ? '...' : status?.queued ?? 0}</span>
        </div>
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryIndexProcessing')}</span>
          <span className="text-sm font-medium text-text-primary">{loading ? '...' : status?.processing ?? 0}</span>
        </div>
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryIndexOtherTarget')}</span>
          <span className="text-sm font-medium text-text-primary">{loading ? '...' : otherTargetReady}</span>
        </div>
      </div>
      {otherTargetReady > 0 && (
        <p className="mt-3 text-xs text-amber-600">
          {formatTemplate(t('settings.memoryIndexOtherTargetHint'), {
            count: String(otherTargetReady),
            rows: String(embeddingRows),
          })}
        </p>
      )}
      {error && (
        <p className="mt-3 text-xs text-red-500">{t('common.loadFailed')}: {error}</p>
      )}
      {blockedReason && (
        <p className="mt-3 break-words text-xs text-amber-600">
          {formatTemplate(t('settings.memoryIndexProcessingBlocked'), { reason: blockedReason })}
        </p>
      )}
      {status?.latest_error && (
        <p className="mt-3 break-words text-xs text-red-500">
          {t('settings.memoryIndexLatestError')}: {status.latest_error}
        </p>
      )}
    </div>
  );
}
