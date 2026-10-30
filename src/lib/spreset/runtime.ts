/**
 * 预设插件运行时：把酒馆 SPreset 的「请求改写 + 工具绑定 + 输出处理」搬到 LumiMuse。
 *
 * 一轮聊天的完整流程（与酒馆一致）：
 *
 *   assemblePresetPrompt()            → messages（含预置正文与 <run_tool_replacement> 等标记）
 *   ├─ ChatSquash                     → 把对话压成一条，套角色前缀 / 分隔符，跑后置脚本
 *   ├─ buildRequestBase()             → 原始请求体（模型 / 采样 / stream）
 *   ├─ tools                          → 由 ToolBindings 生成 OpenAI tools 定义
 *   ├─ FinalRequestProcessing         → 脚本拿到整个请求体，可换 messages / 加 context 工具 / 定 tool_choice
 *   ├─ 调模型（可多轮）
 *   │    ├─ 返回合成工具调用（如 context）→ 执行 → 结果回灌 → 再来一轮
 *   │    └─ 返回回复工具调用（如 story_reply）→ 交给 toolCallFormatter 还原成正文
 *   └─ OutputPreprocessing            → 逐段放行可见文本
 *
 * 设计原则：脚本说错话由预设负责，运行时只保证「脚本崩了不拖垮聊天」——
 * 每一步失败都退回该步之前的形态，绝不整轮失败。
 */

import {
  buildChatRequestBody,
  ChatMessage,
  ChatToolCall,
  completeRequest,
  CompletionRequestOptions,
  CompletionRequestResult,
  StreamCallbacks,
} from '@/lib/api-client';
import { hasSpresetRuntime, parseSpresetConfig, SpresetConfig } from '@/lib/spreset/config';
import {
  createOutputPreprocessor,
  createToolCallFormatter,
  defaultToolCallText,
  OutputPreprocessor,
  ToolCallFormatter,
} from '@/lib/spreset/output';
import { applyChatSquash, runFinalRequestProcessor } from '@/lib/spreset/request';
import { createSandboxScope } from '@/lib/spreset/sandbox';
import { LoadedTool, ModelToolCall, loadTools } from '@/lib/spreset/tools';
import type { PresetEntry, PromptPreset, Settings } from '@/types';

/** 与酒馆 `tool_call_recurse_limit` 对齐的默认上限：一轮回复最多连续调用几次工具。 */
const DEFAULT_MAX_TOOL_ROUNDS = 5;

type RawMessage = Record<string, unknown>;

export interface PresetRuntime {
  config: SpresetConfig;
  /** 仅明确启用工具消费与格式化时，绑定工具才作为回复通道。 */
  replyToolNames: Set<string>;
  buildRequest(messages: ChatMessage[], settings: Settings): Promise<Record<string, unknown>>;
  executeTool(call: ChatToolCall): Promise<string>;
  formatReply(calls: ChatToolCall[]): string;
  /** 输出过滤器；没有配置时返回 null。 */
  outputFilter: OutputPreprocessor | null;
  dispose(): void;
}

/**
 * 由预设的 `extensions` 构造运行时。没有插件配置 / 配置全部关闭时返回 null，
 * 调用方继续走普通聊天路径。
 */
export function createPresetRuntime(
  preset: Pick<PromptPreset, 'extensions'>,
  entries: readonly PresetEntry[],
  options: {
    userName?: string;
    /** 请求脚本失败时重新组装：未改写的消息还带着只有脚本读得懂的控制指令。 */
    fallbackMessages?: () => Promise<ChatMessage[]>;
  } = {},
): PresetRuntime | null {
  const config = parseSpresetConfig(preset.extensions);
  if (!config || !hasSpresetRuntime(config)) return null;

  const scope = createSandboxScope();
  try {
    const enabledEntryIds = new Set(entries.filter(entry => entry.enabled).map(entry => entry.id));
    const tools: LoadedTool[] = loadTools(config.tools, entryId => enabledEntryIds.has(entryId), scope);

    const formatter: ToolCallFormatter | null = createToolCallFormatter(config.output?.formatter?.script, { scope });
    if (config.output?.formatter && !formatter) {
      console.warn('[spreset] toolCallFormatter 无法求值，回复工具回退到默认拼接');
    }
    const outputFilter = createOutputPreprocessor(config.output?.script, { scope });
    // 按配置而非编译结果判断：脚本坏了也还是回复通道，formatReply 会用默认拼接。
    const toolNames = new Set(config.output?.consumeToolCalls && config.output.formatter ? tools.map(tool => tool.name) : []);
    const userName = options.userName ?? '用户';

    return {
      config,
      replyToolNames: toolNames,
      outputFilter,
      dispose: () => scope.dispose(),

      async buildRequest(messages: ChatMessage[], settings: Settings): Promise<Record<string, unknown>> {
        const squashed = config.chatSquash
          ? applyChatSquash(messages, config.chatSquash, userName, { scope })
          : messages;

        const body = buildChatRequestBody(settings, settings.streaming !== false);
        body.messages = squashed;
        if (tools.length > 0) {
          body.tools = tools.map(tool => tool.definition);
        }

        let request = body;
        if (config.finalRequest) {
          const result = runFinalRequestProcessor(config.finalRequest.script, body, { scope });
          if (result.error) {
            console.warn('[spreset] FinalRequestProcessing 失败，使用未改写请求:', result.error);
            if (options.fallbackMessages) request = { ...body, messages: await options.fallbackMessages() };
          } else {
            request = result.request;
          }
        }
        return restoreDroppedImages(request, messages);
      },

      async executeTool(call: ChatToolCall): Promise<string> {
        const tool = tools.find(item => item.name === call.name);
        if (!tool) return JSON.stringify({ ok: true });
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.arguments || '{}') as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          // 半截 JSON：交给工具自己处理空参数，不要让整轮失败
        }
        try {
          return await tool.run(args);
        } catch (error) {
          console.warn('[spreset] 工具执行失败:', error);
          return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },

      formatReply(calls: ChatToolCall[]): string {
        const asModelCalls: ModelToolCall[] = calls.map(call => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        }));
        const fallback = defaultToolCallText(asModelCalls);
        if (!formatter) return fallback;
        return formatter(asModelCalls, fallback);
      },
    };
  } catch (error) {
    scope.dispose();
    throw error;
  }
}

/** ChatSquash 只压文本，请求脚本也可能换掉整个 messages；用户发的图片不能因此丢失。 */
function restoreDroppedImages(
  request: Record<string, unknown>,
  original: ChatMessage[],
): Record<string, unknown> {
  if (!Array.isArray(request.messages)) return request;
  const current = request.messages as RawMessage[];
  const serialized = JSON.stringify(current);
  const missing = original
    .flatMap(message => (Array.isArray(message.content) ? message.content : []))
    .filter(part => part.type === 'image_url' && !serialized.includes(part.image_url.url));
  if (missing.length === 0) return request;

  const index = current.findLastIndex(message => message.role === 'user');
  if (index < 0) return { ...request, messages: [...current, { role: 'user', content: missing }] };
  const { content } = current[index];
  const existing = Array.isArray(content) ? content : content ? [{ type: 'text', text: content }] : [];
  return {
    ...request,
    messages: current.map((message, position) => (
      position === index ? { ...message, content: [...existing, ...missing] } : message
    )),
  };
}

/** 把工具调用 + 结果回灌进请求体，供下一轮模型调用。 */
function appendToolRound(
  messages: RawMessage[],
  calls: ChatToolCall[],
  results: string[],
  text: string,
  assistantFields?: Record<string, unknown>,
): RawMessage[] {
  const toolCalls = calls.map((call, index) => ({
    id: call.id || `call_${index + 1}`,
    type: 'function',
    function: { name: call.name, arguments: call.arguments || '{}' },
    ...(call.extra_content === undefined ? {} : { extra_content: call.extra_content }),
  }));
  const next: RawMessage[] = [
    ...messages,
    { role: 'assistant', content: text || '', ...assistantFields, tool_calls: toolCalls },
  ];
  calls.forEach((call, index) => {
    next.push({
      role: 'tool',
      tool_call_id: toolCalls[index].id,
      name: call.name,
      content: results[index] ?? '',
    });
  });
  return next;
}

/**
 * 流式放行只发「比上次更长的前缀」增量，避免重复渲染；
 * 保存则以过滤器最新的 output 为准，它可能改写已放行的文本（前端在 done 后刷新对齐）。
 */
class OutputPump {
  private buffer = '';
  private emitted = '';
  private latest = '';
  private state: Record<string, unknown> = {};

  constructor(private readonly filter: OutputPreprocessor | null) {}

  private apply(filter: OutputPreprocessor, final: boolean): string {
    const result = filter(this.buffer, final, this.state);
    this.state = result.state;
    this.latest = result.output;
    if (result.output.length > this.emitted.length && result.output.startsWith(this.emitted)) {
      const addition = result.output.slice(this.emitted.length);
      this.emitted = result.output;
      return addition;
    }
    return '';
  }

  push(delta: string, onChunk: (text: string) => void): void {
    this.buffer += delta;
    if (!this.filter) this.latest = this.buffer;
    const visible = this.filter ? this.apply(this.filter, false) : delta;
    if (visible) onChunk(visible);
  }

  finish(onChunk: (text: string) => void): string {
    if (this.filter) {
      const addition = this.apply(this.filter, true);
      if (addition) onChunk(addition);
    }
    return this.latest;
  }

  visibleText(): string {
    return this.latest;
  }
}

export interface RunPresetChatParams {
  runtime: PresetRuntime;
  messages: ChatMessage[];
  settings: Settings;
  callbacks: StreamCallbacks;
  /** 注入点：测试可换成假的模型；生产走 api-client。 */
  complete?: (
    settings: Settings,
    body: Record<string, unknown>,
    options: CompletionRequestOptions,
  ) => Promise<CompletionRequestResult>;
  maxToolRounds?: number;
}

/**
 * 跑一轮带插件运行时的聊天。
 *
 * 与普通路径的差别只在请求形态与工具循环；正文最终仍走 `callbacks.onDone`，
 * 由 chat-engine 继续做日志、剥离与落库，行为边界保持一致。
 */
export async function runPresetChat(params: RunPresetChatParams): Promise<void> {
  const { runtime, messages, settings, callbacks } = params;
  const complete = params.complete ?? completeRequest;
  const maxRounds = Math.max(0, params.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS);
  const pump = new OutputPump(runtime.outputFilter);

  let rounds = 0;
  let hasText = false;

  const emitText = (text: string): void => {
    if (!text || callbacks.signal?.aborted) return;
    pump.push(text, callbacks.onChunk);
    hasText = true;
  };

  try {
    let finalText: string;
    try {
      if (callbacks.signal?.aborted) return;
      let request = await runtime.buildRequest(messages, settings);
      while (rounds <= maxRounds && !callbacks.signal?.aborted) {
        rounds += 1;
        const result = await complete(settings, request, {
          signal: callbacks.signal,
          onText: emitText,
          onUsage: callbacks.onUsage,
        });
        if (callbacks.signal?.aborted) break;

        // 回复工具：参数就是正文，交给预设的 formatter 还原成 <game> 等分区。
        const replyCalls = result.toolCalls.filter(call => runtime.replyToolNames.has(call.name));
        if (replyCalls.length > 0) {
          const formatted = runtime.formatReply(replyCalls);
          if (formatted.trim()) {
            emitText(`${hasText ? '\n' : ''}${formatted}`);
            break;
          }
        }

        // 合成工具（如 context）：执行后把结果回灌，继续下一轮。
        if (result.toolCalls.length > 0) {
          const results: string[] = [];
          for (const call of result.toolCalls) {
            if (callbacks.signal?.aborted) break;
            results.push(await runtime.executeTool(call));
          }
          if (callbacks.signal?.aborted) break;
          const currentMessages = Array.isArray(request.messages)
            ? request.messages as RawMessage[]
            : [];
          request = {
            ...request,
            messages: appendToolRound(currentMessages, result.toolCalls, results, result.text, result.assistantFields),
          };
          continue;
        }

        // 纯文本回复：正常结束。
        break;
      }

      finalText = callbacks.signal?.aborted ? pump.visibleText() : pump.finish(callbacks.onChunk);
      if (!finalText.trim()) {
        if (callbacks.signal?.aborted) return;
        callbacks.onError(new Error('API 未返回有效正文（可能仅返回了工具调用）'));
        return;
      }
    } catch (error) {
      const visible = pump.visibleText();
      if (visible) {
        try {
          if (callbacks.signal?.aborted) await callbacks.onDone(visible);
          else await callbacks.onPartial?.(visible);
        } catch { /* 保存失败不掩盖原错误 */ }
      }
      if (callbacks.signal?.aborted) return;
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // 放在 catch 之外：保存失败不是模型调用失败，再走一遍错误路径会把回复存两次。
    await callbacks.onDone(finalText);
  } finally {
    runtime.dispose();
  }
}
