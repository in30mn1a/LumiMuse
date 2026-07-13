/**
 * 部分 LLM（Gemini、Grok 等）对 image_tags 里的幼态/敏感 danbooru 词会误拦或 403。
 * 生图 prompt 请求前先剥离，生成后再拼回最终 prompt，保证 NAI/SD 侧外貌完整。
 */

export const IMAGE_PROMPT_SENSITIVE_TAG_PATTERN =
  /^(?:loli|shota|child|kindergarten|kindergarten uniform)$/i;

/** 人数/主体 tag（拼回敏感词时插在其后，符合 danbooru 习惯顺序） */
const SUBJECT_COUNT_TAG_CORE =
  /^(?:\d+girls?(?:\s+\d+boys?)?|\d+boys?)$/i;

/** NovelAI / SD 权重写法：1.3::tag:: 或 1.3::tag */
const WEIGHTED_TAG_PATTERN = /^(\d+(?:\.\d+)?)::(.+?)(?:::\s*)?$/i;

/** 取出用于敏感判定的标签本体（剥掉权重外壳） */
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

/** 是否需在调用上游前剥离 image_tags 中的敏感词 */
export function shouldStripSensitiveImagePromptTags(model: string): boolean {
  return /gemini|grok/i.test(model);
}

export function partitionSensitiveImageTags(imageTags: string): {
  safeForLlm: string;
  strippedForRejoin: string;
} {
  const allTags = imageTags.split(',').map(t => t.trim()).filter(Boolean);
  const sensitive = allTags.filter(isSensitiveImageTag);
  const safe = allTags.filter(t => !isSensitiveImageTag(t));
  return {
    safeForLlm: safe.join(', '),
    strippedForRejoin: sensitive.join(', '),
  };
}

/**
 * 将剥离的敏感 tag 插回生成结果：紧跟第一个 1girl / 1boy 等主体 tag 之后。
 * 若模型输出里没有主体 tag，则插在第一个 tag 之后（避免整段顶在最前）。
 */
export function rejoinSensitiveTagsAfterSubject(positive: string, strippedTags: string): string {
  const strippedParts = strippedTags.split(',').map(t => t.trim()).filter(Boolean);
  if (strippedParts.length === 0) return positive;

  const parts = positive.split(',').map(t => t.trim()).filter(Boolean);
  if (parts.length === 0) return strippedParts.join(', ');

  const subjectIdx = parts.findIndex(isSubjectCountImageTag);
  const insertAt = subjectIdx >= 0 ? subjectIdx + 1 : 1;
  const clampedInsert = Math.min(insertAt, parts.length);

  parts.splice(clampedInsert, 0, ...strippedParts);
  return parts.join(', ');
}