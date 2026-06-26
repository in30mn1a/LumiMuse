import { Settings } from '@/types';
import { safeFetch } from './ssrf-guard';
import { parseSseStream } from './sse-parser';

// 推理模型（带 reasoning_content）会先消耗大量 token 思考。后台任务（记忆提取、画像 patch）
// 需要模型在思考之后仍能输出完整 JSON，若沿用聊天的小 max_tokens 会在思考阶段耗尽额度、
// 正式内容为空而失败。后台调用方应至少使用该值作为 max_tokens 下限。
export const REASONING_SAFE_MAX_TOKENS = 16384;

/**
 * 清理上游响应中可能回显的敏感字段（Authorization 头、API key 片段等），
 * 防止错误消息被透传到客户端日志/前端时泄漏凭据。最终长度限制 200。
 */
export function sanitizeUpstreamError(text: string): string {
  let sanitized = text;
  // Authorization: Bearer xxx（含 Bearer 后整段 token）
  sanitized = sanitized.replace(/Authorization\s*[:=]\s*Bearer\s+[\w.\-+/=]+/gi, 'Authorization: Bearer [REDACTED]');
  // Authorization: 其他认证方案（Basic/Digest/纯 token 等）
  sanitized = sanitized.replace(/Authorization\s*[:=]\s*[^\s,;"'}\]]+/gi, 'Authorization: [REDACTED]');
  // 独立出现的 Bearer xxx
  sanitized = sanitized.replace(/Bearer\s+[\w.\-+/=]+/g, 'Bearer [REDACTED]');
  // api_key=xxx / api-key=xxx / apikey=xxx（query string 或 JSON 风格）
  sanitized = sanitized.replace(/(api[_-]?key)\s*[:=]\s*["']?[\w.\-+/=]+["']?/gi, '$1=[REDACTED]');
  // OpenAI 风格的 sk-xxxxx
  sanitized = sanitized.replace(/sk-[\w-]{8,}/g, 'sk-[REDACTED]');
  return sanitized.slice(0, 200);
}

export type ChatMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
    >;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatMessageContent;
}

/**
 * LLM 上游返回的 token 用量统计。
 *
 * OpenAI 兼容协议下，非流式响应直接在 body.usage 返回；
 * 流式响应需要请求体带 `stream_options: { include_usage: true }`，
 * 上游会在最后一个 chunk（choices 为空数组）里附带 usage。
 *
 * 不同上游可能额外返回 prompt_cache_hit_tokens 等字段，
 * 这里只保留跨上游通用的三个核心字段。
 */
export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onDone: (fullText: string) => Promise<void> | void;
  onError: (error: Error) => void;
  /**
   * 上游返回 usage 时触发（流式仅在最后一个 chunk 携带）。
   * 上游未返回 usage 时不会调用，调用方应保留原有估算逻辑作为 fallback。
   */
  onUsage?: (usage: LlmUsage) => void;
  signal?: AbortSignal;
}

/**
 * 从 SSE chunk 的 raw JSON 中提取 usage 字段（若存在）。
 * OpenAI 协议规定 usage 出现在最后一个 chunk，choices 为空数组。
 */
function extractUsageFromChunk(raw: unknown): LlmUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = (raw as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } }).usage;
  if (!usage) return undefined;
  const promptTokens = Number(usage.prompt_tokens);
  const completionTokens = Number(usage.completion_tokens);
  const totalTokens = Number(usage.total_tokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return undefined;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : promptTokens + completionTokens,
  };
}

/**
 * 把用户在设置里配置的可选采样参数（top_p / frequency_penalty / presence_penalty / top_k /
 * repetition_penalty / seed）追加到请求体。
 *
 * 约定：值为 null 表示「未设置」，对应的字段不会出现在请求体里——这样兼容那些
 * 不支持其中部分参数的上游（不支持的字段若强行发送可能被某些网关直接拒绝）。
 * 非空数值才会被写入。
 */
function appendOptionalSamplingParams(body: Record<string, unknown>, settings: Settings): void {
  // 用 != null 同时兼容 null 和 undefined（旧测试数据可能不带这些字段）
  if (settings.top_p != null) body.top_p = settings.top_p;
  if (settings.frequency_penalty != null) body.frequency_penalty = settings.frequency_penalty;
  if (settings.presence_penalty != null) body.presence_penalty = settings.presence_penalty;
  if (settings.top_k != null) body.top_k = settings.top_k;
  if (settings.repetition_penalty != null) body.repetition_penalty = settings.repetition_penalty;
  if (settings.seed != null) body.seed = settings.seed;
}

export async function chatCompletionStream(
  settings: Settings,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
): Promise<void> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    max_tokens: settings.max_tokens,
    temperature: settings.temperature,
    stream: true,
    // OpenAI 协议：流式默认不返回 usage，需显式开启。
    // 兼容上游会忽略未知字段，不支持的也不会报错；支持的上游会在最后一个 chunk 附带 usage。
    stream_options: { include_usage: true },
  };
  appendOptionalSamplingParams(body, settings);

  const response = await safeFetch(`${settings.api_base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.api_key}`,
    },
    body: JSON.stringify(body),
    signal: callbacks.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    callbacks.onError(new Error(`API error ${response.status}: ${sanitizeUpstreamError(text)}`));
    return;
  }

  if (!response.body) {
    callbacks.onError(new Error('API 未返回响应体（可能是网络或代理问题）'));
    return;
  }

  const reader = response.body.getReader();
  let fullText = '';
  // 捕获最后一个 chunk 的 usage；流正常结束时通过 onUsage 回调上报。
  // abort 场景下 usage 通常尚未到达，不上报（调用方 fallback 到估算值）。
  let capturedUsage: LlmUsage | undefined;

  try {
    await parseSseStream(reader, ({ text, raw }) => {
      if (text) {
        fullText += text;
        callbacks.onChunk(text);
      }
      // usage 只在最后一个 chunk 出现，每次都尝试提取，后到的覆盖先到的
      const usage = extractUsageFromChunk(raw);
      if (usage) {
        capturedUsage = usage;
      }
    }, { signal: callbacks.signal });
  } catch (err) {
    // reader.read() 被 abort 时抛出 AbortError；若已有部分内容，先保存，避免用户可见回复丢失
    if (err instanceof Error && (err.name === 'AbortError' || callbacks.signal?.aborted)) {
      try { await reader.cancel(); } catch { /* ignore */ }
      if (fullText) {
        await callbacks.onDone(fullText);
      }
      return;
    }
    // 非 abort 错误：若已累积部分内容，先保存再向上抛出，避免用户已看到的回复丢失
    if (fullText) {
      try {
        await callbacks.onDone(fullText);
      } catch {
        // 保存失败不应掩盖原始错误
      }
    }
    throw err;
  }

  // parseSseStream 在 abort 时静默返回；已有部分内容时仍保存，空内容则不写入空回复
  if (callbacks.signal?.aborted && !fullText) return;

  // 正常结束：先上报 usage（若有），再触发 onDone
  if (capturedUsage && callbacks.onUsage) {
    try {
      callbacks.onUsage(capturedUsage);
    } catch {
      // usage 上报失败不应影响主流程
    }
  }
  await callbacks.onDone(fullText);
}

export async function chatCompletion(
  settings: Settings,
  messages: ChatMessage[],
  signal?: AbortSignal,
  extraBody?: Record<string, unknown>,
  onUsage?: (usage: LlmUsage) => void,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    max_tokens: settings.max_tokens,
    temperature: settings.temperature,
    stream: false,
  };
  appendOptionalSamplingParams(body, settings);

  if (settings.json_mode) {
    body.response_format = { type: 'json_object' };
  }
  if (extraBody) {
    Object.assign(body, extraBody);
  }

  const response = await safeFetch(`${settings.api_base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.api_key}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${sanitizeUpstreamError(text)}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content || (typeof content === 'string' && content.trim() === '')) {
    const reason = choice?.finish_reason;
    const hasReasoning = !!choice?.message?.reasoning_content;
    if (reason === 'length' && hasReasoning) {
      throw new Error(`推理模型思考消耗了全部 token，最终未生成内容。请增大 max_tokens（建议 ≥${REASONING_SAFE_MAX_TOKENS}）`);
    }
    throw new Error('LLM 返回了空内容，请检查模型是否支持当前请求格式');
  }

  // 非流式响应直接在 body.usage 返回；提取后通过回调上报（调用方可选消费）
  if (onUsage) {
    const usage = extractUsageFromChunk(data);
    if (usage) {
      try {
        onUsage(usage);
      } catch {
        // usage 上报失败不应影响主流程
      }
    }
  }

  return content;
}
