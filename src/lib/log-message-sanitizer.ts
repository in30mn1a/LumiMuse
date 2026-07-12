const SAFE_OPERATIONAL_MESSAGES = [
  /^(?:SQLITE_[A-Z_]+:\s*)?(?:database is (?:locked|busy)|disk I\/O error|database or disk is full)$/i,
  /^(?:fetch failed|network error|connection (?:refused|reset|timed out)|socket hang up)$/i,
  /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)(?:: [A-Za-z0-9 ._-]+)?$/,
  /^(?:The operation was aborted|This operation was aborted|operation timed out)$/i,
];

const REDACTED_ERROR_MESSAGE = 'Error details redacted';

/**
 * Error messages may contain upstream response bodies, prompts, chat text, URLs, or credentials.
 * Only a deliberately small set of operational messages is safe enough for correlation logs.
 */
export function sanitizeLogErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return REDACTED_ERROR_MESSAGE;
  const message = error.message.trim();
  if (message.length === 0 || message.length > 160) return REDACTED_ERROR_MESSAGE;
  return SAFE_OPERATIONAL_MESSAGES.some(pattern => pattern.test(message))
    ? message
    : REDACTED_ERROR_MESSAGE;
}
