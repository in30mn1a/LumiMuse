import { ImageGenSettings } from '@/types';

export const NAI_V5_FULL_MODEL = 'nai-diffusion-5-full';
export const NAI_V5_CURATED_MODEL = 'nai-diffusion-5-curated';

export type ImagePromptStyle = 'danbooru' | 'nai-v5';

export type NaiCharacterCaption = {
  char_caption: string;
  centers: Array<{ x: number; y: number }>;
};

export type NaiPromptFields = {
  structured: boolean;
  prompt: string;
  characters: string[];
  uc: string;
};

const NAI_FIELD_HEADER =
  /^(Prompt|POSITIVE|NEGATIVE|UC|Character\s*\d+)\s*[:：]\s*/i;

function isNaiFieldHeader(line: string): RegExpMatchArray | null {
  return line.match(NAI_FIELD_HEADER);
}

function characterIndexFromHeader(header: string): number | null {
  const match = header.match(/character\s*(\d+)/i);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index) || index < 1) return null;
  return index - 1;
}

/**
 * V5 模型 ID 形如 nai-diffusion-5-full / nai-diffusion-5-curated。
 * 不能用 includes('5')：nai-diffusion-4-5-full 也会误中。
 */
export function isNaiV5Model(model: string | undefined): boolean {
  return typeof model === 'string' && model.includes('nai-diffusion-5');
}

export function isNaiV4FamilyModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.includes('nai-diffusion-4');
}

/** V4 / V4.5 / V5 都走 v4_prompt / v4_negative_prompt 结构。 */
export function usesNaiV4PromptApi(model: string | undefined): boolean {
  return isNaiV4FamilyModel(model) || isNaiV5Model(model);
}

export function resolveImagePromptStyle(imageGen?: Partial<ImageGenSettings> | null): ImagePromptStyle {
  if (!imageGen?.enabled || imageGen.engine !== 'nai') return 'danbooru';
  return isNaiV5Model(imageGen.nai_model) ? 'nai-v5' : 'danbooru';
}

function normalizePromptBlock(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/**
 * 解析 LLM / 内联块产出的 NAI 字段。
 * 识别 Prompt / Character N / UC，以及旧格式 POSITIVE / NEGATIVE。
 * 没有任何字段头时，整段当作主提示词（非 structured）。
 */
export function parseNaiPromptFields(raw: string): NaiPromptFields {
  const text = normalizePromptBlock(raw);
  if (!text) {
    return { structured: false, prompt: '', characters: [], uc: '' };
  }

  const lines = text.split('\n');
  const hasFieldHeader = lines.some(line => isNaiFieldHeader(line.trim()));
  if (!hasFieldHeader) {
    return { structured: false, prompt: text, characters: [], uc: '' };
  }

  let prompt = '';
  let uc = '';
  const characterMap = new Map<number, string>();
  let current: { kind: 'prompt' | 'uc' | 'character'; index?: number } | null = null;
  const buffer: string[] = [];

  const flush = () => {
    if (!current) return;
    const value = buffer.join('\n').trim();
    buffer.length = 0;
    if (current.kind === 'prompt') {
      prompt = value;
    } else if (current.kind === 'uc') {
      uc = value;
    } else if (current.kind === 'character' && current.index !== undefined) {
      characterMap.set(current.index, value);
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headerMatch = isNaiFieldHeader(line.trim());
    if (headerMatch) {
      flush();
      const header = headerMatch[1];
      const rest = line.trim().slice(headerMatch[0].length);
      const characterIndex = characterIndexFromHeader(header);
      if (characterIndex !== null) {
        current = { kind: 'character', index: characterIndex };
      } else if (/^negative$/i.test(header) || /^uc$/i.test(header)) {
        current = { kind: 'uc' };
      } else {
        current = { kind: 'prompt' };
      }
      if (rest) buffer.push(rest);
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();

  const maxIndex = characterMap.size === 0 ? -1 : Math.max(...characterMap.keys());
  const characters: string[] = [];
  for (let index = 0; index <= maxIndex; index += 1) {
    characters.push(characterMap.get(index)?.trim() ?? '');
  }

  const sawPromptHeader = /^Prompt\s*[:：]/im.test(text);
  const hasCharacterCaptions = characters.some(caption => caption.length > 0);
  return {
    structured: sawPromptHeader || hasCharacterCaptions,
    prompt,
    characters,
    uc,
  };
}

export function formatNaiPromptFields(fields: NaiPromptFields): string {
  if (!fields.structured) {
    return fields.prompt.trim();
  }

  const blocks = [`Prompt:\n${fields.prompt.trim()}`];
  fields.characters.forEach((caption, index) => {
    if (!caption.trim()) return;
    blocks.push(`Character ${index + 1}:\n${caption.trim()}`);
  });
  if (fields.uc.trim()) {
    blocks.push(`UC:\n${fields.uc.trim()}`);
  }
  return blocks.join('\n\n');
}

function composeCaptionPrefix(cfg: ImageGenSettings, caption: string): string {
  const parts: string[] = [];
  if (cfg.nai_artist_tags?.trim()) parts.push(cfg.nai_artist_tags.trim());
  if (cfg.quality_tags?.trim()) parts.push(cfg.quality_tags.trim());
  if (caption.trim()) parts.push(caption.trim());
  return parts.join(', ');
}

/**
 * 丢掉空的角色槽位，并把 Prompt / UC 正文里的 `Character N` 指代改写成压实后的新编号。
 *
 * `char_captions` 在 use_order 下是**按序号绑定**的：若直接过滤掉空洞（例如模型只写了
 * Character 2），后面的角色会静默前移，正文里写的「Character 2 正在…」就会绑到错误的人。
 * 压实与改写必须成对做。这一步只在出站组装时执行，敏感 tag 回插仍按模型原本的编号进行。
 */
function compactNaiCharacterSlots(fields: NaiPromptFields): NaiPromptFields {
  const trimmed = fields.characters.map(caption => caption.trim());
  if (trimmed.every(Boolean)) return fields;

  const renumbered = new Map<number, number>();
  const characters: string[] = [];
  trimmed.forEach((caption, index) => {
    if (!caption) return;
    characters.push(caption);
    renumbered.set(index + 1, characters.length);
  });

  // 单次替换，避免 2→1 之后又被当成 1 再映射一次
  const rewrite = (text: string): string =>
    text.replace(/\bCharacter\s*(\d+)/gi, (match, digits: string) => {
      const next = renumbered.get(Number.parseInt(digits, 10));
      return next === undefined ? match : `Character ${next}`;
    });

  return {
    ...fields,
    characters,
    prompt: rewrite(fields.prompt),
    uc: rewrite(fields.uc),
  };
}

function toCharCaptions(captions: string[]): NaiCharacterCaption[] {
  return captions
    .map(caption => caption.trim())
    .filter(Boolean)
    .map(char_caption => ({
      char_caption,
      centers: [{ x: 0.5, y: 0.5 }],
    }));
}

/**
 * 合并负面提示词：用户在设置里配的 `nai_negative_prompt` 是长期偏好，不应被模型临时
 * 产出的 UC / NEGATIVE 整段顶掉，两者按「预设在前、模型在后」拼接并按字面去重。
 */
function mergeNegativePrompts(...sources: Array<string | undefined>): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const source of sources) {
    for (const part of (source ?? '').split(',')) {
      const tag = part.trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(tag);
    }
  }
  return merged.join(', ');
}

export type NaiGenerateSeeds = {
  seed: number;
  extra_noise_seed: number;
};

export function randomNaiSeeds(): NaiGenerateSeeds {
  return {
    seed: Math.floor(Math.random() * 2 ** 32),
    extra_noise_seed: Math.floor(Math.random() * 2 ** 32),
  };
}

/**
 * 组装 NovelAI /ai/generate-image 请求体。
 * V5 与 V4/V4.5 共用 v4_prompt；若提示词带 Character 栏，写入 char_captions。
 */
export function buildNaiGenerateRequest(
  prompt: string,
  negativePrompt: string,
  cfg: ImageGenSettings,
  seeds: NaiGenerateSeeds = randomNaiSeeds(),
): {
  input: string;
  model: string;
  action: 'generate';
  parameters: Record<string, unknown>;
} {
  const fields = compactNaiCharacterSlots(parseNaiPromptFields(prompt));
  const baseCaption = composeCaptionPrefix(cfg, fields.prompt || (fields.structured ? '' : prompt));
  const fullNeg = mergeNegativePrompts(cfg.nai_negative_prompt, negativePrompt, fields.uc);
  const model = cfg.nai_model;
  const charCaptions = toCharCaptions(fields.characters);

  const parameters: Record<string, unknown> = {
    width: cfg.nai_width,
    height: cfg.nai_height,
    scale: cfg.nai_scale,
    cfg_rescale: cfg.nai_cfg_rescale,
    sampler: cfg.nai_sampler,
    noise_schedule: cfg.nai_noise_schedule,
    steps: cfg.nai_steps,
    n_samples: 1,
    ucPreset: 0,
    negative_prompt: fullNeg,
    seed: seeds.seed,
    extra_noise_seed: seeds.extra_noise_seed,
  };

  if (usesNaiV4PromptApi(model)) {
    const isV5 = isNaiV5Model(model);
    parameters.params_version = isV5 ? 4 : 3;
    parameters.legacy = false;
    parameters.prefer_brownian = true;
    parameters.quality_toggle = true;
    parameters.autoSmea = !isV5;
    parameters.dynamic_thresholding = false;
    parameters.v4_prompt = {
      caption: {
        base_caption: baseCaption,
        char_captions: charCaptions,
      },
      use_coords: false,
      use_order: true,
    };
    parameters.v4_negative_prompt = {
      caption: {
        base_caption: fullNeg,
        char_captions: charCaptions.map(caption => ({
          char_caption: '',
          centers: caption.centers,
        })),
      },
      use_coords: false,
      use_order: false,
    };
    if (isV5 || model.includes('4-5')) {
      parameters.skip_cfg_above_sigma = null;
    }
    if (isV5) {
      parameters.tag_hint_transparent_background = false;
    }
  }

  return {
    input: baseCaption,
    model,
    action: 'generate',
    parameters,
  };
}
