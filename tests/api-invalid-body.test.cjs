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

function invalidJsonRequest() {
  return {
    signal: new AbortController().signal,
    async json() {
      throw new SyntaxError('Unexpected token');
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

async function assertJsonError(response, status, error) {
  assert.equal(response.status, status);
  const payload = await response.json();
  assert.equal(payload.error, error);
}

function failIfCalled(name) {
  return () => {
    throw new Error(`${name} should not be called for invalid request body`);
  };
}

test('/api/settings PUT returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/settings/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
  });

  const response = await route.PUT(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/settings PUT returns 400 for a non-object body', async () => {
  const route = requireFreshWithMocks('../src/app/api/settings/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
  });

  const response = await route.PUT(jsonRequest([]));

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/summarize POST returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/summarize/route.ts', {
    'next/server': {},
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.POST(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/image-gen POST returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/image-gen/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
    '@/lib/ssrf-guard': { safeFetch: failIfCalled('safeFetch') },
    'fs/promises': { writeFile: failIfCalled('writeFile'), mkdir: failIfCalled('mkdir') },
  });

  const response = await route.POST(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/image-gen POST returns 400 for a non-object override', async () => {
  const route = requireFreshWithMocks('../src/app/api/image-gen/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
    '@/lib/ssrf-guard': { safeFetch: failIfCalled('safeFetch') },
    'fs/promises': { writeFile: failIfCalled('writeFile'), mkdir: failIfCalled('mkdir') },
  });

  const response = await route.POST(jsonRequest({ prompt: 'portrait', override: [] }));

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/image-gen/prompt POST returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/image-gen/prompt/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/settings': {
      loadSettings: failIfCalled('loadSettings'),
      resolveBackgroundConfig: failIfCalled('resolveBackgroundConfig'),
      buildBackgroundChatExtraBody: failIfCalled('buildBackgroundChatExtraBody'),
    },
    '@/lib/api-client': { chatCompletion: failIfCalled('chatCompletion') },
  });

  const response = await route.POST(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});
