/**
 * 请求侧的两个改写环节：
 *   1. ChatSquash —— 把整段对话压成一条（可带角色前缀与分隔符），再交给插件脚本改写。
 *   2. FinalRequestProcessing —— 拿到最终请求体，由预设脚本决定怎么发（可直接换掉 messages、
 *      加 tools、改 tool_choice）。
 *
 * 两者都是「脚本说了算」：我们只负责把结构化数据递进去、把返回值接回来，
 * 不做任何语义修剪——否则就不叫移植了。
 */

import type { ChatMessage, ChatMessageContent } from '@/lib/api-client';
import { buildChatRequestBody } from '@/lib/api-client';
import { evaluateFunction, SandboxOptions } from '@/lib/spreset/sandbox';
import type { SpresetChatSquash } from '@/lib/spreset/config';
import type { Settings } from '@/types';

/** 把 ChatMessage.content（字符串或多段）拍平成纯文本。 */
export function messageText(content: ChatMessageContent | unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const record = part as { type?: unknown; text?: unknown };
        return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function expandUserMacro(template: string, userName: string): string {
  return template.replace(/\{\{\s*user\s*\}\}/gi, userName);
}

/**
 * ChatSquash：把聊天压成一条消息。
 *
 * 与酒馆语义对齐的要点：
 *   - 只压 user/assistant（真正的对话），system 条目原位保留；
 *   - 用户/角色各有前后缀，条目之间用分隔符合并；
 *   - `squashed_post_script` 拿到合并后的整段文本做最后改写（本预设用它把 `|角色|`
 *     标记换成 JSON 片段，供后面的 FinalRequestProcessing 拼装）；
 *   - `conditional_enabled` 时，只有正文里出现 conditionalTag 才压。
 */
export function applyChatSquash(
  messages: ChatMessage[],
  squash: SpresetChatSquash,
  userName: string,
  options: SandboxOptions = {},
): ChatMessage[] {
  if (!squash.enabled) return messages;

  if (squash.conditionalEnabled) {
    const tag = squash.conditionalTag;
    const hit = messages.some(message => messageText(message.content).includes(tag));
    if (!hit) return messages;
  }

  const postScript = squash.postScriptEnabled
    ? evaluateFunction<string, string>(squash.postScript, options)
    : null;

  const userPrefix = expandUserMacro(squash.userPrefix, userName);
  const userSuffix = expandUserMacro(squash.userSuffix, userName);
  const charPrefix = expandUserMacro(squash.charPrefix, userName);
  const charSuffix = expandUserMacro(squash.charSuffix, userName);

  const out: ChatMessage[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const joined = squash.enableSeparator
      ? buffer.join(squash.separator)
      : buffer.join('\n');
    let text = joined;
    if (postScript) {
      try {
        const rewritten = postScript(joined);
        if (typeof rewritten === 'string') text = rewritten;
      } catch {
        // 脚本抛错时退回未改写文本：压扁本身比脚本正确性更重要
      }
    }
    out.push({
      role: squash.role,
      content: `${squash.prefixSystem}${text}${squash.suffixSystem}`,
    });
    buffer = [];
  };

  try {
    for (const message of messages) {
      if (message.role === 'system') {
        flush();
        out.push(message);
        continue;
      }
      const text = messageText(message.content);
      buffer.push(message.role === 'user'
        ? `${userPrefix}${text}${userSuffix}`
        : `${charPrefix}${text}${charSuffix}`);
    }
    flush();
    return out;
  } finally {
    postScript?.dispose();
  }
}

/** 预设脚本里常见的 `@internal` 字段：只用于脚本间传值，不能真的发给上游。 */
const INTERNAL_BODY_KEYS = ['custom_include_body'] as const;

export interface FinalRequestResult {
  request: Record<string, unknown>;
  /** 脚本报错时的原因；此时 request 保持传入的原样。 */
  error?: string;
}

/**
 * FinalRequestProcessing：把拼好的请求体交给脚本，再把它的返回值当最终请求体。
 *
 * 脚本报错不抛给用户：退回到未改写的请求体，聊天照常继续（失败不阻塞原则）。
 */
export function runFinalRequestProcessor(
  script: string,
  request: Record<string, unknown>,
  options: SandboxOptions = {},
): FinalRequestResult {
  const fn = evaluateFunction<{ request: Record<string, unknown> }, unknown>(script, options);
  if (!fn) return { request, error: '脚本无法求值' };

  try {
    let result: unknown;
    try {
      const copy = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
      result = fn({ request: copy });
    } catch (error) {
      return { request, error: error instanceof Error ? error.message : String(error) };
    }

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { request, error: '脚本没有返回请求对象' };
    }

    const next = { ...(result as Record<string, unknown>) };
    for (const key of INTERNAL_BODY_KEYS) delete next[key];

    try {
      return { request: JSON.parse(JSON.stringify(next)) as Record<string, unknown> };
    } catch {
      return { request, error: '脚本返回的请求体无法序列化' };
    }
  } finally {
    fn.dispose();
  }
}

/** 组装初始请求体（与 api-client 的流式路径同一口径）。 */
export function buildRequestBase(settings: Settings, stream: boolean): Record<string, unknown> {
  return buildChatRequestBody(settings, stream);
}
