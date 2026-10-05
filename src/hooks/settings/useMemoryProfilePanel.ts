import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { HttpResponseError, expectOkResponse, getErrorMessage, parseJsonResponse } from '@/lib/http';
import type { ToastType } from '@/components/ui/Toast';

export interface MemoryProfileResponse {
  profile: {
    character_id: string;
    profile_name: string;
    relationship_state: string;
    recent_story_state: string;
    emotional_baseline: string;
    open_threads: string[];
    user_profile_summary: string;
    pinned_summary: string;
    updated_at: string;
  } | null;
  versions: Array<{
    id: number;
    version_number: number;
    snapshot: { profile_name?: string };
    reason: string;
    created_at: string;
  }>;
  tasks: Array<{ id: number; reason: string; status: string; retry_count: number; error_message: string | null }>;
}

interface MemoryProfileActionResponse {
  ok: boolean;
  error?: string;
  detail?: string;
  status?: string;
  created?: boolean;
  already_exists?: boolean;
  processed?: number;
  skipped?: number;
  failed?: number;
  remaining?: number;
  no_pending_tasks?: boolean;
  memory_count?: number;
}

interface UseMemoryProfilePanelOptions {
  characterId: string;
  memoryManagementCharacterIdRef: MutableRefObject<string>;
  loadMemoryDiagnostics: () => Promise<void> | void;
  t: (key: string) => string;
  showToast: (message: string, type?: ToastType) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function useMemoryProfilePanel({
  characterId: selectedCharacterId,
  memoryManagementCharacterIdRef,
  loadMemoryDiagnostics,
  t,
  showToast,
}: UseMemoryProfilePanelOptions) {
  const [memoryProfile, setMemoryProfile] = useState<MemoryProfileResponse | null>(null);
  const [loadingCharacterId, setLoadingCharacterId] = useState<string | null>(null);
  const memoryProfileLoading = loadingCharacterId === selectedCharacterId.trim();
  const [memoryProfileActionLoading, setMemoryProfileActionLoading] = useState(false);
  const [memoryProfileError, setMemoryProfileError] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingProfileDraft, setEditingProfileDraft] = useState<Record<string, string>>({});
  const memoryProfileRequestSeqRef = useRef(0);
  const [profileCharacterId, setProfileCharacterId] = useState(selectedCharacterId);
  if (profileCharacterId !== selectedCharacterId) {
    setProfileCharacterId(selectedCharacterId);
    setMemoryProfileActionLoading(false);
  }
  const scopeRef = useRef({ characterId: selectedCharacterId.trim() });
  const actionSeqRef = useRef(0);
  // 选择角色时可在 React 提交前发起加载；请求与提交必须使用同一角色作用域。
  const syncScope = useCallback((characterId: string) => {
    if (scopeRef.current.characterId !== characterId) scopeRef.current = { characterId };
    return scopeRef.current;
  }, []);
  useLayoutEffect(() => {
    syncScope(selectedCharacterId.trim());
  }, [selectedCharacterId, syncScope]);
  useLayoutEffect(() => () => {
    scopeRef.current = { characterId: scopeRef.current.characterId };
  }, []);

  const beginAction = (characterId: string) => {
    const scope = syncScope(characterId);
    const actionSeq = ++actionSeqRef.current;
    return () => scope === scopeRef.current
      && actionSeq === actionSeqRef.current
      && memoryManagementCharacterIdRef.current.trim() === characterId;
  };

  const resetProfile = useCallback(() => {
    setMemoryProfile(null);
    setMemoryProfileError(null);
    setEditingProfile(false);
    setEditingProfileDraft({});
  }, []);

  const loadMemoryProfile = useCallback(async (nextCharacterId: string) => {
    const trimmed = nextCharacterId.trim();
    if (!trimmed) {
      setMemoryProfileError(t('settings.memoryProfileCharacterRequired'));
      return;
    }

    if (memoryManagementCharacterIdRef.current.trim() !== trimmed) return;
    const scope = syncScope(trimmed);
    setLoadingCharacterId(trimmed);
    setMemoryProfileError(null);
    memoryProfileRequestSeqRef.current += 1;
    const requestSeq = memoryProfileRequestSeqRef.current;
    try {
      const data = await parseJsonResponse<MemoryProfileResponse>(
        await fetch('/api/memory-profile?character_id=' + encodeURIComponent(trimmed)),
      );
      if (scope !== scopeRef.current || memoryManagementCharacterIdRef.current.trim() !== trimmed || requestSeq !== memoryProfileRequestSeqRef.current) return;
      setMemoryProfile(data);
    } catch (err) {
      if (scope !== scopeRef.current || memoryManagementCharacterIdRef.current.trim() !== trimmed || requestSeq !== memoryProfileRequestSeqRef.current) return;
      setMemoryProfileError(getErrorMessage(err));
    } finally {
      if (scope === scopeRef.current && memoryManagementCharacterIdRef.current.trim() === trimmed && requestSeq === memoryProfileRequestSeqRef.current) {
        setLoadingCharacterId(null);
      }
    }
  }, [memoryManagementCharacterIdRef, syncScope, t]);

  const handleMemoryProfileAction = async (action: 'init_from_memories') => {
    const characterId = selectedCharacterId.trim();
    if (!characterId) {
      setMemoryProfileError(t('settings.memoryProfileCharacterRequired'));
      return;
    }

    const isCurrent = beginAction(characterId);
    setMemoryProfileActionLoading(true);
    setMemoryProfileError(null);
    showToast(t('settings.memoryProfileInitFromMemoriesStarted'), 'success');
    try {
      const body: Record<string, unknown> = { action, character_id: characterId };
      const response = await fetch('/api/memory-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await parseJsonResponse<unknown>(response);
      if (!isRecord(data) || data.ok !== true) {
        throw new HttpResponseError('Invalid memory profile action response', response.status, data);
      }
      if (!isCurrent()) return;
      const result = data as unknown as MemoryProfileActionResponse;
      if (characterId) await loadMemoryProfile(characterId);
      if (!isCurrent()) return;
      await loadMemoryDiagnostics();
      if (!isCurrent()) return;
      setEditingProfile(false);
      setEditingProfileDraft({});
      if (result.status === 'no_changes') {
        showToast(t('settings.memoryProfileInitFromMemoriesNoChanges'), 'info');
        return;
      }
      showToast(t('settings.memoryProfileInitFromMemoriesDone').replace('{count}', String(result.memory_count ?? 0)), 'success');
    } catch (err) {
      if (!isCurrent()) return;
      if (
        err instanceof HttpResponseError
        && isRecord(err.data)
        && err.data.error === 'no_active_memories'
      ) {
        if (characterId) await loadMemoryProfile(characterId);
        if (!isCurrent()) return;
        await loadMemoryDiagnostics();
        if (!isCurrent()) return;
        showToast(t('settings.memoryProfileInitFromMemoriesNoMemories'), 'error');
        return;
      }
      showToast(`${t('settings.memoryProfileActionFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      if (isCurrent()) setMemoryProfileActionLoading(false);
    }
  };

  const handleMemoryProfileRollback = async (versionId: number) => {
    const characterId = selectedCharacterId.trim();
    if (!characterId) {
      setMemoryProfileError(t('settings.memoryProfileCharacterRequired'));
      return;
    }

    const isCurrent = beginAction(characterId);
    setMemoryProfileActionLoading(true);
    setMemoryProfileError(null);
    try {
      await expectOkResponse(await fetch('/api/memory-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rollback', character_id: characterId, version_id: versionId }),
      }));
      if (!isCurrent()) return;
      await loadMemoryProfile(characterId);
      if (!isCurrent()) return;
      await loadMemoryDiagnostics();
      if (!isCurrent()) return;
    } catch (err) {
      if (!isCurrent()) return;
      showToast(`${t('settings.memoryProfileActionFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      if (isCurrent()) setMemoryProfileActionLoading(false);
    }
  };

  const handleMemoryProfileDeleteVersion = async (versionId: number) => {
    const characterId = selectedCharacterId.trim();
    if (!characterId) {
      setMemoryProfileError(t('settings.memoryProfileCharacterRequired'));
      return;
    }
    if (!window.confirm(t('settings.memoryProfileDeleteVersionConfirm'))) return;

    const isCurrent = beginAction(characterId);
    setMemoryProfileActionLoading(true);
    setMemoryProfileError(null);
    try {
      const result = await parseJsonResponse<{ ok: boolean; deleted?: boolean }>(await fetch('/api/memory-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_version', character_id: characterId, version_id: versionId }),
      }));
      if (!isCurrent()) return;
      if (result.deleted) showToast(t('settings.memoryProfileVersionDeleted'), 'success');
      if (!isCurrent()) return;
      await loadMemoryProfile(characterId);
      if (!isCurrent()) return;
      await loadMemoryDiagnostics();
      if (!isCurrent()) return;
    } catch (err) {
      if (!isCurrent()) return;
      showToast(`${t('settings.memoryProfileActionFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      if (isCurrent()) setMemoryProfileActionLoading(false);
    }
  };

  const startEditingProfile = () => {
    if (!memoryProfile?.profile) return;
    const p = memoryProfile.profile;
    setEditingProfileDraft({
      profile_name: p.profile_name ?? '',
      relationship_state: p.relationship_state ?? '',
      recent_story_state: p.recent_story_state ?? '',
      emotional_baseline: p.emotional_baseline ?? '',
      user_profile_summary: p.user_profile_summary ?? '',
      pinned_summary: p.pinned_summary ?? '',
      open_threads: Array.isArray(p.open_threads) ? p.open_threads.join('\n') : '',
    });
    setEditingProfile(true);
  };

  const cancelEditingProfile = () => {
    setEditingProfile(false);
    setEditingProfileDraft({});
  };

  const saveEditingProfile = async () => {
    const characterId = selectedCharacterId.trim();
    if (!characterId) return;
    if (!memoryProfile?.profile) return;
    const currentProfile = memoryProfile.profile;

    const isCurrent = beginAction(characterId);
    setMemoryProfileActionLoading(true);
    setMemoryProfileError(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of [
        'profile_name',
        'relationship_state',
        'recent_story_state',
        'emotional_baseline',
        'user_profile_summary',
        'pinned_summary',
      ] as const) {
        const trimmedValue = String(editingProfileDraft[key] ?? '').trim();
        if (trimmedValue !== (currentProfile[key] ?? '').trim()) {
          patch[key] = trimmedValue;
        }
      }
      const threads = String(editingProfileDraft.open_threads ?? '').split('\n').map(s => s.trim()).filter(Boolean);
      const currentThreads = Array.isArray(currentProfile.open_threads) ? currentProfile.open_threads : [];
      if (threads.join('\n') !== currentThreads.join('\n')) {
        patch.open_threads = threads;
      }

      if (Object.keys(patch).length === 0) {
        showToast(t('settings.memoryProfileEditNoChanges'), 'info');
        if (isCurrent()) setMemoryProfileActionLoading(false);
        return;
      }

      await expectOkResponse(await fetch('/api/memory-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enqueue',
          character_id: characterId,
          patch,
          reason: 'manual_edit',
        }),
      }));

      if (!isCurrent()) return;
      setEditingProfile(false);
      setEditingProfileDraft({});
      showToast(t('settings.memoryProfileEditSaved'), 'success');
      if (!isCurrent()) return;
      await loadMemoryProfile(characterId);
      if (!isCurrent()) return;
      await loadMemoryDiagnostics();
      if (!isCurrent()) return;
    } catch (err) {
      if (!isCurrent()) return;
      showToast(`${t('settings.memoryProfileActionFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      if (isCurrent()) setMemoryProfileActionLoading(false);
    }
  };

  return {
    memoryProfile,
    memoryProfileLoading,
    memoryProfileActionLoading,
    memoryProfileError,
    editingProfile,
    editingProfileDraft,
    setEditingProfileDraft,
    resetProfile,
    loadMemoryProfile,
    handleMemoryProfileAction,
    handleMemoryProfileRollback,
    handleMemoryProfileDeleteVersion,
    startEditingProfile,
    cancelEditingProfile,
    saveEditingProfile,
  };
}

export type UseMemoryProfilePanelResult = ReturnType<typeof useMemoryProfilePanel>;
