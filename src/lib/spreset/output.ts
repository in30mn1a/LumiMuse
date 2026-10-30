/**
 * 输出侧的两个环节：
 *   1. `toolCallFormatter` —— 把模型返回的 tool_call 参数还原成聊天正文（`<game>`/`<options>` 等分区）。
 *      SPreset 的整套输出格式就靠它，所以这里原样执行预设脚本，不做内置映射。
 *   2. `OutputPreprocessing` —— 流式输出过滤器，按 `{output, hold, state}` 契约逐段放行。
 */

import { evaluateFunction, SandboxOptions } from '@/lib/spreset/sandbox';
import type { ModelToolCall } from '@/lib/spreset/tools';

export interface ToolCallFormatter {
  (calls: ModelToolCall[], defaultText: string): string;
  dispose(): void;
}

export interface OutputPreprocessor {
  (buffer: string, final: boolean, state: Record<string, unknown>): {
    output: string;
    hold: string;
    state: Record<string, unknown>;
  };
  dispose(): void;
}

/** 预设没给格式化脚本时的兜底：直接吐参数里的 content，或者拼接所有字符串字段。 */
export function defaultToolCallText(calls: ModelToolCall[]): string {
  return calls
    .map((call) => {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        return call.arguments;
      }
      if (!args || typeof args !== 'object') return String(args ?? '');
      const record = args as Record<string, unknown>;
      if (typeof record.content === 'string') return record.content;
      return Object.values(record)
        .filter((value): value is string => typeof value === 'string')
        .join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 编译 `toolCallFormatter` 脚本。
 *
 * 脚本签名是 `({ calls, defaultText }) => string`；求值失败返回 null，由调用方退回默认拼接，
 * 保证「插件坏了也有正文」。
 */
export function createToolCallFormatter(
  script: string | undefined,
  options: SandboxOptions = {},
): ToolCallFormatter | null {
  if (!script || !script.trim()) return null;
  const fn = evaluateFunction<{ calls: ModelToolCall[]; defaultText: string }, unknown>(script, options);
  if (!fn) return null;

  const format = (calls: ModelToolCall[], defaultText: string): string => {
    try {
      const result = fn({ calls, defaultText });
      return typeof result === 'string' ? result : defaultText;
    } catch {
      return defaultText;
    }
  };
  return Object.assign(format, { dispose: () => fn.dispose() });
}

/**
 * 编译 `OutputPreprocessing` 脚本。
 *
 * 脚本签名是 `({ buffer, final, state }) => ({ output, hold, state })`：
 * 返回的 `output` 是本次可放行的可见文本，`hold` 是继续暂存的尾巴。
 * 脚本报错时退化为直通（output=buffer），不让一轮回复因为过滤器崩掉而丢内容。
 */
export function createOutputPreprocessor(
  script: string | undefined,
  options: SandboxOptions = {},
): OutputPreprocessor | null {
  if (!script || !script.trim()) return null;
  const fn = evaluateFunction<
    { buffer: string; final: boolean; state: Record<string, unknown> },
    unknown
  >(script, options);
  if (!fn) return null;

  const filter = (buffer: string, final: boolean, state: Record<string, unknown>) => {
    try {
      const result = fn({ buffer, final, state }) as {
        output?: unknown;
        hold?: unknown;
        state?: unknown;
      } | null;
      const output = typeof result?.output === 'string' ? result.output : buffer;
      const hold = typeof result?.hold === 'string' ? result.hold : '';
      const nextState = result?.state && typeof result.state === 'object' && !Array.isArray(result.state)
        ? result.state as Record<string, unknown>
        : state;
      return { output, hold, state: nextState };
    } catch {
      return { output: buffer, hold: '', state };
    }
  };
  return Object.assign(filter, { dispose: () => fn.dispose() });
}
