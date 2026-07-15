const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
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
    // also clear db deps that might cache
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}src${path.sep}lib${path.sep}db.ts`)) {
        delete require.cache[key];
      }
    }
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('getDb source assigns singleton only after migrate succeeds', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/db.ts'), 'utf8');
  assert.match(source, /const db = new Database\(DB_PATH\)/);
  assert.match(source, /_db = db/);
  assert.doesNotMatch(source, /_db\s*=\s*new Database/);
  assert.match(source, /try\s*\{\s*db\.close\(\)/);
  assert.match(source, /export function __resetDbForTests/);
});

test('getDb boot recovery triggers embedding drain after recover', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/db.ts'), 'utf8');
  // 与提取/画像队列对称：recover 后应尝试 trigger，而不是只重置 pending
  assert.match(
    source,
    /recoverStaleMemoryEmbeddingTasks[\s\S]{0,400}triggerMemoryIndexProcessing/,
  );
});

test('messages_fts heal condition rebuilds when fts has extra rows', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/db.ts'), 'utf8');
  // 与 trigram 对齐：用 !== 同时覆盖缺失与多出
  assert.match(source, /ftsCount\s*!==\s*messageCount/);
  assert.doesNotMatch(
    source,
    /if\s*\(\s*messageCount\s*>\s*0\s*&&\s*ftsCount\s*<\s*messageCount\s*\)/,
  );
});

test('getDb does not keep a half-migrated connection after migrate failure', () => {
  const instances = [];

  function FakeDatabase() {
    const self = {
      closed: false,
      pragma() {
        return undefined;
      },
      exec() {
        // migrate 会调 exec；直接抛错模拟半迁移失败
        throw new Error('injected migrate failure');
      },
      prepare() {
        return {
          get: () => undefined,
          all: () => [],
          run: () => ({ changes: 0 }),
        };
      },
      transaction(fn) {
        return (...args) => fn(...args);
      },
      close() {
        self.closed = true;
      },
    };
    instances.push(self);
    return self;
  }

  const dbModule = requireFreshWithMocks('../src/lib/db.ts', {
    'better-sqlite3': FakeDatabase,
    fs: {
      existsSync: () => true,
      mkdirSync: () => {},
    },
    path: require('node:path'),
    '@/lib/structured-log': { structuredLog: () => {} },
    '@/lib/memory-category': { inferMemoryDefaults: () => ({ memory_kind: 'general', importance: 0.5, emotional_weight: 0 }) },
    '@/lib/memory-embedding-schema': {
      ensureMemoryEmbeddingForeignKeys: () => {},
      MEMORY_EMBEDDING_DEDUPLICATION_DML: '',
      MEMORY_EMBEDDING_INDEX_DDL: '',
      MEMORY_EMBEDDING_TABLE_DDL: '',
    },
  });

  assert.throws(() => dbModule.getDb(), /injected migrate failure/);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].closed, true);

  // 第二次仍应新建连接并再次失败，而不是返回已关闭的半迁移实例
  assert.throws(() => dbModule.getDb(), /injected migrate failure/);
  assert.equal(instances.length, 2);
  assert.equal(instances[1].closed, true);
});
