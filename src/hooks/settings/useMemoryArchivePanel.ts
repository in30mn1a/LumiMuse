import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { HttpResponseError, expectOkResponse, getErrorMessage, parseJsonResponse } from '@/lib/http';
import type { ToastType } from '@/components/ui/Toast';

export interface MemoryArchiveSelectableMemory {
  id: string;
  category: string;
  content: string;
  status: string;
  pinned: boolean;
  updated_at: string;
}

export interface MemoryArchiveBatch {
  batch_id: string;
  summary_memory_id: string | null;
  summary_content: string;
  covered_count: number;
  updated_at: string;
}

export interface MemoryArchivePlan {
  summaryMemory: { id: string; content: string };
  coveredMemoryUpdates: Array<{ id: string; status: string }>;
}

interface MemoryArchiveBatchDetail {
  covered: Array<{ id: string; category: string; content: string; status: string }>;
  summary: { id: string; content: string } | null;
}

interface MemoryArchiveAiResponse {
  ok: true;
  status?: string;
  archive_count?: number;
  summary?: string;
  message?: string;
  batch_id?: string;
  plan?: MemoryArchivePlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseMemoryArchiveAiResponse(response: Response, data: unknown): MemoryArchiveAiResponse {
  if (!isRecord(data) || data.ok !== true) {
    throw new HttpResponseError('Invalid memory archive AI response', response.status, data);
  }
  return data as unknown as MemoryArchiveAiResponse;
}

function parseMemoryArchiveBatchDetail(response: Response, data: unknown): MemoryArchiveBatchDetail {
  const summary = isRecord(data) ? data.summary : undefined;
  if (
    !isRecord(data)
    || data.ok !== true
    || !Array.isArray(data.covered)
    || !(summary === null || (isRecord(summary) && typeof summary.id === 'string' && typeof summary.content === 'string'))
  ) {
    throw new HttpResponseError('Invalid memory archive batch detail response', response.status, data);
  }
  return data as unknown as MemoryArchiveBatchDetail;
}

interface UseMemoryArchivePanelOptions {
  characterId: string;
  memoryManagementCharacterIdRef: MutableRefObject<string>;
  loadMemoryDiagnostics: () => Promise<void> | void;
  loadMemoryIndexStatus: () => Promise<void> | void;
  t: (key: string) => string;
  showToast: (message: string, type?: ToastType) => void;
}

const MEMORY_ARCHIVE_MEMORY_LIMIT = 200;

export function useMemoryArchivePanel({
  characterId: selectedCharacterId,
  memoryManagementCharacterIdRef,
  loadMemoryDiagnostics,
  loadMemoryIndexStatus,
  t,
  showToast,
}: UseMemoryArchivePanelOptions) {
  const [memoryArchiveMemories, setMemoryArchiveMemories] = useState<MemoryArchiveSelectableMemory[]>([]);
  const [selectedMemoryArchiveIds, setSelectedMemoryArchiveIds] = useState<string[]>([]);
  const [memoryArchiveSummary, setMemoryArchiveSummary] = useState('');
  const [memoryArchiveBatches, setMemoryArchiveBatches] = useState<MemoryArchiveBatch[]>([]);
  const [selectedMemoryArchiveBatchId, setSelectedMemoryArchiveBatchId] = useState('');
  const [memoryArchivePlan, setMemoryArchivePlan] = useState<MemoryArchivePlan | null>(null);
  const [memoryArchiveBatchDetail, setMemoryArchiveBatchDetail] = useState<MemoryArchiveBatchDetail | null>(null);
  const [memoryArchiveLoading, setMemoryArchiveLoading] = useState(false);
  const [memoryArchiveListLoading, setMemoryArchiveListLoading] = useState(false);
  const [memoryArchiveHasMore, setMemoryArchiveHasMore] = useState(false);
  const [memoryArchiveTotal, setMemoryArchiveTotal] = useState(0);
  const [memoryArchiveOffset, setMemoryArchiveOffset] = useState(0);
  const [memoryArchiveError, setMemoryArchiveError] = useState<string | null>(null);
  const [memoryArchiveAiRunning, setMemoryArchiveAiRunning] = useState(false);
  const memoryArchiveRequestSeqRef = useRef(0);
  const memoryArchiveBatchRequestSeqRef = useRef(0);
  const memoryArchiveActionRequestSeqRef = useRef(0);
  const memoryArchiveDetailRequestSeqRef = useRef(0);
  const memoryArchiveAiControllerRef = useRef<AbortController | null>(null);

  const isCurrentMemoryArchiveActionRequest = (requestedCharacterId: string, requestSeq: number) => (
    memoryManagementCharacterIdRef.current === requestedCharacterId
      && requestSeq === memoryArchiveActionRequestSeqRef.current
  );

  const isCurrentMemoryArchiveDetailRequest = (requestedCharacterId: string, requestSeq: number) => (
    memoryManagementCharacterIdRef.current === requestedCharacterId
      && requestSeq === memoryArchiveDetailRequestSeqRef.current
  );

  const isCurrentMemoryArchiveAiRequest = (
    requestedCharacterId: string,
    requestSeq: number,
    controller: AbortController,
  ) => (
    isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)
      && memoryArchiveAiControllerRef.current === controller
      && !controller.signal.aborted
  );

  const resetArchiveForCharacterChange = useCallback(() => {
    const aiController = memoryArchiveAiControllerRef.current;
    if (aiController && !aiController.signal.aborted) aiController.abort();
    memoryArchiveAiControllerRef.current = null;
    memoryArchiveRequestSeqRef.current += 1;
    memoryArchiveBatchRequestSeqRef.current += 1;
    memoryArchiveActionRequestSeqRef.current += 1;
    memoryArchiveDetailRequestSeqRef.current += 1;
    setMemoryArchiveMemories([]);
    setSelectedMemoryArchiveIds([]);
    setMemoryArchiveBatches([]);
    setSelectedMemoryArchiveBatchId('');
    setMemoryArchivePlan(null);
    setMemoryArchiveBatchDetail(null);
    setMemoryArchiveLoading(false);
    setMemoryArchiveListLoading(false);
    setMemoryArchiveHasMore(false);
    setMemoryArchiveTotal(0);
    setMemoryArchiveOffset(0);
    setMemoryArchiveError(null);
    setMemoryArchiveAiRunning(false);
  }, []);

  const loadMemoryArchiveMemories = useCallback(async (nextCharacterId: string, options: { append?: boolean; offset?: number } = {}) => {
    const append = options.append === true;
    if (!nextCharacterId) {
      memoryArchiveRequestSeqRef.current += 1;
      setMemoryArchiveMemories([]);
      setSelectedMemoryArchiveIds([]);
      setMemoryArchiveHasMore(false);
      setMemoryArchiveTotal(0);
      setMemoryArchiveOffset(0);
      setMemoryArchivePlan(null);
      setMemoryArchiveError(null);
      setMemoryArchiveLoading(false);
      setMemoryArchiveListLoading(false);
      return;
    }

    const characterId = nextCharacterId;
    if (memoryManagementCharacterIdRef.current !== characterId) return;

    const memoryArchiveNextOffset = append ? options.offset ?? 0 : 0;
    memoryArchiveRequestSeqRef.current += 1;
    const requestSeq = memoryArchiveRequestSeqRef.current;
    setMemoryArchiveListLoading(true);
    try {
      const data = await parseJsonResponse<{
        memories?: MemoryArchiveSelectableMemory[];
        total?: number;
        hasMore?: boolean;
        offset?: number;
      }>(
        await fetch(`/api/memories?character_id=${encodeURIComponent(characterId)}&status=active&exclude_archive_summary=1&limit=${MEMORY_ARCHIVE_MEMORY_LIMIT}&offset=${memoryArchiveNextOffset}`),
      );
      if (memoryManagementCharacterIdRef.current !== characterId || requestSeq !== memoryArchiveRequestSeqRef.current) return;
      const memories = data.memories || [];
      setMemoryArchiveMemories(prev => (append ? [...prev, ...memories] : memories));
      setMemoryArchiveHasMore(Boolean(data.hasMore));
      setMemoryArchiveTotal(data.total ?? memories.length);
      setMemoryArchiveOffset((data.offset ?? memoryArchiveNextOffset) + memories.length);
    } catch (err) {
      if (memoryManagementCharacterIdRef.current !== characterId || requestSeq !== memoryArchiveRequestSeqRef.current) return;
      setMemoryArchiveError(getErrorMessage(err));
      if (!append) {
        setMemoryArchiveMemories([]);
        setMemoryArchiveHasMore(false);
        setMemoryArchiveTotal(0);
        setMemoryArchiveOffset(0);
      }
    } finally {
      if (memoryManagementCharacterIdRef.current === characterId && requestSeq === memoryArchiveRequestSeqRef.current) {
        setMemoryArchiveListLoading(false);
      }
    }
  }, [memoryManagementCharacterIdRef]);

  const loadMemoryArchiveBatches = useCallback(async (nextCharacterId: string) => {
    if (!nextCharacterId) {
      memoryArchiveBatchRequestSeqRef.current += 1;
      setMemoryArchiveBatches([]);
      return;
    }

    const characterId = nextCharacterId;
    memoryArchiveBatchRequestSeqRef.current += 1;
    const requestSeq = memoryArchiveBatchRequestSeqRef.current;
    try {
      const data = await parseJsonResponse<{ batches?: MemoryArchiveBatch[] }>(
        await fetch(`/api/memory-archive?character_id=${encodeURIComponent(characterId)}`),
      );
      if (memoryManagementCharacterIdRef.current !== characterId || requestSeq !== memoryArchiveBatchRequestSeqRef.current) return;
      const batches = data.batches || [];
      setMemoryArchiveBatches(batches);
      setSelectedMemoryArchiveBatchId(prev => (
        prev && batches.some(batch => batch.batch_id === prev) ? prev : batches[0]?.batch_id || ''
      ));
    } catch (err) {
      if (memoryManagementCharacterIdRef.current !== characterId || requestSeq !== memoryArchiveBatchRequestSeqRef.current) return;
      setMemoryArchiveError(getErrorMessage(err));
      setMemoryArchiveBatches([]);
      setSelectedMemoryArchiveBatchId('');
    }
  }, [memoryManagementCharacterIdRef]);

  const toggleMemoryArchiveSelection = (memoryId: string) => {
    setSelectedMemoryArchiveIds(prev => (
      prev.includes(memoryId)
        ? prev.filter(id => id !== memoryId)
        : [...prev, memoryId]
    ));
    setMemoryArchivePlan(null);
  };

  const buildMemoryArchiveBody = (action: 'preview' | 'execute') => {
    const characterId = selectedCharacterId.trim();
    const summaryContent = memoryArchiveSummary.trim();
    if (!characterId || selectedMemoryArchiveIds.length === 0 || !summaryContent) return null;
    return {
      action,
      character_id: characterId,
      covered_memory_ids: selectedMemoryArchiveIds,
      summary_content: summaryContent,
    };
  };

  const handleMemoryArchivePreview = async () => {
    const body = buildMemoryArchiveBody('preview');
    if (!body) {
      setMemoryArchiveError(t('settings.memoryArchiveRequired'));
      return;
    }
    const requestedCharacterId = body.character_id;
    memoryArchiveActionRequestSeqRef.current += 1;
    const requestSeq = memoryArchiveActionRequestSeqRef.current;

    setMemoryArchiveLoading(true);
    setMemoryArchiveError(null);
    try {
      const data = await parseJsonResponse<{ plan: MemoryArchivePlan }>(await fetch('/api/memory-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      setMemoryArchivePlan(data.plan);
    } catch (err) {
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      setMemoryArchiveError(getErrorMessage(err));
    } finally {
      if (isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) {
        setMemoryArchiveLoading(false);
      }
    }
  };

  const handleMemoryArchiveExecute = async () => {
    const body = buildMemoryArchiveBody('execute');
    if (!body) {
      setMemoryArchiveError(t('settings.memoryArchiveRequired'));
      return;
    }
    const requestedCharacterId = body.character_id;
    memoryArchiveActionRequestSeqRef.current += 1;
    const requestSeq = memoryArchiveActionRequestSeqRef.current;

    setMemoryArchiveLoading(true);
    setMemoryArchiveError(null);
    try {
      const data = await parseJsonResponse<{ plan: MemoryArchivePlan }>(await fetch('/api/memory-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      setMemoryArchivePlan(data.plan);
      setSelectedMemoryArchiveIds([]);
      await loadMemoryDiagnostics();
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      await loadMemoryIndexStatus();
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      await loadMemoryArchiveMemories(requestedCharacterId);
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      await loadMemoryArchiveBatches(requestedCharacterId);
    } catch (err) {
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      setMemoryArchiveError(getErrorMessage(err));
    } finally {
      if (isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) {
        setMemoryArchiveLoading(false);
      }
    }
  };

  const handleMemoryArchiveUndo = async () => {
    const characterId = selectedCharacterId.trim();
    const batchId = selectedMemoryArchiveBatchId.trim();
    if (!characterId || !batchId) {
      setMemoryArchiveError(t('settings.memoryArchiveUndoRequired'));
      return;
    }
    const requestedCharacterId = characterId;
    memoryArchiveActionRequestSeqRef.current += 1;
    const requestSeq = memoryArchiveActionRequestSeqRef.current;

    setMemoryArchiveLoading(true);
    setMemoryArchiveError(null);
    try {
      await expectOkResponse(await fetch('/api/memory-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo', character_id: characterId, batch_id: batchId }),
      }));
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      setMemoryArchivePlan(null);
      setSelectedMemoryArchiveBatchId('');
      setMemoryArchiveBatchDetail(null);
      await loadMemoryDiagnostics();
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      await loadMemoryIndexStatus();
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      await loadMemoryArchiveMemories(requestedCharacterId);
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      await loadMemoryArchiveBatches(requestedCharacterId);
    } catch (err) {
      if (!isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) return;
      setMemoryArchiveError(getErrorMessage(err));
    } finally {
      if (isCurrentMemoryArchiveActionRequest(requestedCharacterId, requestSeq)) {
        setMemoryArchiveLoading(false);
      }
    }
  };

  const handleMemoryArchiveAi = async () => {
    const characterId = selectedCharacterId.trim();
    if (!characterId) {
      setMemoryArchiveError(t('settings.memoryArchiveUndoRequired'));
      return;
    }
    const requestedCharacterId = characterId;
    memoryArchiveActionRequestSeqRef.current += 1;
    const requestSeq = memoryArchiveActionRequestSeqRef.current;

    const controller = new AbortController();
    memoryArchiveAiControllerRef.current = controller;
    setMemoryArchiveAiRunning(true);
    setMemoryArchiveLoading(true);
    setMemoryArchiveError(null);
    setMemoryArchivePlan(null);
    try {
      const res = await fetch('/api/memory-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ai_archive', character_id: requestedCharacterId }),
        signal: controller.signal,
      });
      const result = parseMemoryArchiveAiResponse(res, await parseJsonResponse<unknown>(res));

      if (!isCurrentMemoryArchiveAiRequest(requestedCharacterId, requestSeq, controller)) return;

      if (result.status === 'no_archive_needed') {
        showToast(result.message || t('settings.memoryArchiveAiNoArchiveNeeded'), 'success');
        setMemoryArchivePlan(null);
      } else if (result.plan) {
        const count = result.archive_count ?? result.plan.coveredMemoryUpdates.length;
        showToast(t('settings.memoryArchiveAiDone').replace('{count}', String(count)), 'success');
        setMemoryArchivePlan({
          summaryMemory: result.plan.summaryMemory,
          coveredMemoryUpdates: result.plan.coveredMemoryUpdates,
        });
        if (result.summary) setMemoryArchiveSummary(result.summary);
      } else {
        showToast(t('settings.memoryArchiveAiDone')
          .replace('{count}', String(result.archive_count ?? 0)), 'success');
      }

      await loadMemoryDiagnostics();
      if (!isCurrentMemoryArchiveAiRequest(requestedCharacterId, requestSeq, controller)) return;
      await loadMemoryIndexStatus();
      if (!isCurrentMemoryArchiveAiRequest(requestedCharacterId, requestSeq, controller)) return;
      await loadMemoryArchiveMemories(requestedCharacterId);
      if (!isCurrentMemoryArchiveAiRequest(requestedCharacterId, requestSeq, controller)) return;
      await loadMemoryArchiveBatches(requestedCharacterId);
    } catch (err) {
      if (controller.signal.aborted) {
        if (isCurrentMemoryArchiveAiRequest(requestedCharacterId, requestSeq, controller)) setMemoryArchiveError(null);
        return;
      }
      if (!isCurrentMemoryArchiveAiRequest(requestedCharacterId, requestSeq, controller)) return;
      const msg = getErrorMessage(err);
      showToast(err instanceof HttpResponseError ? msg : `${t('settings.memoryArchiveAiFailed')}: ${msg}`, 'error');
      setMemoryArchiveError(msg);
    } finally {
      if (memoryArchiveAiControllerRef.current === controller) {
        memoryArchiveAiControllerRef.current = null;
        setMemoryArchiveAiRunning(false);
        setMemoryArchiveLoading(false);
      }
    }
  };

  const handleStopMemoryArchiveAi = () => {
    const controller = memoryArchiveAiControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    showToast(t('settings.memoryArchiveAiStopping'), 'success');
  };

  const loadMemoryArchiveBatchDetail = async (batchId: string) => {
    if (!batchId) { memoryArchiveDetailRequestSeqRef.current += 1; setMemoryArchiveBatchDetail(null); return; }
    const characterId = selectedCharacterId.trim();
    if (!characterId) { memoryArchiveDetailRequestSeqRef.current += 1; return; }
    const body = { action: 'batch_details', character_id: characterId, batch_id: batchId };
    const requestedCharacterId = body.character_id;
    memoryArchiveDetailRequestSeqRef.current += 1;
    const requestSeq = memoryArchiveDetailRequestSeqRef.current;
    try {
      const res = await fetch('/api/memory-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = parseMemoryArchiveBatchDetail(res, await parseJsonResponse<unknown>(res));
      if (!isCurrentMemoryArchiveDetailRequest(requestedCharacterId, requestSeq)) return;
      setMemoryArchiveBatchDetail(data);
      setMemoryArchiveError(null);
      if (data.summary?.content) setMemoryArchiveSummary(data.summary.content);
    } catch (err) {
      if (!isCurrentMemoryArchiveDetailRequest(requestedCharacterId, requestSeq)) return;
      setMemoryArchiveError(getErrorMessage(err));
    }
  };

  return {
    memoryArchiveMemories,
    selectedMemoryArchiveIds,
    memoryArchiveSummary,
    memoryArchiveBatches,
    selectedMemoryArchiveBatchId,
    memoryArchivePlan,
    memoryArchiveBatchDetail,
    memoryArchiveLoading,
    memoryArchiveListLoading,
    memoryArchiveHasMore,
    memoryArchiveTotal,
    memoryArchiveOffset,
    memoryArchiveError,
    memoryArchiveAiRunning,
    setMemoryArchiveSummary,
    setSelectedMemoryArchiveBatchId,
    resetArchiveForCharacterChange,
    loadMemoryArchiveMemories,
    loadMemoryArchiveBatches,
    toggleMemoryArchiveSelection,
    handleMemoryArchivePreview,
    handleMemoryArchiveExecute,
    handleMemoryArchiveUndo,
    handleMemoryArchiveAi,
    handleStopMemoryArchiveAi,
    loadMemoryArchiveBatchDetail,
  };
}

export type UseMemoryArchivePanelResult = ReturnType<typeof useMemoryArchivePanel>;
