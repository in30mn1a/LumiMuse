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
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
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

test('/api/image-gen/delete preserves the character directory while checking nested references', async () => {
  const db = {};
  let checkedCandidates = null;
  let deletedCandidates = null;
  const route = requireFreshWithMocks('../src/app/api/image-gen/delete/route.ts', {
    'next/server': {
      NextResponse: {
        json(body, init = {}) {
          return { status: init.status ?? 200, json: async () => body };
        },
      },
    },
    '@/lib/db': { getDb: () => db },
    '@/lib/request-json': {
      readJsonObject: async () => ({
        ok: true,
        data: { url: '/api/files/generated/char-a/image.png' },
      }),
    },
    '@/lib/character-file-utils': {
      resolveLocalAssetUrl: () => ({
        dir: 'generated',
        filename: 'char-a/image.png',
        filePath: 'unused',
      }),
      filterUnreferencedLocalAssetUrls(receivedDb, candidates) {
        assert.equal(receivedDb, db);
        checkedCandidates = [...candidates];
        return checkedCandidates;
      },
      async deleteLocalAssetUrls(candidates) {
        deletedCandidates = [...candidates];
      },
    },
  });

  const response = await route.POST({});

  assert.equal(response.status, 200);
  assert.deepEqual(checkedCandidates, ['/api/files/generated/char-a/image.png']);
  assert.deepEqual(deletedCandidates, checkedCandidates);
});
