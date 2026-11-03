/**
 * LLM 上游错误的结构化信息。
 *
 * 上游错误正文可能带提示词或用户内容，日志一律脱敏成同一句话，只靠文本无法区分故障。
 * 这里把 HTTP 状态和故障类别作为结构化字段传递，让诊断不需要保存正文。
 * 本模块被 structured-log 引用，不得依赖其他项目模块。
 */
export type LlmErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'upstream_server'
  | 'upstream_client'
  | 'timeout'
  | 'network'
  | 'unknown';

export interface LlmErrorClassification {
  category: LlmErrorCategory;
  httpStatus?: number;
}

export class UpstreamApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'UpstreamApiError';
    this.status = status;
  }
}

/** 只保留模型标识，不复制请求正文或凭据，也不改变原错误类型及公开文案。 */
const requestModels = new WeakMap<Error, string>();

export function withLlmRequestModel<T>(error: T, model: unknown): T {
  if (error instanceof Error && typeof model === 'string') requestModels.set(error, model);
  return error;
}

export function getLlmRequestModel(error: unknown): string | undefined {
  return error instanceof Error ? requestModels.get(error) : undefined;
}

const TIMEOUT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError', 'BackgroundLlmTimeoutError']);
const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
]);
const MAX_CAUSE_DEPTH = 5;

function categoryForStatus(status: number): LlmErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status <= 599) return 'upstream_server';
  if (status >= 400 && status <= 499) return 'upstream_client';
  return 'unknown';
}

/** fetch 把真正的网络原因放在 `cause` 里，外层只有一句 `fetch failed`，所以要沿 cause 查。 */
function classifyCauseChain(error: Error): LlmErrorCategory | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (TIMEOUT_ERROR_NAMES.has(current.name)) return 'timeout';
    if (typeof code === 'string' && TIMEOUT_ERROR_CODES.has(code)) return 'timeout';
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return 'network';
    current = current.cause;
  }
  return undefined;
}

export function classifyLlmError(error: unknown): LlmErrorClassification {
  if (error instanceof UpstreamApiError) {
    return { category: categoryForStatus(error.status), httpStatus: error.status };
  }
  if (!(error instanceof Error)) return { category: 'unknown' };

  const fromCause = classifyCauseChain(error);
  if (fromCause) return { category: fromCause };
  if (/\btimed out\b/i.test(error.message)) return { category: 'timeout' };
  if (/fetch failed|network error|socket hang up/i.test(error.message)) return { category: 'network' };
  return { category: 'unknown' };
}
