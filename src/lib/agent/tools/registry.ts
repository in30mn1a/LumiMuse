import { z } from 'zod';
import type { AgentTool } from './types';

/** OpenAI 兼容的 tools 字段。 */
export function toolDefinitions(tools: readonly AgentTool[]): Record<string, unknown>[] {
  return tools.map(tool => {
    const parameters: Record<string, unknown> = z.toJSONSchema(tool.schema, { target: 'draft-7', io: 'input' });
    // 部分上游（经中转的 Gemini 等）会拒绝未知的顶层关键字
    delete parameters.$schema;
    return {
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters },
    };
  });
}

export type ParsedToolArguments =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

const JSON_ERROR_CONTEXT = 30;

/**
 * JSON 解析失败的说明：带上解析器的原因，能定位时附出错位置前后的片段。
 * 只说「不合法」时模型不知道错在哪，长参数会一错再错（2026-11-06 实跑连错 3 次，都是末尾多了一个 }）。
 */
function jsonErrorMessage(raw: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  const position = /position (\d+)/.exec(reason);
  if (!position) return `参数不是合法的 JSON：${reason}`;
  const at = Number(position[1]);
  const before = raw.slice(Math.max(0, at - JSON_ERROR_CONTEXT), at);
  const after = raw.slice(at, at + JSON_ERROR_CONTEXT);
  return `参数不是合法的 JSON：${reason}。出错位置附近：${JSON.stringify(before)} ⟨此处⟩ ${JSON.stringify(after)}`;
}

/** 解析并校验模型给的参数字符串；错误信息直接回给模型，方便它修正后重试。 */
export function parseToolArguments(tool: AgentTool, raw: string): ParsedToolArguments {
  let value: unknown;
  try {
    value = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    return { ok: false, error: jsonErrorMessage(raw, error) };
  }
  const parsed = tool.schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: `参数无效：${detail}` };
  }
  return { ok: true, args: parsed.data as Record<string, unknown> };
}
