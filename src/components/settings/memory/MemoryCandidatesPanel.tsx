import { RefreshIcon } from '@/components/ui/icons';
import {
  getCandidateTags,
  getCandidateText,
  type UseMemoryCandidatesPanelResult,
} from '@/hooks/settings/useMemoryCandidatesPanel';

interface MemoryCandidatesPanelProps {
  t: (key: string) => string;
  candidates: UseMemoryCandidatesPanelResult;
}

export function MemoryCandidatesPanel({
  t,
  candidates,
}: MemoryCandidatesPanelProps) {
  const memoryCandidates = candidates.memoryCandidates;
  const memoryCandidatesLoading = candidates.memoryCandidatesLoading;
  const memoryCandidatesError = candidates.memoryCandidatesError;
  const memoryCandidateActionId = candidates.memoryCandidateActionId;
  const editingMemoryCandidateId = candidates.editingMemoryCandidateId;
  const memoryCandidateEdits = candidates.memoryCandidateEdits;
  const setEditingMemoryCandidateId = candidates.setEditingMemoryCandidateId;
  const setMemoryCandidateEdits = candidates.setMemoryCandidateEdits;
  const loadMemoryCandidates = candidates.loadMemoryCandidates;
  const handleMemoryCandidateAction = candidates.handleMemoryCandidateAction;

  return (
    <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryCandidatesTitle')}</h3>
          <p className="mt-1 text-xs text-text-muted">{t('settings.memoryCandidatesHint')}</p>
        </div>
        <button
          type="button"
          onClick={() => void loadMemoryCandidates()}
          disabled={memoryCandidatesLoading}
          className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {memoryCandidatesLoading ? (
            <span className="spinner-sm" aria-hidden="true" />
          ) : (
            <RefreshIcon className="h-3.5 w-3.5" />
          )}
          {memoryCandidatesLoading ? t('common.loading') : t('settings.memoryCandidatesRefresh')}
        </button>
      </div>

      {memoryCandidatesError && (
        <p className="mb-3 text-xs text-red-500">{t('common.loadFailed')}: {memoryCandidatesError}</p>
      )}

      {memoryCandidatesLoading && memoryCandidates.length === 0 ? (
        <p className="text-sm text-text-muted">{t('common.loading')}</p>
      ) : memoryCandidates.length === 0 ? (
        <p className="text-sm text-text-muted">{t('settings.memoryCandidatesEmpty')}</p>
      ) : (
        <div className="space-y-3">
          {memoryCandidates.map(candidate => {
            const isEditing = editingMemoryCandidateId === candidate.id;
            const isBusy = memoryCandidateActionId === candidate.id;
            const content = getCandidateText(candidate, 'content');
            const category = getCandidateText(candidate, 'category') || t('common.empty');
            const role = getCandidateText(candidate, 'role') || getCandidateText(candidate, 'memory_kind') || t('common.empty');
            const tags = getCandidateTags(candidate);

            return (
              <div key={candidate.id} className="rounded-xl border border-border-light bg-white/60 px-3 py-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <span className="rounded-full bg-accent/10 px-2 py-0.5 text-accent-dark">{category}</span>
                  <span>{t('settings.memoryCandidatesRole')}: {role}</span>
                  {candidate.error_reason && (
                    <span>{t('settings.memoryCandidatesErrorReason')}: {candidate.error_reason}</span>
                  )}
                </div>

                {isEditing ? (
                  <textarea
                    value={memoryCandidateEdits[candidate.id] ?? content}
                    onChange={e => setMemoryCandidateEdits(prev => ({ ...prev, [candidate.id]: e.target.value }))}
                    rows={3}
                    className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/80 px-3 py-2 text-sm"
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{content || t('common.empty')}</p>
                )}

                {tags && (
                  <p className="mt-2 text-xs text-text-muted">{t('settings.memoryCandidatesTags')}: {tags}</p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleMemoryCandidateAction(candidate, 'accept')}
                    disabled={isBusy}
                    className="soft-button soft-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('settings.memoryCandidateAccept')}
                  </button>
                  {isEditing ? (
                    <button
                      type="button"
                      onClick={() => void handleMemoryCandidateAction(candidate, 'edit-accept')}
                      disabled={isBusy}
                      className="soft-button soft-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('settings.memoryCandidateEditAccept')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingMemoryCandidateId(candidate.id);
                        setMemoryCandidateEdits(prev => ({ ...prev, [candidate.id]: content }));
                      }}
                      disabled={isBusy}
                      className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('common.edit')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleMemoryCandidateAction(candidate, 'ignore')}
                    disabled={isBusy}
                    className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('settings.memoryCandidateIgnore')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleMemoryCandidateAction(candidate, 'discard')}
                    disabled={isBusy}
                    className="soft-button soft-button-danger px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('settings.memoryCandidateDiscard')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
