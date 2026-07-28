/**
 * SillyTavern 宏子集处理（RONG 预设依赖的关键宏）。
 *
 * 支持 4 类核心宏：
 *   - {{setvar::name::value}}   定义变量；该条目本身**不输出文本**（但保留同条目中其余文本）
 *   - {{addvar::name::value}}   append 到变量
 *   - {{getvar::name}}          替换为当前变量值（空字符串若未定义）
 *   - {{lastUserMessage}}       替换为最新 user 消息原文（去时间戳）
 *
 * 用法（与 prompt-preset-assembler 集成）：
 *   1. 第一遍扫所有 relative 启用条目：逐条处理其中出现的 setvar/addvar → 累积 variables map。
 *      （同时**剔除**这些宏指令，得到该条目的 final content。）
 *   2. 第二遍所有 relative + in-chat 内容做 getvar/lastUserMessage 替换。
 *
 * 与酒馆 exact 行为差异：RONG 风格预设把 setvar/addvar/getvar 都写在"普通条目"的内容里——
 * 酒馆是把 setvar/addvar 写在独立条目作为"占位指令"（内容渲染前被吃掉），getvar 写在 consumer 条目。
 * 上面算法对该预设能产生等价效果。
 */

export interface StMacroState {
  variables: Map<string, string>;
}

export function createStMacroState(): StMacroState {
  return { variables: new Map() };
}

/**
 * 处理一段 content：
 *   - 移除 setvar/addvar 指令并更新 state.variables
 *   - 不做 getvar/lastUserMessage 替换（留给 expandPass）
 *
 * 返回剥离 setvar/addvar 之后的 content（可能为空）。
 */
const SETVAR_OPEN = /\{\{(setvar|addvar)::/g;

/**
 * 找到一个宏调用（{{setvar::...}} 或 {{addvar::...}}）从 startIndex 开始的范围。
 * 处理嵌套：value 部分可能含 {{user}}/{{char}} 等其它宏的 "}}" 闭合。
 * 返回 { start, end, kind, name, value } 或 null（没找到/未闭合）。
 *
 * 用 brace-depth 扫描：遇到 "{{" 深度 +1，遇到 "}}" 深度 -1，深度回到 0 的 "}}" 即结束。
 * startIndex 必须正好指向某个 "{{"（kind setvar/addvar 之一）。
 */
function parseMacroBlock(source: string, startIndex: number): {
  kind: 'setvar' | 'addvar';
  name: string;
  value: string;
  startIndex: number;
  endIndex: number;
} | null {
  // 找最近的宏起始（{{setvar:: 或 {{addvar::）
  const head = source.slice(startIndex).match(/^\{\{(setvar|addvar)::/);
  if (!head) return null;
  const kind = head[1] as 'setvar' | 'addvar';
  const afterKind = startIndex + head[0].length;

  // name 从这里到下一个 ::
  const nameEnd = source.indexOf('::', afterKind);
  if (nameEnd < 0) return null;
  const name = source.slice(afterKind, nameEnd);

  // value 从下一个字符开始；深度扫描找配对的 }}
  let depth = 2; // 已经是 2 个嵌套 {{ + {{ ?—— 不，整个宏本身是 1 个 { 层；text 内嵌套才 +1
  depth = 1;
  let i = nameEnd + 2;
  const valueStart = i;
  while (i < source.length) {
    if (source.startsWith('{{', i)) {
      depth += 1;
      i += 2;
      continue;
    }
    if (source.startsWith('}}', i)) {
      depth -= 1;
      if (depth === 0) {
        const value = source.slice(valueStart, i);
        return { kind, name: name.trim(), value, startIndex, endIndex: i + 2 };
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  return null; // 未闭合
}

/**
 * 处理一段 content：
 *   - 移除 setvar/addvar 指令并更新 state.variables
 *   - 不做 getvar/lastUserMessage 替换（留给 expandPass）
 *
 * 返回剥离 setvar/addvar 之后的 content（可能为空）。
 */
export function collectSetAndAddVars(content: string, state: StMacroState): string {
  const out: string[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    // 找下一处 {{setvar:: 或 {{addvar::
    SETVAR_OPEN.lastIndex = cursor;
    const m = SETVAR_OPEN.exec(content);
    if (!m) break;
    const startIndex = m.index;
    out.push(content.slice(cursor, startIndex));

    const block = parseMacroBlock(content, startIndex);
    if (!block) {
      // 未闭合：把 "{{" 头按原文输出，从 startIndex+2 继续找
      out.push(content.slice(startIndex, startIndex + 2));
      cursor = startIndex + 2;
      continue;
    }

    const name = block.name;
    if (block.kind === 'setvar') {
      state.variables.set(name, block.value);
    } else {
      const prev = state.variables.get(name);
      state.variables.set(name, (prev ?? '') + block.value);
    }
    cursor = block.endIndex;
  }
  out.push(content.slice(cursor));
  return out.join('');
}

/**
 * 处理一段 content：
 *   - {{getvar::name}} 替换为 state.variables.get(name) ?? ''
 *   - {{lastUserMessage}} 替换为 lastUserMessage
 */
export function expandGetVars(
  content: string,
  state: StMacroState,
  lastUserMessage: string,
): string {
  return content
    .replace(/\{\{getvar::([^}:]+)\}\}/g, (match, name: string) => state.variables.get(name.trim()) ?? '')
    .replace(/\{\{lastUserMessage\}\}/g, () => lastUserMessage);
}

/**
 * 单段 convenience API：先 collect 再 expand。
 * 用于单条 entry.content 处理（不需要跨条目聚合时）。
 */
export function processStMacrosOnce(
  content: string,
  state: StMacroState,
  lastUserMessage: string,
): string {
  const collected = collectSetAndAddVars(content, state);
  return expandGetVars(collected, state, lastUserMessage);
}
