import { structuredLog } from '@/lib/structured-log';

/**
 * 面向客户端的错误消息收口（审计 F03）。
 *
 * 错误源分两类：
 * 1. **可公开（透传）**：业务校验错误（如 "Only active memories can be merged"，
 *    固定文案、不含内部细节），以及上游 LLM 错误——`api-client` 的
 *    `chatCompletion` / `chatCompletionStream` 在抛出 / 回调前已过
 *    `sanitizeUpstreamError` 脱敏（凭据已替换为 `[REDACTED]`），用户需要
 *    看到它们来修上游配置（401 invalid key 等）。这两类都是普通 `Error`
 *    （无系统级 `code`）。
 * 2. **不可公开（收口为 fallback）**：better-sqlite3 的 `SqliteError`
 *    （message 常含完整 SQL 语句与数据库文件路径）、文件系统异常
 *    （Node 系统错误带 `code`，message 含服务器本地路径）等意外异常。
 *
 * 判定依据是「错误携带的系统级标识」而非猜测 message 内容：
 * better-sqlite3 异常 `name === 'SqliteError'`；Node 系统错误（fs / net）
 * 必带字符串型 `code`（ENOENT / EACCES ...）。命中任一即收口，原始错误
 * 交 structuredLog 留服务端痕迹。
 */
/** Node 系统错误（fs / net / better-sqlite3）附带字符串型 `code` 属性。 */
type ErrorWithCode = Error & { code?: unknown };

/** 判定是否「系统级」异常：message 含 SQL / 文件路径等内部细节，不可透传。 */
function hasSystemErrorMarker(error: Error): boolean {
  // better-sqlite3 的 SqliteError 无独立类型可 import，靠 name 判定
  if (error.name === 'SqliteError') return true;
  // Node 系统错误（fs / net）必带字符串型 code（ENOENT / EACCES ...）。
  // 应用层 Error 不设 code，不会误判。
  return typeof (error as ErrorWithCode).code === 'string';
}

/**
 * 返回可安全下发给客户端的错误消息：
 * - 业务校验错误 / 已脱敏上游错误（普通 Error）→ 透传 message；
 * - SqliteError、带系统 code 的异常、非 Error 值 → 收口为 fallback，
 *   原始错误经 structuredLog 留服务端日志（log message 另有
 *   `sanitizeLogErrorMessage` 白名单，双保险）。
 */
export function publicErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    if (!hasSystemErrorMarker(error)) return error.message;
    structuredLog('error', 'api.internal_error', { status: 'redacted' }, error);
    return fallback;
  }
  structuredLog('error', 'api.internal_error', { status: 'redacted' }, error);
  return fallback;
}
