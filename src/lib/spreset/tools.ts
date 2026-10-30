/**
 * 预设工具绑定（`extensions.SPreset.ToolBindings`）→ OpenAI `tools` 定义 + 可执行动作。
 *
 * 酒馆里一份绑定的形态是：一段 JS 脚本 `return { name, description, parameters, action }`。
 * `action` 在模型调用工具后执行，返回值会作为 `role: "tool"` 的内容回灌给模型。
 * 这套语义与 OpenAI function calling 一一对应，因此可以原样搬过来。
 *
 * 绑定挂在具体提示词条目上：条目被禁用时工具也应当消失（酒馆同样如此），
 * 由调用方传入 `isEntryEnabled` 判断。
 */

import { disposeSandboxValue, evaluateFactory, type SandboxScope } from '@/lib/spreset/sandbox';
import type { SpresetToolBinding } from '@/lib/spreset/config';

export interface ModelToolCall {
  id: string;
  name: string;
  /** 上游给的是 JSON 字符串（流式时会分片到达）。 */
  arguments: string;
}

export interface LoadedTool {
  name: string;
  description: string;
  /** 直接塞进请求体 `tools` 数组的元素。 */
  definition: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
  run: (args: Record<string, unknown>) => Promise<string>;
  dispose(): void;
}

interface RawToolDefinition {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  action?: unknown;
}

/** 工具 action 超时：脚本是本地预设代码，卡死不该拖住整个聊天请求。 */
const ACTION_TIMEOUT_MS = 10_000;

function defaultParameters(): Record<string, unknown> {
  return { type: 'object', properties: {}, required: [] };
}

/**
 * 把绑定脚本求值成可用工具。
 *
 * 求值失败的绑定直接跳过（当作没有这个工具），并保持其余工具可用——
 * 一个坏掉的插件不该让整轮聊天不可用。
 */
export function loadTools(
  bindings: SpresetToolBinding[],
  isEntryEnabled: (entryId: string) => boolean,
  scope?: SandboxScope,
): LoadedTool[] {
  const tools: LoadedTool[] = [];
  const seen = new Set<string>();

  for (const binding of bindings) {
    if (!binding.enabled || !binding.valid) continue;
    if (!isEntryEnabled(binding.entryId)) continue;
    if (seen.has(binding.name)) continue;

    const raw = evaluateFactory<RawToolDefinition>(binding.code, { timeoutMs: ACTION_TIMEOUT_MS, scope });
    if (!raw || typeof raw !== 'object') continue;

    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : binding.name;
    if (!name || seen.has(name)) {
      disposeSandboxValue(raw);
      continue;
    }
    const description = typeof raw.description === 'string' ? raw.description : '';
    const parameters = raw.parameters && typeof raw.parameters === 'object' && !Array.isArray(raw.parameters)
      ? raw.parameters as Record<string, unknown>
      : defaultParameters();
    const action = typeof raw.action === 'function'
      ? raw.action as (args: Record<string, unknown>) => unknown
      : undefined;

    tools.push({
      name,
      description,
      definition: { type: 'function', function: { name, description, parameters } },
      dispose: () => disposeSandboxValue(raw),
      run: async (args) => {
        if (!action) return JSON.stringify({ ok: true });
        const value = await action(args);
        if (typeof value === 'string') return value;
        try {
          return JSON.stringify(value ?? { ok: true });
        } catch {
          return JSON.stringify({ ok: true });
        }
      },
    });
    seen.add(name);
  }

  return tools;
}

/** 上游给的工具参数可能是半截 JSON；解析失败时交给调用方决定怎么兜底。 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return {};
  }
}
