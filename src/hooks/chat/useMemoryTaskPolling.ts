import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Character, Memory } from '@/types';
import { formatTemplate } from '@/lib/i18n';
import { fetchMessagesPage } from '@/lib/chat-stream-client';
import { getErrorMessage, parseJsonArrayResponse, parseJsonResponse } from '@/lib/http';

type MemoryExtractStatus = 'idle' | 'extracting' | 'done' | 'failed';

type MemoryTaskStatusResponse = {
  status: string;
  mergeCount: number;
  retryCount?: number;
  errorMessage?: string | null;
  updatedAt: string | null;
};

type UseMemoryTaskPollingOptions = {
  activeConvIdRef: MutableRefObject<string | null>;
  characterRef: MutableRefObject<Character | null>;
  setMemories: Dispatch<SetStateAction<Memory[]>>;
  showToast: (message: string, type?: 'info' | 'error') => void;
  t: (key: string) => string;
  getLoadedMessageCount: () => number;
  updateServerCounts: (conversationId: string, unextractedCount?: number, totalTokens?: number) => void;
  pageSize: number;
};

const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function useMemoryTaskPolling({
  activeConvIdRef,
  characterRef,
  setMemories,
  showToast,
  t,
  getLoadedMessageCount,
  updateServerCounts,
  pageSize,
}: UseMemoryTaskPollingOptions) {
  const [memoryExtractStatus, setMemoryExtractStatus] = useState<MemoryExtractStatus>('idle');
  const seenMemoryTaskRef = useRef<Record<string, string>>({});
  const pollAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const extractStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    for (const controller of pollAbortControllersRef.current.values()) {
      controller.abort();
    }
    pollAbortControllersRef.current.clear();
    if (extractStatusTimerRef.current) clearTimeout(extractStatusTimerRef.current);
  }, []);

  const refreshCounts = useCallback((convId: string) => {
    fetchMessagesPage(convId, { limit: Math.max(pageSize, getLoadedMessageCount()) })
      .then(({ unextractedCount: uc, totalTokens: tt }) => {
        if (activeConvIdRef.current !== convId) return;
        updateServerCounts(convId, uc, tt);
      })
      .catch(() => {});
  }, [activeConvIdRef, getLoadedMessageCount, pageSize, updateServerCounts]);

  const scheduleStatusReset = useCallback(() => {
    if (extractStatusTimerRef.current) clearTimeout(extractStatusTimerRef.current);
    extractStatusTimerRef.current = setTimeout(() => setMemoryExtractStatus('idle'), 3000);
  }, []);

  const pollMemoryTask = useCallback(async (convId: string) => {
    pollAbortControllersRef.current.get(convId)?.abort();
    const controller = new AbortController();
    pollAbortControllersRef.current.set(convId, controller);

    try {
      if (activeConvIdRef.current === convId) {
        setMemoryExtractStatus('extracting');
      }
      if (extractStatusTimerRef.current) {
        clearTimeout(extractStatusTimerRef.current);
        extractStatusTimerRef.current = null;
      }

      const pollOnce = async (): Promise<{
        finished: boolean;
        status: string;
        retryCount: number;
        errorMessage: string | null;
        updatedAt: string | null;
      }> => {
        const response = await fetch(`/api/memory-tasks?conversation_id=${encodeURIComponent(convId)}`, { signal: controller.signal });
        const parsed = await parseJsonResponse<MemoryTaskStatusResponse>(response);
        const isFinished = parsed.status === 'done' || parsed.status === 'failed' || parsed.status === 'idle';

        if (parsed.status === 'done' && parsed.mergeCount > 0) {
          const taskKey = parsed.updatedAt ? `${parsed.status}:${parsed.updatedAt}` : parsed.status;
          if (seenMemoryTaskRef.current[convId] !== taskKey) {
            seenMemoryTaskRef.current[convId] = taskKey;
            showToast(formatTemplate(t('chat.memoryUpdated'), { count: parsed.mergeCount }), 'info');
          }
        }

        return {
          finished: isFinished,
          status: parsed.status,
          retryCount: parsed.retryCount || 0,
          errorMessage: parsed.errorMessage || null,
          updatedAt: parsed.updatedAt,
        };
      };

      // 轮询上限 200 次（约 7 分钟，1.5s 间隔 + 网络往返）；
      // 后端 undici 默认 300s 超时，前端略长避免提前放弃导致误报 failed
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (controller.signal.aborted) return;

        let result: Awaited<ReturnType<typeof pollOnce>>;
        try {
          result = await pollOnce();
        } catch (error) {
          if (isAbortError(error)) return;
          showToast(`${t('common.loadFailed')}: ${getErrorMessage(error)}`, 'error');
          if (activeConvIdRef.current === convId) {
            setMemoryExtractStatus('failed');
            scheduleStatusReset();
          }
          return;
        }

        const { finished, status, retryCount, errorMessage, updatedAt } = result;
        if (finished) {
          if (activeConvIdRef.current === convId) {
            if (status === 'done') {
              setMemoryExtractStatus('done');
              const charId = characterRef.current?.id;
              if (charId) {
                try {
                  const list = await parseJsonArrayResponse<Memory>(
                    await fetch(`/api/memories?character_id=${encodeURIComponent(charId)}`, { signal: controller.signal }),
                  );
                  if (activeConvIdRef.current === convId && characterRef.current?.id === charId) {
                    setMemories(list);
                  }
                } catch (error) {
                  if (!isAbortError(error) && activeConvIdRef.current === convId && characterRef.current?.id === charId) {
                    showToast(`${t('common.loadFailed')}: ${getErrorMessage(error)}`, 'error');
                  }
                }
              }
            } else if (status === 'failed') {
              setMemoryExtractStatus('failed');
              const taskKey = updatedAt ? `${status}:${updatedAt}` : status;
              if (seenMemoryTaskRef.current[convId] !== taskKey) {
                seenMemoryTaskRef.current[convId] = taskKey;
                const failureError = errorMessage?.trim() || t('chat.extractFailed');
                showToast(formatTemplate(t('chat.memoryExtractFailedDetail'), {
                  error: failureError,
                  retryCount: retryCount > 0 ? retryCount : 0,
                }), 'error');
              }
            } else {
              setMemoryExtractStatus('idle');
            }

            refreshCounts(convId);
            scheduleStatusReset();
          }
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
        if (controller.signal.aborted) return;
      }

      if (activeConvIdRef.current === convId) {
        setMemoryExtractStatus('failed');
        refreshCounts(convId);
        scheduleStatusReset();
      }
    } finally {
      if (pollAbortControllersRef.current.get(convId) === controller) {
        pollAbortControllersRef.current.delete(convId);
      }
    }
  }, [activeConvIdRef, characterRef, refreshCounts, scheduleStatusReset, setMemories, showToast, t]);

  return {
    memoryExtractStatus,
    pollMemoryTask,
  };
}

export type UseMemoryTaskPollingResult = ReturnType<typeof useMemoryTaskPolling>;
