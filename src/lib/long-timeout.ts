/** Node/浏览器单次 setTimeout 可安全表达的最大延迟。更长 deadline 会分段调度。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function scheduleLongTimeout(callback: () => void, delayMs: number): () => void {
  const deadline = Date.now() + delayMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const scheduleNext = () => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }
    timer = setTimeout(scheduleNext, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };

  scheduleNext();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
