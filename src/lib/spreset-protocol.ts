/**
 * SPreset（依赖同名插件的酒馆预设）插件协议兼容层。
 *
 * 这类预设把「工具调用」当成输出通道，正文里会出现两种插件私有语法：
 *
 *   1. 控制指令 `<<<|catgodml|...>>>`
 *      - `registerPart:<key>:<描述>` 由插件在构建请求时读走，用来给工具动态追加参数；
 *        模型「调用工具」后，插件再把参数还原成 `<game>` / `<options>` 这些分区。
 *      - `setLastMessage:{{lastUserMessage}}` 把当前用户输入塞进插件的消息表。
 *      - `deepthink` 打开插件的长思考。
 *   2. 请求拼装标记 `<|sep|>` / `<|merge|>` / `<run_tool_replacement>`
 *
 * LumiMuse 既不下发插件工具、也不执行插件脚本，于是这些语法会以纯文本进入 system prompt。
 * 更关键的是：`setLastMessage` 里的 `{{lastUserMessage}}` 会命中组装器
 * 「当前输入已由宏提供」的判定（`prompt-preset-assembler` 的 stripMacroUser），把真正的
 * user 消息从历史里摘掉——模型收到一串 system 却没有任何用户发言，只能吐出拒答。
 *
 * 本模块只做协议层的翻译，不改作者写的正文：
 *   - 渲染前剥掉控制指令与拼装标记；
 *   - 把 registerPart 声明的分区标签转成 strip_tags（剥容器留正文）；
 *   - 工具参数里当思考草稿用的标签（如 `<draft_notes>`）转成 drop 规则；
 *   - 额外生成一条「预设兼容说明」条目，告诉模型直接输出正文即可，别去找工具。
 */

const DIRECTIVE_PREFIX = '<<<|catgodml|';
const DIRECTIVE_SUFFIX = '>>>';
const DIRECTIVE_RE = /<<<\|catgodml\|[\s\S]*?>>>/g;

/** 插件的请求拼装标记；只有在确认是 SPreset 预设时才会被调用方剥掉。 */
const CONTROL_TOKENS = ['<|sep|>', '<|merge|>', '<run_tool_replacement>'] as const;

const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9_~-]*$/;
const TAG_IN_TEXT_RE = /<\/?([A-Za-z][A-Za-z0-9_~-]*)/g;

/** 追加的兼容条目名（导入器与 UI 都用它）。 */
export const SPRESET_COMPAT_ENTRY_NAME = '（兼容）工具协议转换';

export interface SpresetPart {
  /** registerPart 的分区键，如 `story_content`。 */
  key: string;
  /** 描述里出现的标签名（可能多个，如 options 分区同时含 option）。 */
  tags: string[];
  description: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 预设里是否出现 SPreset 控制指令（判据只用指令前缀，避免误伤普通预设）。 */
export function hasSpresetProtocol(contents: readonly string[]): boolean {
  return contents.some(content => typeof content === 'string' && content.includes(DIRECTIVE_PREFIX));
}

function tagsIn(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(TAG_IN_TEXT_RE)) {
    const name = match[1].toLowerCase();
    if (TAG_NAME_RE.test(match[1]) && !tags.includes(name)) tags.push(name);
  }
  return tags;
}

/** 按出现顺序收集 registerPart 声明的输出分区。 */
export function collectSpresetParts(contents: readonly string[]): SpresetPart[] {
  const parts: SpresetPart[] = [];
  const seen = new Set<string>();

  for (const content of contents) {
    if (typeof content !== 'string' || !content.includes(DIRECTIVE_PREFIX)) continue;
    for (const match of content.matchAll(DIRECTIVE_RE)) {
      const inner = match[0].slice(DIRECTIVE_PREFIX.length, -DIRECTIVE_SUFFIX.length);
      const colon = inner.indexOf(':');
      if (colon < 0 || inner.slice(0, colon).trim() !== 'registerPart') continue;

      const body = inner.slice(colon + 1);
      const nextColon = body.indexOf(':');
      const key = (nextColon < 0 ? body : body.slice(0, nextColon)).trim();
      const description = (nextColon < 0 ? '' : body.slice(nextColon + 1)).trim();
      if (!key || seen.has(key)) continue;

      seen.add(key);
      parts.push({ key, tags: tagsIn(description), description });
    }
  }

  return parts;
}

interface ToolBinding {
  name: string;
  params: string[];
}

/**
 * 读取 `extensions.SPreset.ToolBindings` 里的工具名与参数名。
 * 酒馆里该字段既可能是数组（本预设系）也可能是以 uuid 为键的对象，两种都认。
 */
export function collectSpresetToolBindings(root: Record<string, unknown>): ToolBinding[] {
  const spreset = asRecord(asRecord(root.extensions)?.SPreset);
  const bindings = spreset?.ToolBindings;
  const raw = Array.isArray(bindings) ? bindings : Object.values(asRecord(bindings) ?? {});
  const tools: ToolBinding[] = [];

  for (const value of raw) {
    const tool = asRecord(value);
    if (!tool || tool.enabled === false || tool.valid === false) continue;
    const form = asRecord(tool.form);
    const name = textOf(tool.resolvedName).trim()
      || textOf(tool.name).trim()
      || textOf(form?.name).trim();
    if (!name) continue;

    const params: string[] = [];
    const formParams = Array.isArray(form?.parameters) ? form.parameters : [];
    for (const entry of formParams) {
      const param = asRecord(entry);
      const paramName = textOf(param?.name).trim();
      if (paramName && TAG_NAME_RE.test(paramName) && !params.includes(paramName)) params.push(paramName);
    }
    tools.push({ name, params });
  }

  return tools;
}

/**
 * 把控制指令与拼装标记从正文里剥掉。
 *
 * 只应在确认是 SPreset 预设后调用：`<|sep|>` 这类写法在别的预设里可能有别的用途，
 * 兼容层不替作者做决定。
 */
export function stripSpresetControl(content: string): string {
  if (typeof content !== 'string') return '';
  if (!content.includes(DIRECTIVE_PREFIX) && !CONTROL_TOKENS.some(token => content.includes(token))) {
    return content;
  }

  let stripped = content.replace(DIRECTIVE_RE, '');
  for (const token of CONTROL_TOKENS) stripped = stripped.split(token).join('');

  // 指令独占一行时整行会变空：清掉行尾空白并把连续空行收成一个，避免正文里留下一串空洞。
  return stripped
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n+/, '');
}

export interface SpresetCompatPlan {
  parts: SpresetPart[];
  tools: string[];
  /** 当思考草稿用的标签（转成 `#tag` 丢弃规则）。 */
  thinkingTags: string[];
  /** 转成 preset strip_tags 的规则。 */
  stripTags: string[];
}

/** 依据协议内容与工具绑定算出导入期需要的兼容参数。 */
export function planSpresetCompat(
  contents: readonly string[],
  root: Record<string, unknown>,
): SpresetCompatPlan {
  const joined = contents.join('\n');
  const parts = collectSpresetParts(contents);
  const tools = collectSpresetToolBindings(root);
  const thinkingTags: string[] = [];

  for (const tool of tools) {
    for (const param of tool.params) {
      // 参数被写成标签（<draft_notes>…</draft_notes>）说明它是正文分区；否则无从判断，跳过。
      if (!joined.includes(`<${param}`)) continue;
      // 与 registerPart 的分区标签同名时不抢：分区标签优先按「剥容器留正文」处理。
      if (parts.some(part => part.tags.includes(param))) continue;
      if (!thinkingTags.includes(param)) thinkingTags.push(param);
    }
  }

  const stripTags: string[] = [];
  for (const part of parts) {
    for (const tag of part.tags) {
      if (!stripTags.includes(tag)) stripTags.push(tag);
    }
  }
  for (const tag of thinkingTags) {
    if (!stripTags.includes(`#${tag}`)) stripTags.push(`#${tag}`);
  }

  return { parts, tools: tools.map(tool => tool.name), thinkingTags, stripTags };
}

/**
 * 生成追加的「预设兼容说明」条目正文。
 *
 * 语种跟随预设正文（这类预设都是中文），并逐条列出分区标签，让模型知道该用哪套标签输出。
 */
export function buildSpresetCompatContent(plan: SpresetCompatPlan): string {
  const lines = [
    '## 预设兼容说明（LumiMuse 自动生成）',
    '本预设原本依赖 SillyTavern 的 SPreset 插件：它要求模型调用工具，再由插件把工具参数还原成正文分区。',
    '当前环境直接对接模型接口，不下发插件工具，所以按下面几条执行即可：',
    '1. 直接用普通文本回复正文，不要调用任何工具、不要解释自己无法调用工具。',
    '2. 不要把控制指令（形如 <<<|catgodml|...>>>）或请求标记写进回复。',
  ];

  // 没有标签的分区（例如「杂项」）没法用标签表达，列出来只会让模型困惑，跳过。
  const taggedParts = plan.parts.filter(part => part.tags.length > 0);
  if (taggedParts.length > 0) {
    lines.push('3. 需要分区时，用对应的 XML 标签把内容包住：');
    for (const part of taggedParts) {
      const tags = part.tags.map(tag => `<${tag}>`).join(' ');
      lines.push(`   - ${tags}：${part.description || part.key}`);
    }
  } else {
    lines.push('3. 不需要额外分区，正文直接输出即可。');
  }

  if (plan.thinkingTags.length > 0) {
    const tags = plan.thinkingTags.map(tag => `<${tag}>…</${tag}>`).join('、');
    lines.push(`4. 思考过程写在 ${tags} 里，用户不会看到这部分。`);
  }

  if (plan.tools.length > 0) {
    lines.push(`（原预设要求的工具：${plan.tools.join('、')}；此处不需要调用。）`);
  }

  return lines.join('\n');
}
