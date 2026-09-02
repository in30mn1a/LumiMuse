import { formatNaiPromptFields, parseNaiPromptFields } from '@/lib/nai-image';

/**
 * LLM 对 image_tags 里的幼态/敏感 danbooru 词会误拦或 403。
 * 生图 prompt 请求前先剥离，生成后再按 image_tags 原顺序拼回，保证 NAI/SD 侧外貌完整。
 * 不区分模型，所有模型统一走剥离 + 拼回。
 */

export const IMAGE_PROMPT_SENSITIVE_TAG_PATTERN =
  /(?<![A-Za-z0-9])(?:loli|shota|underage|child|children|childlike|kindergarten|kindergartener|toddler|infant|baby|grade[\s_]+schooler|(?:little|young)[\s_]+girl|(?:elementary|primary|middle|junior[\s_]+high)[\s_]+school(?:[\s_]+(?:student|uniform|girl|boy))?)(?![A-Za-z0-9])|萝莉|正太|幼女|幼儿|幼态|未成年/i;

/** 人数/主体 tag：仅作「原顺序锚点都找不到」时的兜底位置 */
const SUBJECT_COUNT_TAG_CORE =
  /^(?:\d+girls?(?:\s+\d+boys?)?|\d+boys?)$/i;

/** 取出用于敏感判定/锚点匹配的标签本体（递归剥掉各类权重、括号及包装语法） */
export function imageTagCoreForSensitivity(tag: string): string {
  let current = tag.trim();
  let prev = '';
  while (current && current !== prev) {
    prev = current;
    // 剥去各种括号外壳：{}, (), [], <>
    current = current.replace(/^[{(<[]+\s*/, '').replace(/\s*[})>\]]+$/, '').trim();

    // SD WebUI 权重写法：tag:1.3
    const sdWeighted = /^(.+?):\s*\d+(?:\.\d+)?$/i.exec(current);
    if (sdWeighted) {
      current = sdWeighted[1].trim();
      continue;
    }

    // NovelAI / SD 权重写法：1.3::tag:: 或 1.3::tag 或 ::tag:: 或 ::tag 或 1.3 :: tag ::
    const naiWeighted = /^(?:\d+(?:\.\d+)?\s*::\s*|\s*::\s*)(.+?)(?:\s*::\s*)?$/i.exec(current);
    if (naiWeighted) {
      current = naiWeighted[1].trim();
      continue;
    }

    // LoRA 写法：lora:name:weight
    const loraMatch = /^lora:([^:]+)(?::.*)?$/i.exec(current);
    if (loraMatch) {
      current = loraMatch[1].trim();
      continue;
    }
  }
  return current;
}

export function isSensitiveImageTag(tag: string): boolean {
  return IMAGE_PROMPT_SENSITIVE_TAG_PATTERN.test(imageTagCoreForSensitivity(tag));
}

export function isSubjectCountImageTag(tag: string): boolean {
  return SUBJECT_COUNT_TAG_CORE.test(imageTagCoreForSensitivity(tag));
}

export function splitTags(tags: string): string[] {
  if (!tags) return [];
  // 支持中英文逗号、分号、换行等常见分隔符
  return tags
    .split(/[,，;；\r\n]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function coreKey(tag: string): string {
  return imageTagCoreForSensitivity(tag).toLowerCase();
}

function findTagIndexByCore(parts: string[], core: string): number {
  const needle = core.toLowerCase();
  return parts.findIndex(t => coreKey(t) === needle);
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

/** 发给模型前：从 image_tags 抽出可给模型的安全串。 */
export function prepareImageTagsForLlm(
  imageTags?: string,
): { tagsForLlm: string | undefined; strippedForRejoin: string } {
  if (!imageTags?.trim()) {
    return { tagsForLlm: undefined, strippedForRejoin: '' };
  }
  const { safeForLlm, strippedForRejoin } = partitionSensitiveImageTags(imageTags);
  return {
    tagsForLlm: safeForLlm || undefined,
    strippedForRejoin,
  };
}

/**
 * 模型产出的生图 prompt（内联或专用）落库/出图前：按 image_tags 原顺序拼回敏感 tag。
 *
 * V5 结构化字段把外貌写在 Character 栏，敏感 tag 必须插回**各自归属**的栏：
 * 角色的进 Character 1。用户的进「看起来像用户外貌」的那一栏（通常是最后一栏，
 * 因为其他生物/配角会占 Character 2，用户顺延到 Character 3）。两者不能合成一个串，
 * 否则用户的发色/瞳色/体型会长到角色或狗身上。找不到匹配栏时用户敏感 tag 直接丢弃
 * ——与「用户不在画面里就不写用户外貌」的指令一致。
 *
 * 非结构化（danbooru 单行 tag 串）沿用旧行为：两者合并后按原顺序拼回。
 */
export function restoreSensitiveImageTagsToPrompt(
  prompt: string,
  characterImageTags?: string,
  userImageTags?: string,
): string {
  const characterTags = characterImageTags?.trim() ?? '';
  const userTags = userImageTags?.trim() ?? '';
  if (!prompt.trim() || (!characterTags && !userTags)) {
    return prompt;
  }

  const fields = parseNaiPromptFields(prompt);
  if (fields.structured) {
    if (characterTags) {
      if (fields.characters[0] != null) {
        fields.characters[0] = rejoinSensitiveTagsFromOriginalOrder(fields.characters[0], characterTags);
      } else {
        fields.prompt = rejoinSensitiveTagsFromOriginalOrder(fields.prompt, characterTags);
      }
    }
    if (userTags) {
      const userSlotIndex = findUserCharacterSlot(fields.characters, userTags);
      if (userSlotIndex >= 0) {
        fields.characters[userSlotIndex] = rejoinSensitiveTagsFromOriginalOrder(
          fields.characters[userSlotIndex],
          userTags,
        );
      }
    }
    return formatNaiPromptFields(fields);
  }

  const originalOrder = [characterTags, userTags].filter(Boolean).join(', ');
  return rejoinSensitiveTagsFromOriginalOrder(prompt, originalOrder);
}

function appearanceCoreKeys(tags: string): string[] {
  return [...new Set(
    splitTags(tags)
      .map(coreKey)
      .filter(core => core && !isSensitiveImageTag(core) && !isSubjectCountImageTag(core)),
  )];
}

/**
 * 用户栏不一定是 Character 2：画面有狗/兽等配角时用户会顺延到 Character 3。
 * 用用户外貌的非敏感锚点（发色、瞳色等）从后往前找最像的一栏；Character 1 留给主角色。
 */
function findUserCharacterSlot(characters: string[], userTags: string): number {
  if (characters.length < 2) return -1;
  const anchors = appearanceCoreKeys(userTags);
  if (anchors.length === 0) return -1;

  let bestIndex = -1;
  let bestHits = 0;
  for (let index = characters.length - 1; index >= 1; index -= 1) {
    const caption = characters[index];
    if (!caption?.trim()) continue;
    const hits = anchors.filter(anchor => findTagIndexByCore(splitTags(caption), anchor) >= 0).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestIndex = index;
    }
  }
  return bestHits > 0 ? bestIndex : -1;
}
