const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');

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

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          async json() { return body; },
        };
      },
    },
  };
}

function clearRouteDependencies() {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes(`${path.sep}src${path.sep}lib${path.sep}prompt-presets`)
      || key.includes(`${path.sep}src${path.sep}app${path.sep}api${path.sep}characters`)
    ) {
      delete require.cache[key];
    }
  }
}

function loadRoute(modulePath, db) {
  clearRouteDependencies();
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === 'next/server') return jsonResponseMock();
    if (request === '@/lib/db') return { getDb: () => db };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function jsonRequest(body) {
  return { async json() { return body; } };
}

test('character CRUD defaults to full, persists valid modes, preserves omissions, and rejects invalid values', async (t) => {
  const dbModule = require('../src/lib/db.ts');
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  dbModule.__migrateForTests(db);
  db.prepare(`
    INSERT INTO characters (id, name, active_preset_id, created_at, updated_at)
    VALUES ('char-existing', '艾莉丝', '__none__', datetime('now'), datetime('now'))
  `).run();

  const detailRoute = loadRoute('../src/app/api/characters/[id]/route.ts', db);
  const params = { params: Promise.resolve({ id: 'char-existing' }) };
  const initial = await detailRoute.GET({}, params);
  assert.equal((await initial.json()).memory_chat_injection_mode, 'full');

  for (const mode of ['local', 'hybrid', 'vector', 'full']) {
    const response = await detailRoute.PUT(jsonRequest({ memory_chat_injection_mode: mode }), params);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).memory_chat_injection_mode, mode);
  }

  await detailRoute.PUT(jsonRequest({ memory_chat_injection_mode: 'vector' }), params);
  const renamed = await detailRoute.PUT(jsonRequest({ name: '艾莉丝-改名' }), params);
  assert.equal((await renamed.json()).memory_chat_injection_mode, 'vector');

  const invalid = await detailRoute.PUT(jsonRequest({ memory_chat_injection_mode: 'inherit' }), params);
  assert.equal(invalid.status, 400);
  assert.equal(
    db.prepare("SELECT memory_chat_injection_mode FROM characters WHERE id = 'char-existing'").get().memory_chat_injection_mode,
    'vector',
  );

  const collectionRoute = loadRoute('../src/app/api/characters/route.ts', db);
  const defaultCreated = await collectionRoute.POST(jsonRequest({ name: '默认角色' }));
  assert.equal(defaultCreated.status, 201);
  assert.equal((await defaultCreated.json()).memory_chat_injection_mode, 'full');

  const localCreated = await collectionRoute.POST(jsonRequest({
    name: '本地角色',
    memory_chat_injection_mode: 'local',
  }));
  assert.equal(localCreated.status, 201);
  assert.equal((await localCreated.json()).memory_chat_injection_mode, 'local');
});
