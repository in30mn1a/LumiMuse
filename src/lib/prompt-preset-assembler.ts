/**
 * 预设提示词组装管线（SillyTavern preset prompts 移植核心）。
 *
 * 设计对齐 Q1-Q7：
 *   - 单层启用（Q2）：`PresetsEntry.enabled` 直接决定启用。
 *   - 6 条核心 marker（Q3）：charDescription/charPersonality/scenario/dialogueExamples/chatHistory/memoryPackage。
 *   - 完全按酒馆模型组装（Q5）+ 末尾强制追加隐藏 system 行为/时间条目。
 *   - 完全按酒馆语义实现 in-chat 深度注入（Q7）。
 *
 * 与 chat-engine.assemblePrompt 关系：
 *   - 启用预设时由 chat-engine.runChat 主动调用本模块，**完全替代** LumiMuse 原骨架；
 *   - 但 buildHistoryMessages（历史构建）/ parseExampleDialogue / mergeConsecutiveRoles / inline image prompt
 *     这些子流程**复用** chat-engine / merge-messages，保证两条路径的"历史、附件、预算截断、合并"行为完全一致。
 */

import { ChatMessage } from '@/lib/api-client';
import {
  BEHAVIOR_INSTRUCTION,
  buildHistoryMessages,
  normalizeMemoryContextText,
} from '@/lib/chat-engine';
import { buildCurrentTimeInstruction, ChatTimeContext } from '@/lib/chat-time';
import { estimateTokens } from '@/lib/token-counter';
import { mergeConsecutiveRoles } from '@/lib/merge-messages';
import { buildInlinePromptInstruction } from '@/lib/inline-image-prompt';
import { resolveImagePromptStyle } from '@/lib/nai-image';
import {
  prepareImageTagsForLlm,
} from '@/lib/image-prompt-sensitive-tags';
import {
  collectSetAndAddVars,
  createStMacroState,
  expandGetVars,
  StMacroState,
} from '@/lib/st-macros';
import {
  Character,
  Message,
  PresetEntry,
  PresetRole,
  PromptPreset,
  Settings,
} from '@/types';

const MACRO_USER_RE = /\{\{user\}\}/gi;
const MACRO_CHAR_RE = /\{\{char\}\}/gi;

/** Gemini 不允许连续同 role；用零宽 system 隔开不同语义段，避免文风/记忆/示例/当前输入粘成一条 user。 */
export const PRESET_SEGMENT_SEAM = '\u200b';

function appendSegment(target: ChatMessage[], next: ChatMessage[]): void {
  if (next.length === 0) return;
  const last = target[target.length - 1];
  const first = next[0];
  if (last && first && last.role === first.role && last.role !== 'system') {
    target.push({ role: 'system', content: PRESET_SEGMENT_SEAM });
  }
  target.push(...next);
}

function stripLatestPlainTextUser(history: ChatMessage[]): ChatMessage[] {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== 'user') continue;
    if (typeof history[i].content !== 'string') return history;
    return history.filter((_, index) => index !== i);
  }
  return history;
}

export interface MacroContext {
  userName: string;
  charName: string;
}

export function substitutePresetMacros(content: string, ctx: MacroContext): string {
  return content
    .replace(MACRO_CHAR_RE, () => ctx.charName)
    .replace(MACRO_USER_RE, () => ctx.userName);
}

/**
 * 完整宏替换流水线（酒馆子集）：
 *   1. 收集 setvar/addvar 到 state（返回剥离后的 content）
 *   2. 替换 getvar / lastUserMessage
 *   3. 替换 {{user}}/{{char}}
 */
export function renderContentWithStMacros(
  content: string,
  state: StMacroState,
  ctx: MacroContext,
  lastUserMessage: string,
): string {
  const collected = collectSetAndAddVars(content, state);
  const expanded = expandGetVars(collected, state, lastUserMessage);
  return substitutePresetMacros(expanded, ctx);
}

function formatBehaviorAndTimeSystemContent(timeContext?: ChatTimeContext): string {
  let content = `## 行为要求\n${BEHAVIOR_INSTRUCTION}`;
  if (timeContext) {
    content += `\n\n## Current Time\n${buildCurrentTimeInstruction(timeContext)}`;
  }
  return content;
}

/**
 * 渲染单条启用条目为 0..N 条 ChatMessage。
 *  - 非 marker：单条 message（保留 role，做宏替换；空 content 跳过）。
 *  - chatHistory marker：返回 []（由调用方在主循环里处理占位）。
 *  - 其余 marker：按当前角色字段渲染，可能产生多条（dialogueExamples 按行拆 user/assistant）。
 */
/** 把对话历史渲染成 chatHistory marker 的内容（**只含历史正文本身**，不带 <story_history> 容器 tag）。
 *
 * 酒馆 RONG 风格：`<story_history>` 与 `</story_history>` 是「对话历史开始 / 对话历史结束」
 * 两条独立 enabled user 条目的 content。单块兼容模式会由调用方移除这两个独立消息，
 * 再把标签与本函数返回的正文一起放进 chatHistory marker 对应的 system 消息，避免标签
 * 跨越多个 role。
 *
 * 排除"当前最新一条 user 输入"：那是 {{lastUserMessage}} 宏该去的地方，
 * 不属于历史 —— history 应该**截止于最新 user 之前**。
 */
function renderHistoryForChatHistoryMarker(history: ChatMessage[]): string {
  const lines: string[] = [];
  // RONG 单块兼容：把当前 user 留给 {{lastUserMessage}}，这里只渲染它之前的纯文本历史。
  let latestUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user') {
      latestUserIdx = i;
      break;
    }
  }

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (i === latestUserIdx) continue; // 跳过当前 user 输入
    if (m.role === 'system') continue;
    if (typeof m.content !== 'string' || !m.content.trim()) continue;
    const speaker = m.role === 'user' ? '{{user}}' : '{{char}}';
    lines.push(`${speaker}: ${m.content}`);
  }
  if (lines.length === 0) return '';
  return lines.join('\n');
}

function renderEntry(
  entry: PresetEntry,
  ctx: {
    character: Character;
    memoryText: string;
    macro: MacroContext;
    stMacroState: StMacroState;
    lastUserMessageText: string;
  },
): ChatMessage[] {
  const c = ctx.character;

  switch (entry.marker_key) {
    case null:
    case undefined: {
      // 普通文本条目：先做 setvar/addvar 收集 + getvar / lastUserMessage / {{user}}/{{char}} 替换
      const text = renderContentWithStMacros(entry.content, ctx.stMacroState, ctx.macro, ctx.lastUserMessageText).trim();
      if (!text) return [];
      return [{ role: entry.role, content: text }];
    }
    case 'charDescription': {
      // 等价于酒馆 charDescription：角色 system_prompt + basic_info 合并
      // （不相同名酒馆，它指的"描述"是 character.description；LumiMuse 用 basic_info 充当 description。）
      // 记忆包不再追加到这条：可待的 charDescription 是 user，追加后再 merge 会把记忆、文风和示例对粘成一条。
      const parts = [c.system_prompt, c.basic_info].filter(s => s && s.trim());
      if (parts.length === 0) return [];
      return [{ role: entry.role, content: parts.join('\n\n') }];
    }
    case 'charPersonality': {
      const text = c.personality?.trim();
      return text ? [{ role: entry.role, content: `## 角色性格\n${text}` }] : [];
    }
    case 'scenario': {
      const text = c.scenario?.trim();
      return text ? [{ role: entry.role, content: `## 场景设定\n${text}` }] : [];
    }
    case 'dialogueExamples': {
      const raw = c.example_dialogue?.trim();
      if (!raw) return [];
      const body = substitutePresetMacros(raw, ctx.macro);
      return [{ role: entry.role, content: `## 示例对话\n\n${body}` }];
    }
    case 'memoryPackage': {
      const text = normalizeMemoryContextText(ctx.memoryText);
      if (!text) return [];
      return [{ role: entry.role, content: text }];
    }
    case 'chatHistory': {
      // 由 assemblePresetPrompt 在拿到实际 buildHistoryMessages 结果后处理。
      return [];
    }
    default: {
      // 未识别 marker_key：当作普通文本条目渲染（碑记模式）
      const text = renderContentWithStMacros(entry.content, ctx.stMacroState, ctx.macro, ctx.lastUserMessageText).trim();
      if (!text) return [];
      return [{ role: entry.role, content: text }];
    }
  }
}

/**
 * 酒馆 `populateInjectionPrompts`（openai.js:801-866）的 1:1 移植。
 *
 * 在 chatHistory 已就位的 result 数组上执行：
 *   1. 反转数组（最新在前）
 *   2. 对每个 depth 升序遍历
 *   3. 同 depth 内按 order 降序；同 order 内按 role 优先级 system>user>assistant 合组
 *   4. splice 到 `i + totalInserted`
 *   5. 处理完后反转回原顺序
 *
 * 注意：传入数组将被作为不可变输入处理，函数返回新数组。
 */
interface PreparedInjectionGroup {
  depth: number;
  messages: ChatMessage[];
}

function prepareInjectionGroups(
  inChatEntries: PresetEntry[],
  macro: MacroContext,
  stMacroState: StMacroState,
  lastUserMessageText: string,
): PreparedInjectionGroup[] {
  const groups: PreparedInjectionGroup[] = [];
  const depths = Array.from(new Set(inChatEntries.map(e => e.injection_depth))).sort((a, b) => a - b);

  for (const depth of depths) {
    const atDepth = inChatEntries.filter(e => e.injection_depth === depth);

    // 酒馆 openai.js:833 排序 `(+b) - (+a)` 是**降序**（order 大值先被收集）。结合同 depth
    // 一次 splice 到 `i + totalInserted` 后再统一 reverse 的语义，等价于：
    //   - roleMessages 数组在反转前 = [order 大值 role 组, order 小值 role 组]（反转数组中顺序如此）
    //   - reverse 回原 = [order 小值 role 组, order 大值 role 组]
    // 即：**同 depth 同 order 内 role 优先级 system>user>assistant；不同 order 之间小值在前（更靠 chat 末尾离 latest 更近），大值在后（离 latest 更远）**。
    // 注意 Q7 在初步梳理里把"order 大离 latest 近"和"order 小离 latest 近"写反了——以本实现（与酒馆一致）为准。
    const orders = Array.from(new Set(atDepth.map(e => e.injection_order))).sort((a, b) => b - a);
    const roleMessages: ChatMessage[] = [];

    for (const order of orders) {
      const group = atDepth.filter(e => e.injection_order === order);
      // role 优先级（酒馆 openai.js:838 注 "most important go lower"）：system > user > assistant。
      // 收集顺序与最终 prompt 顺序一致（同 order 内 system 在 user 之前，user 在 assistant 之前）。
      for (const role of ['system', 'user', 'assistant'] as PresetRole[]) {
        const byRole = group.filter(e => e.role === role);
        if (byRole.length === 0) continue;
        const body = byRole
          .map(e => renderContentWithStMacros(e.content, stMacroState, macro, lastUserMessageText).trim())
          .filter(Boolean)
          .join('\n');
        if (body) roleMessages.push({ role, content: body });
      }
    }

    if (roleMessages.length > 0) groups.push({ depth: Math.max(0, depth), messages: roleMessages });
  }

  return groups;
}

function populateInjectionPrompts(
  input: ChatMessage[],
  injectionGroups: PreparedInjectionGroup[],
): ChatMessage[] {
  if (injectionGroups.length === 0) return input;

  const reversed = [...input].reverse();
  let totalInserted = 0;
  for (const group of injectionGroups) {
    reversed.splice(group.depth + totalInserted, 0, ...group.messages);
    totalInserted += group.messages.length;
  }
  return reversed.reverse();
}

export interface AssemblePresetPromptOptions {
  /** 用户显示名（用于 {{user}} 替换）。MVP 默认 "用户"。 */
  userName?: string;
}

function hasAttachments(messages: Message[]): boolean {
  return messages.some(message => (message.metadata?.attachments?.length ?? 0) > 0);
}

function estimateMessageContentTokens(message: ChatMessage): number {
  if (typeof message.content === 'string') return estimateTokens(message.content);
  return message.content.reduce(
    (sum, part) => sum + (part.type === 'text' ? estimateTokens(part.text) : 0),
    0,
  );
}

type RelativeSegment =
  | { kind: 'messages'; messages: ChatMessage[]; isStoryHistoryBoundary: boolean; isolate: boolean }
  | { kind: 'history'; role: PresetRole };

/**
 * 预设组装主入口。
 *
 * 步骤：
 *   1. 过滤 enabled && relative（injection_position=0）条目，按 sort_order 升序
 *   2. 用 buildHistoryMessages 构建真实历史（含当前 user、附件与既有预算语义）
 *   3. 仅在无附件、无 in-chat 且显式使用 {{lastUserMessage}} 时保留 RONG 单块历史兼容
 *   4. in-chat 只在真实 history 数组内按 depth/order 注入
 *   5. 顺序扫描 relative；chatHistory marker 处把处理后的 history 整段 splice 进来
 *   3. 若扫完未见启用的 chatHistory marker，强制把 history 追加到末尾（兜底）
 *   6. 末尾追加隐藏 system: BEHAVIOR_INSTRUCTION + CurrentTime
 *   7. 合并连续同 role，并追加 inline image 指令
 */
export async function assemblePresetPrompt(
  character: Character,
  messages: Message[],
  settings: Settings,
  memoryText: string,
  timeContext: ChatTimeContext | undefined,
  preset: PromptPreset,
  entries: PresetEntry[],
  options?: AssemblePresetPromptOptions,
): Promise<ChatMessage[]> {
  const userName = options?.userName ?? '用户';
  const macro: MacroContext = { userName, charName: character.name };

  const relativeEntries = entries
    .filter(e => e.enabled && e.injection_position === 0)
    .sort((a, b) => a.sort_order - b.sort_order);
  const inChatEntries = entries.filter(e => e.enabled && e.injection_position === 1);
  const normalizedMemoryText = normalizeMemoryContextText(memoryText);
  const hasMemoryPackageMarker = relativeEntries.some(e => e.marker_key === 'memoryPackage');
  const memoryMessages: ChatMessage[] = !hasMemoryPackageMarker && normalizedMemoryText
    ? [{ role: 'system', content: normalizedMemoryText }]
    : [];

  // 取最新 user 消息原文供 {{lastUserMessage}} 替换。数据库正文不含展示层时间戳。
  const lastUserRaw = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content.trim();
    }
    return '';
  })();

  // 先渲染固定 preset 上下文，再把其真实 token 占用交给 buildHistoryMessages。
  // 这样 setvar 等不输出内容的宏不会被重复计费，in-chat、行为/时间和 inline 指令也不会漏记。
  const stMacroState = createStMacroState();
  const segments: RelativeSegment[] = [];
  const renderCtx = {
    character,
    memoryText,
    macro,
    stMacroState,
    lastUserMessageText: lastUserRaw,
  };
  for (const entry of relativeEntries) {
    if (entry.marker_key === 'chatHistory') {
      segments.push({ kind: 'history', role: entry.role });
      continue;
    }
    const rendered = renderEntry(entry, renderCtx);
    if (rendered.length > 0) {
      const trimmedContent = entry.content.trim();
      segments.push({
        kind: 'messages',
        messages: rendered,
        isStoryHistoryBoundary: entry.marker_key == null
          && (trimmedContent === '<story_history>' || trimmedContent === '</story_history>'),
        isolate: entry.marker_key === 'dialogueExamples',
      });
    }
  }
  const injectionGroups = prepareInjectionGroups(
    inChatEntries,
    macro,
    stMacroState,
    lastUserRaw,
  );
  const behaviorAndTimeContent = formatBehaviorAndTimeSystemContent(timeContext);
  let inlinePromptInstruction = '';
  if (settings.image_gen?.enabled && settings.image_gen?.inline_prompt) {
    const { tagsForLlm } = prepareImageTagsForLlm(character.image_tags);
    const { tagsForLlm: userTagsForLlm } = prepareImageTagsForLlm(character.user_image_tags);
    inlinePromptInstruction = buildInlinePromptInstruction(
      tagsForLlm,
      userTagsForLlm,
      resolveImagePromptStyle(settings.image_gen),
    );
  }

  let baseTokens = estimateTokens(behaviorAndTimeContent);
  for (const segment of segments) {
    if (segment.kind === 'messages') {
      baseTokens += segment.messages.reduce(
        (sum, message) => sum + estimateMessageContentTokens(message),
        0,
      );
    }
  }
  for (const group of injectionGroups) {
    baseTokens += group.messages.reduce(
      (sum, message) => sum + estimateMessageContentTokens(message),
      0,
    );
  }
  if (memoryMessages.length > 0) baseTokens += estimateTokens(normalizedMemoryText);
  if (inlinePromptInstruction) baseTokens += estimateTokens(inlinePromptInstruction);

  const { history } = await buildHistoryMessages(messages, settings, timeContext, baseTokens);

  const hasChatHistoryMarker = relativeEntries.some(e => e.marker_key === 'chatHistory');
  const hasStoryHistoryOpen = relativeEntries.some(
    e => e.marker_key == null && e.content.trim() === '<story_history>',
  );
  const hasStoryHistoryClose = relativeEntries.some(
    e => e.marker_key == null && e.content.trim() === '</story_history>',
  );
  const usesLastUserMessageMacro = relativeEntries.some(
    e => e.marker_key == null && /\{\{lastUserMessage\}\}/.test(e.content),
  );
  const useRongSingleBlockHistory = hasChatHistoryMarker
    && hasStoryHistoryOpen
    && hasStoryHistoryClose
    && usesLastUserMessageMacro
    && inChatEntries.length === 0
    && !hasAttachments(messages)
    && history.every(message => typeof message.content === 'string')
    && history.at(-1)?.role === 'user';

  // in-chat 只能相对真实聊天历史注入，不能把 relative prompt 条目计入 depth。
  const historyWithInjections = populateInjectionPrompts(history, injectionGroups);
  const historyForPrompt = usesLastUserMessageMacro
    ? stripLatestPlainTextUser(historyWithInjections)
    : historyWithInjections;

  const result: ChatMessage[] = [];
  let chatHistoryInserted = false;
  for (const segment of segments) {
    if (segment.kind === 'messages') {
      if (useRongSingleBlockHistory && segment.isStoryHistoryBoundary) continue;
      if (segment.isolate) appendSegment(result, segment.messages);
      else result.push(...segment.messages);
      continue;
    }
    if (chatHistoryInserted) continue;
    chatHistoryInserted = true;
    appendSegment(result, memoryMessages);
    if (useRongSingleBlockHistory) {
      const block = renderHistoryForChatHistoryMarker(history);
      appendSegment(result, [{
        role: segment.role,
        content: block ? `<story_history>\n${block}\n</story_history>` : '<story_history>\n</story_history>',
      }]);
    } else {
      appendSegment(result, historyForPrompt);
    }
  }

  if (!chatHistoryInserted) {
    appendSegment(result, memoryMessages);
    appendSegment(result, historyForPrompt);
  }

  // 末尾强制追加隐藏 system：行为要求 + Current Time（Q5 决定）
  result.push({
    role: 'system',
    content: behaviorAndTimeContent,
  });

  // 合并连续同 role（与 assemblePrompt 一致）
  const merged = mergeConsecutiveRoles(result);

  // 内联生图提示词：与 assemblePrompt 同等对待，仅在 image_gen.enabled && image_gen.inline_prompt 时
  // 追加到 **最后一条 user** 消息尾部（约束力最强）。
  // 注意：仅作用于发给模型的请求副本，不落库——避免污染对话记录 / 记忆 / 前端显示。
  if (inlinePromptInstruction) {
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const msg = merged[i];
      if (msg.role !== 'user') continue;
      if (typeof msg.content === 'string') {
        msg.content = `${msg.content}\n\n${inlinePromptInstruction}`;
      } else if (Array.isArray(msg.content)) {
        const textIdx = (msg.content as Array<{ type: string }>).findIndex(p => p.type === 'text');
        if (textIdx >= 0) {
          const part = (msg.content as Array<{ type: 'text'; text: string }>)[textIdx];
          (msg.content as Array<{ type: 'text'; text: string }>)[textIdx] = {
            type: 'text',
            text: `${part.text}\n\n${inlinePromptInstruction}`,
          };
        } else {
          (msg.content as Array<{ type: 'text'; text: string }>).unshift({
            type: 'text',
            text: inlinePromptInstruction,
          });
        }
      }
      break;
    }
  }

  return merged;
}
