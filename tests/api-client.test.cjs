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
