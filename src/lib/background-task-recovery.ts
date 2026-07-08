/**
 * 后台任务租约默认值（秒）。
 * recoverStale* 只回收 processing 且租约/开始时间已超过该窗口的任务，
 * 避免多实例共享 SQLite 时，一方重启把另一方 in-flight 任务抢回 pending。
 */
export const DEFAULT_BACKGROUND_TASK_LEASE_SECONDS = 300;

export function backgroundTaskStaleCutoffIso(leaseSeconds: number = DEFAULT_BACKGROUND_TASK_LEASE_SECONDS): string {
  const sec = Math.max(1, Math.floor(leaseSeconds));
  return new Date(Date.now() - sec * 1000).toISOString();
}