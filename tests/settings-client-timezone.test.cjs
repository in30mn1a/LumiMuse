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
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createSettingsDb() {
  const db = new Database(':memory:');
  // 与 db.ts 的建表一致：settings 只有 key/value 两列，没有 updated_at
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  return db;
}

function loadSettingsModule(db) {
  return requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': { getDb: () => db },
  });
}

function storedTimezone(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'client_timezone'").get();
  return row ? JSON.parse(row.value) : null;
}

test('records a valid IANA time zone reported by the browser', () => {
  const db = createSettingsDb();
  const { recordClientTimezone } = loadSettingsModule(db);

  recordClientTimezone('Asia/Tokyo', '');

  assert.equal(storedTimezone(db), 'Asia/Tokyo');
});

test('does not write when the reported zone matches the stored one', () => {
  const db = createSettingsDb();
  const { recordClientTimezone } = loadSettingsModule(db);

  // 聊天是热路径，每轮都写 settings 是不必要的开销
  recordClientTimezone('Asia/Tokyo', 'Asia/Tokyo');

  assert.equal(storedTimezone(db), null);
});

test('rejects an invalid time zone instead of persisting it', () => {
  const db = createSettingsDb();
  const { recordClientTimezone } = loadSettingsModule(db);

  // 存进去会让后台任务的 Intl.DateTimeFormat 抛错，而后台抛错等于丢记忆
  recordClientTimezone('Not/AZone', '');

  assert.equal(storedTimezone(db), null);
});

test('ignores non-string and oversized values', () => {
  const db = createSettingsDb();
  const { recordClientTimezone } = loadSettingsModule(db);

  recordClientTimezone(undefined, '');
  recordClientTimezone(null, '');
  recordClientTimezone(42, '');
  recordClientTimezone('   ', '');
  recordClientTimezone(`Asia/${'x'.repeat(100)}`, '');

  assert.equal(storedTimezone(db), null);
});

test('updates when the user moves to a different time zone', () => {
  const db = createSettingsDb();
  const { recordClientTimezone } = loadSettingsModule(db);

  recordClientTimezone('Asia/Tokyo', '');
  recordClientTimezone('Europe/Berlin', 'Asia/Tokyo');

  assert.equal(storedTimezone(db), 'Europe/Berlin');
});

test('loadSettings exposes client_timezone with an empty default', () => {
  const db = createSettingsDb();
  const { loadSettings, recordClientTimezone } = loadSettingsModule(db);

  assert.equal(loadSettings().client_timezone, '');

  recordClientTimezone('Asia/Tokyo', '');
  assert.equal(loadSettings().client_timezone, 'Asia/Tokyo');
});
