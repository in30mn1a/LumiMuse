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

function createMaintenanceDb() {
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
    CREATE TABLE messages_fts (
      id TEXT PRIMARY KEY
    );
  `);

  db.prepare('INSERT INTO characters (id, avatar_url) VALUES (?, ?)')
    .run('character-live', '/avatars/avatar-live.png');
  db.prepare('INSERT INTO conversations (id, character_id) VALUES (?, ?)')
    .run('conversation-live', 'character-live');
  db.prepare('INSERT INTO conversations (id, character_id) VALUES (?, ?)')
    .run('conversation-orphan', 'character-missing');

  db.prepare('INSERT INTO messages (id, conversation_id, content, metadata) VALUES (?, ?, ?, ?)').run(
    'message-live',
    'conversation-live',
    'content image: /api/files/attachments/abc123.png',
    JSON.stringify({
      attachments: [{ url: '/api/files/attachments/metadata-live.png' }],
      generatedImages: [{ data: '/generated/generated-live.png' }],
    }),
  );
  db.prepare('INSERT INTO messages (id, conversation_id, content, metadata) VALUES (?, ?, ?, ?)')
    .run('message-orphan-conversation', 'conversation-orphan', '', '{}');
  db.prepare('INSERT INTO messages (id, conversation_id, content, metadata) VALUES (?, ?, ?, ?)')
    .run('message-orphan', 'conversation-missing', '', '{}');

  db.prepare('INSERT INTO memories (id, character_id) VALUES (?, ?)')
    .run('memory-live', 'character-live');
  db.prepare('INSERT INTO memories (id, character_id) VALUES (?, ?)')
    .run('memory-orphan', 'character-missing');

  db.prepare('INSERT INTO memory_tasks (id, conversation_id) VALUES (?, ?)')
    .run(1, 'conversation-live');
  db.prepare('INSERT INTO memory_tasks (id, conversation_id) VALUES (?, ?)')
    .run(2, 'conversation-orphan');
  db.prepare('INSERT INTO memory_tasks (id, conversation_id) VALUES (?, ?)')
    .run(3, 'conversation-missing');

  db.prepare('INSERT INTO messages_fts (id) VALUES (?)').run('message-live');
  db.prepare('INSERT INTO messages_fts (id) VALUES (?)').run('message-missing');

  return db;
}

function writeFixtureFile(workspace, dirName, filename) {
  const dir = path.join(workspace, 'public', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), filename, 'utf8');
}

test('maintenance preview finds orphans and cleanup preserves avatar/content/metadata references', async () => {
  const tempRoot = path.join(root, '.tmp-tests');
  fs.mkdirSync(tempRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'maintenance-route-'));
  const relativeWorkspace = path.relative(root, workspace);
  assert.ok(relativeWorkspace && !relativeWorkspace.startsWith('..') && !path.isAbsolute(relativeWorkspace));

  const previousCwd = process.cwd();
  const db = createMaintenanceDb();

  try {
    for (const [dirName, filenames] of Object.entries({
      avatars: ['avatar-live.png', 'avatar-orphan.png'],
      attachments: ['abc123.png', 'metadata-live.png', 'attachment-orphan.png'],
      generated: ['generated-live.png', 'generated-orphan.png'],
    })) {
      for (const filename of filenames) writeFixtureFile(workspace, dirName, filename);
    }

    process.chdir(workspace);
    const route = requireFreshWithMocks('../src/app/api/maintenance/route.ts', {
      '@/lib/db': { getDb: () => db },
      '@/lib/route-auth': { requireAuth: async () => null },
      'next/server': jsonResponseMock(),
    });

    const previewResponse = await route.GET({});
    const preview = await previewResponse.json();

    assert.equal(previewResponse.status, 200);
    assert.deepEqual(
      {
        orphanMessages: preview.orphanMessages,
        orphanConversations: preview.orphanConversations,
        orphanMemories: preview.orphanMemories,
        orphanMemoryTasks: preview.orphanMemoryTasks,
        orphanFts: preview.orphanFts,
        total: preview.total,
      },
      {
        orphanMessages: 1,
        orphanConversations: 1,
        orphanMemories: 1,
        orphanMemoryTasks: 1,
        orphanFts: 1,
        total: 5,
      },
    );
    assert.deepEqual(preview.orphanFiles, {
      avatars: { total: 2, orphanCount: 1 },
      attachments: { total: 3, orphanCount: 1 },
      generated: { total: 2, orphanCount: 1 },
    });

    const cleanupResponse = await route.POST({});
    const cleanup = await cleanupResponse.json();

    assert.equal(cleanupResponse.status, 200);
    assert.equal(cleanup.dbDeleted, 5);
    assert.deepEqual(cleanup.fileResults, {
      avatars: { deleted: 1, errors: 0 },
      attachments: { deleted: 1, errors: 0 },
      generated: { deleted: 1, errors: 0 },
    });
    assert.deepEqual(cleanup.after, {
      conversations: 1,
      messages: 1,
      memories: 1,
      memory_tasks: 1,
    });

    assert.deepEqual(db.prepare('SELECT id FROM conversations ORDER BY id').all(), [
      { id: 'conversation-live' },
    ]);
    assert.deepEqual(db.prepare('SELECT id FROM messages ORDER BY id').all(), [
      { id: 'message-live' },
    ]);
    assert.deepEqual(db.prepare('SELECT id FROM memories ORDER BY id').all(), [
      { id: 'memory-live' },
    ]);
    assert.deepEqual(db.prepare('SELECT id FROM memory_tasks ORDER BY id').all(), [
      { id: 1 },
    ]);
    assert.deepEqual(db.prepare('SELECT id FROM messages_fts ORDER BY id').all(), [
      { id: 'message-live' },
    ]);

    for (const [dirName, filename] of [
      ['avatars', 'avatar-live.png'],
      ['attachments', 'abc123.png'],
      ['attachments', 'metadata-live.png'],
      ['generated', 'generated-live.png'],
    ]) {
      assert.equal(fs.existsSync(path.join(workspace, 'public', dirName, filename)), true);
    }
    for (const [dirName, filename] of [
      ['avatars', 'avatar-orphan.png'],
      ['attachments', 'attachment-orphan.png'],
      ['generated', 'generated-orphan.png'],
    ]) {
      assert.equal(fs.existsSync(path.join(workspace, 'public', dirName, filename)), false);
    }
  } finally {
    process.chdir(previousCwd);
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
