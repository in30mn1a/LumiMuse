import { RefreshIcon } from '@/components/ui/icons';
import type { MemoryDiagnostics } from '@/hooks/settings/useMemoryIndexPanel';

interface MemoryDiagnosticsPanelProps {
  t: (key: string) => string;
  diagnostics: MemoryDiagnostics | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function MemoryDiagnosticsPanel({
  t,
  diagnostics,
  loading,
  error,
  onRefresh,
}: MemoryDiagnosticsPanelProps) {
  return (
    <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryDiagnosticsTitle')}</h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <span className="spinner-sm" aria-hidden="true" />
            ) : (
              <RefreshIcon className="h-3.5 w-3.5" />
            )}
            {loading ? t('common.loading') : t('settings.memoryCandidatesRefresh')}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryDiagnosticsIndex')}</span>
          <span className="text-sm font-medium text-text-primary">
            {loading ? '...' : `${diagnostics?.index.ready ?? 0}/${diagnostics?.index.total ?? 0}`}
          </span>
        </div>
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryDiagnosticsTasks')}</span>
          <span className="text-sm font-medium text-text-primary">
            {loading ? '...' : `${diagnostics?.tasks.pending ?? 0}/${diagnostics?.tasks.processing ?? 0}/${diagnostics?.tasks.failed ?? 0}`}
          </span>
        </div>
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryDiagnosticsCandidates')}</span>
          <span className="text-sm font-medium text-text-primary">
            {loading ? '...' : diagnostics?.candidates.repairable ?? 0}
          </span>
        </div>
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryDiagnosticsProfile')}</span>
          <span className="text-sm font-medium text-text-primary">
            {loading ? '...' : (
              diagnostics?.profile.exists
                ? `${diagnostics.profile.filled_fields}/6`
                : t('common.empty')
            )}
          </span>
        </div>
        <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
          <span className="block text-text-muted">{t('settings.memoryDiagnosticsArchive')}</span>
          <span className="text-sm font-medium text-text-primary">
            {loading ? '...' : (() => {
              const a = diagnostics?.archive.archived ?? 0;
              const s = diagnostics?.archive.summarized ?? 0;
              return s > 0 ? `${a}/${s}` : String(a);
            })()}
          </span>
        </div>
      </div>
      {error && (
        <p className="mt-3 text-xs text-red-500">{t('common.loadFailed')}: {error}</p>
      )}
    </div>
  );
}
