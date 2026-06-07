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
  const raw = JSON.stringify(body);
  return {
    nextUrl: new URL('http://test.local/api/models'),
    async text() {
      return raw;
    },
    async json() {
      return body;
    },
  };
}

function textRequest(raw) {
  return {
    nextUrl: new URL('http://test.local/api/models'),
    async text() {
      return raw;
    },
  };
}

test('/api/models POST resolves api_base and api_key from provider_id', async () => {
  const seenRequests = [];
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT api_base, api_key, model FROM api_providers WHERE id = ?')) {
        return {
          get: id => {
            assert.equal(id, 'provider-bg');
            return {
              api_base: 'https://provider.example/v1',
              api_key: 'provider-secret',
              model: 'provider-model',
            };
          },
        };
      }
      if (sql.includes('SELECT models, cached_at FROM model_cache')) {
        return { get: () => undefined };
      }
      if (sql.includes('INSERT INTO model_cache')) {
        return { run: () => {} };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };

  const route = requireFreshWithMocks('../src/app/api/models/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://chat.example/v1',
        api_key: 'chat-secret',
        memory_engine: {
          embedding_api_base: '',
          embedding_api_key: '',
          reranker_api_base: '',
          reranker_api_key: '',
        },
      }),
    },
    '@/lib/ssrf-guard': {
      safeFetch: async (url, init) => {
        seenRequests.push({ url, auth: init.headers.Authorization });
        return {
          ok: true,
          async json() {
            return { data: [{ id: 'model-b' }, { id: 'model-a' }] };
          },
        };
      },
    },
  });

  const response = await route.POST(jsonRequest({
    provider_id: 'provider-bg',
    refresh: true,
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { models: ['model-a', 'model-b'], error: null, cached: false });
  assert.deepEqual(seenRequests, [
    { url: 'https://provider.example/v1/models', auth: 'Bearer provider-secret' },
  ]);
});

test('/api/models POST with empty body falls back to saved settings', async () => {
  const seenRequests = [];
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT models, cached_at FROM model_cache')) {
        return { get: () => undefined };
      }
      if (sql.includes('INSERT INTO model_cache')) {
        return { run: () => {} };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };

  const route = requireFreshWithMocks('../src/app/api/models/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://chat.example/v1',
        api_key: 'chat-secret',
        memory_engine: {
          embedding_api_base: '',
          embedding_api_key: '',
          reranker_api_base: '',
          reranker_api_key: '',
        },
      }),
    },
    '@/lib/ssrf-guard': {
      safeFetch: async (url, init) => {
        seenRequests.push({ url, auth: init.headers.Authorization });
        return {
          ok: true,
          async json() {
            return { models: ['saved-model'] };
          },
        };
      },
    },
  });

  const response = await route.POST(textRequest(''));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { models: ['saved-model'], error: null, cached: false });
  assert.deepEqual(seenRequests, [
    { url: 'https://chat.example/v1/models', auth: 'Bearer chat-secret' },
  ]);
});

test('/api/models POST rejects malformed JSON without fetching upstream models', async () => {
  let safeFetchCalled = false;

  const route = requireFreshWithMocks('../src/app/api/models/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': {
      getDb: () => {
        throw new Error('getDb should not be called');
      },
    },
    '@/lib/settings': {
      loadSettings: () => {
        throw new Error('loadSettings should not be called');
      },
    },
    '@/lib/ssrf-guard': {
      safeFetch: async () => {
        safeFetchCalled = true;
        throw new Error('safeFetch should not be called');
      },
    },
  });

  const response = await route.POST(textRequest('{'));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { models: [], error: '请求体不是有效 JSON' });
  assert.equal(safeFetchCalled, false);
});
