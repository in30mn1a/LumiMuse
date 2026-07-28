/**
 * 落库前剥离 SillyTavern 预设的剧本协议 XML：
 *   <story_plot>
 *     <story_scene>
 *       <date>...</date><time>...</time><location>...</location>
 *     </story_scene>
 *     <story_body>...正文...</story_body>
 *     <story_after_format><story_done/> 或 <w2g>...</w2g></story_after_format>
 *   </story_plot>
 *
 * 规则（用户决策）：
 *   - 容器标签全剥：<story_plot>、<story_scene>、<story_body>、<story_after_format>（含开闭）。
 *   - <story_scene> 整体丢弃，包括 <date> / <time> / <location>（用户 Q1）。
 *   - <story_body> 内正文原样保留（trim 首尾空白）。
 *   - <story_after_format> 内 <story_done/> 空标签整体丢弃；
 *     其他内容（比如行动选项 <w2g>...</w2g>：主人已禁用，但万一模型仍输出）按原样追加到正文末尾（Q2 语义：禁用了就剥掉标签但保留文本）。
 *
 * 触发条件：输入文本以 <story_plot> 开头（去除 BOM/空白后）。否则原样返回。
 */

const STORY_PLOT_PREFIX = '<story_plot';
const STORY_BODY_CLOSE = '</story_body>';
const STORY_SCENE_PREFIX = '<story_scene';
const STORY_SCENE_CLOSE = '</story_scene>';
const STORY_AFTER_FORMAT_CLOSE = '</story_after_format>';
const PROTOCOL_TAG_PREFIXES = [
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
    // Abort 可能停在尚未闭合的容器 tag 中间，不能把协议碎片写入 DB。
    .replace(/<\/?story_(?:plot|body|after_format|scene)[^>]*$/g, '');
  return dropTrailingProtocolPrefix(stripped);
}

/**
 * 持有/丢弃末尾尚未生成完整的协议 tag。
 *
 * 例如 abort 恰好停在 `<sto`、`</story_bo` 时，不能把这段协议碎片发给前端或写入数据库。
 * 普通的 `<w2g>` 等非协议 tag 不受影响：一旦其前缀已明确不属于协议，就会原样保留。
 */
function dropTrailingProtocolPrefix(text: string): string {
  const lastOpen = text.lastIndexOf('<');
  if (lastOpen < 0) return text;
  const suffix = text.slice(lastOpen);
  return PROTOCOL_TAG_PREFIXES.some(prefix => prefix.startsWith(suffix))
    ? text.slice(0, lastOpen)
    : text;
}

export function stripStoryPlotXml(rawText: string): string {
  const source = rawText.trimStart();
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

  // 写坏或被 abort 的输出：剥已知容器；未闭合 scene 从其开头起整体丢弃，避免元数据污染正文。
  return stripKnownContainers(stripSceneBlocks(source, true)).trim();
}

/**
 * 流式语法剥离的前缀 variant：
 * 对已收到的 partial text，**安全剥离**已完整的 <story_scene> 和"故事开头容器 tag"，
 * 让 SSE 流式响应给前端的 chunk 也是干净正文。
 *
 * 规则：
 *   - 若 partial 尚未包含 `<story_plot>` 开头：原样返回（模型可能还在生成）
 *   - 完整 <story_scene>...</story_scene>：剥掉整块
 *   - 完整 <story_plot>：剥开 tag（保留后续）
 *   - 完整 <story_body>：剥开 tag（保留后续）
 *   - body 与 after_format 都只返回已确认安全的可见前缀；协议 tag 的跨 chunk 前缀会被持有。
 *   - 返回值对同一累计输入保持单调（后一次结果一定以前一次结果开头），调用方可安全按长度增量发送。
 */
export function stripStoryPlotForStreamingChunk(partialText: string): string {
  const source = partialText.trimStart();

  // 在确认前持有可能的 story_plot 前缀；一旦明确不是协议输出，再原样流出。
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
    // 同样持有可能跨 chunk 的 scene opening tag 前缀，避免先发 "<sto" 后再回删。
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
