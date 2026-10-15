/** SillyTavern 常用宏。按模板顺序求值，替换得到的数据不再当模板执行。 */
export interface StMacroState {
  variables: Map<string, string>;
  lastUserVariables: Set<string>;
}

export interface StMacroContext {
  user?: string;
  char?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  mesExamples?: string;
  mesExamplesRaw?: string;
  lastUserMessage?: string;
  lastCharMessage?: string;
  lastMessage?: string;
}

export interface StMacroResult {
  content: string;
  usesLastUserMessage: boolean;
}

export function createStMacroState(): StMacroState {
  return { variables: new Map(), lastUserVariables: new Set() };
}

interface MacroBlock {
  name: string;
  tail: string;
  endIndex: number;
}

const CONTENT_MACROS = new Set([
  'user', 'char', 'description', 'personality', 'scenario', 'mesexamples',
  'mesexamplesraw', 'lastusermessage', 'lastcharmessage', 'lastmessage',
  'trim', 'noop', 'newline',
]);

function readMacro(source: string, startIndex: number): MacroBlock | null {
  let depth = 1;
  for (let i = startIndex + 2; i < source.length;) {
    if (source.startsWith('{{', i)) {
      depth += 1;
      i += 2;
    } else if (source.startsWith('}}', i)) {
      depth -= 1;
      if (depth === 0) {
        const inner = source.slice(startIndex + 2, i);
        const head = inner.match(/^\s*(\/\/\/|\/\/|\/?[\w]+)([\s\S]*)$/);
        return { name: head?.[1].toLowerCase() ?? inner.trim(), tail: head?.[2] ?? '', endIndex: i + 2 };
      }
      i += 2;
    } else {
      i += 1;
    }
  }
  return null;
}

function variableArgs(block: MacroBlock): string[] | null {
  const tail = block.tail.trimStart();
  if (!tail.startsWith('::')) return null;
  const args = tail.slice(2);
  if (block.name === 'getvar') return args.trim() ? [args] : null;
  let depth = 0;
  for (let i = 0; i < args.length;) {
    if (args.startsWith('{{', i)) {
      depth += 1;
      i += 2;
    } else if (args.startsWith('}}', i)) {
      depth -= 1;
      i += 2;
    } else if (depth === 0 && args.startsWith('::', i)) {
      return args.slice(0, i).trim() ? [args.slice(0, i), args.slice(i + 2)] : null;
    } else {
      i += 1;
    }
  }
  return null;
}

function supportsMacro(block: MacroBlock): boolean {
  if (block.name === '//' || block.name === 'comment') return true;
  if (['setvar', 'addvar', 'getvar'].includes(block.name)) return variableArgs(block) !== null;
  return CONTENT_MACROS.has(block.name) && block.tail.trim() === '';
}

function commentEnd(source: string, block: MacroBlock): number {
  if (block.name !== '//' || block.tail.trim()) return block.endIndex;
  let depth = 1;
  for (let cursor = block.endIndex; cursor < source.length;) {
    const start = source.indexOf('{{', cursor);
    if (start < 0) break;
    const next = readMacro(source, start);
    if (!next) break;
    if (next.name === '//' && !next.tail.trim()) depth += 1;
    if (next.name === '///' && !next.tail.trim()) {
      depth -= 1;
      if (depth === 0) return next.endIndex;
    }
    cursor = next.endIndex;
  }
  return block.endIndex;
}

/** 导入器使用纯扫描结果提示未知宏及不支持的写法；注释内容不参与检测。 */
export function findUnsupportedStMacros(content: string): string[] {
  const unsupported = new Set<string>();
  function scan(source: string): void {
    for (let cursor = 0; cursor < source.length;) {
      const start = source.indexOf('{{', cursor);
      if (start < 0) break;
      const block = readMacro(source, start);
      if (!block) {
        unsupported.add(source.slice(start + 2).match(/^\s*([^\s:{}]+)/)?.[1].toLowerCase() ?? '未闭合宏');
        cursor = start + 2;
        continue;
      }
      if (block.name === '//' || block.name === 'comment') {
        cursor = commentEnd(source, block);
        continue;
      }
      if (!supportsMacro(block)) unsupported.add(block.name || '无效宏');
      scan(block.tail);
      cursor = block.endIndex;
    }
  }
  scan(content);
  return [...unsupported];
}

function getVariable(state: StMacroState, name: string): string {
  const value = state.variables.get(name) ?? '';
  if (state.lastUserVariables.has(name)) return value;
  return value.trim() && !Number.isNaN(Number(value)) ? String(Number(value)) : value;
}

function addVariable(previous: string, value: string): string {
  try {
    const parsed: unknown = JSON.parse(previous);
    if (Array.isArray(parsed)) return JSON.stringify([...parsed, value]);
  } catch {
    // 非数组变量按数值相加或字符串拼接处理。
  }
  return !Number.isNaN(Number(previous)) && !Number.isNaN(Number(value))
    ? String(Number(previous) + Number(value))
    : previous + value;
}

type RenderMode = 'all' | 'collect' | 'expand';

function renderTemplate(
  source: string,
  state: StMacroState,
  context: Map<string, string | undefined>,
  mode: RenderMode,
): StMacroResult {
  const output: string[] = [];
  const trimIndexes: number[] = [];
  const dataIndexes = new Set<number>();
  let usesLastUserMessage = false;
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('{{', cursor);
    if (start < 0) break;
    const block = readMacro(source, start);
    if (!block) {
      // 未闭合的 {{ 按原文保留并继续扫描，避免一处笔误让同条目后续的宏全部失效。
      output.push(source.slice(cursor, start + 2));
      cursor = start + 2;
      continue;
    }
    output.push(source.slice(cursor, start));
    const raw = source.slice(start, block.endIndex);
    cursor = block.endIndex;
    if (!supportsMacro(block)) {
      output.push(raw);
      continue;
    }
    if (block.name === '//' || block.name === 'comment') {
      cursor = commentEnd(source, block);
      continue;
    }
    const isSetter = block.name === 'setvar' || block.name === 'addvar';
    if (isSetter && mode !== 'expand') {
      const args = variableArgs(block)!;
      const name = renderTemplate(args[0], state, context, 'all').content.trim();
      if (!name) {
        output.push(raw);
        continue;
      }
      const value = renderTemplate(args[1], state, context, 'all');
      const append = block.name === 'addvar';
      state.variables.set(name, append ? addVariable(getVariable(state, name), value.content) : value.content);
      if (value.usesLastUserMessage || (append && state.lastUserVariables.has(name))) state.lastUserVariables.add(name);
      else state.lastUserVariables.delete(name);
      continue;
    }
    if (isSetter || mode === 'collect') {
      output.push(raw);
      continue;
    }
    if (block.name === 'getvar') {
      const name = renderTemplate(variableArgs(block)![0], state, context, mode).content.trim();
      dataIndexes.add(output.length);
      output.push(getVariable(state, name));
      usesLastUserMessage ||= state.lastUserVariables.has(name);
    } else if (block.name === 'trim') {
      trimIndexes.push(output.length);
      output.push('');
    } else if (block.name === 'newline') {
      output.push('\n');
    } else if (block.name !== 'noop') {
      const value = context.get(block.name);
      dataIndexes.add(output.length);
      output.push(value ?? raw);
      usesLastUserMessage ||= block.name === 'lastusermessage' && value !== undefined;
    }
  }
  output.push(source.slice(cursor));
  // 先吃掉不输出文本的指令，再按 trim 清除相邻模板换行；不裁剪插入的数据正文。
  for (const trimIndex of trimIndexes) {
    for (const direction of [-1, 1]) {
      for (let i = trimIndex + direction; i >= 0 && i < output.length; i += direction) {
        if (dataIndexes.has(i) && output[i]) break;
        output[i] = output[i].replace(direction < 0 ? /(?:\r?\n)*$/ : /^(?:\r?\n)*/, '');
        if (output[i]) break;
      }
    }
  }
  return { content: output.join(''), usesLastUserMessage };
}

export function renderStMacros(content: string, state: StMacroState, context: StMacroContext = {}): StMacroResult {
  return renderTemplate(content, state, new Map(Object.entries(context).map(([name, value]) => [name.toLowerCase(), value])), 'all');
}

/** 兼容已有两阶段调用；完整渲染使用 renderStMacros，以保持同条目内的读写顺序。 */
export function collectSetAndAddVars(content: string, state: StMacroState): string {
  return renderTemplate(content, state, new Map(), 'collect').content;
}

export function applyTrimMacro(content: string): string {
  return content.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '');
}

export function expandGetVars(content: string, state: StMacroState, lastUserMessage: string): string {
  return renderTemplate(content, state, new Map([['lastusermessage', lastUserMessage]]), 'expand').content;
}

export function processStMacrosOnce(content: string, state: StMacroState, lastUserMessage: string): string {
  return renderStMacros(content, state, { lastUserMessage }).content;
}
