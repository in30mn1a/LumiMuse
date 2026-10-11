const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const Database = require('better-sqlite3');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');
const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
global.sessionStorage = window.sessionStorage;
const { render, cleanup, fireEvent, waitFor, act } = require('@testing-library/react');
const userEvent = require('@testing-library/user-event').default;
const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const file of [`${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) if (fs.existsSync(file)) return file;
  }
  return originalResolve.call(this, request, ...args);
};
function loadTs(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
}
require.extensions['.ts'] = loadTs;
require.extensions['.tsx'] = loadTs;
function load(file, mocks = {}) {
  Module._load = function (request, ...args) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, ...args);
  };
  try { delete require.cache[require.resolve(file)]; return require(file); }
  finally { Module._load = originalLoad; }
}
const t = key => key;
const showToast = (...args) => toasts.push(args);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let db;
let route;
let character;
let calls;
let pushes;
let toasts;
let removed;
let cleared;
let deleteFailure;
let putGate;
let deleteGate;
function params(id = character.id) { const promise = Promise.resolve({ id }); promise.status = 'fulfilled'; promise.value = { id }; return promise; }
async function mount({ strict = false, marker = true } = {}) {
  if (marker) sessionStorage.setItem('lumimuse_new_character_id', character.id);
  const Editor = load('../src/app/characters/[id]/page.tsx', {
    'next/navigation': { useRouter: () => ({ push: value => pushes.push(value) }) },
    '@/lib/i18n-context': { useTranslation: () => ({ t }) },
    '@/components/ui/Toast': { useToast: () => ({ showToast }) },
    '@/lib/virtual-keyboard': { dismissVirtualKeyboard: async () => {} },
    '@/lib/character-list-cache': { getCharacterListCache: () => [character], setCharacterListCache: value => removed.push(value) },
    '@/lib/character-context-cache': { clearCharacterContext: value => cleared.push(value) },
    '@/lib/image-blob-cache': { forgetImageBlobs: async () => {} },
    ...Object.fromEntries(['PresetSelectField', 'ModelPresetBindingsField', 'CharacterTaskModelsField'].map(name => [`@/components/ui/${name}`, { __esModule: true, default: () => null }])),
    '@/components/characters/CharacterExportDialog': { CharacterExportDialog: () => null },
    '@/components/characters/CharacterAiGeneratorPanel': { CharacterAiGeneratorPanel: () => null },
  }).default;
  const element = React.createElement(Editor, { params: params() });
  const view = render(strict ? React.createElement(React.StrictMode, null, element) : element);
  view.rerenderEditor = id => view.rerender(React.createElement(Editor, { params: params(id) }));
  await waitFor(() => assert.ok(view.queryByText('editor.title')));
  return view;
}
test.beforeEach(async () => {
  calls = []; pushes = []; toasts = []; removed = []; cleared = []; deleteFailure = null; putGate = null; deleteGate = null;
  sessionStorage.clear();
  const dbModule = require('../src/lib/db.ts');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  dbModule.__migrateForTests(db);
  dbModule.__setDbForTests(db);
  const fileUtils = { collectCharacterLocalAssetUrls: () => new Set(), filterUnreferencedLocalAssetUrls: () => [], deleteLocalAssetUrls: async () => [] };
  route = load('../src/app/api/characters/[id]/route.ts', { '@/lib/character-file-utils': fileUtils });
  const create = load('../src/app/api/characters/route.ts');
  character = await (await create.POST(new Request('http://localhost/api/characters', { method: 'POST', body: JSON.stringify({ name: 'New Character' }) }))).json();
  global.fetch = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (init.method === 'DELETE' && deleteFailure) {
      if (deleteFailure === 'network') throw new Error('Network unavailable');
      return json({ error: 'Unavailable' }, 503);
    }
    if (init.method === 'PUT' && putGate) await putGate.promise;
    if (init.method === 'DELETE' && deleteGate) await deleteGate.promise;
    return route[init.method || 'GET'](new Request(`http://localhost${url}`, init), { params: params(url.split('/').at(-1)) });
  };
});
test.afterEach(() => { cleanup(); require('../src/lib/db.ts').__resetDbForTests(); delete global.fetch; });
test.after(() => { delete global.sessionStorage; restoreDom(); Module._resolveFilename = originalResolve; });

test('conditional cleanup preserves a stale marker with conversation and message history', async () => {
  db.prepare('INSERT INTO conversations (id, character_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('conversation', character.id, 'History', character.created_at, character.created_at);
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run('message', 'conversation', 'user', 'Keep me', character.created_at);
  const view = await mount();
  fireEvent.click(view.getByText('editor.cancel'));
  await waitFor(() => assert.equal(pushes.length, 1));
  assert.ok(db.prepare('SELECT id FROM characters WHERE id = ?').get(character.id));
  assert.equal(db.prepare('SELECT content FROM messages').get().content, 'Keep me');
  assert.equal(removed.length, 0);
});
test('conditional cleanup preserves a saved empty character', async () => {
  db.prepare('UPDATE characters SET updated_at = ? WHERE id = ?').run('2027-01-01T00:00:00.000Z', character.id);
  const view = await mount();
  fireEvent.click(view.getByText('editor.cancel'));
  await waitFor(() => assert.equal(pushes.length, 1));
  assert.ok(db.prepare('SELECT id FROM characters WHERE id = ?').get(character.id));
});
test('immediate cancel still deletes a fresh empty character in StrictMode', async () => {
  const view = await mount({ strict: true });
  fireEvent.click(view.getByText('editor.cancel'));
  await waitFor(() => assert.equal(pushes.length, 1));
  assert.equal(db.prepare('SELECT id FROM characters WHERE id = ?').get(character.id), undefined);
  assert.equal(removed.length, 1);
});
test('leaving and remounting invalidates creation cleanup eligibility', async () => {
  const first = await mount();
  first.unmount();
  const next = await mount({ marker: false });
  fireEvent.click(next.getByText('editor.cancel'));
  await waitFor(() => assert.equal(pushes.length, 1));
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
  assert.ok(db.prepare('SELECT id FROM characters WHERE id = ?').get(character.id));
});
test('changing route ids and returning does not reactivate the original creation flow', async () => {
  const create = require('../src/app/api/characters/route.ts');
  const other = await (await create.POST(new Request('http://localhost/api/characters', { method: 'POST', body: JSON.stringify({ name: 'Other' }) }))).json();
  const view = await mount();
  view.rerenderEditor(other.id);
  await waitFor(() => assert.equal(view.getByPlaceholderText('editor.namePlaceholder').value, 'Other'));
  view.rerenderEditor(character.id);
  await waitFor(() => assert.equal(view.getByPlaceholderText('editor.namePlaceholder').value, 'New Character'));
  fireEvent.click(view.getByText('editor.cancel'));
  await waitFor(() => assert.equal(pushes.length, 1));
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
});
test('conditional route cleanup preserves stored content and new associated data', async () => {
  const request = () => new Request('http://localhost/api/characters', {
    method: 'DELETE', headers: { 'X-Character-Cleanup': character.created_at },
  });
  db.prepare('UPDATE characters SET image_tags = ? WHERE id = ?').run('silver hair', character.id);
  assert.deepEqual(await (await route.DELETE(request(), { params: params() })).json(), { ok: true, deleted: false });
  db.prepare('UPDATE characters SET image_tags = ? WHERE id = ?').run('', character.id);
  db.exec('CREATE TABLE future_character_data (character_id TEXT NOT NULL, value TEXT)');
  db.prepare('INSERT INTO future_character_data VALUES (?, ?)').run(character.id, 'Preserve');
  assert.deepEqual(await (await route.DELETE(request(), { params: params() })).json(), { ok: true, deleted: false });
  assert.ok(db.prepare('SELECT id FROM characters WHERE id = ?').get(character.id));
});
test('saving an unchanged character immediately still invalidates conditional cleanup', async () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse(character.created_at);
  try {
    const saved = await (await route.PUT(new Request('http://localhost/api/characters', { method: 'PUT', body: '{}' }), { params: params() })).json();
    assert.notEqual(saved.created_at, saved.updated_at);
    const response = await route.DELETE(new Request('http://localhost/api/characters', { method: 'DELETE', headers: { 'X-Character-Cleanup': character.created_at } }), { params: params() });
    assert.deepEqual(await response.json(), { ok: true, deleted: false });
  } finally { Date.now = originalNow; }
});
test('save and cancel are mutually exclusive while PUT is pending', async () => {
  let resolve;
  putGate = { promise: new Promise(done => { resolve = done; }) };
  const view = await mount();
  fireEvent.change(view.getByPlaceholderText('editor.namePlaceholder'), { target: { value: 'Saved name' } });
  fireEvent.click(view.getByText('editor.save'));
  fireEvent.click(view.getByText('editor.cancel'));
  assert.ok(!view.queryByText('editor.confirmDiscard'));
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
  await act(async () => { resolve(); });
  await waitFor(() => assert.equal(pushes.length, 1));
  assert.equal(db.prepare('SELECT name FROM characters WHERE id = ?').get(character.id).name, 'Saved name');
});
test('pending cleanup synchronously rejects duplicate cancel and save operations', async () => {
  let resolve;
  deleteGate = { promise: new Promise(done => { resolve = done; }) };
  const view = await mount();
  const cancel = view.getByText('editor.cancel');
  const save = view.getByText('editor.save');
  act(() => {
    cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
  await act(async () => { resolve(); });
  await waitFor(() => assert.equal(pushes.length, 1));
});
for (const failure of ['503', 'network']) test(`cleanup ${failure} failure preserves cache and eligibility for retry`, async () => {
  deleteFailure = failure;
  const view = await mount();
  fireEvent.click(view.getByText('editor.cancel'));
  await waitFor(() => assert.ok(toasts.some(([message]) => message.includes('editor.deleteFailed'))));
  assert.equal(pushes.length, 0); assert.equal(removed.length, 0); assert.equal(cleared.length, 0);
  assert.ok(db.prepare('SELECT id FROM characters WHERE id = ?').get(character.id));
  deleteFailure = null;
  fireEvent.click(view.getByText('editor.cancel'));
  await waitFor(() => assert.equal(pushes.length, 1));
  assert.equal(removed.length, 1);
});
test('unblurred tag drafts protect beforeunload and save includes the blur commit', async () => {
  const view = await mount();
  const user = userEvent.setup();
  const input = view.getAllByPlaceholderText('1girl, silver hair, short hair, orange eyes, slender...').find(node => node.tagName === 'INPUT');
  await user.type(input, 'silver hair');
  const event = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  await user.click(view.getByText('editor.save'));
  await waitFor(() => assert.equal(pushes.length, 1));
  assert.equal(db.prepare('SELECT image_tags FROM characters WHERE id = ?').get(character.id).image_tags, 'silver hair');
  const after = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
});
test('unblurred user tag drafts also trigger discard protection', async () => {
  const view = await mount();
  const input = view.getAllByPlaceholderText('1boy, black hair, brown eyes, glasses...').find(node => node.tagName === 'INPUT');
  fireEvent.change(input, { target: { value: 'glasses' } });
  const event = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  fireEvent.click(view.getByText('editor.cancel'));
  assert.ok(view.queryByText('editor.confirmDiscard'));
  assert.equal(pushes.length, 0);
});



