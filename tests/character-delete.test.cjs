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
      jsx: ts.JsxEmit.ReactJSX,
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
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function loadDeleteRoute(db, fileUtils) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === 'next/server') return jsonResponseMock();
    if (request === '@/lib/db') return { getDb: () => db };
    if (request === '@/lib/character-file-utils') return fileUtils;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve('../src/app/api/characters/[id]/route.ts');
    delete require.cache[resolved];
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

function createDeleteDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, character_id TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
    CREATE TABLE memories (id TEXT PRIMARY KEY, character_id TEXT NOT NULL);
    CREATE TABLE memory_tasks (id INTEGER PRIMARY KEY, character_id TEXT NOT NULL, conversation_id TEXT NOT NULL);
    CREATE TABLE memory_embedding_tasks (id INTEGER PRIMARY KEY, character_id TEXT NOT NULL);
    CREATE TABLE memory_embeddings (id INTEGER PRIMARY KEY, character_id TEXT NOT NULL);
    CREATE TABLE memory_extraction_candidates (id INTEGER PRIMARY KEY, character_id TEXT NOT NULL);
    CREATE TABLE character_memory_profile_update_tasks (id INTEGER PRIMARY KEY, character_id TEXT NOT NULL);
    CREATE TABLE character_memory_profile_versions (id INTEGER PRIMARY KEY, character_id TEXT NOT NULL);
    CREATE TABLE character_memory_profiles (character_id TEXT PRIMARY KEY);

    INSERT INTO characters VALUES ('char-target', 'Target'), ('char-keep', 'Keep');
    INSERT INTO conversations VALUES ('conv-target', 'char-target'), ('conv-keep', 'char-keep');
    INSERT INTO messages VALUES ('msg-target', 'conv-target'), ('msg-keep', 'conv-keep');
    INSERT INTO memories VALUES ('mem-target', 'char-target'), ('mem-keep', 'char-keep');
    INSERT INTO memory_tasks VALUES (1, 'char-target', 'conv-target'), (2, 'char-keep', 'conv-keep');
    INSERT INTO memory_embedding_tasks VALUES (1, 'char-target'), (2, 'char-keep');
    INSERT INTO memory_embeddings VALUES (1, 'char-target'), (2, 'char-keep');
    INSERT INTO memory_extraction_candidates VALUES (1, 'char-target'), (2, 'char-keep');
    INSERT INTO character_memory_profile_update_tasks VALUES (1, 'char-target'), (2, 'char-keep');
    INSERT INTO character_memory_profile_versions VALUES (1, 'char-target'), (2, 'char-keep');
    INSERT INTO character_memory_profiles VALUES ('char-target'), ('char-keep');
  `);
  return db;
}

test('character DELETE checks only collected candidates and preserves other characters', async () => {
  const db = createDeleteDb();
  const candidateUrls = new Set([
    '/api/files/generated/target.png',
    '/api/files/avatars/shared.png',
  ]);
  const calls = { filter: [], deleted: [] };
  const route = loadDeleteRoute(db, {
    collectCharacterLocalAssetUrls(actualDb, characterId) {
      assert.equal(actualDb, db);
      assert.equal(characterId, 'char-target');
      return candidateUrls;
    },
    filterUnreferencedLocalAssetUrls(actualDb, candidates) {
      assert.equal(actualDb, db);
      assert.equal(db.prepare("SELECT 1 FROM characters WHERE id = 'char-target'").get(), undefined);
      calls.filter.push([...candidates]);
      return ['/api/files/generated/target.png'];
    },
    async deleteLocalAssetUrls(urls) {
      calls.deleted.push([...urls]);
    },
  });

  const response = await route.DELETE({}, {
    params: Promise.resolve({ id: 'char-target' }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(calls.filter, [[...candidateUrls]]);
  assert.deepEqual(calls.deleted, [['/api/files/generated/target.png']]);
  assert.deepEqual(db.prepare('SELECT id FROM characters ORDER BY id').all(), [{ id: 'char-keep' }]);
  assert.deepEqual(db.prepare('SELECT id FROM conversations ORDER BY id').all(), [{ id: 'conv-keep' }]);
  assert.deepEqual(db.prepare('SELECT id FROM messages ORDER BY id').all(), [{ id: 'msg-keep' }]);
  assert.deepEqual(db.prepare('SELECT id FROM memories ORDER BY id').all(), [{ id: 'mem-keep' }]);
  for (const table of [
    'memory_tasks',
    'memory_embedding_tasks',
    'memory_embeddings',
    'memory_extraction_candidates',
    'character_memory_profile_update_tasks',
    'character_memory_profile_versions',
  ]) {
    assert.deepEqual(db.prepare(`SELECT id FROM ${table} ORDER BY id`).all(), [{ id: 2 }]);
  }
  assert.deepEqual(
    db.prepare('SELECT character_id FROM character_memory_profiles ORDER BY character_id').all(),
    [{ character_id: 'char-keep' }],
  );
  db.close();
});

test('character editor prevents duplicate deletes and exposes localized pending state', () => {
  const page = fs.readFileSync(path.join(root, 'src/app/characters/[id]/page.tsx'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'src/lib/i18n.ts'), 'utf8');

  assert.match(page, /const \[deleting, setDeleting\] = useState\(false\)/);
  assert.match(page, /const deleteInFlightRef = useRef\(false\)/);
  assert.match(page, /if \(deleteInFlightRef\.current\) return/);
  assert.match(page, /deleteInFlightRef\.current = true/);
  assert.match(page, /deleteInFlightRef\.current = false/);
  assert.match(page, /onClick=\{handleDelete\}[^>]*disabled=\{deleting\}/);
  assert.match(page, /deleting \? t\('editor\.deleting'\) : t\('editor\.delete'\)/);
  assert.match(i18n, /'editor\.deleting': '正在删除\.\.\.'/);
  assert.match(i18n, /'editor\.deleting': 'Deleting\.\.\.'/);
});
