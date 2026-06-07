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

function requireFreshWithMocks(modulePath, mocks) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulesToReset = [
      modulePath,
      '../src/lib/settings.ts',
      '../src/lib/schemas.ts',
      '../src/lib/constants.ts',
    ];
    for (const resetPath of modulesToReset) {
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
    nextUrl: new URL('http://test.local/api/providers'),
    cookies: { get: () => undefined },
    async json() {
      return body;
    },
  };
}

function createProviderDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_base TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      temperature REAL NOT NULL DEFAULT 1,
      max_tokens INTEGER NOT NULL DEFAULT 4096,
      context_window INTEGER NOT NULL DEFAULT 131072,
      json_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function upsertSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : undefined;
}

function insertProvider(db, fields = {}) {
  const provider = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Existing Provider',
    api_base: 'https://old-provider.example/v1',
    api_key: 'old-provider-key',
    model: 'old-model',
    temperature: 0.7,
    max_tokens: 2048,
    context_window: 8192,
    json_mode: 0,
    ...fields,
  };
  db.prepare(`
    INSERT INTO api_providers (
      id, name, api_base, api_key, model, temperature,
      max_tokens, context_window, json_mode
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    provider.id,
    provider.name,
    provider.api_base,
    provider.api_key,
    provider.model,
    provider.temperature,
    provider.max_tokens,
    provider.context_window,
    provider.json_mode,
  );
  return provider;
}

function loadRoute(db) {
  return requireFreshWithMocks('../src/app/api/providers/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });
}

const { API_KEY_MASK } = require('../src/lib/constants.ts');

test('/api/providers POST clears masked api_key when api_base changes from current settings', async () => {
  const db = createProviderDb();
  upsertSetting(db, 'api_base', 'https://old-provider.example/v1');
  upsertSetting(db, 'api_key', 'old-settings-key');
  const route = loadRoute(db);

  const response = await route.POST(jsonRequest({
    name: 'New Provider',
    api_base: 'https://new-provider.example/v1',
    api_key: API_KEY_MASK,
  }));
  const payload = await response.json();
  const provider = db.prepare('SELECT api_key FROM api_providers WHERE id = ?').get(payload.id);

  assert.equal(response.status, 200);
  assert.equal(provider.api_key, '');
  assert.notEqual(provider.api_key, 'old-settings-key');
});

test('/api/providers PUT clears masked api_key when api_base changes from existing provider', async () => {
  const db = createProviderDb();
  const existing = insertProvider(db);
  const route = loadRoute(db);

  const response = await route.PUT(jsonRequest({
    id: existing.id,
    api_base: 'https://new-provider.example/v1',
    api_key: API_KEY_MASK,
  }));
  const provider = db.prepare('SELECT api_key FROM api_providers WHERE id = ?').get(existing.id);

  assert.equal(response.status, 200);
  assert.equal(provider.api_key, '');
  assert.notEqual(provider.api_key, 'old-provider-key');
});

test('/api/providers save_as_current writes the cleared provider key into settings', async () => {
  const db = createProviderDb();
  const existing = insertProvider(db);
  upsertSetting(db, 'api_key', 'old-settings-key');
  const route = loadRoute(db);

  const response = await route.PUT(jsonRequest({
    id: existing.id,
    api_base: 'https://new-provider.example/v1',
    api_key: API_KEY_MASK,
    save_as_current: true,
  }));

  assert.equal(response.status, 200);
  assert.equal(getSetting(db, 'api_key'), '');
  assert.notEqual(getSetting(db, 'api_key'), 'old-provider-key');
  assert.notEqual(getSetting(db, 'api_key'), 'old-settings-key');
});

test('/api/providers keeps masked api_key when api_base is unchanged', async () => {
  const db = createProviderDb();
  const existing = insertProvider(db);
  const route = loadRoute(db);

  const response = await route.PUT(jsonRequest({
    id: existing.id,
    api_base: existing.api_base,
    api_key: API_KEY_MASK,
  }));
  const provider = db.prepare('SELECT api_key FROM api_providers WHERE id = ?').get(existing.id);

  assert.equal(response.status, 200);
  assert.equal(provider.api_key, 'old-provider-key');
});
