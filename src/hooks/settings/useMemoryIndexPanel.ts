import { useCallback, useEffect, useState, type MutableRefObject } from 'react';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';
import { formatTemplate } from '@/lib/i18n';
import type { ToastType } from '@/components/ui/Toast';

export type MemoryIndexProcessingBlockedReason =
  | 'memory_engine_disabled'
  | 'external_memory_payloads_disabled'
  | 'embedding_disabled'
  | 'embedding_api_base_missing'
  | 'embedding_model_missing';

export interface MemoryIndexStatus {
  indexed: number;
  total: number;
  failed: number;
  pending?: number;
  queued?: number;
  processing?: number;
  canRebuild?: boolean;
  latest_error?: string | null;
  processing_blocked_reason?: MemoryIndexProcessingBlockedReason;
}

interface MemoryIndexActionResponse {
  ok: boolean;
  queued?: number;
  processing_blocked_reason?: MemoryIndexProcessingBlockedReason;
}

export interface MemoryDiagnostics {
  index: { total: number; ready: number; failed: number };
  tasks: Record<string, number>;
  candidates: Record<string, number>;
  profile: { exists: boolean; filled_fields: number };
  archive: Record<string, number>;
}

interface UseMemoryIndexPanelOptions {
  active: boolean;
  memoryManagementCharacterIdRef: MutableRefObject<string>;
  t: (key: string) => string;
  showToast: (message: string, type?: ToastType) => void;
}

const MEMORY_INDEX_STATUS_POLL_INTERVAL_MS = 2000;

export function useMemoryIndexPanel({
  active,
  memoryManagementCharacterIdRef,
  t,
  showToast,
}: UseMemoryIndexPanelOptions) {
  const [status, setStatus] = useState<MemoryIndexStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [indexingUnindexed, setIndexingUnindexed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<MemoryDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  const formatMemoryIndexBlockedReason = useCallback((reason?: MemoryIndexProcessingBlockedReason | null): string | null => {
    return reason ? t(`settings.memoryIndexBlocked.${reason}`) : null;
  }, [t]);

  const showMemoryIndexActionResult = useCallback((result: MemoryIndexActionResponse, successKey: string) => {
    const blockedReason = formatMemoryIndexBlockedReason(result.processing_blocked_reason);
    if (blockedReason) {
      const message = formatTemplate(t('settings.memoryIndexProcessingBlocked'), { reason: blockedReason });
      setError(message);
      showToast(message, 'error');
      return;
    }
    showToast(t(successKey), 'success');
  }, [formatMemoryIndexBlockedReason, showToast, t]);

  const activeTasks = (status?.pending ?? status?.queued ?? 0) + (status?.processing ?? 0);
  const blockedReason = formatMemoryIndexBlockedReason(status?.processing_blocked_reason);

  const loadMemoryIndexStatus = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    setError(null);
    try {
      const data = await parseJsonResponse<MemoryIndexStatus>(await fetch('/api/memory-index'));
      setStatus(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, []);

  const loadMemoryDiagnostics = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    const diagnosticsCharacterId = memoryManagementCharacterIdRef.current.trim();
    try {
      const query = diagnosticsCharacterId ? `?character_id=${encodeURIComponent(diagnosticsCharacterId)}` : '';
      const data = await parseJsonResponse<MemoryDiagnostics>(await fetch(`/api/memory-diagnostics${query}`));
      if (memoryManagementCharacterIdRef.current.trim() !== diagnosticsCharacterId) return;
      setDiagnostics(data);
    } catch (err) {
      if (memoryManagementCharacterIdRef.current.trim() !== diagnosticsCharacterId) return;
      setDiagnosticsError(getErrorMessage(err));
    } finally {
      if (!options.silent) setDiagnosticsLoading(false);
    }
  }, [memoryManagementCharacterIdRef]);

  const handleRebuildMemoryIndex = async () => {
    setRebuilding(true);
    setError(null);
    try {
      const result = await parseJsonResponse<MemoryIndexActionResponse>(await fetch('/api/memory-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rebuild' }),
      }));
      showMemoryIndexActionResult(result, 'settings.memoryIndexRebuildQueued');
      await loadMemoryIndexStatus();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      showToast(`${t('settings.memoryIndexRebuildFailed')}: ${message}`, 'error');
    } finally {
      setRebuilding(false);
    }
  };

  const handleRetryFailedMemoryIndex = async () => {
    setRetrying(true);
    setError(null);
    try {
      const result = await parseJsonResponse<MemoryIndexActionResponse>(await fetch('/api/memory-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry_failed' }),
      }));
      showMemoryIndexActionResult(result, 'settings.memoryIndexRetryFailedQueued');
      await loadMemoryIndexStatus();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      showToast(`${t('settings.memoryIndexRetryFailedError')}: ${message}`, 'error');
    } finally {
      setRetrying(false);
    }
  };

  const handleIndexUnindexedMemoryIndex = async () => {
    setIndexingUnindexed(true);
    setError(null);
    try {
      const result = await parseJsonResponse<MemoryIndexActionResponse>(await fetch('/api/memory-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'index_unindexed' }),
      }));
      showMemoryIndexActionResult(result, 'settings.memoryIndexIndexUnindexedQueued');
      await loadMemoryIndexStatus();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      showToast(`${t('settings.memoryIndexIndexUnindexedFailed')}: ${message}`, 'error');
    } finally {
      setIndexingUnindexed(false);
    }
  };

  const handleClearMemoryIndex = async () => {
    setClearing(true);
    setError(null);
    try {
      await parseJsonResponse<{ ok: boolean }>(await fetch('/api/memory-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear_index' }),
      }));
      showToast(t('settings.memoryIndexClearSuccess'), 'success');
      await loadMemoryIndexStatus();
      await loadMemoryDiagnostics();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      showToast(`${t('settings.memoryIndexClearFailed')}: ${message}`, 'error');
    } finally {
      setClearing(false);
    }
  };

  const handleStopCurrentMemoryTask = async () => {
    setStopping(true);
    setError(null);
    try {
      await parseJsonResponse<{ ok: boolean }>(await fetch('/api/memory-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop_current' }),
      }));
      showToast(t('settings.memoryIndexStopCurrentSuccess'), 'success');
      await loadMemoryIndexStatus();
      await loadMemoryDiagnostics();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      showToast(`${t('settings.memoryIndexStopCurrentFailed')}: ${message}`, 'error');
    } finally {
      setStopping(false);
    }
  };

  const shouldPollMemoryIndexStatus = active && (
    rebuilding ||
    retrying ||
    indexingUnindexed ||
    (status?.queued ?? 0) > 0 ||
    (status?.processing ?? 0) > 0
  );

  useEffect(() => {
    if (!shouldPollMemoryIndexStatus) return;
    const interval = setInterval(() => {
      void loadMemoryIndexStatus({ silent: true });
      void loadMemoryDiagnostics({ silent: true });
    }, MEMORY_INDEX_STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [
    loadMemoryDiagnostics,
    loadMemoryIndexStatus,
    shouldPollMemoryIndexStatus,
  ]);

  return {
    status,
    loading,
    rebuilding,
    retrying,
    indexingUnindexed,
    clearing,
    stopping,
    error,
    activeTasks,
    blockedReason,
    diagnostics,
    diagnosticsLoading,
    diagnosticsError,
    loadMemoryIndexStatus,
    loadMemoryDiagnostics,
    handleRebuildMemoryIndex,
    handleRetryFailedMemoryIndex,
    handleIndexUnindexedMemoryIndex,
    handleClearMemoryIndex,
    handleStopCurrentMemoryTask,
  };
}
