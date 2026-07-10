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

test('buildBackgroundChatExtraBody disables thinking only for DeepSeek background models when enabled', () => {
  const { buildBackgroundChatExtraBody } = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': {
      getDb: () => {
        throw new Error('db should not be used by buildBackgroundChatExtraBody');
      },
    },
  });

  assert.deepEqual(
    buildBackgroundChatExtraBody({ disable_deepseek_thinking_for_background: true }, 'deepseek-v4-pro'),
    { thinking: { type: 'disabled' } },
  );
  assert.equal(
    buildBackgroundChatExtraBody({ disable_deepseek_thinking_for_background: true }, 'gpt-4o-mini'),
    undefined,
  );
  assert.equal(
    buildBackgroundChatExtraBody({ disable_deepseek_thinking_for_background: false }, 'deepseek-v4-pro'),
    undefined,
  );
});

test('buildBackgroundChatExtraBody adds reasoning_effort only when background toggle is on', () => {
  const { buildBackgroundChatExtraBody } = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': {
      getDb: () => {
        throw new Error('db should not be used');
      },
    },
  });

  assert.equal(
    buildBackgroundChatExtraBody(
      {
        disable_deepseek_thinking_for_background: false,
        memory_background_reasoning_effort_enabled: false,
        memory_background_reasoning_effort: 'high',
      },
      'gpt-4o',
    ),
    undefined,
  );

  assert.deepEqual(
    buildBackgroundChatExtraBody(
      {
        disable_deepseek_thinking_for_background: false,
        memory_background_reasoning_effort_enabled: true,
        memory_background_reasoning_effort: 'high',
      },
      'gpt-4o',
    ),
    { reasoning_effort: 'high' },
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

test('resolveBackgroundConfig lets explicit background model override provider model', () => {
  const { resolveBackgroundConfig } = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': {
      getDb: () => ({
        prepare: () => ({
          get: id => {
            assert.equal(id, 'provider-1');
            return {
              api_base: 'https://provider.example/v1',
              api_key: 'provider-key',
              model: 'deepseek-v4-pro',
            };
          },
        }),
      }),
    },
  });

  assert.deepEqual(resolveBackgroundConfig({
    api_base: 'https://main.example/v1',
    api_key: 'main-key',
    model: 'deepseek-v4-pro',
    memory_background_provider_id: 'provider-1',
    memory_background_model: 'gemini-3.1-pro-preview',
  }), {
    api_base: 'https://provider.example/v1',
    api_key: 'provider-key',
    model: 'gemini-3.1-pro-preview',
  });
});

test('resolveBackgroundConfig falls back to provider model when background model is blank', () => {
  const { resolveBackgroundConfig } = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': {
      getDb: () => ({
        prepare: () => ({
          get: () => ({
            api_base: 'https://provider.example/v1',
            api_key: 'provider-key',
            model: 'deepseek-v4-pro',
          }),
        }),
      }),
    },
  });

  assert.deepEqual(resolveBackgroundConfig({
    api_base: 'https://main.example/v1',
    api_key: 'main-key',
    model: 'main-model',
    memory_background_provider_id: 'provider-1',
    memory_background_model: '   ',
  }), {
    api_base: 'https://provider.example/v1',
    api_key: 'provider-key',
    model: 'deepseek-v4-pro',
  });
});

test('settings background model fetch posts provider_id instead of provider api_key when provider is selected', () => {
  const settingsPage = fs.readFileSync(path.join(root, 'src/app/settings/page.tsx'), 'utf8');

  assert.ok(settingsPage.includes('providerId?: string'), 'fetchModelList should accept providerId');
  assert.ok(settingsPage.includes('body.provider_id = providerId;'), 'provider branch should post provider_id');
  assert.match(
    settingsPage,
    /fetchModelList\(apiBase,\s*apiKey,\s*undefined,\s*providerId \|\| undefined\)/,
    'background model fetch should pass selected provider_id',
  );
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
