import { scheduleLongTimeout } from '@/lib/long-timeout';

export const DEFAULT_BACKGROUND_LLM_TIMEOUT_MS = 30 * 60 * 1000;

export class BackgroundLlmTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`后台 LLM 调用超过 ${timeoutMs}ms，已中止`);
    this.name = 'BackgroundLlmTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export async function runWithBackgroundLlmDeadline<T>(
  timeoutMs: number | undefined,
  work: (signal?: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const effectiveTimeout = timeoutMs ?? DEFAULT_BACKGROUND_LLM_TIMEOUT_MS;
  if (effectiveTimeout === 0) {
    return work(externalSignal);
  }

  const controller = new AbortController();
  const timeoutError = new BackgroundLlmTimeoutError(effectiveTimeout);
  let clearTimer: (() => void) | undefined;
  let removeExternalAbortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    clearTimer = scheduleLongTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, effectiveTimeout);
  });
  const externalAbort = externalSignal
    ? new Promise<never>((_, reject) => {
        const handleExternalAbort = () => {
          const reason = externalSignal.reason
            ?? new DOMException('The operation was aborted', 'AbortError');
          controller.abort(reason);
          reject(reason);
        };
        if (externalSignal.aborted) {
          handleExternalAbort();
          return;
        }
        externalSignal.addEventListener('abort', handleExternalAbort, { once: true });
        removeExternalAbortListener = () => {
          externalSignal.removeEventListener('abort', handleExternalAbort);
        };
      })
    : undefined;

  try {
    const workPromise = Promise.resolve().then(() => work(controller.signal));
    return await Promise.race(
      externalAbort ? [workPromise, timeout, externalAbort] : [workPromise, timeout],
    );
  } finally {
    clearTimer?.();
    removeExternalAbortListener?.();
  }
}
