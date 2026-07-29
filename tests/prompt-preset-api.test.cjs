const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');

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
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const dbModulePath = require.resolve(path.join(root, 'src', 'lib', 'db.ts'));
const presetModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-presets.ts'));
const entryRouteModulePath = require.resolve(path.join(
  root,
  'src',
  'app',
  'api',
  'prompt-presets',
  '[id]',
  'entries',
  '[entryId]',
  'route.ts',
));
const exportRouteModulePath = require.resolve(path.join(
  root,
  'src',
  'app',
  'api',
  'prompt-presets',
  '[id]',
  'export',
  'route.ts',
));
const presetRouteModulePath = require.resolve(path.join(
  root,
  'src',
  'app',
  'api',
  'prompt-presets',
  '[id]',
  'route.ts',
));

let db;
let presetLib;
let entryRoute;
let exportRoute;
let presetRoute;

test.beforeEach(() => {
  const keysBefore = Object.keys(require.cache).filter(key => (
    key.startsWith(root + path.sep + 'src' + path.sep + 'lib')
    || key.includes(path.join('src', 'app', 'api', 'prompt-presets'))
  ));
  for (const key of keysBefore) delete require.cache[key];

  const dbModule = require(dbModulePath);
  dbModule.__resetDbForTests();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  dbModule.__migrateForTests(db);
  dbModule.__setDbForTests(db);

  presetLib = require(presetModulePath);
  entryRoute = require(entryRouteModulePath);
  exportRoute = require(exportRouteModulePath);
  presetRoute = require(presetRouteModulePath);
});

test.afterEach(() => {
  try { db && db.close(); } catch {}
});

test('nested entry GET/PATCH/DELETE reject an entry owned by another preset', async () => {
  const requestedParent = presetLib.createPreset({ name: 'Requested parent' });
  const actualParent = presetLib.createPreset({ name: 'Actual parent' });
  const entry = presetLib.upsertEntry({
    preset_id: actualParent.id,
    name: 'victim',
    role: 'user',
    content: 'unchanged',
  });
  const params = {
    params: Promise.resolve({ id: requestedParent.id, entryId: entry.id }),
  };

  const getResponse = await entryRoute.GET({}, params);
  assert.equal(getResponse.status, 404);

  const patchRequest = new NextRequest(
    `http://localhost/api/prompt-presets/${requestedParent.id}/entries/${entry.id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'corrupted' }),
    },
  );
  const patchResponse = await entryRoute.PATCH(patchRequest, params);
  assert.equal(patchResponse.status, 404);
  assert.equal(presetLib.getEntry(entry.id).content, 'unchanged');

  const deleteResponse = await entryRoute.DELETE({}, params);
  assert.equal(deleteResponse.status, 404);
  assert.ok(presetLib.getEntry(entry.id));
});

test('export uses an ASCII-safe Content-Disposition with UTF-8 filename metadata', async () => {
  const preset = presetLib.createPreset({ name: '中文\r\n预设 × 示例' });
  presetLib.upsertEntry({
    preset_id: preset.id,
    name: 'entry',
    role: 'user',
    content: 'hello',
  });

  const request = new NextRequest(
    `http://localhost/api/prompt-presets/${preset.id}/export?format=lumimuse`
  );
  const response = await exportRoute.GET(request, {
    params: Promise.resolve({ id: preset.id }),
  });

  assert.equal(response.status, 200);
  const disposition = response.headers.get('content-disposition');
  assert.ok(disposition);
  assert.match(disposition, /^[\x20-\x7e]+$/);
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.match(disposition, /%E4%B8%AD%E6%96%87/);
  assert.doesNotMatch(disposition, /[\r\n]/);

  const payload = await response.json();
  assert.equal(payload.preset.name, preset.name);
});

test('preset PATCH rejects invalid and conflicting strip_tags', async () => {
  const preset = presetLib.createPreset({ name: 'Rules' });
  const params = { params: Promise.resolve({ id: preset.id }) };

  for (const strip_tags of [['#'], ['content', '#CONTENT']]) {
    const request = new NextRequest(
      `http://localhost/api/prompt-presets/${preset.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strip_tags }),
      },
    );
    const response = await presetRoute.PATCH(request, params);
    assert.equal(response.status, 400);
  }

  assert.deepEqual(presetLib.getPreset(preset.id).strip_tags, []);
});
