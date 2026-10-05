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
const { act, cleanup, render, fireEvent, waitFor } = require('@testing-library/react');
const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const t = key => key;
const showToast = () => {};
const navigation = [];
const router = { push: url => navigation.push(url) };
let db;
const mocks = {
  '@/lib/db': { getDb: () => db },
  '@/lib/route-auth': { requireAuth: async () => null },
  '@/lib/i18n-context': { useTranslation: () => ({ t }) },
  'next/navigation': { useRouter: () => router },
  '@/components/ui/Toast': { useToast: () => ({ showToast }) },
  '@/components/ui/CharacterTaskModelsField': { __esModule: true, default: () => null },
  '@/lib/character-context-cache': { clearCharacterContext() {} },
  '@/lib/image-blob-cache': { forgetImageBlobs: async () => {} },
  '@/lib/virtual-keyboard': { dismissVirtualKeyboard: async () => {} },
};
Module._resolveFilename = function(request, parent, ...args) {
  if (request.startsWith('@/')) {
    const base = path.join(root, 'src', request.slice(2));
    for (const file of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return originalResolve.call(this, request, parent, ...args);
};
Module._load = function(request, ...args) {
  if (Object.hasOwn(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, ...args);
};
function loadTs(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
}
require.extensions['.ts'] = loadTs;
require.extensions['.tsx'] = loadTs;
const { __migrateForTests } = require('../src/lib/db.ts');
const PresetSelectField = require('../src/components/ui/PresetSelectField.tsx').default;
const ModelPresetBindingsField = require('../src/components/ui/ModelPresetBindingsField.tsx').default;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const request = (payload, endpoint) => ({
  nextUrl: new URL(endpoint, 'http://localhost'), headers: new Headers(),
  text: async () => JSON.stringify(payload),
});

test.afterEach(async () => {
  cleanup();
  await new Promise(resolve => setImmediate(resolve));
  delete global.fetch;
  navigation.length = 0;
});
test.after(() => {
  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;
  restoreDom();
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

test('v3 import refreshes both real editor preset fields without losing the editable draft', async context => {
  const originalSetTimeout = global.setTimeout;
  const noticeTimers = [];
  context.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    if (delay === 5000) noticeTimers.push(timer);
    return timer;
  });
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  try {
    db.prepare('INSERT INTO characters (id, name) VALUES (?, ?)').run('target', '目标角色');
    const backup = {
      version: 3,
      character: { id: 'source', name: '恢复的角色', active_preset_id: 'source-preset' },
      model_preset_bindings: [{ model: 'fixture-model', preset_id: 'source-preset' }],
      prompt_presets: [{ id: 'source-preset', name: '恢复的预设' }],
      prompt_preset_entries: [{ id: 'entry', preset_id: 'source-preset', name: '指令', role: 'system', content: '角色指令' }],
    };
    const importer = require('../src/app/api/import/route.ts');
    const presetRoute = require('../src/app/api/prompt-presets/route.ts');
    const CharacterEditor = require('../src/app/characters/[id]/page.tsx').default;
    const refreshes = [];
    let characterLoads = 0;
    let importedDraft;
    global.fetch = async (url, init) => {
      if (url === '/api/characters/target') {
        characterLoads++;
        return Response.json({ ...db.prepare('SELECT * FROM characters WHERE id=?').get('target'), model_preset_bindings: [] });
      }
      if (url === '/api/models') return Response.json({ models: ['fixture-model'] });
      if (url === '/api/prompt-presets') {
        if (!importedDraft) return presetRoute.GET();
        const response = deferred();
        refreshes.push(response);
        return response.promise;
      }
      if (url.startsWith('/api/import?')) {
        assert.equal(init.body.name, 'backup.json');
        const response = await importer.POST(request(backup, url));
        assert.equal(response.status, 200);
        importedDraft = (await response.clone().json()).characterDraft;
        return response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    let view;
    await act(async () => {
      view = render(React.createElement(CharacterEditor, { params: Promise.resolve({ id: 'target' }) }));
    });
    await waitFor(() => assert.equal(view.getByLabelText('preset.fieldLabel').disabled, false));
    fireEvent.change(view.container.querySelector('input[accept=".json,application/json"]'), {
      target: { files: [new window.File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' })] },
    });
    fireEvent.click(view.getByRole('button', { name: 'import.apply' }));
    await waitFor(() => assert.equal(refreshes.length, 2));
    assert.notEqual(importedDraft.active_preset_id, 'source-preset');
    const name = view.getByPlaceholderText('editor.namePlaceholder');
    fireEvent.change(name, { target: { value: '刷新期间保留的草稿' } });
    await act(async () => {
      for (const response of refreshes) response.resolve(await presetRoute.GET());
    });
    for (const label of ['preset.fieldLabel', 'preset.modelBindPreset']) {
      const select = view.getByLabelText(label);
      assert.equal(select.value, importedDraft.active_preset_id);
      assert.match(select.selectedOptions[0].textContent, /恢复的预设/);
      fireEvent.change(select, { target: { value: '__none__' } });
      assert.equal(select.value, '__none__');
      fireEvent.change(select, { target: { value: importedDraft.active_preset_id } });
      assert.equal(select.value, importedDraft.active_preset_id);
    }
    assert.equal(name.value, '刷新期间保留的草稿');
    assert.equal(characterLoads, 1);
    assert.deepEqual(navigation, []);
    const closing = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(closing);
    assert.equal(closing.defaultPrevented, true);
  } finally {
    for (const timer of noticeTimers) clearTimeout(timer);
    db.close();
  }
});

for (const [name, Component, label, value] of [
  ['default', PresetSelectField, 'preset.fieldLabel', 'new'],
  ['model binding', ModelPresetBindingsField, 'preset.modelBindPreset', [{ model: 'fixture-model', preset_id: 'new' }]],
]) {
  test(`${name} refresh aborts the previous request and ignores its late response`, async () => {
    const pending = [];
    global.fetch = async (url, init) => {
      if (url === '/api/models') return Response.json({ models: ['fixture-model'] });
      const response = deferred();
      pending.push({ ...response, signal: init.signal });
      return response.promise;
    };
    const props = { value, onChange() {}, refreshKey: 0 };
    const view = render(React.createElement(Component, props));
    view.rerender(React.createElement(Component, { ...props, refreshKey: 1 }));
    assert.equal(pending.length, 2);
    assert.equal(pending[0].signal.aborted, true);
    await act(async () => { pending[1].resolve(Response.json({ presets: [{ id: 'new', name: '新预设' }] })); });
    await act(async () => { pending[0].resolve(Response.json({ presets: [{ id: 'old', name: '旧预设' }] })); });
    const select = view.getByLabelText(label);
    assert.equal(select.disabled, false);
    assert.equal(select.value, 'new');
    assert.equal(select.selectedOptions[0].textContent, '新预设');
    assert.equal(Boolean(view.queryByRole('option', { name: '旧预设' })), false);
  });

  test(`${name} refresh clears an earlier error and exposes loading until the new list arrives`, async () => {
    const replacement = deferred();
    let calls = 0;
    global.fetch = async url => {
      if (url === '/api/models') return Response.json({ models: [] });
      return ++calls === 1 ? new Response(null, { status: 500 }) : replacement.promise;
    };
    const props = { value, onChange() {}, refreshKey: 0 };
    const view = render(React.createElement(Component, props));
    await waitFor(() => assert.ok(view.getByText(/preset.loadError/)));
    view.rerender(React.createElement(Component, { ...props, refreshKey: 1 }));
    assert.equal(Boolean(view.queryByText(/preset.loadError/)), false);
    assert.ok(view.getByText('preset.loading'));
    assert.equal(view.getByLabelText(label).disabled, true);
    await act(async () => { replacement.resolve(Response.json({ presets: [{ id: 'new', name: '恢复的预设' }] })); });
    assert.equal(Boolean(view.queryByText('preset.loading')), false);
    assert.equal(view.getByLabelText(label).disabled, false);
    assert.equal(view.getByLabelText(label).selectedOptions[0].textContent, '恢复的预设');
  });
}
