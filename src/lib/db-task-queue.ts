/**
 * DbTaskQueue — SQLite 后台任务队列的深模块。
 *
 * 收敛 claim_token + lease_expires_at 租约、可选入队去重/失败复活、
 * recoverStale 与简单 drain 闸门。业务 process 逻辑由调用方注入/外置。
 *
 * 表约定（调用方负责 migrate）：
 * - status TEXT（pending | processing | done | failed）
 * - claim_token TEXT NULL
 * - lease_expires_at TEXT NULL
 * - updated_at TEXT（写入时由本模块维护为 datetime('now') 或 ISO，见配置）
 * - 可选 retry_count / error_message（fail 时使用）
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  DEFAULT_BACKGROUND_TASK_LEASE_SECONDS,
} from '@/lib/background-task-recovery';

export type DbTaskQueueTimestampMode = 'sqlite_now' | 'iso';

export type DbTaskQueueConfig = {
  /** 任务表名（标识符，禁止来自用户输入） */
  table: string;
  /** 默认租约秒数 */
  defaultLeaseSeconds?: number;
  /**
   * 时间戳写法：画像表用 SQLite datetime('now')；提取/embedding 历史用 ISO。
   * 默认 sqlite_now。
   */
  timestampMode?: DbTaskQueueTimestampMode;
  /** fail 时是否递增 retry_count（列须存在）。默认 true */
  incrementRetryOnFail?: boolean;
};

export type DbTaskQueueFilter = {
  /** 已绑定参数的 SQL 片段，如 "character_id = ?" */
  sql: string;
  params?: unknown[];
};

export type DbTaskQueueEnqueueOptions = {
  /** INSERT 列（不含 status/created_at/updated_at/claim 等队列列；status 固定 pending） */
  columns: Record<string, unknown>;
  /**
   * 去重键：存在 pending/processing 时跳过插入。
   * 不传 = 不去重（画像队列）。
   */
  dedupeKey?: { column: string; value: string };
  /**
   * 若最新任务为 failed，则复活为 pending（embedding 用）。
   * 需配合 dedupeKey。
   */
  reviveFailed?: boolean;
  /** 复活时额外写入的列（如 reason、retry_count=0） */
  reviveColumns?: Record<string, unknown>;
};

export type DbTaskQueueClaimOptions = {
  limit?: number;
  leaseSeconds?: number;
  /** 额外 WHERE 条件（AND） */
  filters?: DbTaskQueueFilter[];
  /** 为 true 时不加 LIMIT（如 throughTaskId 批量认领） */
  unlimited?: boolean;
};

export type DbTaskQueueEnqueueResult = {
  inserted: boolean;
  revived: boolean;
  id: number | null;
};

export type DbTaskQueueDrainGate = {
  trigger: () => void;
  isActive: () => boolean;
};

function assertSafeIdent(name: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`DbTaskQueue: invalid ${label} "${name}"`);
  }
  return name;
}

function quoteIdent(name: string): string {
  return `"${assertSafeIdent(name, 'identifier')}"`;
}

export function createDbTaskQueue(config: DbTaskQueueConfig) {
  const table = quoteIdent(config.table);
  const defaultLeaseSeconds = Math.max(
    1,
    Math.floor(config.defaultLeaseSeconds ?? DEFAULT_BACKGROUND_TASK_LEASE_SECONDS),
  );
  const timestampMode: DbTaskQueueTimestampMode = config.timestampMode ?? 'sqlite_now';
  const incrementRetryOnFail = config.incrementRetryOnFail !== false;

  const nowExpr = timestampMode === 'sqlite_now' ? `datetime('now')` : null;

  function bindNow(db: Database.Database): { sql: string; params: unknown[] } {
    if (nowExpr) return { sql: nowExpr, params: [] };
    return { sql: '?', params: [new Date().toISOString()] };
  }

  function claimablePredicate(alias = ''): string {
    const p = alias ? `${alias}.` : '';
    return `(
      ${p}status = 'pending'
      OR (
        ${p}status = 'processing'
        AND ${p}lease_expires_at IS NOT NULL
        AND ${p}lease_expires_at <= datetime('now')
      )
    )`;
  }

  function enqueue(db: Database.Database, options: DbTaskQueueEnqueueOptions): DbTaskQueueEnqueueResult {
    const columnEntries = Object.entries(options.columns);
    for (const [key] of columnEntries) assertSafeIdent(key, 'column');

    const run = db.transaction(() => {
      if (options.dedupeKey) {
        const col = quoteIdent(options.dedupeKey.column);
        const existing = db.prepare(
          `SELECT id FROM ${table}
           WHERE ${col} = ? AND status IN ('pending','processing')
           LIMIT 1`,
        ).get(options.dedupeKey.value) as { id: number } | undefined;
        if (existing) {
          return { inserted: false, revived: false, id: existing.id };
        }

        if (options.reviveFailed) {
          const failed = db.prepare(
            `SELECT id FROM ${table}
             WHERE ${col} = ? AND status = 'failed'
             ORDER BY updated_at DESC, id DESC
             LIMIT 1`,
          ).get(options.dedupeKey.value) as { id: number } | undefined;
          if (failed) {
            const reviveEntries = Object.entries(options.reviveColumns || {});
            for (const [key] of reviveEntries) assertSafeIdent(key, 'column');
            const now = bindNow(db);
            const setParts = [
              `status = 'pending'`,
              `claim_token = NULL`,
              `lease_expires_at = NULL`,
              `error_message = NULL`,
              `updated_at = ${now.sql}`,
              ...reviveEntries.map(([key]) => `${quoteIdent(key)} = ?`),
            ];
            const params = [
              ...now.params,
              ...reviveEntries.map(([, value]) => value),
              failed.id,
            ];
            db.prepare(
              `UPDATE ${table} SET ${setParts.join(', ')} WHERE id = ?`,
            ).run(...params);
            return { inserted: false, revived: true, id: failed.id };
          }
        }
      }

      const now = bindNow(db);
      const keys = columnEntries.map(([key]) => quoteIdent(key));
      const placeholders = columnEntries.map(() => '?');
      // created_at / updated_at：若调用方未提供则由模块补上
      const hasCreated = columnEntries.some(([key]) => key === 'created_at');
      const hasUpdated = columnEntries.some(([key]) => key === 'updated_at');
      if (!hasCreated) {
        keys.push(quoteIdent('created_at'));
        placeholders.push(now.sql);
      }
      if (!hasUpdated) {
        keys.push(quoteIdent('updated_at'));
        placeholders.push(now.sql);
      }
      keys.push(quoteIdent('status'));
      placeholders.push(`'pending'`);

      const params = [
        ...columnEntries.map(([, value]) => value),
        ...(!hasCreated ? now.params : []),
        ...(!hasUpdated ? now.params : []),
      ];

      const result = db.prepare(
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders.join(', ')})`,
      ).run(...params);

      return {
        inserted: true,
        revived: false,
        id: Number(result.lastInsertRowid),
      };
    });

    return run();
  }

  function claim<T extends { id: number } = { id: number }>(
    db: Database.Database,
    options: DbTaskQueueClaimOptions = {},
  ): T[] {
    const leaseSeconds = Math.max(
      1,
      Math.floor(options.leaseSeconds ?? defaultLeaseSeconds),
    );
    const claimToken = randomUUID();
    const filters = options.filters || [];
    const limit = options.unlimited
      ? null
      : Math.max(1, Math.floor(options.limit ?? 10));

    db.transaction(() => {
      const whereParts = [claimablePredicate()];
      const params: unknown[] = [];
      for (const filter of filters) {
        whereParts.push(`(${filter.sql})`);
        if (filter.params) params.push(...filter.params);
      }
      const limitSql = limit === null ? '' : 'LIMIT ?';
      const rows = db.prepare(
        `SELECT id FROM ${table}
         WHERE ${whereParts.join(' AND ')}
         ORDER BY id ASC
         ${limitSql}`,
      ).all(...params, ...(limit === null ? [] : [limit])) as Array<{ id: number }>;

      const now = bindNow(db);
      for (const row of rows) {
        // 不在 claim 时清 error_message：部分旧表/精简 fixture 可能无该列；
        // 完成/失败路径会写入最终诊断字段。
        db.prepare(
          `UPDATE ${table}
           SET status = 'processing',
               claim_token = ?,
               lease_expires_at = datetime('now', ?),
               updated_at = ${now.sql}
           WHERE id = ?
             AND ${claimablePredicate()}`,
        ).run(claimToken, `+${leaseSeconds} seconds`, ...now.params, row.id);
      }
    })();

    return db.prepare(
      `SELECT * FROM ${table} WHERE claim_token = ? ORDER BY id ASC`,
    ).all(claimToken) as T[];
  }

  /**
   * 写前确认仍持有 claim（心跳式：不改租约到期时间，仅校验 token）。
   * 与画像 confirmTaskClaimForWrite 语义一致。
   */
  function confirmClaim(
    db: Database.Database,
    task: { id: number; claim_token: string | null },
  ): boolean {
    if (!task.claim_token) return false;
    const result = db.prepare(
      `UPDATE ${table}
       SET lease_expires_at = lease_expires_at
       WHERE id = ? AND claim_token = ? AND status = 'processing'`,
    ).run(task.id, task.claim_token);
    return result.changes > 0;
  }

  function complete(
    db: Database.Database,
    task: { id: number; claim_token: string | null },
    options: {
      errorMessage?: string | null;
      /** 业务列（如 merge_count），在完成时一并写入 */
      columns?: Record<string, unknown>;
    } = {},
  ): boolean {
    if (!task.claim_token) return false;
    const extra = Object.entries(options.columns || {});
    for (const [key] of extra) assertSafeIdent(key, 'column');
    const now = bindNow(db);
    const extraSql = extra.map(([key]) => `${quoteIdent(key)} = ?`).join(', ');
    const result = db.prepare(
      `UPDATE ${table}
       SET status = 'done',
           claim_token = NULL,
           lease_expires_at = NULL,
           error_message = ?,
           ${extraSql ? `${extraSql},` : ''}
           updated_at = ${now.sql}
       WHERE id = ? AND claim_token = ?`,
    ).run(
      options.errorMessage === undefined ? null : options.errorMessage,
      ...extra.map(([, value]) => value),
      ...now.params,
      task.id,
      task.claim_token,
    );
    return result.changes > 0;
  }

  function fail(
    db: Database.Database,
    task: { id: number; claim_token: string | null },
    errorMessage: string,
  ): boolean {
    if (!task.claim_token) return false;
    const now = bindNow(db);
    const retrySql = incrementRetryOnFail ? 'retry_count = retry_count + 1,' : '';
    const result = db.prepare(
      `UPDATE ${table}
       SET status = 'failed',
           claim_token = NULL,
           lease_expires_at = NULL,
           ${retrySql}
           error_message = ?,
           updated_at = ${now.sql}
       WHERE id = ? AND claim_token = ?`,
    ).run(errorMessage, ...now.params, task.id, task.claim_token);
    return result.changes > 0;
  }

  /**
   * 释放 claim 并回到 pending（可恢复错误的延迟重试）。
   * 与 fail 不同：不进入 failed，可选递增 retry_count。
   */
  function requeue(
    db: Database.Database,
    task: { id: number; claim_token: string | null },
    options: {
      errorMessage?: string | null;
      incrementRetry?: boolean;
      columns?: Record<string, unknown>;
    } = {},
  ): boolean {
    if (!task.claim_token) return false;
    const extra = Object.entries(options.columns || {});
    for (const [key] of extra) assertSafeIdent(key, 'column');
    const now = bindNow(db);
    const retrySql = options.incrementRetry ? 'retry_count = retry_count + 1,' : '';
    const extraSql = extra.map(([key]) => `${quoteIdent(key)} = ?`).join(', ');
    const result = db.prepare(
      `UPDATE ${table}
       SET status = 'pending',
           claim_token = NULL,
           lease_expires_at = NULL,
           ${retrySql}
           error_message = ?,
           ${extraSql ? `${extraSql},` : ''}
           updated_at = ${now.sql}
       WHERE id = ? AND claim_token = ? AND status = 'processing'`,
    ).run(
      options.errorMessage === undefined ? null : options.errorMessage,
      ...extra.map(([, value]) => value),
      ...now.params,
      task.id,
      task.claim_token,
    );
    return result.changes > 0;
  }

  function recoverStale(db: Database.Database): number {
    const now = bindNow(db);
    const result = db.prepare(
      `UPDATE ${table}
       SET status = 'pending',
           claim_token = NULL,
           lease_expires_at = NULL,
           updated_at = ${now.sql}
       WHERE status = 'processing'
         AND (
           lease_expires_at IS NULL
           OR lease_expires_at <= datetime('now')
         )`,
    ).run(...now.params);
    return result.changes;
  }

  function countClaimable(db: Database.Database, filters: DbTaskQueueFilter[] = []): number {
    const whereParts = [claimablePredicate()];
    const params: unknown[] = [];
    for (const filter of filters) {
      whereParts.push(`(${filter.sql})`);
      if (filter.params) params.push(...filter.params);
    }
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM ${table} WHERE ${whereParts.join(' AND ')}`,
    ).get(...params) as { count: number };
    return row.count;
  }

  /**
   * 简单互斥 drain：已在跑则跳过；循环 runBatch 直到 claimed===0 或触顶。
   * embedding 的 delay/stop/config 复杂调度不要用这个。
   */
  function createDrainGate(
    runBatch: () => Promise<{ claimed: number }>,
    options: {
      maxRounds?: number;
      onError?: (error: unknown) => void;
    } = {},
  ): DbTaskQueueDrainGate {
    let active = false;
    const maxRounds = Math.max(1, Math.floor(options.maxRounds ?? 1000));

    return {
      isActive: () => active,
      trigger: () => {
        if (active) return;
        active = true;
        void (async () => {
          try {
            for (let i = 0; i < maxRounds; i += 1) {
              const result = await runBatch();
              if (!result || result.claimed === 0) break;
            }
          } catch (error) {
            options.onError?.(error);
          } finally {
            active = false;
          }
        })();
      },
    };
  }

  return {
    table: config.table,
    enqueue,
    claim,
    confirmClaim,
    complete,
    fail,
    requeue,
    recoverStale,
    countClaimable,
    createDrainGate,
    claimablePredicate,
  };
}

export type DbTaskQueue = ReturnType<typeof createDbTaskQueue>;
