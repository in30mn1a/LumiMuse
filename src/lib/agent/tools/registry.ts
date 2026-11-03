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

/** 解析并校验模型给的参数字符串；错误信息直接回给模型，方便它修正后重试。 */
export function parseToolArguments(tool: AgentTool, raw: string): ParsedToolArguments {
  let value: unknown;
  try {
    value = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, error: '参数不是合法的 JSON' };
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
