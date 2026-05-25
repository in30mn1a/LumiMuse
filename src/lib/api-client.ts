import { Settings } from '@/types';
import { safeFetch } from './ssrf-guard';

/**
 * 清理上游响应中可能回显的敏感字段（Authorization 头、API key 片段等），
 * 防止错误消息被透传到客户端日志/前端时泄漏凭据。最终长度限制 200。
 */
function sanitizeUpstreamError(text: string): string {
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

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onDone: (fullText: string) => Promise<void> | void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
}

export async function chatCompletionStream(
  settings: Settings,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
): Promise<void> {
  const body = {
    model: settings.model,
    messages,
    max_tokens: settings.max_tokens,
    temperature: settings.temperature,
    stream: true,
  };

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
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 检查是否已被 abort
      if (callbacks.signal?.aborted) {
        reader.cancel();
        return; // 不调用 onDone，不保存消息
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      // 保留最后一段可能不完整的数据
      buffer = parts.pop()!;

      for (const part of parts) {
        for (const line of part.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              callbacks.onChunk(delta);
            }
          } catch {
            // 跳过格式不完整的分片
          }
        }
      }
    }
  } catch (err) {
    // reader.read() 被 abort 时抛出 AbortError，直接返回不保存
    if (err instanceof Error && (err.name === 'AbortError' || callbacks.signal?.aborted)) {
      reader.cancel();
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

  // 检查循环结束后是否已被 abort
  if (callbacks.signal?.aborted) return;

  // 处理剩余缓冲区
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          callbacks.onChunk(delta);
        }
      } catch { /* 跳过 */ }
    }
  }

  await callbacks.onDone(fullText);
}

export async function chatCompletion(
  settings: Settings,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    max_tokens: settings.max_tokens,
    temperature: settings.temperature,
    stream: false,
  };

  if (settings.json_mode) {
    body.response_format = { type: 'json_object' };
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
      throw new Error('推理模型思考消耗了全部 token，最终未生成内容。请增大 max_tokens（建议 ≥16384）');
    }
    throw new Error('LLM 返回了空内容，请检查模型是否支持当前请求格式');
  }
  return content;
}
