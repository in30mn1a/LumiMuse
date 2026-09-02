const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const naiImage = require(path.resolve(__dirname, '../src/lib/nai-image.ts'));
const { buildInlinePromptInstruction } = require(path.resolve(__dirname, '../src/lib/inline-image-prompt.ts'));
const { restoreSensitiveImageTagsToPrompt } = require(path.resolve(__dirname, '../src/lib/image-prompt-sensitive-tags.ts'));
const { DEFAULT_IMAGE_GEN_SETTINGS } = require(path.resolve(__dirname, '../src/types/index.ts'));

test('isNaiV5Model matches V5 ids and not V4.5', () => {
  assert.equal(naiImage.isNaiV5Model('nai-diffusion-5-full'), true);
  assert.equal(naiImage.isNaiV5Model('nai-diffusion-5-curated'), true);
  assert.equal(naiImage.isNaiV5Model('nai-diffusion-5-full-inpainting'), true);
  assert.equal(naiImage.isNaiV5Model('nai-diffusion-4-5-full'), false);
  assert.equal(naiImage.isNaiV5Model('nai-diffusion-4-full'), false);
  assert.equal(naiImage.isNaiV5Model('nai-diffusion-3'), false);
});

test('usesNaiV4PromptApi covers V4 family and V5, not V3', () => {
  assert.equal(naiImage.usesNaiV4PromptApi('nai-diffusion-5-full'), true);
  assert.equal(naiImage.usesNaiV4PromptApi('nai-diffusion-4-5-full'), true);
  assert.equal(naiImage.usesNaiV4PromptApi('nai-diffusion-4-full'), true);
  assert.equal(naiImage.usesNaiV4PromptApi('nai-diffusion-3'), false);
});

test('resolveImagePromptStyle is nai-v5 only when NAI engine is enabled on a V5 model', () => {
  assert.equal(naiImage.resolveImagePromptStyle(undefined), 'danbooru');
  assert.equal(naiImage.resolveImagePromptStyle({
    enabled: true,
    engine: 'sd',
    nai_model: 'nai-diffusion-5-full',
  }), 'danbooru');
  assert.equal(naiImage.resolveImagePromptStyle({
    enabled: true,
    engine: 'nai',
    nai_model: 'nai-diffusion-4-5-full',
  }), 'danbooru');
  assert.equal(naiImage.resolveImagePromptStyle({
    enabled: false,
    engine: 'nai',
    nai_model: 'nai-diffusion-5-full',
  }), 'danbooru');
  assert.equal(naiImage.resolveImagePromptStyle({
    enabled: true,
    engine: 'nai',
    nai_model: 'nai-diffusion-5-full',
  }), 'nai-v5');
});

test('parseNaiPromptFields splits Prompt / Character / UC and treats POSITIVE as unstructured', () => {
  const structured = naiImage.parseNaiPromptFields(`
Prompt:
1girl, solo, from side, window light
She is sitting by the rainy window.

Character 1:
girl, silver hair, blue eyes, white dress

UC:
text, watermark
`);
  assert.equal(structured.structured, true);
  assert.match(structured.prompt, /1girl, solo/);
  assert.match(structured.prompt, /rainy window/);
  assert.equal(structured.characters[0], 'girl, silver hair, blue eyes, white dress');
  assert.equal(structured.uc, 'text, watermark');

  const legacy = naiImage.parseNaiPromptFields('POSITIVE: 1girl, silver hair, blue eyes');
  assert.equal(legacy.structured, false);
  assert.equal(legacy.prompt, '1girl, silver hair, blue eyes');
  assert.deepEqual(legacy.characters, []);
});

test('buildNaiGenerateRequest uses v4_prompt for V5 and puts appearance in char_captions', () => {
  const cfg = {
    ...DEFAULT_IMAGE_GEN_SETTINGS,
    nai_model: 'nai-diffusion-5-full',
    nai_artist_tags: 'artist:foo',
    quality_tags: 'very aesthetic',
    nai_negative_prompt: 'saved-neg',
  };
  const body = naiImage.buildNaiGenerateRequest(
    'Prompt:\n1girl, from side\n\nCharacter 1:\ngirl, silver hair, blue eyes',
    '',
    cfg,
    { seed: 1, extra_noise_seed: 2 },
  );

  assert.equal(body.model, 'nai-diffusion-5-full');
  assert.equal(body.action, 'generate');
  assert.equal(body.input, 'artist:foo, very aesthetic, 1girl, from side');
  assert.equal(body.parameters.params_version, 4);
  assert.equal(body.parameters.autoSmea, false);
  assert.equal(body.parameters.quality_toggle, true);
  assert.equal(body.parameters.skip_cfg_above_sigma, null);
  assert.equal(body.parameters.tag_hint_transparent_background, false);
  assert.deepEqual(body.parameters.v4_prompt, {
    caption: {
      base_caption: 'artist:foo, very aesthetic, 1girl, from side',
      char_captions: [{
        char_caption: 'girl, silver hair, blue eyes',
        centers: [{ x: 0.5, y: 0.5 }],
      }],
    },
    use_coords: false,
    use_order: true,
  });
});

test('buildNaiGenerateRequest keeps V4.5 on params_version 3 and autoSmea true', () => {
  const body = naiImage.buildNaiGenerateRequest(
    '1girl, silver hair',
    'request-neg',
    {
      ...DEFAULT_IMAGE_GEN_SETTINGS,
      nai_model: 'nai-diffusion-4-5-full',
      nai_artist_tags: '',
      quality_tags: '',
    },
    { seed: 1, extra_noise_seed: 2 },
  );
  assert.equal(body.parameters.params_version, 3);
  assert.equal(body.parameters.autoSmea, true);
  assert.equal(body.parameters.v4_prompt.caption.base_caption, '1girl, silver hair');
  assert.deepEqual(body.parameters.v4_prompt.caption.char_captions, []);
});

test('V5 inline instruction stays compact and still requires creature Character slots', () => {
  const { NAI_V5_PROMPT_GENERATION_SYSTEM } = require(path.resolve(__dirname, '../src/lib/image-prompt-instructions.ts'));
  const danbooru = buildInlinePromptInstruction('silver hair, blue eyes', '1boy, black hair');
  assert.match(danbooru, /danbooru/);
  assert.match(danbooru, /35 - 70 个标签/);

  const v5 = buildInlinePromptInstruction('silver hair, blue eyes', '1boy, black hair', 'nai-v5');
  assert.match(v5, /NovelAI Diffusion V5/);
  assert.match(v5, /Prompt:/);
  assert.match(v5, /Character 1:/);
  assert.match(v5, /每个出场主体都必须另开 Character N/);
  assert.match(v5, /不能只写女角色把其他生物塞进 Prompt/);
  assert.match(v5, /tag 和自然语言必须混用/);
  assert.match(v5, /禁止纯 tag 串或纯散文/);
  assert.doesNotMatch(v5, /35 - 70 个标签/);
  assert.equal(v5.includes(NAI_V5_PROMPT_GENERATION_SYSTEM), false);
  assert.match(v5, /不是角色与用户的亲密互动/);
  assert.match(v5, /不得包含任何用户外貌标签/);
  assert.match(v5, /固定外貌标签：silver hair, blue eyes/);
});

test('restoreSensitiveImageTagsToPrompt rejoins into Character 1 for V5 structured prompts', () => {
  const restored = restoreSensitiveImageTagsToPrompt(
    'Prompt:\n1girl, from side\n\nCharacter 1:\ngirl, blue eyes, red hair',
    'blue eyes, 1.3::loli::, red hair',
  );
  assert.match(restored, /^Prompt:/);
  assert.match(restored, /Character 1:/);
  assert.match(restored, /1\.3::loli::/);
  assert.doesNotMatch(restored.split('Character 1:')[0], /loli/);
});

test('V5 structured prompts keep character and user sensitive tags in their own slots', () => {
  const restored = restoreSensitiveImageTagsToPrompt(
    `Prompt:
1girl, 1boy, from side

Character 1:
girl, blue eyes, red hair

Character 2:
boy, short hair, brown eyes`,
    'blue eyes, 1.3::loli::, red hair',
    'short hair, shota, brown eyes',
  );
  const [, char1, char2] = restored.split(/Character [12]:/);
  // 角色的敏感 tag 只进 Character 1，用户的只进 Character 2，互不串栏
  assert.match(char1, /1\.3::loli::/);
  assert.doesNotMatch(char1, /shota/);
  assert.match(char2, /shota/);
  assert.doesNotMatch(char2, /loli/);
});

test('V5 structured prompts rejoin user sensitive tags into Character 3 when a creature occupies Character 2', () => {
  const restored = restoreSensitiveImageTagsToPrompt(
    `Prompt:
1girl, 1other, 1boy

Character 1:
girl, blue eyes, red hair

Character 2:
other, golden retriever, large body, golden fur

Character 3:
boy, short hair, brown eyes`,
    'blue eyes, 1.3::loli::, red hair',
    'short hair, shota, brown eyes',
  );
  const [, char1, char2, char3] = restored.split(/Character [123]:/);
  assert.match(char1, /1\.3::loli::/);
  assert.doesNotMatch(char2, /shota/);
  assert.doesNotMatch(char2, /loli/);
  assert.match(char3, /shota/);
  assert.doesNotMatch(char3, /loli/);
});

test('V5 structured prompts drop user sensitive tags when the user is not on stage', () => {
  const restored = restoreSensitiveImageTagsToPrompt(
    `Prompt:
1girl, solo

Character 1:
girl, blue eyes, red hair`,
    'blue eyes, 1.3::loli::, red hair',
    'short hair, shota, brown eyes',
  );
  assert.match(restored, /1\.3::loli::/);
  // 没有 Character 2 就是用户没出场，用户外貌不得漏进角色栏或主提示词
  assert.doesNotMatch(restored, /shota/);
  assert.doesNotMatch(restored, /Character 2:/);
});

test('danbooru prompts still rejoin character and user sensitive tags into one tag string', () => {
  const restored = restoreSensitiveImageTagsToPrompt(
    '1girl, 1boy, blue eyes, red hair, short hair, brown eyes',
    'blue eyes, 1.3::loli::, red hair',
    'short hair, shota, brown eyes',
  );
  assert.match(restored, /1\.3::loli::/);
  assert.match(restored, /shota/);
});

test('empty character slots are compacted and Character references renumbered together', () => {
  const cfg = { ...DEFAULT_IMAGE_GEN_SETTINGS, nai_model: 'nai-diffusion-5-full', nai_negative_prompt: '' };
  const body = naiImage.buildNaiGenerateRequest(
    `Prompt:
1girl, 1boy
Character 2 is leaning on the railing.

Character 2:
boy, short hair, brown eyes`,
    '',
    cfg,
    { seed: 1, extra_noise_seed: 2 },
  );
  const captions = body.parameters.v4_prompt.caption.char_captions;
  // 空洞压实后只剩一位角色，正文指代必须跟着变成 Character 1，否则绑到不存在的槽位
  assert.equal(captions.length, 1);
  assert.match(captions[0].char_caption, /short hair/);
  assert.match(body.parameters.v4_prompt.caption.base_caption, /Character 1 is leaning/);
  assert.doesNotMatch(body.parameters.v4_prompt.caption.base_caption, /Character 2/);
});

test('non-empty character slots keep their original numbering', () => {
  const cfg = { ...DEFAULT_IMAGE_GEN_SETTINGS, nai_model: 'nai-diffusion-5-full' };
  const body = naiImage.buildNaiGenerateRequest(
    `Prompt:
1girl, 1boy
Character 2 is holding Character 1.

Character 1:
girl, red hair

Character 2:
boy, short hair`,
    '',
    cfg,
    { seed: 1, extra_noise_seed: 2 },
  );
  assert.equal(body.parameters.v4_prompt.caption.char_captions.length, 2);
  assert.match(body.parameters.v4_prompt.caption.base_caption, /Character 2 is holding Character 1/);
});

test('configured negative prompt survives a model-supplied UC and is deduped', () => {
  const cfg = {
    ...DEFAULT_IMAGE_GEN_SETTINGS,
    nai_model: 'nai-diffusion-5-full',
    nai_negative_prompt: 'lowres, bad hands',
  };
  const body = naiImage.buildNaiGenerateRequest(
    `Prompt:
1girl

UC:
bad hands, blurry`,
    '',
    cfg,
    { seed: 1, extra_noise_seed: 2 },
  );
  const neg = body.parameters.negative_prompt;
  // 用户长期配置的负面预设不得被一句临时 UC 顶掉；重复项只留一份
  assert.equal(neg, 'lowres, bad hands, blurry');
});

test('V5 system prompt forbids colon-prefixed Character lines inside Prompt', () => {
  const { NAI_V5_PROMPT_GENERATION_SYSTEM } = require(path.resolve(__dirname, '../src/lib/image-prompt-instructions.ts'));
  assert.match(NAI_V5_PROMPT_GENERATION_SYSTEM, /禁止出现「Character 1:」这种带冒号的行首写法/);
  assert.match(NAI_V5_PROMPT_GENERATION_SYSTEM, /tag 和自然语言可以、也应该混用/);
  assert.match(NAI_V5_PROMPT_GENERATION_SYSTEM, /tag 与自然语言混用/);
});

test('V5 system prompt requires a Character slot for every visible creature', () => {
  const { NAI_V5_PROMPT_GENERATION_SYSTEM } = require(path.resolve(__dirname, '../src/lib/image-prompt-instructions.ts'));
  assert.match(NAI_V5_PROMPT_GENERATION_SYSTEM, /每一个可辨认的主体各占一栏/);
  assert.match(NAI_V5_PROMPT_GENERATION_SYSTEM, /不能只写女角色而把狗\/兽\/其他生物塞进 Prompt 一句带过/);
  assert.match(NAI_V5_PROMPT_GENERATION_SYSTEM, /other, 物种 体型 毛色/);
});
