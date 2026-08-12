const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;

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

const {
  GENERATED_IMAGE_FOLDER_MIGRATION_KEY,
  GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE,
  enableGeneratedImageFolderMigrationTracking,
  installGeneratedImageFolderMigrationTracking,
  runGeneratedImageFolderMigration,
  triggerGeneratedImageFolderMigration,
} = require('../src/lib/generated-image-folder-migration.ts');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run(GENERATED_IMAGE_FOLDER_MIGRATION_KEY, '0');
  return db;
}

function addCharacter(db, characterId, conversationId) {
  db.prepare('INSERT INTO characters (id) VALUES (?)').run(characterId);
  db.prepare('INSERT INTO conversations (id, character_id) VALUES (?, ?)')
    .run(conversationId, characterId);
}

function addMessage(db, id, conversationId, content, metadata) {
  db.prepare('INSERT INTO messages (id, conversation_id, content, metadata) VALUES (?, ?, ?, ?)')
    .run(id, conversationId, content, JSON.stringify(metadata));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeWorkspace(workspace) {
  const relative = path.relative(root, workspace);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  // Windows runners can briefly lock newly written files (Defender / indexer).
  // recursive rmdir then races with ENOTEMPTY even after assertions passed.
  const maxAttempts = process.platform === 'win32' ? 8 : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      return;
    } catch (error) {
      lastError = error;
      const code = error && error.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
        throw error;
      }
      if (attempt < maxAttempts) {
        sleepSync(50 * attempt);
      }
    }
  }
  throw lastError;
}

function createWorkspace(t) {
  const tempRoot = path.join(root, '.tmp-tests');
  fs.mkdirSync(tempRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'generated-image-migration-'));
  const generatedRoot = path.join(workspace, 'public', 'generated');
  fs.mkdirSync(generatedRoot, { recursive: true });
  t.after(() => {
    removeWorkspace(workspace);
  });
  return generatedRoot;
}

function writeImage(generatedRoot, relativePath, bytes) {
  const filePath = path.join(generatedRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

function getMessage(db, id) {
  const row = db.prepare('SELECT content, metadata FROM messages WHERE id = ?').get(id);
  return { content: row.content, metadata: JSON.parse(row.metadata) };
}

function markerValue(db) {
  return db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(GENERATED_IMAGE_FOLDER_MIGRATION_KEY).value;
}

async function waitFor(predicate, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('condition did not become true before the migration scheduler went idle');
}

test('legacy generated images migrate across rowid pages and split shared files by character', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());

  addCharacter(db, 'character-a', 'conversation-a');
  addCharacter(db, 'character-b', 'conversation-b');

  const soloBytes = Buffer.from('solo-image');
  const sharedBytes = Buffer.from('shared-image');
  writeImage(generatedRoot, 'solo.png', soloBytes);
  writeImage(generatedRoot, 'shared.webp', sharedBytes);

  addMessage(
    db,
    'message-a1',
    'conversation-a',
    'current ![](/api/files/generated/solo.png)',
    {
      generatedImages: [{
        id: 'image-a',
        url: '/generated/solo.png',
        prompt: 'solo',
        versions: [{ id: 'version-shared', url: '/api/files/generated/shared.webp', prompt: 'shared' }],
      }],
    },
  );
  addMessage(
    db,
    'message-a2',
    'conversation-a',
    'same character alias /generated/shared.webp?cache=1',
    { generatedImages: [{ id: 'image-shared-a', data: '/generated/shared.webp', prompt: 'shared' }] },
  );
  addMessage(
    db,
    'message-b1',
    'conversation-b',
    'other character /api/files/generated/shared.webp#preview',
    { generatedImages: [{ id: 'image-shared-b', url: '/api/files/generated/shared.webp', prompt: 'shared' }] },
  );

  const result = await runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });

  assert.equal(result.pending, false);
  assert.equal(result.scannedMessages, 3);
  assert.equal(result.updatedMessages, 3);
  assert.equal(result.copiedFiles, 3);
  assert.equal(result.deletedSources, 2);
  assert.equal(markerValue(db), '1');

  assert.deepEqual(fs.readFileSync(path.join(generatedRoot, 'character-a', 'solo.png')), soloBytes);
  assert.deepEqual(fs.readFileSync(path.join(generatedRoot, 'character-a', 'shared.webp')), sharedBytes);
  assert.deepEqual(fs.readFileSync(path.join(generatedRoot, 'character-b', 'shared.webp')), sharedBytes);
  assert.equal(fs.existsSync(path.join(generatedRoot, 'solo.png')), false);
  assert.equal(fs.existsSync(path.join(generatedRoot, 'shared.webp')), false);

  const messageA1 = getMessage(db, 'message-a1');
  assert.equal(messageA1.content, 'current ![](/api/files/generated/character-a/solo.png)');
  assert.equal(messageA1.metadata.generatedImages[0].url, '/api/files/generated/character-a/solo.png');
  assert.equal(
    messageA1.metadata.generatedImages[0].versions[0].url,
    '/api/files/generated/character-a/shared.webp',
  );

  const messageA2 = getMessage(db, 'message-a2');
  assert.equal(messageA2.content, 'same character alias /api/files/generated/character-a/shared.webp?cache=1');
  assert.equal(messageA2.metadata.generatedImages[0].data, '/api/files/generated/character-a/shared.webp');

  const messageB1 = getMessage(db, 'message-b1');
  assert.equal(messageB1.content, 'other character /api/files/generated/character-b/shared.webp#preview');
  assert.equal(messageB1.metadata.generatedImages[0].url, '/api/files/generated/character-b/shared.webp');
});

test('missing sources and conflicting targets preserve legacy references and keep marker pending', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, 'character-a', 'conversation-a');

  writeImage(generatedRoot, 'conflict.png', Buffer.from('legacy-source'));
  writeImage(generatedRoot, 'character-a/conflict.png', Buffer.from('different-target'));
  addMessage(
    db,
    'message-a',
    'conversation-a',
    'missing /generated/missing.png and conflict /api/files/generated/conflict.png',
    {
      generatedImages: [
        { id: 'missing', url: '/generated/missing.png', prompt: 'missing' },
        { id: 'conflict', url: '/api/files/generated/conflict.png', prompt: 'conflict' },
      ],
    },
  );

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = line => warnings.push(String(line));
  try {
    const result = await runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });
    assert.equal(result.pending, true);
    assert.equal(result.missingSources, 1);
    assert.equal(result.conflicts, 1);
    assert.equal(result.updatedMessages, 0);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(markerValue(db), '0');
  assert.equal(fs.existsSync(path.join(generatedRoot, 'conflict.png')), true);
  assert.deepEqual(fs.readFileSync(path.join(generatedRoot, 'character-a', 'conflict.png')), Buffer.from('different-target'));
  assert.equal(getMessage(db, 'message-a').content, 'missing /generated/missing.png and conflict /api/files/generated/conflict.png');
  assert.ok(warnings.some(line => line.includes('image.folder_migration.source_missing')));
  assert.ok(warnings.some(line => line.includes('image.folder_migration.target_conflict')));
});

test('shared flat source is retained when one character target conflicts', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, 'character-a', 'conversation-a');
  addCharacter(db, 'character-b', 'conversation-b');
  writeImage(generatedRoot, 'partial.png', Buffer.from('shared-source'));
  writeImage(generatedRoot, 'character-b/partial.png', Buffer.from('conflicting-target'));
  addMessage(
    db,
    'message-a',
    'conversation-a',
    '/generated/partial.png',
    { generatedImages: [{ id: 'partial-a', url: '/generated/partial.png', prompt: 'partial' }] },
  );
  addMessage(
    db,
    'message-b',
    'conversation-b',
    '/api/files/generated/partial.png',
    { generatedImages: [{ id: 'partial-b', url: '/api/files/generated/partial.png', prompt: 'partial' }] },
  );

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.pending, true);
  assert.equal(getMessage(db, 'message-a').content, '/api/files/generated/character-a/partial.png');
  assert.equal(getMessage(db, 'message-b').content, '/api/files/generated/partial.png');
  assert.equal(fs.existsSync(path.join(generatedRoot, 'partial.png')), true);
  assert.equal(markerValue(db), '0');
});

test('pre-existing identical target is reused and concurrent triggers share one migration promise', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, 'character-a', 'conversation-a');

  const bytes = Buffer.from('already-copied');
  writeImage(generatedRoot, 'restored.jpg', bytes);
  writeImage(generatedRoot, 'character-a/restored.jpg', bytes);
  addMessage(
    db,
    'message-a',
    'conversation-a',
    '/generated/restored.jpg',
    { generatedImages: [{ id: 'restored', url: '/generated/restored.jpg', prompt: 'restored' }] },
  );

  const first = triggerGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });
  const second = triggerGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });
  assert.strictEqual(first, second);

  const result = await first;
  assert.equal(result.copiedFiles, 0);
  assert.equal(result.reusedFiles, 1);
  assert.equal(result.updatedMessages, 1);
  assert.equal(markerValue(db), '1');
  assert.equal(fs.existsSync(path.join(generatedRoot, 'restored.jpg')), false);

  const rerun = await runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });
  assert.equal(rerun.skipped, true);
  assert.equal(rerun.updatedMessages, 0);
});

test('unsafe character directory never escapes generated root and leaves the legacy reference pending', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, '../outside', 'conversation-unsafe');
  writeImage(generatedRoot, 'unsafe.png', Buffer.from('unsafe-image'));
  addMessage(
    db,
    'message-unsafe',
    'conversation-unsafe',
    '/generated/unsafe.png',
    { generatedImages: [{ id: 'unsafe', url: '/generated/unsafe.png', prompt: 'unsafe' }] },
  );

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.pending, true);
  assert.equal(result.copyFailures, 1);
  assert.equal(markerValue(db), '0');
  assert.equal(getMessage(db, 'message-unsafe').content, '/generated/unsafe.png');
  assert.equal(fs.existsSync(path.resolve(generatedRoot, '..', 'outside', 'unsafe.png')), false);
  assert.equal(fs.existsSync(path.join(generatedRoot, 'unsafe.png')), true);
});

test('nested generated URLs and external URL path segments are not mistaken for flat legacy aliases', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, 'character-a', 'conversation-a');
  const content = [
    'nested /api/files/generated/character-a/kept.png',
    'external https://example.com/generated/remote.png',
    'external-query https://example.com/proxy?src=/generated/query.png',
    'external-hash https://example.com/#src=/api/files/generated/hash.png',
  ].join(' ');
  const metadata = {
    generatedImages: [
      { id: 'nested', url: '/generated/character-a/kept.png', prompt: 'nested' },
      { id: 'remote', url: 'https://example.com/generated/remote.png', prompt: 'remote' },
      { id: 'query', url: 'https://example.com/proxy?src=/generated/query.png', prompt: 'query' },
    ],
  };
  addMessage(db, 'message-a', 'conversation-a', content, metadata);

  const result = await runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });

  assert.equal(result.pending, false);
  assert.equal(result.updatedMessages, 0);
  assert.equal(result.copiedFiles, 0);
  assert.equal(markerValue(db), '1');
  assert.equal(getMessage(db, 'message-a').content, content);
  assert.deepEqual(getMessage(db, 'message-a').metadata, metadata);
});

test('message rewrite re-reads the current row and preserves edits made while the file copy is in flight', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, 'character-a', 'conversation-a');
  writeImage(generatedRoot, 'fresh.png', Buffer.alloc(64 * 1024, 7));
  addMessage(
    db,
    'message-a',
    'conversation-a',
    'old /generated/fresh.png',
    { generatedImages: [{ id: 'fresh', url: '/generated/fresh.png', prompt: 'fresh' }] },
  );

  const migration = runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });
  // run() 已读完本页，并在第一个异步文件检查处让出事件循环。
  await Promise.resolve();
  db.prepare('UPDATE messages SET content = ?, metadata = ? WHERE id = ?').run(
    'edited /generated/fresh.png',
    JSON.stringify({
      preservedByConcurrentEdit: true,
      generatedImages: [{ id: 'fresh', url: '/generated/fresh.png', prompt: 'fresh' }],
    }),
    'message-a',
  );

  const result = await migration;
  const message = getMessage(db, 'message-a');
  assert.equal(result.updatedMessages, 1);
  assert.equal(message.content, 'edited /api/files/generated/character-a/fresh.png');
  assert.equal(message.metadata.preservedByConcurrentEdit, true);
  assert.equal(message.metadata.generatedImages[0].url, '/api/files/generated/character-a/fresh.png');
});

test('finalization rechecks late flat references before deleting the source or completing the marker', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, 'character-a', 'conversation-a');
  writeImage(generatedRoot, 'late.png', Buffer.from('late-image'));
  addMessage(db, 'message-before', 'conversation-a', '/generated/late.png', {});

  let inserted = false;
  const first = await runGeneratedImageFolderMigration({
    db,
    generatedRoot,
    pageSize: 1,
    beforeFinalization() {
      inserted = true;
      addMessage(db, 'message-late', 'conversation-a', '/generated/late.png', {});
    },
  });

  assert.equal(inserted, true);
  assert.equal(first.pending, true);
  assert.equal(markerValue(db), '0');
  assert.equal(fs.existsSync(path.join(generatedRoot, 'late.png')), true);
  assert.equal(getMessage(db, 'message-late').content, '/generated/late.png');

  const second = await runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });
  assert.equal(second.pending, false);
  assert.equal(markerValue(db), '1');
  assert.equal(getMessage(db, 'message-late').content, '/api/files/generated/character-a/late.png');
  assert.equal(fs.existsSync(path.join(generatedRoot, 'late.png')), false);
});

test('durable cleanup journal removes a migrated flat source after restart', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, 'character-a', 'conversation-a');
  writeImage(generatedRoot, 'journal.png', Buffer.from('journal-image'));
  writeImage(generatedRoot, 'character-a/journal.png', Buffer.from('journal-image'));
  addMessage(db, 'message-a', 'conversation-a', '/api/files/generated/character-a/journal.png', {});
  db.exec(`CREATE TABLE ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE} (filename TEXT PRIMARY KEY, created_at TEXT NOT NULL)`);
  db.prepare(`INSERT INTO ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE} (filename, created_at) VALUES (?, ?)`)
    .run('journal.png', new Date().toISOString());

  const result = await runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });

  assert.equal(result.pending, false);
  assert.equal(result.deletedSources, 1);
  assert.equal(fs.existsSync(path.join(generatedRoot, 'journal.png')), false);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE}`).get().count,
    0,
  );
  assert.equal(markerValue(db), '1');
});

test('cleanup failure keeps the journal and marker pending for a later retry', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, 'character-a', 'conversation-a');
  addMessage(db, 'message-a', 'conversation-a', '/api/files/generated/character-a/stuck.png', {});
  fs.mkdirSync(path.join(generatedRoot, 'stuck.png'));
  db.exec(`CREATE TABLE ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE} (filename TEXT PRIMARY KEY, created_at TEXT NOT NULL)`);
  db.prepare(`INSERT INTO ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE} (filename, created_at) VALUES (?, ?)`)
    .run('stuck.png', new Date().toISOString());

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.pending, true);
  assert.equal(result.cleanupFailures, 1);
  assert.equal(markerValue(db), '0');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE}`).get().count,
    1,
  );
});

test('a flat URL written after completion resets the marker and is migrated from the existing character copy', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, 'character-a', 'conversation-a');
  addCharacter(db, 'character-b', 'conversation-b');
  writeImage(generatedRoot, 'returned.png', Buffer.from('returned-image'));
  addMessage(db, 'message-before', 'conversation-a', '/generated/returned.png', {});
  await runGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 1 });
  assert.equal(markerValue(db), '1');
  assert.equal(fs.existsSync(path.join(generatedRoot, 'returned.png')), false);

  installGeneratedImageFolderMigrationTracking(db);
  enableGeneratedImageFolderMigrationTracking(db, { generatedRoot, pageSize: 1 });
  addMessage(db, 'message-late', 'conversation-b', '/generated/returned.png', {});
  assert.equal(markerValue(db), '0');

  await waitFor(() => markerValue(db) === '1');
  assert.equal(getMessage(db, 'message-late').content, '/api/files/generated/character-b/returned.png');
  assert.equal(fs.existsSync(path.join(generatedRoot, 'character-b', 'returned.png')), true);
});

test('a late flat write that lands during an active scan is drained again without a restart', async (t) => {
  const generatedRoot = createWorkspace(t);
  const db = createDb();
  t.after(() => db.close());
  addCharacter(db, 'character-a', 'conversation-a');
  writeImage(generatedRoot, 'inflight.png', Buffer.alloc(64 * 1024, 9));
  addMessage(db, 'message-before', 'conversation-a', '/generated/inflight.png', {});
  installGeneratedImageFolderMigrationTracking(db);
  enableGeneratedImageFolderMigrationTracking(db, { generatedRoot, pageSize: 10 });

  const migration = triggerGeneratedImageFolderMigration({ db, generatedRoot, pageSize: 10 });
  await Promise.resolve();
  addMessage(db, 'message-late', 'conversation-a', '/generated/inflight.png', {});

  await migration;
  await waitFor(() => markerValue(db) === '1');
  assert.equal(getMessage(db, 'message-late').content, '/api/files/generated/character-a/inflight.png');
  assert.equal(fs.existsSync(path.join(generatedRoot, 'inflight.png')), false);
});

test('database migration initializes the legacy image marker once without resetting completion', () => {
  const { __migrateForTests } = require('../src/lib/db.ts');
  const db = new Database(':memory:');
  try {
    __migrateForTests(db);
    assert.equal(markerValue(db), '0');
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE));
    db.prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('1', GENERATED_IMAGE_FOLDER_MIGRATION_KEY);
    __migrateForTests(db);
    assert.equal(markerValue(db), '1');
  } finally {
    db.close();
  }
});
