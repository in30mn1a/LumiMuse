const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

function requireFreshWithMocks(modulePath, mocks = {}) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('applyBackgroundSystemPrompt returns original messages if prompt is empty or whitespace', () => {
  const { applyBackgroundSystemPrompt } = requireFreshWithMocks('../src/lib/background-system-prompt.ts');

  const initial = [{ role: 'user', content: 'hello' }];
  assert.strictEqual(applyBackgroundSystemPrompt(initial, ''), initial);
  assert.strictEqual(applyBackgroundSystemPrompt(initial, '   '), initial);
  assert.strictEqual(applyBackgroundSystemPrompt(initial, undefined), initial);
  assert.strictEqual(applyBackgroundSystemPrompt(initial, { memory_background_system_prompt: '' }), initial);
  assert.strictEqual(applyBackgroundSystemPrompt(initial, { memory_background_system_prompt: '   \n  ' }), initial);
});

test('applyBackgroundSystemPrompt prepends system message when first message is not system', () => {
  const { applyBackgroundSystemPrompt } = requireFreshWithMocks('../src/lib/background-system-prompt.ts');

  const initial = [{ role: 'user', content: 'do something' }];
  const res = applyBackgroundSystemPrompt(initial, 'You are an analysis assistant.');

  assert.strictEqual(res.length, 2);
  assert.deepEqual(res[0], { role: 'system', content: 'You are an analysis assistant.' });
  assert.deepEqual(res[1], { role: 'user', content: 'do something' });
});

test('applyBackgroundSystemPrompt merges to existing system message at index 0', () => {
  const { applyBackgroundSystemPrompt } = requireFreshWithMocks('../src/lib/background-system-prompt.ts');

  const initial = [
    { role: 'system', content: 'Existing system instructions.' },
    { role: 'user', content: 'User query' },
  ];
  const res = applyBackgroundSystemPrompt(initial, 'Top-level background system prompt.');

  assert.strictEqual(res.length, 2);
  assert.deepEqual(res[0], {
    role: 'system',
    content: 'Top-level background system prompt.\n\nExisting system instructions.',
  });
  assert.deepEqual(res[1], { role: 'user', content: 'User query' });
});

test('applyBackgroundSystemPrompt handles system message with empty content cleanly', () => {
  const { applyBackgroundSystemPrompt } = requireFreshWithMocks('../src/lib/background-system-prompt.ts');

  const initial = [
    { role: 'system', content: '   ' },
    { role: 'user', content: 'User query' },
  ];
  const res = applyBackgroundSystemPrompt(initial, 'Background prompt');

  assert.strictEqual(res.length, 2);
  assert.deepEqual(res[0], { role: 'system', content: 'Background prompt' });
  assert.deepEqual(res[1], { role: 'user', content: 'User query' });
});

test('applyBackgroundSystemPrompt handles empty messages array', () => {
  const { applyBackgroundSystemPrompt } = requireFreshWithMocks('../src/lib/background-system-prompt.ts');

  const res = applyBackgroundSystemPrompt([], 'Background prompt');
  assert.strictEqual(res.length, 1);
  assert.deepEqual(res[0], { role: 'system', content: 'Background prompt' });
});

test('resolveBackgroundSystemPrompt resolves model-specific prompt from by_model dictionary', () => {
  const { resolveBackgroundSystemPrompt, applyBackgroundSystemPrompt } = requireFreshWithMocks('../src/lib/background-system-prompt.ts');

  const settings = {
    memory_background_system_prompt: 'Default background prompt',
    memory_background_system_prompt_by_model: {
      'gpt-4o-mini': 'Prompt for GPT-4o mini',
      'deepseek-chat': 'Prompt for DeepSeek',
    },
  };

  assert.strictEqual(resolveBackgroundSystemPrompt(settings, 'gpt-4o-mini'), 'Prompt for GPT-4o mini');
  assert.strictEqual(resolveBackgroundSystemPrompt(settings, 'deepseek-chat'), 'Prompt for DeepSeek');
  assert.strictEqual(resolveBackgroundSystemPrompt(settings, 'claude-3-5-sonnet'), 'Default background prompt');
  assert.strictEqual(resolveBackgroundSystemPrompt(settings, ''), 'Default background prompt');
  assert.strictEqual(resolveBackgroundSystemPrompt(settings, undefined), 'Default background prompt');

  const messages = [{ role: 'user', content: 'hello' }];
  const res = applyBackgroundSystemPrompt(messages, settings, 'gpt-4o-mini');
  assert.deepEqual(res[0], { role: 'system', content: 'Prompt for GPT-4o mini' });
});

test('planBackgroundModelSwitch saves current prompt and restores target model prompt', () => {
  const { planBackgroundModelSwitch } = requireFreshWithMocks('../src/lib/background-system-prompt.ts');

  let byModel = {};

  // 1. Model A has prompt "Prompt A"
  const step1 = planBackgroundModelSwitch({
    previousModel: 'model-a',
    previousPrompt: 'Prompt A',
    nextModel: 'model-b',
    byModel,
  });

  // Next prompt for model-b should be empty, and model-a should be remembered
  assert.strictEqual(step1.prompt, '');
  assert.strictEqual(step1.byModel['model-a'], 'Prompt A');
  assert.strictEqual(step1.byModel['model-b'], '');

  // 2. User edits model-b's prompt to "Prompt B", then switches to model-c
  byModel = { ...step1.byModel, 'model-b': 'Prompt B' };
  const step2 = planBackgroundModelSwitch({
    previousModel: 'model-b',
    previousPrompt: 'Prompt B',
    nextModel: 'model-c',
    byModel,
  });
  assert.strictEqual(step2.prompt, '');
  assert.strictEqual(step2.byModel['model-b'], 'Prompt B');

  // 3. Switch back to model-a: should restore "Prompt A"
  byModel = step2.byModel;
  const step3 = planBackgroundModelSwitch({
    previousModel: 'model-c',
    previousPrompt: '',
    nextModel: 'model-a',
    byModel,
  });
  assert.strictEqual(step3.prompt, 'Prompt A');

  // 4. Switch back to model-b: should restore "Prompt B"
  const step4 = planBackgroundModelSwitch({
    previousModel: 'model-a',
    previousPrompt: 'Prompt A',
    nextModel: 'model-b',
    byModel: step3.byModel,
  });
  assert.strictEqual(step4.prompt, 'Prompt B');
});

test('global settings no longer store a background system prompt', () => {
  const { DEFAULT_SETTINGS } = requireFreshWithMocks('../src/types/index.ts');
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, 'memory_background_system_prompt'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, 'memory_background_system_prompt_by_model'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, 'memory_background_model'), false);
});

test('character schema validates separate background and image prompt maps', () => {
  const { characterCreateSchema } = requireFreshWithMocks('../src/lib/schemas.ts');

  const valid = characterCreateSchema.safeParse({
    background_system_prompt_by_model: { 'model-a': 'prompt a' },
    image_prompt_system_prompt_by_model: { 'model-b': 'prompt b' },
  });
  assert.equal(valid.success, true);

  const oversized = 'a'.repeat(32 * 1024 + 1);
  const invalid = characterCreateSchema.safeParse({
    background_system_prompt_by_model: { 'model-a': oversized },
  });
  assert.equal(invalid.success, false);
});

test('sanitizeBackgroundSystemPromptByModel drops prototype pollution and oversized entries', () => {
  const { sanitizeBackgroundSystemPromptByModel } = requireFreshWithMocks('../src/lib/settings.ts');

  const sanitized = sanitizeBackgroundSystemPromptByModel({
    '__proto__': 'malicious',
    'constructor': 'malicious',
    'valid-model': 'valid prompt',
    123: 'numeric key',
  });

  assert.strictEqual(sanitized['valid-model'], 'valid prompt');
  assert.strictEqual(sanitized['123'], 'numeric key');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sanitized, '__proto__'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sanitized, 'constructor'), false);
});

test('background LLM call sites use the character task system prompt', () => {
  const files = [
    'src/lib/memory-engine.ts',
    'src/lib/memory-profile.ts',
    'src/app/api/summarize/route.ts',
    'src/app/api/memory-review/route.ts',
    'src/app/api/memory-archive/route.ts',
    'src/app/api/image-gen/prompt/route.ts',
  ];
  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.match(source, /resolveCharacterTaskSystemPrompt/, relativePath);
    assert.match(source, /applyBackgroundSystemPrompt/, relativePath);
  }
});

test('character editor exposes separate system prompts and settings no longer does', () => {
  const section = fs.readFileSync(path.join(root, 'src/components/settings/memory/MemoryEngineSection.tsx'), 'utf8');
  const field = fs.readFileSync(path.join(root, 'src/components/ui/CharacterTaskModelsField.tsx'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'src/lib/i18n.ts'), 'utf8');

  assert.equal(section.includes('settings-memory-background-system-prompt'), false);
  assert.equal(section.includes('memory_background_model'), false);
  assert.match(field, /background_system_prompt_by_model/);
  assert.match(field, /image_prompt_system_prompt_by_model/);
  assert.match(field, /planBackgroundModelSwitch/);
  assert.ok(i18n.includes("'editor.taskModelSystemPrompt': '系统提示词'"));
  assert.ok(i18n.includes("'editor.taskModelSystemPrompt': 'System prompt'"));
  assert.ok(i18n.includes('换成该模型自己的提示词'));
});
