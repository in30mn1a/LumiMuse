import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { expectOkResponse, getErrorMessage, parseJsonResponse } from '@/lib/http';
import type { ToastType } from '@/components/ui/Toast';

export interface MemoryCandidate {
  id: number;
  character_id: string;
  conversation_id: string | null;
  raw_candidate: Record<string, unknown>;
  error_reason: string | null;
  created_at: string;
}

interface UseMemoryCandidatesPanelOptions {
  characterId: string;
  memoryManagementCharacterIdRef: MutableRefObject<string>;
  t: (key: string) => string;
  showToast: (message: string, type?: ToastType) => void;
  loadMemoryDiagnostics: () => Promise<void> | void;
  loadMemoryIndexStatus: () => Promise<void> | void;
}

export function getCandidateText(candidate: MemoryCandidate, key: string): string {
  const value = candidate.raw_candidate[key];
  return typeof value === 'string' ? value : '';
}

export function getCandidateTags(candidate: MemoryCandidate): string {
  const value = candidate.raw_candidate.tags;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').join(', ');
  return typeof value === 'string' ? value : '';
}

export function useMemoryCandidatesPanel({
  characterId: selectedCharacterId,
  memoryManagementCharacterIdRef,
  t,
  showToast,
  loadMemoryDiagnostics,
  loadMemoryIndexStatus,
}: UseMemoryCandidatesPanelOptions) {
  const [memoryCandidates, setMemoryCandidates] = useState<MemoryCandidate[]>([]);
  const [memoryCandidatesLoading, setMemoryCandidatesLoading] = useState(false);
  const [memoryCandidatesError, setMemoryCandidatesError] = useState<string | null>(null);
  const [memoryCandidateActionId, setMemoryCandidateActionId] = useState<number | null>(null);
  const [editingMemoryCandidateId, setEditingMemoryCandidateId] = useState<number | null>(null);
  const [memoryCandidateEdits, setMemoryCandidateEdits] = useState<Record<number, string>>({});
  const memoryCandidatesRequestSeqRef = useRef(0);
  const memoryCandidateActionRequestSeqRef = useRef(0);

  const isCurrentMemoryCandidatesRequest = useCallback((requestedCharacterId: string, requestSeq: number) => (
    memoryManagementCharacterIdRef.current === requestedCharacterId
      && requestSeq === memoryCandidatesRequestSeqRef.current
  ), [memoryManagementCharacterIdRef]);

  const isCurrentMemoryCandidateActionRequest = useCallback((requestedCharacterId: string, requestSeq: number) => (
    memoryManagementCharacterIdRef.current === requestedCharacterId
      && requestSeq === memoryCandidateActionRequestSeqRef.current
  ), [memoryManagementCharacterIdRef]);

  const loadMemoryCandidates = useCallback(async (nextCharacterId = selectedCharacterId) => {
    if (!nextCharacterId) {
      memoryCandidatesRequestSeqRef.current += 1;
      setMemoryCandidates([]);
      setMemoryCandidatesError(null);
      setMemoryCandidatesLoading(false);
      return;
    }

    const characterId = nextCharacterId;
    if (memoryManagementCharacterIdRef.current !== characterId) return;

    const requestSeq = ++memoryCandidatesRequestSeqRef.current;
    setMemoryCandidatesLoading(true);
    setMemoryCandidatesError(null);
    try {
      const data = await parseJsonResponse<{ candidates?: MemoryCandidate[] }>(
        await fetch(`/api/memory-candidates?character_id=${encodeURIComponent(characterId)}&limit=50`),
      );
      if (!isCurrentMemoryCandidatesRequest(characterId, requestSeq)) return;
      setMemoryCandidates(data.candidates || []);
    } catch (err) {
      if (!isCurrentMemoryCandidatesRequest(characterId, requestSeq)) return;
      setMemoryCandidatesError(getErrorMessage(err));
    } finally {
      if (isCurrentMemoryCandidatesRequest(characterId, requestSeq)) {
        setMemoryCandidatesLoading(false);
      }
    }
  }, [isCurrentMemoryCandidatesRequest, memoryManagementCharacterIdRef, selectedCharacterId]);

  const handleMemoryCandidateAction = async (
    candidate: MemoryCandidate,
    action: 'accept' | 'edit-accept' | 'ignore' | 'discard',
  ) => {
    const requestedCharacterId = candidate.character_id;
    if (memoryManagementCharacterIdRef.current !== requestedCharacterId) return;

    if (action === 'edit-accept') {
      const content = (memoryCandidateEdits[candidate.id] ?? getCandidateText(candidate, 'content')).trim();
      if (!content) {
        showToast(t('settings.memoryCandidatesEmptyContent'), 'error');
        return;
      }
    }

    const requestSeq = ++memoryCandidateActionRequestSeqRef.current;
    setMemoryCandidateActionId(candidate.id);
    try {
      const body: Record<string, unknown> = {
        action: action === 'edit-accept' ? 'accept' : action,
      };
      if (action === 'edit-accept') {
        body.memory = {
          content: (memoryCandidateEdits[candidate.id] ?? getCandidateText(candidate, 'content')).trim(),
        };
      }
      await expectOkResponse(await fetch(`/api/memory-candidates/${candidate.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      if (!isCurrentMemoryCandidateActionRequest(requestedCharacterId, requestSeq)) return;
      setEditingMemoryCandidateId(null);
      setMemoryCandidateEdits(prev => {
        const next = { ...prev };
        delete next[candidate.id];
        return next;
      });
      await loadMemoryCandidates(requestedCharacterId);
      if (!isCurrentMemoryCandidateActionRequest(requestedCharacterId, requestSeq)) return;
      await loadMemoryDiagnostics();
      if (!isCurrentMemoryCandidateActionRequest(requestedCharacterId, requestSeq)) return;
      await loadMemoryIndexStatus();
    } catch (err) {
      if (!isCurrentMemoryCandidateActionRequest(requestedCharacterId, requestSeq)) return;
      showToast(`${t('settings.memoryCandidatesActionFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      if (isCurrentMemoryCandidateActionRequest(requestedCharacterId, requestSeq)) {
        setMemoryCandidateActionId(null);
      }
    }
  };

  return {
    memoryCandidates,
    memoryCandidatesLoading,
    memoryCandidatesError,
    memoryCandidateActionId,
    editingMemoryCandidateId,
    memoryCandidateEdits,
    setEditingMemoryCandidateId,
    setMemoryCandidateEdits,
    loadMemoryCandidates,
    handleMemoryCandidateAction,
  };
}

export type UseMemoryCandidatesPanelResult = ReturnType<typeof useMemoryCandidatesPanel>;
