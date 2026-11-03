import { sanitizeLogErrorMessage } from '@/lib/log-message-sanitizer';
import { classifyLlmError } from '@/lib/upstream-error';

type LogLevel = 'info' | 'warn' | 'error';
type SafeLogFields = Record<string, unknown>;

export interface StructuredLogRecord {
  timestamp: string;
  level: 'warn' | 'error';
  event: string;
  fields: SafeLogFields;
  error?: { name: string; message: string };
}

export type StructuredLogSink = (record: StructuredLogRecord) => void;

const SAFE_FIELDS = new Set([
  'requestId',
  'taskId',
  'characterId',
  'conversationId',
  'messageId',
  'engine',
  'provider',
  'providerId',
  'model',
  'operation',
  'status',
  'durationMs',
  'httpStatus',
  'errorCategory',
  'attempt',
  'tokenCount',
  'budgetCap',
]);

let sink: StructuredLogSink | null = null;
let sinkRunning = false;

/** db.ts 也调用 structuredLog，所以落库方由外部注册，本模块不依赖 getDb。 */
export function setStructuredLogSink(next: StructuredLogSink | null): void {
  sink = next;
}

function serializeError(error: unknown): { name: string; message: string } | undefined {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeLogErrorMessage(error),
    };
  }
  if (error === undefined || error === null) return undefined;
  return { name: 'Error', message: sanitizeLogErrorMessage(error) };
}

/** 日志写入失败不得影响调用方；sink 内部再写日志也不得递归。 */
function deliverToSink(record: StructuredLogRecord): void {
  if (!sink || sinkRunning) return;
  sinkRunning = true;
  try {
    sink(record);
  } catch {
    // 落库只是诊断副本，控制台日志已经写出
  } finally {
    sinkRunning = false;
  }
}

export function structuredLog(
  level: LogLevel,
  event: string,
  fields: SafeLogFields = {},
  error?: unknown,
): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => SAFE_FIELDS.has(key) && value !== undefined),
  );
  const serializedError = serializeError(error);
  if (serializedError) {
    const { category, httpStatus } = classifyLlmError(error);
    safeFields.errorCategory ??= category;
    if (httpStatus !== undefined) safeFields.httpStatus ??= httpStatus;
  }
  const timestamp = new Date().toISOString();
  const line = JSON.stringify({
    timestamp,
    level,
    event,
    ...safeFields,
    ...(serializedError ? { error: serializedError } : {}),
  });

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.info(line);
  }

  if (level !== 'info') {
    deliverToSink({
      timestamp,
      level,
      event,
      fields: safeFields,
      ...(serializedError ? { error: serializedError } : {}),
    });
  }
}
