import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '@/lib/db';

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
  } catch {
    // 响应只暴露检查结果，避免泄露数据库路径或内部错误。
  }

  await Promise.all(PERSISTENT_DIRECTORIES.map(async ([name, directoryPath]) => {
    try {
      await access(directoryPath, constants.W_OK);
      checks[name] = true;
    } catch {
      // 目录路径和权限错误仅保留在进程内部，不进入公开健康响应。
    }
  }));

  return checks;
}

export function isReady(checks: ReadinessChecks): boolean {
  return Object.values(checks).every(Boolean);
}
