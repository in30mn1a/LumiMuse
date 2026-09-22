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

function requireFreshWithMocks(modulePath, mocks) {
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

test('buildBackgroundChatExtraBody reads reasoning effort from the character model map', () => {
  const { buildBackgroundChatExtraBody } = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': {
      getDb: () => {
        throw new Error('db should not be used by buildBackgroundChatExtraBody');
      },
    },
  });

  const character = {
    background_provider_id: '',
    background_model: '',
    image_prompt_model: '',
    background_reasoning_by_model: { 'gpt-4o': 'high' },
    image_prompt_reasoning_by_model: {},
    background_system_prompt_by_model: {},
    image_prompt_system_prompt_by_model: {},
  };

  assert.deepEqual(
    buildBackgroundChatExtraBody('gpt-4o', { character, kind: 'background' }),
    { reasoning_effort: 'high' },
  );
  assert.equal(
    buildBackgroundChatExtraBody('gpt-4o', {
      character: { ...character, background_reasoning_by_model: { 'gpt-4o': 'default' } },
      kind: 'background',
    }),
    undefined,
  );
  assert.equal(buildBackgroundChatExtraBody('gpt-4o'), undefined);
});

test('character task models override background and image prompt models separately', () => {
  const { resolveBackgroundConfig, buildBackgroundChatExtraBody, resolveCharacterTaskSystemPrompt } = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': {
      getDb: () => {
        throw new Error('db should not be used when no background provider is selected');
      },
    },
  });

  const settings = {
    api_base: 'https://llm.example/v1',
    api_key: 'secret',
    model: 'chat-model',
  };
  const character = {
    background_provider_id: '',
    background_model: 'extract-model',
    image_prompt_model: 'draw-model',
    background_reasoning_by_model: { 'extract-model': 'high' },
    image_prompt_reasoning_by_model: { 'draw-model': 'max' },
    background_system_prompt_by_model: { 'extract-model': 'extract carefully' },
    image_prompt_system_prompt_by_model: { 'draw-model': 'draw carefully' },
  };

  assert.equal(
    resolveBackgroundConfig(settings, { character, kind: 'background' }).model,
    'extract-model',
  );
  assert.deepEqual(
    buildBackgroundChatExtraBody('extract-model', { character, kind: 'background' }),
    { reasoning_effort: 'high' },
  );
  assert.equal(
    resolveCharacterTaskSystemPrompt({ character, kind: 'background' }, 'extract-model'),
    'extract carefully',
  );
  assert.equal(
    resolveBackgroundConfig(settings, { character, kind: 'image_prompt' }).model,
    'draw-model',
  );
  assert.deepEqual(
    buildBackgroundChatExtraBody('draw-model', { character, kind: 'image_prompt' }),
    { reasoning_effort: 'max' },
  );
  assert.equal(
    resolveCharacterTaskSystemPrompt({ character, kind: 'image_prompt' }, 'draw-model'),
    'draw carefully',
  );

  const followBackground = {
    ...character,
    image_prompt_model: '',
  };
  assert.equal(
    resolveBackgroundConfig(settings, { character: followBackground, kind: 'image_prompt' }).model,
    'extract-model',
  );
  assert.deepEqual(
    buildBackgroundChatExtraBody('extract-model', { character: followBackground, kind: 'image_prompt' }),
    { reasoning_effort: 'high' },
  );
  assert.equal(
    resolveCharacterTaskSystemPrompt({ character: followBackground, kind: 'image_prompt' }, 'extract-model'),
    'extract carefully',
  );

  assert.equal(resolveBackgroundConfig(settings).model, 'chat-model');
  assert.equal(
    buildBackgroundChatExtraBody('chat-model', {
      character: { ...character, background_model: '', image_prompt_model: '' },
      kind: 'background',
    }),
    undefined,
  );
  assert.equal(
    buildBackgroundChatExtraBody('draw-model', {
      character: { ...character, image_prompt_reasoning_by_model: { 'draw-model': 'default' } },
      kind: 'image_prompt',
    }),
    undefined,
  );
});

test('mergeSettingsForBackgroundLlm clears chat reasoning_effort from background requests', () => {
  const { mergeSettingsForBackgroundLlm } = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': {
      getDb: () => {
        throw new Error('db should not be used');
      },
    },
  });

  const base = {
    api_base: 'https://main/v1',
    api_key: 'k',
    model: 'main-model',
    reasoning_effort: 'max',
    max_tokens: 4096,
    temperature: 1,
  };

  const merged = mergeSettingsForBackgroundLlm(base, {
    api_base: 'https://bg/v1',
    api_key: 'bk',
    model: 'bg-model',
  });

  assert.equal(merged.model, 'bg-model');
  assert.equal(merged.reasoning_effort, 'default');
});

test('resolveBackgroundConfig uses the character provider and falls back to the main API', () => {
  const { resolveBackgroundConfig } = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': {
      getDb: () => ({
        prepare: () => ({
          get: id => {
            assert.equal(id, 'provider-1');
            return {
              api_base: 'https://provider.example/v1',
              api_key: 'provider-key',
            };
          },
        }),
      }),
    },
  });

  const character = {
    background_provider_id: 'provider-1',
    background_model: 'grok-4.6',
    image_prompt_model: '',
    background_reasoning_by_model: {},
    image_prompt_reasoning_by_model: {},
    background_system_prompt_by_model: {},
    image_prompt_system_prompt_by_model: {},
  };
  assert.deepEqual(resolveBackgroundConfig({
    api_base: 'https://main.example/v1',
    api_key: 'main-key',
    model: 'gemini-3.8-flash',
  }, { character, kind: 'background' }), {
    api_base: 'https://provider.example/v1',
    api_key: 'provider-key',
    model: 'grok-4.6',
  });
});

test('resolveBackgroundConfig uses the main chat model when the character model is blank', () => {
  const { resolveBackgroundConfig } = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': {
      getDb: () => ({
        prepare: () => ({
          get: () => undefined,
        }),
      }),
    },
  });

  assert.deepEqual(resolveBackgroundConfig({
    api_base: 'https://main.example/v1',
    api_key: 'main-key',
    model: 'main-model',
  }, {
    character: {
      background_provider_id: 'missing',
      background_model: '',
      image_prompt_model: '',
      background_reasoning_by_model: {},
      image_prompt_reasoning_by_model: {},
      background_system_prompt_by_model: {},
      image_prompt_system_prompt_by_model: {},
    },
    kind: 'background',
  }), {
    api_base: 'https://main.example/v1',
    api_key: 'main-key',
    model: 'main-model',
  });
});

test('character task model list posts provider_id and settings no longer selects a background provider', () => {
  const settingsPage = fs.readFileSync(path.join(root, 'src/app/settings/page.tsx'), 'utf8');
  const characterField = fs.readFileSync(path.join(root, 'src/components/ui/CharacterTaskModelsField.tsx'), 'utf8');

  assert.equal(settingsPage.includes('memory_background_provider_id'), false);
  assert.ok(characterField.includes('body.provider_id = selectedProviderId'));
});

test('image prompt route resolves background provider and model before chat completion', () => {
  const route = fs.readFileSync(path.join(root, 'src/app/api/image-gen/prompt/route.ts'), 'utf8');

  assert.ok(route.includes('resolveBackgroundConfig'));
  assert.ok(route.includes('mergeSettingsForBackgroundLlm'));
});

test('background LLM watchdog is wired only into background call sites', () => {
  const memoryEngine = fs.readFileSync(path.join(root, 'src/lib/memory-engine.ts'), 'utf8');
  const memoryProfile = fs.readFileSync(path.join(root, 'src/lib/memory-profile.ts'), 'utf8');
  const imagePrompt = fs.readFileSync(path.join(root, 'src/app/api/image-gen/prompt/route.ts'), 'utf8');
  const chatEngine = fs.readFileSync(path.join(root, 'src/lib/chat-engine.ts'), 'utf8');

  for (const source of [memoryEngine, memoryProfile, imagePrompt]) {
    assert.match(source, /runWithBackgroundLlmDeadline/);
    assert.match(source, /memory_background_timeout_ms/);
  }
  assert.doesNotMatch(chatEngine, /runWithBackgroundLlmDeadline/);
});

test('memory settings exposes the configurable background timeout with explicit zero semantics', () => {
  const section = fs.readFileSync(path.join(root, 'src/components/settings/memory/MemoryEngineSection.tsx'), 'utf8');
  const translations = fs.readFileSync(path.join(root, 'src/lib/i18n.ts'), 'utf8');

  assert.match(section, /memory_background_timeout_ms/);
  assert.match(section, /settings\.memoryBackgroundTimeout/);
  assert.match(translations, /'settings\.memoryBackgroundTimeout'/);
  assert.match(translations, /30 分钟/);
  assert.match(translations, /0[^\n]+关闭/);
  assert.match(translations, /30 minutes/i);
});
