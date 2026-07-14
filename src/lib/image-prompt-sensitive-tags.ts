/**
 * 部分 LLM（Gemini、Grok 等）对 image_tags 里的幼态/敏感 danbooru 词会误拦或 403。
 * 生图 prompt 请求前先剥离，生成后再按 image_tags 原顺序拼回，保证 NAI/SD 侧外貌完整。
 */

export const IMAGE_PROMPT_SENSITIVE_TAG_PATTERN =
  /^(?:loli|shota|child|kindergarten|kindergarten uniform)$/i;

/** 人数/主体 tag：仅作「原顺序锚点都找不到」时的兜底位置 */
const SUBJECT_COUNT_TAG_CORE =
  /^(?:\d+girls?(?:\s+\d+boys?)?|\d+boys?)$/i;

/** NovelAI / SD 权重写法：1.3::tag:: 或 1.3::tag */
const WEIGHTED_TAG_PATTERN = /^(\d+(?:\.\d+)?)::(.+?)(?:::\s*)?$/i;

/** 取出用于敏感判定/锚点匹配的标签本体（剥掉权重外壳） */
export function imageTagCoreForSensitivity(tag: string): string {
  const trimmed = tag.trim();
  const weighted = WEIGHTED_TAG_PATTERN.exec(trimmed);
  if (weighted) return weighted[2].trim();
  return trimmed;
}

export function isSensitiveImageTag(tag: string): boolean {
  return IMAGE_PROMPT_SENSITIVE_TAG_PATTERN.test(imageTagCoreForSensitivity(tag));
}

export function isSubjectCountImageTag(tag: string): boolean {
  return SUBJECT_COUNT_TAG_CORE.test(imageTagCoreForSensitivity(tag));
}

function splitTags(tags: string): string[] {
  return tags.split(',').map(t => t.trim()).filter(Boolean);
}

function coreKey(tag: string): string {
  return imageTagCoreForSensitivity(tag).toLowerCase();
}

function findTagIndexByCore(parts: string[], core: string): number {
  const needle = core.toLowerCase();
  return parts.findIndex(t => coreKey(t) === needle);
}

/** 是否需在调用上游前剥离 image_tags 中的敏感词 */
export function shouldStripSensitiveImagePromptTags(model: string): boolean {
  return /gemini|grok/i.test(model);
}

export function partitionSensitiveImageTags(imageTags: string): {
  safeForLlm: string;
  strippedForRejoin: string;
} {
  const allTags = splitTags(imageTags);
  const sensitive = allTags.filter(isSensitiveImageTag);
  const safe = allTags.filter(t => !isSensitiveImageTag(t));
  return {
    safeForLlm: safe.join(', '),
    strippedForRejoin: sensitive.join(', '),
  };
}

/**
 * 按 image_tags 原顺序把敏感 tag 插回模型输出。
 * 每个敏感 tag 优先插在「原串中左侧最近邻居」之后；否则插在「右侧最近邻居」之前；
 * 邻居在输出里找不到时，再兜底到 1girl/1boy 后或第一个 tag 后。
 * 已在输出中出现的敏感 core 不重复插入。
 */
export function rejoinSensitiveTagsFromOriginalOrder(
  positive: string,
  originalImageTags: string,
): string {
  const original = splitTags(originalImageTags);
  const sensitive = original.filter(isSensitiveImageTag);
  if (sensitive.length === 0) return positive;

  const parts = splitTags(positive);
  if (parts.length === 0) return sensitive.join(', ');

  for (let origIdx = 0; origIdx < original.length; origIdx += 1) {
    const tag = original[origIdx];
    if (!isSensitiveImageTag(tag)) continue;
    if (findTagIndexByCore(parts, coreKey(tag)) >= 0) continue;

    let insertAt: number | null = null;

    for (let left = origIdx - 1; left >= 0; left -= 1) {
      const leftIdx = findTagIndexByCore(parts, coreKey(original[left]));
      if (leftIdx >= 0) {
        insertAt = leftIdx + 1;
        break;
      }
    }

    if (insertAt === null) {
      for (let right = origIdx + 1; right < original.length; right += 1) {
        const rightIdx = findTagIndexByCore(parts, coreKey(original[right]));
        if (rightIdx >= 0) {
          insertAt = rightIdx;
          break;
        }
      }
    }

    if (insertAt === null) {
      const subjectIdx = parts.findIndex(isSubjectCountImageTag);
      insertAt = subjectIdx >= 0 ? subjectIdx + 1 : Math.min(1, parts.length);
    }

    parts.splice(Math.min(insertAt, parts.length), 0, tag);
  }

  return parts.join(', ');
}

/**
 * @deprecated 请用 rejoinSensitiveTagsFromOriginalOrder；保留给旧测试/调用的薄包装：
 * 无原串时只能把 stripped 整段插在主体 tag 后。
 */
export function rejoinSensitiveTagsAfterSubject(positive: string, strippedTags: string): string {
  const strippedParts = splitTags(strippedTags);
  if (strippedParts.length === 0) return positive;

  const parts = splitTags(positive);
  if (parts.length === 0) return strippedParts.join(', ');

  const subjectIdx = parts.findIndex(isSubjectCountImageTag);
  const insertAt = subjectIdx >= 0 ? subjectIdx + 1 : 1;
  const clampedInsert = Math.min(insertAt, parts.length);

  parts.splice(clampedInsert, 0, ...strippedParts);
  return parts.join(', ');
}

/**
 * 发给 Gemini/Grok 前：从 image_tags 抽出可给模型的安全串。
 * 非敏感模型原样返回。
 */
export function prepareImageTagsForSensitiveModel(
  model: string,
  imageTags?: string,
): { tagsForLlm: string | undefined; strippedForRejoin: string } {
  if (!imageTags?.trim() || !shouldStripSensitiveImagePromptTags(model)) {
    return { tagsForLlm: imageTags?.trim() || undefined, strippedForRejoin: '' };
  }
  const { safeForLlm, strippedForRejoin } = partitionSensitiveImageTags(imageTags);
  return {
    tagsForLlm: safeForLlm || undefined,
    strippedForRejoin,
  };
}

/**
 * 模型产出的生图 prompt（内联或专用）落库/出图前：按 image_tags 原顺序拼回敏感 tag。
 */
export function restoreSensitiveImageTagsToPrompt(
  model: string,
  prompt: string,
  imageTags?: string,
): string {
  if (!prompt.trim() || !imageTags?.trim() || !shouldStripSensitiveImagePromptTags(model)) {
    return prompt;
  }
  return rejoinSensitiveTagsFromOriginalOrder(prompt, imageTags);
}