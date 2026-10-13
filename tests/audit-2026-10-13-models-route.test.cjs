const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();
const dbModule = require('../src/lib/db.ts');

const originalLoad = Module._load;
const API_BASE = 'https://relay.invalid/v1';

function loadRoute(db, safeFetch) {
  const mocks = {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: '', api_key: '', memory_engine: {} }),
    },
    '@/lib/ssrf-guard': { safeFetch },
  };
  Module._load = function loadWithMocks(request, parent, isMain) {
    return Object.hasOwn(mocks, request) ? mocks[request] : originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../src/app/api/models/route.ts')];
    return require('../src/app/api/models/route.ts');
  } finally {
    Module._load = originalLoad;
  }
}

function migratedDb() {
  const db = new Database(':memory:');
  dbModule.__migrateForTests(db);
  return db;
}

const post = (route, raw) => route.POST({
  nextUrl: new URL('http://test.local/api/models'),
  text: async () => (typeof raw === 'string' ? raw : JSON.stringify(raw)),
});

test('model cache is not shared between different keys on the same api_base', async () => {
  const db = migratedDb();
  const seenAuth = [];
  let networkDown = false;
  const route = loadRoute(db, async (_url, init) => {
    seenAuth.push(init.headers.Authorization);
    if (networkDown) throw new Error('connect failed');
    // 只有 key-a 有效；同一中转站下不同 key 可见的模型也可能不同
    if (init.headers.Authorization !== 'Bearer key-a-valid') return { ok: false, status: 401 };
    return { ok: true, json: async () => ({ data: [{ id: 'model-a' }] }) };
  });

  const first = await post(route, { api_base: API_BASE, api_key: 'key-a-valid' });
  assert.deepEqual(await first.json(), { models: ['model-a'], error: null, cached: false });

  // 换一个（无效的）key 试连：不能拿 key-a 的缓存冒充成功
  const second = await post(route, { api_base: API_BASE, api_key: 'key-b-invalid' });
  assert.equal(second.status, 502);
  assert.deepEqual((await second.json()).models, []);
  assert.deepEqual(seenAuth, ['Bearer key-a-valid', 'Bearer key-b-invalid']);

  // 断网兜底同样不能跨 key 复用旧缓存
  networkDown = true;
  const third = await post(route, { api_base: API_BASE, api_key: 'key-b-invalid', refresh: true });
  assert.equal(third.status, 502);
  assert.deepEqual((await third.json()).models, []);

  // 同一个 key 的缓存与断网兜底照常可用
  const fourth = await post(route, { api_base: API_BASE, api_key: 'key-a-valid' });
  assert.deepEqual(await fourth.json(), { models: ['model-a'], error: null, cached: true });
  const fifth = await post(route, { api_base: API_BASE, api_key: 'key-a-valid', refresh: true });
  assert.deepEqual((await fifth.json()).models, ['model-a']);
});

test('model cache rows written before the key fingerprint existed are treated as a miss', async () => {
  const db = new Database(':memory:');
  // 旧版表结构 + 旧缓存行
  db.exec(`
    CREATE TABLE model_cache (
      api_base TEXT PRIMARY KEY,
      models TEXT NOT NULL DEFAULT '[]',
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO model_cache (api_base, models, cached_at) VALUES (?, ?, ?)')
    .run(API_BASE, JSON.stringify(['legacy-model']), new Date().toISOString());
  dbModule.__migrateForTests(db);

  let fetches = 0;
  const route = loadRoute(db, async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ data: [{ id: 'fresh-model' }] }) };
  });
  const response = await post(route, { api_base: API_BASE, api_key: 'key-a-valid' });
  assert.deepEqual(await response.json(), { models: ['fresh-model'], error: null, cached: false });
  assert.equal(fetches, 1);
});

for (const [label, raw] of [
  ['null', 'null'],
  ['array', '[]'],
  ['string', '"text"'],
  ['number', '123'],
  ['numeric provider_id', { provider_id: 123 }],
  ['numeric api_base', { api_base: 123, api_key: 'key-a-valid' }],
  ['object api_key', { api_base: API_BASE, api_key: { nested: true } }],
]) {
  test(`/api/models POST rejects malformed body with 400 instead of throwing: ${label}`, async () => {
    const route = loadRoute(migratedDb(), async () => {
      throw new Error('upstream must not be called for a malformed body');
    });
    const response = await post(route, raw);
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.deepEqual(payload.models, []);
    assert.equal(typeof payload.error, 'string');
  });
}
