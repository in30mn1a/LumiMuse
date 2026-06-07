import { formatTemplate } from '@/lib/i18n';
import { RefreshIcon, TrashIcon } from '@/components/ui/icons';
import type { UseMemoryManagementCharactersResult } from '@/hooks/settings/useMemoryManagementCharacters';
import type { UseMemoryProfilePanelResult } from '@/hooks/settings/useMemoryProfilePanel';

interface MemoryProfilePanelProps {
  t: (key: string) => string;
  management: UseMemoryManagementCharactersResult;
  profile: UseMemoryProfilePanelResult;
  onCharacterChange: (characterId: string) => void;
}

export function MemoryProfilePanel({
  t,
  management,
  profile,
  onCharacterChange,
}: MemoryProfilePanelProps) {
  const memoryProfile = profile.memoryProfile;
  const memoryManagementCharacterId = management.memoryManagementCharacterId;
  const memoryProfileLoading = profile.memoryProfileLoading;
  const memoryProfileActionLoading = profile.memoryProfileActionLoading;
  const editingProfileDraft = profile.editingProfileDraft;
  const setEditingProfileDraft = profile.setEditingProfileDraft;

  return (
    <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
      <div className="mb-3">
        <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryProfileTitle')}</h3>
        <p className="mt-1 text-xs text-text-muted">{t('settings.memoryProfileHint')}</p>
      </div>
      <div className="mb-3">
        <label className="mb-1.5 block text-sm font-medium text-text-secondary">
          {t('settings.memoryManagementCharacter')}
        </label>
        <select
          value={memoryManagementCharacterId}
          onChange={e => onCharacterChange(e.target.value)}
          disabled={management.memoryManagementLoading}
          className="select-rich"
        >
          <option value="">{t('settings.memoryManagementChooseCharacter')}</option>
          {management.memoryManagementCharacters.map(character => (
            <option key={character.id} value={character.id}>{character.name || character.id}</option>
          ))}
        </select>
        {management.memoryManagementError && (
          <p className="mt-2 text-xs text-red-500">{t('common.loadFailed')}: {management.memoryManagementError}</p>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <button
          type="button"
          onClick={() => void profile.loadMemoryProfile(memoryManagementCharacterId)}
          disabled={memoryProfileLoading || !memoryManagementCharacterId}
          className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {memoryProfileLoading ? (
            <span className="spinner-sm" aria-hidden="true" />
          ) : (
            <RefreshIcon className="h-3.5 w-3.5" />
          )}
          {memoryProfileLoading ? t('common.loading') : t('settings.memoryCandidatesRefresh')}
        </button>
        <button
          type="button"
          onClick={() => void profile.handleMemoryProfileAction('init_from_memories')}
          disabled={memoryProfileActionLoading || !memoryManagementCharacterId}
          className="soft-button soft-button-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('settings.memoryProfileInitFromMemories')}
        </button>
      </div>
      {profile.memoryProfileError && (
        <p className="mt-3 text-xs text-red-500">{profile.memoryProfileError}</p>
      )}
      {memoryProfile && !profile.editingProfile && (
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2 text-xs text-text-secondary md:col-span-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-text-primary">{t('settings.memoryProfileCurrent')}</span>
                <span className="ml-2 text-text-muted">
                  {memoryProfile.profile?.profile_name?.trim() || memoryProfile.profile?.character_id || t('common.empty')}
                </span>
              </div>
              <button
                type="button"
                onClick={profile.startEditingProfile}
                disabled={memoryProfileActionLoading || !memoryProfile.profile}
                className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('common.edit')}
              </button>
            </div>
            <p className="mt-1 whitespace-pre-wrap leading-relaxed">
              {[
                memoryProfile.profile?.relationship_state && formatTemplate(t('settings.memoryProfileDisplayRelationship'), { value: memoryProfile.profile.relationship_state }),
                memoryProfile.profile?.recent_story_state && formatTemplate(t('settings.memoryProfileDisplayStory'), { value: memoryProfile.profile.recent_story_state }),
                memoryProfile.profile?.emotional_baseline && formatTemplate(t('settings.memoryProfileDisplayEmotion'), { value: memoryProfile.profile.emotional_baseline }),
                (() => { const p = memoryProfile.profile; const threads = p?.open_threads; return threads && threads.length > 0 ? formatTemplate(t('settings.memoryProfileDisplayThreads'), { value: threads.join('；') }) : ''; })(),
                memoryProfile.profile?.user_profile_summary && formatTemplate(t('settings.memoryProfileDisplayUser'), { value: memoryProfile.profile.user_profile_summary }),
                memoryProfile.profile?.pinned_summary && formatTemplate(t('settings.memoryProfileDisplayPinned'), { value: memoryProfile.profile.pinned_summary }),
              ].filter(Boolean).join('\n') || t('settings.memoryProfileEmpty')}
            </p>
          </div>
          <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2 text-xs text-text-secondary">
            <div className="space-y-1">
              {memoryProfile.versions.map(version => {
                const versionName = version.snapshot?.profile_name?.trim();
                const versionLabel = versionName || `v${version.version_number}`;
                return (
                  <div
                    key={version.id}
                    className="flex items-stretch gap-1 rounded-lg border border-border-light bg-white/70"
                  >
                    <button
                      type="button"
                      onClick={() => void profile.handleMemoryProfileRollback(version.id)}
                      disabled={memoryProfileActionLoading}
                      className="min-w-0 flex-1 px-2 py-1 text-left text-xs text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="block truncate">{t('settings.memoryProfileRollback')} {versionLabel}</span>
                      <span className="block truncate text-[11px] text-text-muted">
                        {versionName ? `v${version.version_number} · ${version.reason}` : version.reason}
                      </span>
                    </button>
                    <button
                      type="button"
                      title={t('settings.memoryProfileDeleteVersion')}
                      aria-label={t('settings.memoryProfileDeleteVersion')}
                      onClick={() => void profile.handleMemoryProfileDeleteVersion(version.id)}
                      disabled={memoryProfileActionLoading}
                      className="flex w-8 shrink-0 items-center justify-center border-l border-border-light text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {memoryProfile && profile.editingProfile && (
        <div className="mt-3 rounded-xl border border-border-light bg-white/60 px-3 py-2 text-xs text-text-secondary">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-text-primary">{t('settings.memoryProfileEditTitle')}</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void profile.saveEditingProfile()}
                disabled={memoryProfileActionLoading}
                className="soft-button soft-button-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('common.save')}
              </button>
              <button
                type="button"
                onClick={profile.cancelEditingProfile}
                disabled={memoryProfileActionLoading}
                className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {[
              { key: 'profile_name', label: t('settings.memoryProfileFieldName'), singleLine: true },
              { key: 'relationship_state', label: t('settings.memoryProfileFieldRelationship') },
              { key: 'recent_story_state', label: t('settings.memoryProfileFieldStory') },
              { key: 'emotional_baseline', label: t('settings.memoryProfileFieldEmotion') },
              { key: 'user_profile_summary', label: t('settings.memoryProfileFieldUser') },
              { key: 'pinned_summary', label: t('settings.memoryProfileFieldPinned') },
              { key: 'open_threads', label: t('settings.memoryProfileFieldThreads'), rows: 3 },
            ].map(({ key, label, rows, singleLine }) => (
              <div key={key} className={key === 'open_threads' || key === 'pinned_summary' ? 'md:col-span-2' : ''}>
                <label className="mb-1 block font-medium text-text-primary">{label}</label>
                {singleLine ? (
                  <input
                    value={editingProfileDraft[key] ?? ''}
                    onChange={e => setEditingProfileDraft(prev => ({ ...prev, [key]: e.target.value }))}
                    className="input-rich w-full rounded-lg border border-border-light bg-white/80 px-2 py-1.5 text-xs"
                  />
                ) : (
                  <textarea
                    value={editingProfileDraft[key] ?? ''}
                    onChange={e => setEditingProfileDraft(prev => ({ ...prev, [key]: e.target.value }))}
                    rows={rows ?? 2}
                    className="textarea-rich w-full resize-none rounded-lg border border-border-light bg-white/80 px-2 py-1.5 text-xs"
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
