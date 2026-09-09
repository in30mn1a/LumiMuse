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

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

/**
 * 构造带消息历史版本的最小 maintenance DB。
 * message-live 的活跃 content 不含 versioned 引用，仅在
 * metadata.versions[0].content / versions[0].attachments 里引用本地文件——
 * 这是「切回旧版本时才需要的文件」，孤儿清理不得删除。
 */
function createVersionsDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      avatar_url TEXT
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      content TEXT,
      metadata TEXT
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL
    );
    CREATE TABLE memory_tasks (
      id INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL
    );
  `);

  db.prepare('INSERT INTO characters (id, avatar_url) VALUES (?, ?)')
    .run('character-live', null);
  db.prepare('INSERT INTO conversations (id, character_id) VALUES (?, ?)')
    .run('conversation-live', 'character-live');

  db.prepare('INSERT INTO messages (id, conversation_id, content, metadata) VALUES (?, ?, ?, ?)').run(
    'message-live',
    'conversation-live',
    'active content: no local asset urls here',
    JSON.stringify({
      versions: [
        {
          content: 'old version referenced /api/files/generated/character-live/versioned-keep.png in text',
          attachments: [{ url: '/api/files/attachments/versioned-keep.png' }],
        },
      ],
      activeVersion: 1,
    }),
  );

  return db;
}

function writeFixtureFile(workspace, dirName, filename) {
  const dir = path.join(workspace, 'public', dirName);
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, filename, 'utf8');
}

test('maintenance cleanup preserves files referenced only by message history versions', async () => {
  const tempRoot = path.join(root, '.tmp-tests');
  fs.mkdirSync(tempRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'maintenance-versions-'));
  const relativeWorkspace = path.relative(root, workspace);
  assert.ok(relativeWorkspace && !relativeWorkspace.startsWith('..') && !path.isAbsolute(relativeWorkspace));

  const previousCwd = process.cwd();
  const db = createVersionsDb();

  try {
    // 判别样本：
    //  - versioned-keep 两个文件仅被 metadata.versions[0] 引用（活跃 content 不含）→ 必须保留
    //  - versioned-orphan 完全无引用 → 必须删除（证明测试有判别力，不是恒真）
    for (const [dirName, filename] of [
      ['generated', 'character-live/versioned-keep.png'],
      ['attachments', 'versioned-keep.png'],
      ['generated', 'character-live/versioned-orphan.png'],
    ]) {
      writeFixtureFile(workspace, dirName, filename);
    }
    // 孤儿清理有 24h mtime 宽限期；回拨 mtime，避免保护挡住本用例要删除的对照孤儿。
    const oldMtime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(
      path.join(workspace, 'public', 'generated', 'character-live', 'versioned-orphan.png'),
      oldMtime,
      oldMtime,
    );
    // 仅被旧版本引用的文件同样回拨 mtime：若引用集计算漏判，它会被当成「够老的无引用文件」删掉。
    fs.utimesSync(
      path.join(workspace, 'public', 'generated', 'character-live', 'versioned-keep.png'),
      oldMtime,
      oldMtime,
    );
    fs.utimesSync(
      path.join(workspace, 'public', 'attachments', 'versioned-keep.png'),
      oldMtime,
      oldMtime,
    );

    process.chdir(workspace);
    const route = requireFreshWithMocks('../src/app/api/maintenance/route.ts', {
      '@/lib/db': { getDb: () => db },
      '@/lib/route-auth': { requireAuth: async () => null },
      'next/server': jsonResponseMock(),
    });

    // 预览阶段就应只把无引用文件计为孤儿
    const preview = await (await route.GET({})).json();
    assert.equal(preview.orphanFiles.generated.total, 2);
    assert.equal(preview.orphanFiles.generated.orphanCount, 1);
    assert.equal(preview.orphanFiles.attachments.total, 1);
    assert.equal(preview.orphanFiles.attachments.orphanCount, 0);

    const cleanup = await (await route.POST({})).json();
    assert.deepEqual(cleanup.fileResults, {
      avatars: { deleted: 0, errors: 0 },
      attachments: { deleted: 0, errors: 0 },
      generated: { deleted: 1, errors: 0 },
    });
    assert.deepEqual(cleanup.deletedUrls.sort(), [
      '/api/files/generated/character-live/versioned-orphan.png',
      '/generated/character-live/versioned-orphan.png',
    ].sort());

    // 仅被历史版本引用的文件必须仍然存在（否则用户切回旧版本时图片 404）
    assert.equal(
      fs.existsSync(path.join(workspace, 'public', 'generated', 'character-live', 'versioned-keep.png')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(workspace, 'public', 'attachments', 'versioned-keep.png')),
      true,
    );
    // 对照样本：完全无引用的文件应被删掉
    assert.equal(
      fs.existsSync(path.join(workspace, 'public', 'generated', 'character-live', 'versioned-orphan.png')),
      false,
    );
  } finally {
    process.chdir(previousCwd);
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
