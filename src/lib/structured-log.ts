import { sanitizeLogErrorMessage } from '@/lib/log-message-sanitizer';

type LogLevel = 'info' | 'warn' | 'error';

type SafeLogFields = Record<string, unknown>;

const SAFE_FIELDS = new Set([
  'requestId',
  'taskId',
  'characterId',
  'conversationId',
  'messageId',
  'engine',
  'provider',
  'operation',
  'status',
  'durationMs',
  'httpStatus',
  'attempt',
]);

function serializeError(error: unknown): { name: string; message: string } | undefined {
  if (error instanceof Error) {
    return { name: error.name, message: sanitizeLogErrorMessage(error) };
  }
  if (error === undefined || error === null) return undefined;
  return { name: 'Error', message: sanitizeLogErrorMessage(error) };
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
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...safeFields,
    ...(serializedError ? { error: serializedError } : {}),
  });

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}
