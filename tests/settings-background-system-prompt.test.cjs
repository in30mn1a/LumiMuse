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

test('DEFAULT_SETTINGS contains memory_background_system_prompt and by_model dictionary', () => {
  const { DEFAULT_SETTINGS } = requireFreshWithMocks('../src/types/index.ts');
  assert.strictEqual(DEFAULT_SETTINGS.memory_background_system_prompt, '');
  assert.deepEqual(DEFAULT_SETTINGS.memory_background_system_prompt_by_model, {});
});

test('settingsUpdateSchema validates memory_background_system_prompt and by_model within limits', () => {
  const { settingsUpdateSchema } = requireFreshWithMocks('../src/lib/schemas.ts');

  const valid = settingsUpdateSchema.safeParse({
    memory_background_system_prompt: 'Custom background system prompt',
    memory_background_system_prompt_by_model: {
      'model-a': 'prompt a',
      'model-b': 'prompt b',
    },
  });
  assert.ok(valid.success);

  const oversized = 'a'.repeat(32 * 1024 + 1);
  const invalidPrompt = settingsUpdateSchema.safeParse({
    memory_background_system_prompt: oversized,
  });
  assert.strictEqual(invalidPrompt.success, false);

  const invalidByModel = settingsUpdateSchema.safeParse({
    memory_background_system_prompt_by_model: {
      'model-a': oversized,
    },
  });
  assert.strictEqual(invalidByModel.success, false);
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

test('all 6 background LLM call sites pass model to applyBackgroundSystemPrompt', () => {
  const memoryEngine = fs.readFileSync(path.join(root, 'src/lib/memory-engine.ts'), 'utf8');
  const memoryProfile = fs.readFileSync(path.join(root, 'src/lib/memory-profile.ts'), 'utf8');
  const summarize = fs.readFileSync(path.join(root, 'src/app/api/summarize/route.ts'), 'utf8');
  const memoryReview = fs.readFileSync(path.join(root, 'src/app/api/memory-review/route.ts'), 'utf8');
  const memoryArchive = fs.readFileSync(path.join(root, 'src/app/api/memory-archive/route.ts'), 'utf8');
  const imagePrompt = fs.readFileSync(path.join(root, 'src/app/api/image-gen/prompt/route.ts'), 'utf8');

  assert.match(memoryEngine, /applyBackgroundSystemPrompt\(\s*\[\{ role: 'user', content: prompt \}\],\s*context\.llmSettings,\s*context\.llmSettings\.model/);
  assert.match(memoryEngine, /applyBackgroundSystemPrompt\(\s*\[\{ role: 'user', content: prompt \}\],\s*settings,\s*extractionSettings\.model/);
  assert.match(memoryProfile, /applyBackgroundSystemPrompt\(\s*\[\{ role: 'user', content: prompt \}\],\s*loaded,\s*settings\.model/);
  assert.match(summarize, /applyBackgroundSystemPrompt\(\s*\[\{ role: 'user', content: summaryPrompt \}\],\s*settings,\s*bgConfig\.model/);
  assert.match(memoryReview, /applyBackgroundSystemPrompt\(\s*\[\{ role: 'user', content: prompt \}\],\s*settings,\s*llmSettings\.model/);
  assert.match(memoryArchive, /applyBackgroundSystemPrompt\(\s*\[\{ role: 'user', content: prompt \}\],\s*settings,\s*llmSettings\.model/);
  assert.match(imagePrompt, /applyBackgroundSystemPrompt\([\s\S]+?loadedSettings,\s*settings\.model\)/);
});

test('settings UI and i18n expose memory_background_system_prompt with model binding', () => {
  const section = fs.readFileSync(path.join(root, 'src/components/settings/memory/MemoryEngineSection.tsx'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'src/lib/i18n.ts'), 'utf8');

  assert.ok(section.includes('settings-memory-background-system-prompt'), 'Section has textarea ID');
  assert.ok(section.includes('planBackgroundModelSwitch'), 'Section uses planBackgroundModelSwitch');
  assert.ok(section.includes('handleBgModelChange'), 'Section handles background model change');
  assert.ok(section.includes('handleBgPromptChange'), 'Section handles prompt change per model');

  assert.ok(i18n.includes("'settings.memoryBackgroundSystemPrompt': '后台任务系统提示词'"));
  assert.ok(i18n.includes("'settings.memoryBackgroundSystemPrompt': 'Background task system prompt'"));
  assert.ok(i18n.includes('切换后台模型时将同步切换对应提示词'));
  assert.ok(i18n.includes('switch automatically with model changes'));
});
