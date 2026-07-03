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

test('chatCompletion merges extra request body into non-streaming completion requests', async () => {
  let capturedBody = null;

  const { chatCompletion } = requireFreshWithMocks('../src/lib/api-client.ts', {
    './ssrf-guard': {
      safeFetch: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'ok' } }] };
          },
        };
      },
    },
  });

  const result = await chatCompletion(
    {
      api_base: 'https://llm.example/v1',
      api_key: 'secret',
      model: 'deepseek-v4-pro',
      max_tokens: 1024,
      temperature: 0.7,
      json_mode: false,
    },
    [{ role: 'user', content: 'hello' }],
    undefined,
    { thinking: { type: 'disabled' } },
  );

  assert.equal(result, 'ok');
  assert.equal(capturedBody.model, 'deepseek-v4-pro');
  assert.deepEqual(capturedBody.thinking, { type: 'disabled' });
});

test('chatCompletion omits null/undefined sampling params and includes set ones', async () => {
  let capturedBody = null;

  const { chatCompletion } = requireFreshWithMocks('../src/lib/api-client.ts', {
    './ssrf-guard': {
      safeFetch: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'ok' } }] };
          },
        };
      },
    },
  });

  await chatCompletion(
    {
      api_base: 'https://llm.example/v1',
      api_key: 'secret',
      model: 'glm-5.2',
      max_tokens: 2048,
      temperature: 0.9,
      json_mode: false,
      // 启用 top_p 和 frequency_penalty，其余留空
      top_p: 0.9,
      frequency_penalty: 0.5,
      presence_penalty: null,
      top_k: null,
      repetition_penalty: null,
      seed: null,
    },
    [{ role: 'user', content: 'hi' }],
  );

  // 启用的参数应出现在请求体
  assert.equal(capturedBody.top_p, 0.9);
  assert.equal(capturedBody.frequency_penalty, 0.5);
  // null 的参数不应出现在请求体（JSON.stringify 会丢弃 undefined，这里测的是不写入）
  assert.equal('presence_penalty' in capturedBody, false, 'presence_penalty should be absent');
  assert.equal('top_k' in capturedBody, false, 'top_k should be absent');
  assert.equal('repetition_penalty' in capturedBody, false, 'repetition_penalty should be absent');
  assert.equal('seed' in capturedBody, false, 'seed should be absent');
});

test('chatCompletion sends reasoning_effort only when not default', async () => {
  let capturedBody = null;

  const { chatCompletion } = requireFreshWithMocks('../src/lib/api-client.ts', {
    './ssrf-guard': {
      safeFetch: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'ok' } }] };
          },
        };
      },
    },
  });

  const baseSettings = {
    api_base: 'https://llm.example/v1',
    api_key: 'secret',
    model: 'gemini-3.1-pro-preview',
    max_tokens: 2048,
    temperature: 0.9,
    json_mode: false,
  };

  // default：请求体不包含 reasoning_effort
  await chatCompletion({ ...baseSettings, reasoning_effort: 'default' }, [{ role: 'user', content: 'hi' }]);
  assert.equal('reasoning_effort' in capturedBody, false, 'reasoning_effort should be absent when default');

  // 未设置（旧数据无该字段）：同样不发送
  await chatCompletion(baseSettings, [{ role: 'user', content: 'hi' }]);
  assert.equal('reasoning_effort' in capturedBody, false, 'reasoning_effort should be absent when unset');

  // 显式档位：原样发送
  for (const effort of ['low', 'medium', 'high', 'max']) {
    await chatCompletion({ ...baseSettings, reasoning_effort: effort }, [{ role: 'user', content: 'hi' }]);
    assert.equal(capturedBody.reasoning_effort, effort);
  }
});

test('chatCompletion with all-null sampling params produces clean body', async () => {
  let capturedBody = null;

  const { chatCompletion } = requireFreshWithMocks('../src/lib/api-client.ts', {
    './ssrf-guard': {
      safeFetch: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'ok' } }] };
          },
        };
      },
    },
  });

  await chatCompletion(
    {
      api_base: 'https://llm.example/v1',
      api_key: 'secret',
      model: 'glm-5.2',
      max_tokens: 2048,
      temperature: 0.9,
      json_mode: false,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
      top_k: null,
      repetition_penalty: null,
      seed: null,
    },
    [{ role: 'user', content: 'hi' }],
  );

  // 全部 null 时请求体应只有基础字段
  const expectedKeys = ['model', 'messages', 'max_tokens', 'temperature', 'stream'];
  for (const key of expectedKeys) {
    assert.equal(key in capturedBody, true, `${key} should be present`);
  }
  for (const key of ['top_p', 'frequency_penalty', 'presence_penalty', 'top_k', 'repetition_penalty', 'seed']) {
    assert.equal(key in capturedBody, false, `${key} should be absent when null`);
  }
});
