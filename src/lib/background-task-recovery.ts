import type Database from 'better-sqlite3';

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

/** 租约到期后多等一小会儿再回收，吸收 SQLite datetime 的秒级精度 */
const LEASE_EXPIRY_WAKE_GRACE_MS = 1000;

/**
 * 启动恢复 + 租约到期补跑。
 *
 * recoverStale* 只回收租约已过期的 processing。快速重启时，上个进程留下的任务租约往往还没过期：
 * 启动这一次 recover 回收不了它们，trigger 也认领不到；之后若没有新的业务触发，
 * 它们会一直卡在 processing。这里在 recover 之后、trigger 之前取「最晚到期的未过期租约」
 * （此刻本进程还没认领任何任务，剩下的 processing 都是上个进程的孤儿），到点再跑一遍。
 *
 * 一次性定时器、不续挂：到点时这批孤儿的租约必然已全部过期。仍然不抢未过期租约。
 */
export function recoverAndWakeAtLeaseExpiry(
  db: Database.Database,
  table: string,
  queue: { recover: () => void; trigger: () => void },
  onError: (err: unknown) => void,
): void {
  queue.recover();
  const row = db.prepare(
    `SELECT CAST((julianday(MAX(lease_expires_at)) - julianday('now')) * 86400000 AS INTEGER) AS ms
     FROM ${table}
     WHERE status = 'processing' AND lease_expires_at > datetime('now')`,
  ).get() as { ms: number | null } | undefined;
  queue.trigger();
  if (typeof row?.ms !== 'number') return;

  const timer = setTimeout(() => {
    try {
      queue.recover();
      queue.trigger();
    } catch (err) {
      onError(err);
    }
  }, Math.max(0, row.ms) + LEASE_EXPIRY_WAKE_GRACE_MS);
  // 不让这个定时器阻止进程退出
  timer.unref();
}
