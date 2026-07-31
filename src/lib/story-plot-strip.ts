/**
 * 落库前剥离 AI 回复中的「预设包装 XML 容器」。
 *
 * 背景：SillyTavern 预设（RONG / 可待 等）都会让模型输出带一层包装容器：
 *   RONG（story_plot 协议）→ <story_plot><story_scene>…</story_scene><story_body>…正文…</story_body>…</story_plot>
 *   可待（content/scene/thinking 协议）→ <scene>…地点…</scene> + <content>…正文…</content> + <thinking>…思考…</thinking> + <output-template>…</output-template>
 *
 * 预设自带 strip_tags：声明「本预设的输出应剥掉哪些 tag 的包装」，导入时由 auto-detect 生成默认，UI 可手工增删。
 *
 * 两种协议对应两种调用入口（本模块导出单一入口 stripByPresetRules，按 rules 内容分流）：
 *   - 含 block 规则 'story_plot'：走旧 RONG 协议专用逻辑 stripStoryPlotXml（"以 <story_plot 开头"触发，保 body 弃 scene）
 *   - 否则：走参数化 stripContainerTags——剥 block 容器、丢 drop 内容，对正文里的普通 tag 字面量不误伤
 *
 * 参数化 tag 语法（与预设 strip_tags 存储一致）：
 *   - 'xxx'       剥开/闭合 tag，保留内部文本（用于 <content>…正文…</content> → 正文）
 *   - '#xxx'      整块连内容丢弃，EOF 未闭合也丢（用于 #thinking 思考草稿、#output-template 模板）
 */

// ---------- 参数化 tag 列表解析 ----------

const DROP_PREFIX = '#';

const RAW_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** 解析单条 tag 规则，返回 [mode, name]；非法返回 null。 */
function parseTagEntry(raw: unknown): { mode: 'block' | 'drop'; name: string } | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const isDrop = trimmed.startsWith(DROP_PREFIX);
  const name = isDrop ? trimmed.slice(1).trim() : trimmed;
  if (!RAW_NAME_RE.test(name)) return null;
  return { mode: isDrop ? 'drop' : 'block', name };
}

// ---------- 参数化剥离（内容/thinking 类协议） ----------

type ParsedTagRule = { mode: 'block' | 'drop'; name: string };

type ParsedTagToken = {
  start: number;
  end: number;
  name: string;
  mode: 'block' | 'drop';
  kind: 'open' | 'close';
  selfClosing: boolean;
  pairIndex: number | null;
};

type BlockContext = {
  name: string;
  outputStart: number;
  atStart: boolean;
};

type DropContext = {
  name: string;
  preserveLeadingLayout: boolean;
};

function parseTagRules(tags: string[]): ParsedTagRule[] {
  const out: ParsedTagRule[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const parsed = parseTagEntry(raw);
    if (!parsed) continue;
    const name = parsed.name.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ ...parsed, name });
  }
  return out;
}

function findMarkupEnd(text: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

function parseCompleteTag(
  text: string,
  start: number,
  end: number,
  ruleModes: ReadonlyMap<string, 'block' | 'drop'>,
): Omit<ParsedTagToken, 'start' | 'end' | 'pairIndex'> | null {
  let inner = text.slice(start + 1, end);
  if (!inner || /^\s/.test(inner)) return null;

  if (inner.startsWith('/')) {
    const closeBody = inner.slice(1);
    const nameEnd = closeBody.search(/\s/);
    const name = nameEnd < 0 ? closeBody : closeBody.slice(0, nameEnd);
    const trailing = nameEnd < 0 ? '' : closeBody.slice(nameEnd);
    const normalizedName = name.toLowerCase();
    const mode = ruleModes.get(normalizedName);
    if (!mode || trailing.trim() !== '') return null;
    return { name: normalizedName, mode, kind: 'close', selfClosing: false };
  }

  let selfClosing = false;
  if (inner.endsWith('/')) {
    selfClosing = true;
    inner = inner.slice(0, -1).trimEnd();
  }
  const nameEnd = inner.search(/\s/);
  const name = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
  const normalizedName = name.toLowerCase();
  const mode = ruleModes.get(normalizedName);
  if (!mode) return null;
  return { name: normalizedName, mode, kind: 'open', selfClosing };
}

function couldBeRuleTagPrefix(suffix: string, ruleNames: readonly string[]): boolean {
  const normalizedSuffix = suffix.toLowerCase();
  for (const name of ruleNames) {
    for (const target of [`<${name}`, `</${name}`]) {
      if (target.startsWith(normalizedSuffix)) return true;
      if (!normalizedSuffix.startsWith(target)) continue;
      const rest = normalizedSuffix.slice(target.length);
      if (target.startsWith('</')) {
        if (/^\s*$/.test(rest)) return true;
      } else if (rest === '' || rest.startsWith('/') || /^\s/.test(rest)) {
        return true;
      }
    }
  }
  return false;
}

function scanParameterizedTags(
  text: string,
  rules: readonly ParsedTagRule[],
): { tokens: ParsedTagToken[]; partialStart: number | null } {
  const ruleModes = new Map(rules.map(rule => [rule.name, rule.mode]));
  const ruleNames = rules.map(rule => rule.name);
  const tokens: ParsedTagToken[] = [];
  let partialStart: number | null = null;
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    if (start < 0) break;
    const end = findMarkupEnd(text, start);
    if (end < 0) {
      if (couldBeRuleTagPrefix(text.slice(start), ruleNames)) partialStart = start;
      break;
    }
    const parsed = parseCompleteTag(text, start, end, ruleModes);
    if (parsed) {
      tokens.push({ start, end: end + 1, pairIndex: null, ...parsed });
    }
    cursor = end + 1;
  }

  const openStacks = new Map<string, number[]>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.selfClosing) continue;
    if (token.kind === 'open') {
      const stack = openStacks.get(token.name) ?? [];
      stack.push(index);
      openStacks.set(token.name, stack);
      continue;
    }
    const stack = openStacks.get(token.name);
    const openIndex = stack?.pop();
    if (openIndex === undefined) continue;
    token.pairIndex = openIndex;
    tokens[openIndex].pairIndex = index;
  }

  return { tokens, partialStart };
}

function trimWhitespaceAfter(text: string, start: number): string {
  let end = text.length;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

function isLayoutWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function skipLayoutWhitespaceAfter(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && isLayoutWhitespace(text[cursor])) cursor += 1;
  return cursor;
}

function transformParameterizedTags(
  rawText: string,
  tags: string[],
  streaming: boolean,
): { text: string; matched: boolean } {
  const rules = parseTagRules(tags);
  if (rules.length === 0) return { text: rawText, matched: false };

  const { tokens, partialStart } = scanParameterizedTags(rawText, rules);
  const firstNonWhitespace = rawText.search(/\S/);
  let lastNonWhitespace = rawText.length - 1;
  while (lastNonWhitespace >= 0 && /\s/.test(rawText[lastNonWhitespace])) {
    lastNonWhitespace -= 1;
  }

  let out = '';
  let cursor = 0;
  let matched = false;
  let protocolActive = false;
  let protocolAtHead = false;
  const blockStack: BlockContext[] = [];
  const dropStack: DropContext[] = [];
  if (partialStart !== null && partialStart === firstNonWhitespace) {
    matched = true;
    protocolActive = true;
    protocolAtHead = true;
  }

  const appendVisible = (text: string) => {
    if (!text || dropStack.length > 0) return;
    let visible = text;
    const activeBlock = blockStack[blockStack.length - 1];
    if (activeBlock?.atStart) {
      visible = visible.replace(/^\s+/, '');
    }
    if (!visible) return;
    out += visible;
    if (/\S/.test(visible)) {
      const currentBlock = blockStack[blockStack.length - 1];
      if (currentBlock) currentBlock.atStart = false;
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (partialStart !== null && token.start >= partialStart) break;
    appendVisible(rawText.slice(cursor, token.start));

    if (dropStack.length > 0) {
      const activeDrop = dropStack[dropStack.length - 1];
      if (token.mode === 'drop' && token.name === activeDrop.name) {
        if (token.kind === 'open' && !token.selfClosing) {
          dropStack.push({ name: token.name, preserveLeadingLayout: false });
        } else if (token.kind === 'close') {
          const closedDrop = dropStack.pop();
          if (dropStack.length === 0) {
            cursor = closedDrop?.preserveLeadingLayout
              ? skipLayoutWhitespaceAfter(rawText, token.end)
              : token.end;
            continue;
          }
        }
      }
      cursor = token.end;
      continue;
    }

    const tokenIsAtHead = token.start === firstNonWhitespace;
    if (token.mode === 'drop' && token.kind === 'open') {
      matched = true;
      protocolActive = true;
      protocolAtHead ||= tokenIsAtHead;
      const preserveLeadingLayout = isLayoutWhitespace(out[out.length - 1]);
      if (token.selfClosing) {
        cursor = preserveLeadingLayout
          ? skipLayoutWhitespaceAfter(rawText, token.end)
          : token.end;
      } else {
        dropStack.push({ name: token.name, preserveLeadingLayout });
        cursor = token.end;
      }
      continue;
    }

    if (token.mode === 'block' && token.kind === 'open') {
      const canStripUnclosed = protocolActive || tokenIsAtHead;
      if (token.pairIndex !== null || token.selfClosing || canStripUnclosed) {
        matched = true;
        protocolActive = true;
        protocolAtHead ||= tokenIsAtHead;
        if (!token.selfClosing) {
          blockStack.push({ name: token.name, outputStart: out.length, atStart: true });
        }
        cursor = token.end;
        continue;
      }
      if (streaming) {
        cursor = token.start;
        break;
      }
      appendVisible(rawText.slice(token.start, token.end));
      cursor = token.end;
      continue;
    }

    if (token.mode === 'block' && token.kind === 'close') {
      const isTrailingClose = token.end - 1 >= lastNonWhitespace;
      if (token.pairIndex !== null || protocolActive || isTrailingClose) {
        matched = true;
        protocolActive = true;
        const block = blockStack[blockStack.length - 1];
        if (block?.name === token.name) {
          blockStack.pop();
          out = trimWhitespaceAfter(out, block.outputStart);
          if (!block.atStart) {
            const parentBlock = blockStack[blockStack.length - 1];
            if (parentBlock) parentBlock.atStart = false;
          }
        }
        cursor = token.end;
        continue;
      }
    }

    appendVisible(rawText.slice(token.start, token.end));
    cursor = token.end;
  }

  const stoppedAtAmbiguousBlock = streaming && cursor < rawText.length
    && tokens.some(token => token.start === cursor && token.mode === 'block' && token.kind === 'open');
  if (!stoppedAtAmbiguousBlock) {
    const visibleEnd = partialStart ?? rawText.length;
    appendVisible(rawText.slice(cursor, visibleEnd));
    if (!streaming && partialStart !== null && !protocolActive && dropStack.length === 0) {
      appendVisible(rawText.slice(partialStart));
    }
  }

  if (!matched) {
    return { text: streaming ? out.trimEnd() : rawText, matched: false };
  }

  if (protocolAtHead) out = out.trimStart();
  out = out.trimEnd();
  return { text: out, matched: true };
}

/**
 * 按 tags 剥掉指定 XML 容器（内容型协议）。
 *
 * 扫描器只做确定性线性前进；drop 块在 EOF 未闭合时也整段丢弃，避免 abort
 * 把思考草稿写入数据库。普通文本没有命中协议 tag 时按字节原样返回。
 */
export function stripContainerTags(rawText: string, tags: string[]): string {
  return transformParameterizedTags(rawText, tags, false).text;
}

// ---------- RONG 旧剧本协议（strip_rules 含 block 规则 'story_plot' 时走这条） ----------

const STORY_PLOT_PREFIX = '<story_plot';
const STORY_BODY_CLOSE = '</story_body>';
const STORY_SCENE_PREFIX = '<story_scene';
const STORY_SCENE_CLOSE = '</story_scene>';
const STORY_AFTER_FORMAT_CLOSE = '</story_after_format>';
/** 旧协议扫描用的 tag 前缀表；导出供测试校验它与 LEGACY_STORY_PLOT_TAGS 未漏同步。 */
export const PROTOCOL_TAG_PREFIXES = [
  '<story_plot',
  '</story_plot>',
  '<story_scene',
  '</story_scene>',
  '<story_body',
  STORY_BODY_CLOSE,
  '<story_after_format',
  STORY_AFTER_FORMAT_CLOSE,
  '<story_done',
] as const;

function isStoryPlotPrefix(text: string): boolean {
  if (!text.startsWith(STORY_PLOT_PREFIX)) return false;
  const boundary = text[STORY_PLOT_PREFIX.length];
  return boundary === undefined || boundary === '>' || boundary === '/' || /\s/.test(boundary);
}

function stripSceneBlocks(text: string, dropUnclosed: boolean): string {
  const openRe = /<story_scene(?:\s[^>]*)?>/g;
  const out: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    openRe.lastIndex = cursor;
    const open = openRe.exec(text);
    if (!open) {
      out.push(text.slice(cursor));
      break;
    }
    out.push(text.slice(cursor, open.index));
    const closeIndex = text.indexOf(STORY_SCENE_CLOSE, openRe.lastIndex);
    if (closeIndex < 0) {
      if (!dropUnclosed) out.push(text.slice(open.index));
      break;
    }
    cursor = closeIndex + STORY_SCENE_CLOSE.length;
  }

  return out.join('');
}

function stripKnownContainers(text: string): string {
  const stripped = text
    .replace(/<\/?story_plot(?:\s[^>]*)?>/g, '')
    .replace(/<\/?story_body(?:\s[^>]*)?>/g, '')
    .replace(/<\/?story_after_format(?:\s[^>]*)?>/g, '')
    .replace(/<story_done\s*\/>/g, '')
    .replace(/<\/?story_(?:plot|body|after_format|scene)[^>]*$/g, '');
  return dropTrailingProtocolPrefix(stripped);
}

function dropTrailingProtocolPrefix(text: string): string {
  const lastOpen = text.lastIndexOf('<');
  if (lastOpen < 0) return text;
  const suffix = text.slice(lastOpen);
  return PROTOCOL_TAG_PREFIXES.some(prefix => prefix.startsWith(suffix))
    ? text.slice(0, lastOpen)
    : text;
}

/** RONG 旧剧本剥离（保持与历史输出字节级一致，供 strip_rules 含 'story_plot' 时调用）。 */
export function stripStoryPlotXml(rawText: string): string {
  const source = rawText.trimStart();
  if (source && STORY_PLOT_PREFIX.startsWith(source)) return '';
  if (!isStoryPlotPrefix(source)) return rawText;
  if (/^<story_plot\s*\/>/.test(source)) return '';

  const rootOpen = source.match(/^<story_plot(?:\s[^>]*)?>/);
  if (!rootOpen) return '';
  const afterRoot = source.slice(rootOpen[0].length);

  const bodyOpen = /<story_body(?:\s[^>]*)?>/.exec(afterRoot);
  if (bodyOpen) {
    const bodyStart = bodyOpen.index + bodyOpen[0].length;
    const afterBodyOpen = afterRoot.slice(bodyStart);
    const bodyCloseIndex = afterBodyOpen.indexOf(STORY_BODY_CLOSE);
    const bodyRaw = bodyCloseIndex >= 0
      ? afterBodyOpen.slice(0, bodyCloseIndex)
      : afterBodyOpen;
    const body = stripKnownContainers(stripSceneBlocks(bodyRaw, true)).trim();

    let trailing = '';
    const afterSearchStart = bodyCloseIndex >= 0
      ? bodyStart + bodyCloseIndex + STORY_BODY_CLOSE.length
      : afterRoot.length;
    const afterBody = afterRoot.slice(afterSearchStart);
    const afterOpen = /<story_after_format(?:\s[^>]*)?>/.exec(afterBody);
    if (afterOpen) {
      const trailingStart = afterOpen.index + afterOpen[0].length;
      const afterOpenText = afterBody.slice(trailingStart);
      const closeIndex = afterOpenText.indexOf(STORY_AFTER_FORMAT_CLOSE);
      const trailingRaw = closeIndex >= 0 ? afterOpenText.slice(0, closeIndex) : afterOpenText;
      trailing = stripKnownContainers(trailingRaw).trim();
    }

    return body && trailing ? `${body}\n\n${trailing}` : body || trailing;
  }

  return stripKnownContainers(stripSceneBlocks(source, true)).trim();
}

/** RONG 旧剧本流式剥离。 */
export function stripStoryPlotForStreamingChunk(partialText: string): string {
  const source = partialText.trimStart();

  if (!source.startsWith(STORY_PLOT_PREFIX)) {
    return STORY_PLOT_PREFIX.startsWith(source) ? '' : partialText;
  }
  if (!isStoryPlotPrefix(source)) return partialText;
  if (/^<story_plot\s*\/>/.test(source)) return '';

  const rootOpen = source.match(/^<story_plot(?:\s[^>]*)?>/);
  if (!rootOpen) return '';
  const afterRoot = source.slice(rootOpen[0].length);
  const bodyOpen = /<story_body(?:\s[^>]*)?>/.exec(afterRoot);
  if (!bodyOpen) return '';

  const bodyAndAfter = afterRoot.slice(bodyOpen.index + bodyOpen[0].length);
  const bodyCloseIndex = bodyAndAfter.indexOf(STORY_BODY_CLOSE);
  const bodyRaw = bodyCloseIndex >= 0
    ? bodyAndAfter.slice(0, bodyCloseIndex)
    : bodyAndAfter;
  const body = stripKnownContainers(stripSceneBlocksForStreaming(bodyRaw)).trim();

  if (bodyCloseIndex < 0) {
    return body;
  }

  const afterBody = bodyAndAfter.slice(bodyCloseIndex + STORY_BODY_CLOSE.length);
  const afterOpen = /<story_after_format(?:\s[^>]*)?>/.exec(afterBody);
  if (!afterOpen) return body;

  const trailingAndClose = afterBody.slice(afterOpen.index + afterOpen[0].length);
  const trailingCloseIndex = trailingAndClose.indexOf(STORY_AFTER_FORMAT_CLOSE);
  const trailingRaw = trailingCloseIndex >= 0
    ? trailingAndClose.slice(0, trailingCloseIndex)
    : trailingAndClose;
  const trailing = stripKnownContainers(trailingRaw).trim();

  return body && trailing ? `${body}\n\n${trailing}` : body || trailing;
}

function stripSceneBlocksForStreaming(text: string): string {
  const openRe = /<story_scene(?:\s[^>]*)?>/g;
  const out: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    openRe.lastIndex = cursor;
    const open = openRe.exec(text);
    if (open) {
      out.push(text.slice(cursor, open.index));
      const closeIndex = text.indexOf(STORY_SCENE_CLOSE, openRe.lastIndex);
      if (closeIndex < 0) return out.join('');
      cursor = closeIndex + STORY_SCENE_CLOSE.length;
      continue;
    }

    let tail = text.slice(cursor);
    for (let length = Math.min(STORY_SCENE_PREFIX.length, tail.length); length > 0; length -= 1) {
      const suffix = tail.slice(-length);
      if (STORY_SCENE_PREFIX.startsWith(suffix)) {
        tail = tail.slice(0, -length);
        break;
      }
    }
    out.push(tail);
    break;
  }

  return out.join('');
}

// ---------- 预设统一入口 ----------

/**
 * RONG 旧协议专用剥离实际处理的容器 tag。
 *
 * 该模式下剥离流程是硬编码的（见 stripStoryPlotXml），strip_tags 里的其余条目**不参与**，
 * 因此 UI 需要据此标示哪些自定义规则在当前预设下不生效。
 */
export const LEGACY_STORY_PLOT_TAGS: readonly string[] = [
  'story_plot',
  'story_scene',
  'story_body',
  'story_after_format',
  'story_done',
];

/**
 * rules 是否触发 RONG 旧协议专用剥离：含 block 规则 'story_plot' 即触发，
 * 此时 rules 中其余条目一律被忽略（'#story_plot' 是 drop 规则，不触发）。
 */
export function usesLegacyStoryPlotRules(rules: string[]): boolean {
  return rules.some((rule) => {
    const parsed = parseTagEntry(rule);
    return parsed?.mode === 'block' && parsed.name.toLowerCase() === 'story_plot';
  });
}

/**
 * 按预设 strip_tags 剥离回复。
 *   - 含 block 规则 'story_plot'：走 RONG 旧协议专用剥离（保 body 弃 scene，仅原文开头触发）
 *   - 否则：按 tags 参数化剥（block 保留内部、drop 整段丢）
 *
 */
export function stripByPresetRules(rawText: string, rules: string[]): string {
  if (usesLegacyStoryPlotRules(rules)) {
    return stripStoryPlotXml(rawText);
  }
  return stripContainerTags(rawText, rules);
}

/**
 * 流式 variant 返回严格单调的安全前缀，供调用方按上次长度切 delta。
 * 尚不确定是普通字面量还是协议 tag 的尾部会暂存到下一 chunk；drop 内容永不进入安全前缀。
 */
export function stripByPresetRulesForStreamingChunk(partialText: string, rules: string[]): string {
  if (usesLegacyStoryPlotRules(rules)) {
    return stripStoryPlotForStreamingChunk(partialText);
  }
  return transformParameterizedTags(partialText, rules, true).text;
}
