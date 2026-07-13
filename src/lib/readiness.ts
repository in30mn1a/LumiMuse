import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { structuredLog } from '@/lib/structured-log';

export interface ReadinessChecks {
  database: boolean;
  data: boolean;
  generated: boolean;
  avatars: boolean;
  attachments: boolean;
}

const PERSISTENT_DIRECTORIES = [
  ['data', path.join(process.cwd(), 'data')],
  ['generated', path.join(process.cwd(), 'public', 'generated')],
  ['avatars', path.join(process.cwd(), 'public', 'avatars')],
  ['attachments', path.join(process.cwd(), 'public', 'attachments')],
] as const;

/** 限频：同一检查名在窗口内只记一次失败日志，避免健康探针刷屏。 */
const FAILURE_LOG_COOLDOWN_MS = 60_000;
const lastFailureLogAt = new Map<string, number>();

function logReadinessFailure(check: string, error: unknown): void {
  const now = Date.now();
  const last = lastFailureLogAt.get(check) ?? 0;
  if (now - last < FAILURE_LOG_COOLDOWN_MS) return;
  lastFailureLogAt.set(check, now);
  structuredLog('error', 'readiness.check_failed', {
    operation: check,
    status: 'failed',
  }, error);
}

export async function checkReadiness(): Promise<ReadinessChecks> {
  const checks: ReadinessChecks = {
    database: false,
    data: false,
    generated: false,
    avatars: false,
    attachments: false,
  };

  try {
    getDb().prepare('SELECT 1').get();
    checks.database = true;
  } catch (error) {
    // 公开响应只暴露布尔结果；内部脱敏日志记录根因，便于容器诊断。
    logReadinessFailure('database', error);
  }

  await Promise.all(PERSISTENT_DIRECTORIES.map(async ([name, directoryPath]) => {
    try {
      await access(directoryPath, constants.W_OK);
      checks[name] = true;
    } catch (error) {
      // 目录路径不进入公开响应；仅限频记录脱敏错误。
      logReadinessFailure(name, error);
    }
  }));

  return checks;
}

export function isReady(checks: ReadinessChecks): boolean {
  return Object.values(checks).every(Boolean);
}
