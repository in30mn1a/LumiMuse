/**
 * OpenAI 兼容的 SSE 流解析工具。
 *
 * 设计目标：把 api-client 与 summarize 两处几乎一致的「按空行切分（兼容 LF/CRLF）→ 跳过 [DONE]/非 data: 行
 * → JSON.parse → 提取 delta.content」逻辑收敛到一处，避免双份维护。
 *
 * 关键不变量：
 * - 使用 TextDecoder 的 `stream: true` 模式，避免多字节字符（中文/emoji）在 chunk 边界被截断
 * - 缓冲区按空行切分后，**最后一段必须留下来**，因为它可能是被截断的下一个事件
 * - 终止符 `data: [DONE]` 直接跳过（不会进入 onDelta），不抛错也不算结束信号
 * - 完整 data event 的 JSON 解析失败时输出 warn，避免生产中静默丢 chunk；跨 chunk 的不完整 JSON 仍由 buffer 保留等待后续 chunk
 * - signal.aborted 时取消 reader 并立即返回，由调用方决定后续行为
 */

export interface SseDeltaChunk {
  /** 增量文本：OpenAI 流 `choices[0].delta.content` 的内容 */
  text?: string;
  /** 完整解析后的 JSON 对象，供调用方需要其他字段（如 finish_reason、usage 等）时使用 */
  raw?: unknown;
}

export interface ParseSseStreamOptions {
  /** abort 信号；触发时会取消 reader 并直接 return，不抛错 */
  signal?: AbortSignal;
  /**
   * 自定义事件提取器：默认提取 `choices[0].delta.content`。
   * 返回 undefined 表示本行无需推送 text（但 raw 仍会传递给 onDelta）。
   */
  extractText?: (json: unknown) => string | undefined;
}

/**
 * 默认文本提取器：兼容 OpenAI / 多数 OpenAI 兼容 API 的 chat.completions 流。
 */
function defaultExtractText(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const choices = (json as { choices?: Array<{ delta?: { content?: unknown } }> }).choices;
  const delta = choices?.[0]?.delta?.content;
  return typeof delta === 'string' ? delta : undefined;
}

/**
 * 解析 OpenAI 兼容的 SSE 流。
 *
 * 调用方负责：
 * - 在 onDelta 回调中累积文本 / 推送到客户端 / 更新 UI
 * - 处理网络错误（reader.read 抛出的 AbortError 会被原样 rethrow，便于调用方区分）
 * - 在调用前完成 response.ok / response.body 的校验
 *
 * 本函数负责：
 * - 正确的 chunk decode（stream 模式）
 * - 跨 chunk 的 buffer 拼接
 * - 跳过空行 / [DONE] / 非 data: 行
 * - 循环结束后 flush 残留 buffer
 */
export async function parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onDelta: (chunk: SseDeltaChunk) => void,
  options: ParseSseStreamOptions = {},
): Promise<void> {
  const { signal, extractText = defaultExtractText } = options;
  const decoder = new TextDecoder();
  let buffer = '';
  let aborted = signal?.aborted ?? false;

  const cancelReader = (): void => {
    aborted = true;
    void reader.cancel().catch(() => {
      // Abort is best-effort; the caller only needs parsing to stop.
    });
  };

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') return;
    if (!trimmed.startsWith('data: ')) return;
    let json: unknown;
    const data = trimmed.slice(6);
    try {
      json = JSON.parse(data);
    } catch (error) {
      console.warn('[LumiMuse] Failed to parse complete SSE data event', error);
      return;
    }
    const text = extractText(json);
    if (text !== undefined || json !== undefined) {
      onDelta({ text, raw: json });
    }
  };

  if (aborted) {
    cancelReader();
    return;
  }

  signal?.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      if (aborted) return;

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (aborted) return;
        throw error;
      }
      if (aborted) return;
      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      const parts = buffer.split('\n\n');
      // 最后一段可能不完整，保留到下次循环
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        for (const line of part.split('\n')) {
          processLine(line);
        }
      }
    }

    // flush 残留 buffer：最后一段如果没有 \n\n 结尾，也要处理一次
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        processLine(line);
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader);
  }
}
