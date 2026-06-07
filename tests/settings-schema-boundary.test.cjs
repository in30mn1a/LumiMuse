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
    for (const resetPath of [
      modulePath,
      '../src/lib/schemas.ts',
      '../src/lib/constants.ts',
      '../src/types/index.ts',
    ]) {
      const resolved = require.resolve(resetPath);
      delete require.cache[resolved];
    }
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          body,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function jsonRequest(body) {
  return {
    signal: new AbortController().signal,
    async json() {
      return body;
    },
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createSettingsHarness(initialSettings = {}) {
  const settingsState = {
    api_base: 'https://llm.example/v1',
    api_key: 'main-secret',
    model: 'chat-model',
    temperature: 0.7,
    max_tokens: 4096,
    context_window: 131072,
    json_mode: false,
    image_gen: {
      enabled: false,
      nai_api_key: 'nai-secret',
      custom_api_key: 'custom-secret',
    },
    memory_engine: {
      enabled: false,
      embedding_api_base: 'https://embedding.example/v1',
      embedding_api_key: 'embedding-secret',
      embedding_model: 'embedding-model',
      embedding_dimension: 1024,
      reranker_api_base: 'https://reranker.example/v1',
      reranker_api_key: 'reranker-secret',
      reranker_model: 'reranker-model',
    },
    ...initialSettings,
  };
  const writes = [];
  const db = {
    prepare() {
      return {
        run(key, value) {
          writes.push({ key, value });
          settingsState[key] = JSON.parse(value);
        },
      };
    },
    transaction(fn) {
      return () => fn();
    },
  };
  const route = requireFreshWithMocks('../src/app/api/settings/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => deepClone(settingsState) },
  });

  return { route, settingsState, writes };
}

function loadSettingsFromRows(rows) {
  const db = {
    prepare() {
      return {
        all() {
          return rows;
        },
      };
    },
  };
  const { loadSettings } = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': { getDb: () => db },
  });
  return loadSettings();
}

async function assertInvalidSettingsPut(body) {
  const harness = createSettingsHarness();
  const before = deepClone(harness.settingsState);

  const response = await harness.route.PUT(jsonRequest(body));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Invalid request body');
  assert.deepEqual(harness.settingsState, before);
  assert.deepEqual(harness.writes, []);
}

test('loadSettings normalizes legacy numeric booleans into a saveable settings payload', () => {
  const { settingsUpdateSchema, formatZodFieldErrors } = require('../src/lib/schemas.ts');
  const settings = loadSettingsFromRows([
    { key: 'json_mode', value: '0' },
  ]);

  const parsed = settingsUpdateSchema.safeParse(settings);

  assert.equal(settings.json_mode, false);
  assert.equal(
    parsed.success,
    true,
    parsed.success ? undefined : JSON.stringify(formatZodFieldErrors(parsed.error))
  );
});

test('loadSettings normalizes legacy memory preset retrieval modes into a saveable settings payload', () => {
  const { settingsUpdateSchema, formatZodFieldErrors } = require('../src/lib/schemas.ts');
  const settings = loadSettingsFromRows([
    { key: 'memory_engine', value: JSON.stringify({ retrieval_mode: 'balanced' }) },
  ]);

  const parsed = settingsUpdateSchema.safeParse(settings);

  assert.equal(settings.memory_engine.retrieval_mode, 'hybrid');
  assert.equal(
    parsed.success,
    true,
    parsed.success ? undefined : JSON.stringify(formatZodFieldErrors(parsed.error))
  );
});

test('/api/settings PUT rejects string max_tokens without writing settings', async () => {
  await assertInvalidSettingsPut({ max_tokens: 'x' });
});

test('/api/settings PUT rejects string image_gen.enabled without writing settings', async () => {
  await assertInvalidSettingsPut({ image_gen: { enabled: 'false' } });
});

test('/api/settings PUT rejects object api_base without writing settings', async () => {
  await assertInvalidSettingsPut({ api_base: {} });
});

test('/api/settings PUT accepts known typed fields and preserves unknown fields', async () => {
  const harness = createSettingsHarness();

  const response = await harness.route.PUT(jsonRequest({
    api_base: 'https://llm.example/v1',
    model: 'chat-model-v2',
    max_tokens: 8192,
    image_gen: {
      enabled: true,
      custom_model: 'dall-e-3',
      future_image_option: { keep: true },
    },
    future_top_level_option: { keep: true },
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(harness.settingsState.model, 'chat-model-v2');
  assert.equal(harness.settingsState.max_tokens, 8192);
  assert.equal(harness.settingsState.image_gen.enabled, true);
  assert.equal(harness.settingsState.image_gen.custom_model, 'dall-e-3');
  assert.deepEqual(harness.settingsState.image_gen.future_image_option, { keep: true });
  assert.equal(harness.settingsState.future_top_level_option, undefined);
  assert.equal(payload.model, 'chat-model-v2');
});

test('/api/settings PUT keeps masked api_key when api_base is unchanged', async () => {
  const { API_KEY_MASK } = require('../src/lib/constants.ts');
  const harness = createSettingsHarness();

  const response = await harness.route.PUT(jsonRequest({
    api_base: 'https://llm.example/v1',
    api_key: API_KEY_MASK,
    model: 'chat-model-v2',
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(harness.settingsState.api_key, 'main-secret');
  assert.equal(harness.settingsState.model, 'chat-model-v2');
  assert.equal(payload.api_key, API_KEY_MASK);
});

test('/api/settings PUT clears masked api_key when api_base changes', async () => {
  const { API_KEY_MASK } = require('../src/lib/constants.ts');
  const harness = createSettingsHarness();

  const response = await harness.route.PUT(jsonRequest({
    api_base: 'https://new-llm.example/v1',
    api_key: API_KEY_MASK,
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(harness.settingsState.api_base, 'https://new-llm.example/v1');
  assert.equal(harness.settingsState.api_key, '');
  assert.equal(payload.api_key, '');
});
