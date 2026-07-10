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
): Promise<T> {
  const effectiveTimeout = timeoutMs ?? DEFAULT_BACKGROUND_LLM_TIMEOUT_MS;
  if (effectiveTimeout === 0) {
    return work(undefined);
  }

  const controller = new AbortController();
  const timeoutError = new BackgroundLlmTimeoutError(effectiveTimeout);
  let clearTimer: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    clearTimer = scheduleLongTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, effectiveTimeout);
  });

  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimer?.();
  }
}
import { scheduleLongTimeout } from '@/lib/long-timeout';
