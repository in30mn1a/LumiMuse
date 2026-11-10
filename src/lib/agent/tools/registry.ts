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

/**
 * 数字开头的短 ID（如 218f6024）常被模型当成数字、漏掉引号，整段参数因此不是合法 JSON
 * （2026-11-09 实跑 8 次）。只在解析已经失败时尝试：给值位置上含字母的十六进制裸词补引号后重新解析，
 * 仍失败就返回 undefined，由调用方报告原始错误。
 */
function parseWithBareIdsQuoted(raw: string): unknown {
  const repaired = raw.replace(
    /([:[,]\s*)(\d[0-9a-f-]*[a-f][0-9a-f-]*)(?=\s*[,}\]])/gi,
    (_, lead: string, token: string) => `${lead}"${token}"`,
  );
  if (repaired === raw) return undefined;
  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}

/** 解析并校验模型给的参数字符串；错误信息直接回给模型，方便它修正后重试。 */
export function parseToolArguments(tool: AgentTool, raw: string): ParsedToolArguments {
  let value: unknown;
  try {
    value = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    value = parseWithBareIdsQuoted(raw);
    if (value === undefined) return { ok: false, error: jsonErrorMessage(raw, error) };
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
