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

function serializeError(error: unknown): { name: string } | undefined {
  if (error instanceof Error) {
    // Error.message 可能来自上游响应正文，并包含 prompt、消息、密钥或内部 URL。
    // 关联日志只记录错误类别；面向用户的安全错误由各调用边界单独生成。
    return { name: error.name };
  }
  if (error === undefined || error === null) return undefined;
  return { name: 'Error' };
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
