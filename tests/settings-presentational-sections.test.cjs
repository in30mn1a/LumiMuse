const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act, cleanup, fireEvent, render, waitFor } = require('@testing-library/react');

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

function loadTypeScript(module, filename) {
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
}

require.extensions['.ts'] = loadTypeScript;
require.extensions['.tsx'] = loadTypeScript;

function createSpy() {
  const calls = [];
  const fn = (...args) => calls.push(args);
  fn.calls = calls;
  return fn;
}

function createPageHarness() {
  const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
  const initialSettings = {
    ...DEFAULT_SETTINGS,
    api_base: 'https://initial.example/v1',
    api_key: 'initial-key',
    model: 'initial-model',
    top_p: 0.9,
  };
  const requests = [];
  const providerCalls = {
    activate: createSpy(),
    delete: createSpy(),
    save: createSpy(),
    saveCurrent: createSpy(),
    updateCurrent: createSpy(),
    setEditing: createSpy(),
  };
  const fontCalls = [];
  const themeStorageCalls = [];
  const toastCalls = [];
  const asyncNoop = async () => {};
  const noop = () => {};
  const t = key => key;
  const translation = { t, setLang: noop };
  const toast = { showToast: (...args) => toastCalls.push(args) };
  const nullPanel = () => null;
  const providers = [
    {
      id: 'provider-a',
      name: 'Provider A',
      api_base: 'https://a.example/v1',
      api_key: 'key-a',
      model: 'model-a',
      temperature: 0.7,
      max_tokens: 4096,
      context_window: 131072,
      json_mode: false,
      created_at: '2026-07-11T00:00:00.000Z',
    },
    {
      id: 'provider-b',
      name: 'Provider B',
      api_base: 'https://b.example/v1',
      api_key: 'key-b',
      model: 'model-b',
      temperature: 0.8,
      max_tokens: 8192,
      context_window: 200000,
      json_mode: true,
      created_at: '2026-07-11T00:00:00.000Z',
    },
  ];
  const editingProvider = { ...providers[0] };
  providerCalls.setEditing.resolved = [];
  const recordSetEditing = value => {
    providerCalls.setEditing.calls.push([value]);
    if (typeof value === 'function') {
      providerCalls.setEditing.resolved.push(value(editingProvider));
    }
  };
  recordSetEditing.calls = providerCalls.setEditing.calls;
  recordSetEditing.resolved = providerCalls.setEditing.resolved;
  providerCalls.setEditing = recordSetEditing;
  const memoryIndexPanel = {
    status: null,
    loading: false,
    rebuilding: false,
    retrying: false,
    indexingUnindexed: false,
    clearing: false,
    stopping: false,
    error: null,
    activeTasks: [],
    blockedReason: null,
    diagnostics: null,
    diagnosticsLoading: false,
    diagnosticsError: null,
    loadMemoryIndexStatus: asyncNoop,
    loadMemoryDiagnostics: asyncNoop,
    handleRetryFailedMemoryIndex: noop,
    handleRebuildMemoryIndex: noop,
    handleIndexUnindexedMemoryIndex: noop,
    handleClearMemoryIndex: noop,
    handleStopCurrentMemoryTask: noop,
  };
  const memoryManagementPanel = {
    memoryManagementCharacterId: '',
    memoryManagementCharacterIdRef: { current: '' },
    handleMemoryManagementCharacterChange: noop,
    loadMemoryManagementCharacters: asyncNoop,
  };
  const memoryProfilePanel = { resetProfile: noop, loadMemoryProfile: asyncNoop };
  const memoryArchivePanel = {
    resetArchiveForCharacterChange: noop,
    loadMemoryArchiveMemories: asyncNoop,
    loadMemoryArchiveBatches: asyncNoop,
  };
  const memoryCandidatesPanel = { loadMemoryCandidates: asyncNoop };

  global.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), method, body });
    if (url === '/api/settings' && method === 'GET') {
      return new Response(JSON.stringify(initialSettings), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/models' && method === 'POST') {
      return new Response(JSON.stringify({ models: ['fetched-model'] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/settings' && method === 'PUT') {
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === 'next/navigation') return { useRouter: () => ({ push: noop, replace: noop }) };
    if (request === '@/lib/i18n-context') return { useTranslation: () => translation };
    if (request === '@/components/ui/Toast') return { useToast: () => toast };
    if (request === '@/components/ui/icons') {
      return new Proxy({}, { get: () => () => React.createElement('span', { 'aria-hidden': 'true' }) });
    }
    if (request === '@/lib/font-stacks') return { applyFontStyle: value => fontCalls.push(value) };
    if (request === '@/lib/theme-provider') return { writeThemeStorage: value => themeStorageCalls.push(value) };
    if (request === '@/hooks/settings/useSettingsAuth') {
      return { useSettingsAuth: () => ({ authEnabled: false, handleLogout: noop }) };
    }
    if (request === '@/hooks/settings/useSettingsProviders') {
      return {
        useSettingsProviders: () => ({
          providers,
          activeProviderId: 'provider-a',
          editingProvider,
          setEditingProvider: providerCalls.setEditing,
          handleActivateProvider: providerCalls.activate,
          handleDeleteProvider: providerCalls.delete,
          handleSaveProvider: providerCalls.save,
          handleSaveCurrentAsProvider: providerCalls.saveCurrent,
          handleUpdateCurrentProvider: providerCalls.updateCurrent,
        }),
      };
    }
    if (request === '@/hooks/settings/useMemoryIndexPanel') return { useMemoryIndexPanel: () => memoryIndexPanel };
    if (request === '@/hooks/settings/useMemoryManagementCharacters') return { useMemoryManagementCharacters: () => memoryManagementPanel };
    if (request === '@/hooks/settings/useMemoryProfilePanel') return { useMemoryProfilePanel: () => memoryProfilePanel };
    if (request === '@/hooks/settings/useMemoryArchivePanel') return { useMemoryArchivePanel: () => memoryArchivePanel };
    if (request === '@/hooks/settings/useMemoryCandidatesPanel') return { useMemoryCandidatesPanel: () => memoryCandidatesPanel };
    if (request === '@/components/settings/memory/MemoryEngineSection') {
      return { MemoryEngineSection: ({ children }) => React.createElement(React.Fragment, null, children) };
    }
    if (/^@\/components\/settings\/memory\//.test(request)) {
      const exportName = path.basename(request);
      return { [exportName]: nullPanel };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve('../src/app/settings/page.tsx');
    delete require.cache[resolved];
    const SettingsPage = require(resolved).default;
    return {
      SettingsPage,
      editingProvider,
      fontCalls,
      providerCalls,
      requests,
      themeStorageCalls,
      toastCalls,
    };
  } finally {
    Module._load = originalLoad;
  }
}

test.afterEach(() => {
  cleanup();
  delete global.fetch;
});

test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  delete require.extensions['.ts'];
  delete require.extensions['.tsx'];
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('provider presentation forwards list, editor, and persistence callbacks', async () => {
  const harness = createPageHarness();
  const view = render(React.createElement(harness.SettingsPage));
  await waitFor(() => assert.equal(view.container.querySelector('#settings-api-base').value, 'https://initial.example/v1'));

  fireEvent.click(view.getByRole('button', { name: 'settings.providerUpdateCurrent' }));
  fireEvent.click(view.getByRole('button', { name: 'settings.providerSaveCurrent' }));
  fireEvent.click(view.getByRole('button', { name: 'settings.providerSwitch' }));
  fireEvent.click(view.getAllByRole('button', { name: 'common.edit' })[1]);
  fireEvent.click(view.getAllByRole('button', { name: 'common.delete' })[1]);
  fireEvent.change(view.container.querySelector('#settings-provider-model'), { target: { value: 'edited-model' } });
  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  fireEvent.click(view.getByRole('button', { name: 'common.cancel' }));

  assert.equal(harness.providerCalls.updateCurrent.calls.length, 1);
  assert.equal(harness.providerCalls.saveCurrent.calls.length, 1);
  assert.deepEqual(harness.providerCalls.activate.calls, [['provider-b']]);
  assert.deepEqual(harness.providerCalls.delete.calls, [['provider-b']]);
  assert.deepEqual(harness.providerCalls.setEditing.calls[0], [{ ...harness.editingProvider, id: 'provider-b', name: 'Provider B', api_base: 'https://b.example/v1', api_key: 'key-b', model: 'model-b', temperature: 0.8, max_tokens: 8192, context_window: 200000, json_mode: true }]);
  assert.equal(harness.providerCalls.setEditing.resolved[0].model, 'edited-model');
  assert.equal(harness.providerCalls.save.calls.length, 1);
  assert.deepEqual(harness.providerCalls.setEditing.calls.at(-1), [null]);
});

test('API, model, chat, and display controls preserve fetch and save payloads', async () => {
  const harness = createPageHarness();
  const view = render(React.createElement(harness.SettingsPage));
  await waitFor(() => assert.equal(view.container.querySelector('#settings-api-base').value, 'https://initial.example/v1'));
  harness.fontCalls.length = 0;
  harness.themeStorageCalls.length = 0;

  fireEvent.change(view.container.querySelector('#settings-api-base'), { target: { value: 'https://changed.example/v1' } });
  fireEvent.change(view.container.querySelector('#settings-api-key'), { target: { value: 'changed-key' } });
  fireEvent.change(view.container.querySelector('#settings-model'), { target: { value: 'typed-model' } });
  fireEvent.click(view.getByLabelText('settings.jsonMode'));
  fireEvent.click(view.getByRole('button', { name: 'settings.fetchModels' }));

  await waitFor(() => assert.equal(view.container.querySelector('#settings-model').tagName, 'SELECT'));
  const modelRequest = harness.requests.find(request => request.url === '/api/models');
  assert.deepEqual(modelRequest, {
    url: '/api/models',
    method: 'POST',
    body: {
      refresh: true,
      api_base: 'https://changed.example/v1',
      api_key: 'changed-key',
    },
  });
  fireEvent.change(view.container.querySelector('#settings-model'), { target: { value: 'fetched-model' } });

  fireEvent.click(view.getByRole('button', { name: 'settings.tabGeneration' }));
  fireEvent.change(view.getByLabelText('settings.temperature'), { target: { value: '1.25' } });
  fireEvent.change(view.getByLabelText('settings.maxTokens'), { target: { value: '9000' } });
  fireEvent.change(view.getByLabelText('settings.contextWindow'), { target: { value: '200000' } });
  fireEvent.change(view.getByLabelText('settings.topP'), { target: { value: '0.75' } });
  fireEvent.click(view.getByLabelText('settings.streaming'));
  fireEvent.click(view.getByLabelText('settings.exampleDialogue'));
  fireEvent.click(view.getByLabelText('settings.showTimestamps'));

  fireEvent.click(view.getByRole('button', { name: 'settings.tabMemory' }));
  fireEvent.change(view.getByLabelText('settings.theme'), { target: { value: 'dark' } });
  fireEvent.change(view.getByLabelText('settings.language'), { target: { value: 'en' } });
  fireEvent.click(view.getByRole('button', { name: /settings\.fontNameSystem/ }));
  assert.deepEqual(harness.fontCalls, ['system']);

  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'settings.save' }));
  });
  await waitFor(() => assert.ok(harness.requests.some(request => request.url === '/api/settings' && request.method === 'PUT')));

  const saveRequest = harness.requests.find(request => request.url === '/api/settings' && request.method === 'PUT');
  assert.equal(saveRequest.body.api_base, 'https://changed.example/v1');
  assert.equal(saveRequest.body.api_key, 'changed-key');
  assert.equal(saveRequest.body.model, 'fetched-model');
  assert.equal(saveRequest.body.json_mode, true);
  assert.equal(saveRequest.body.temperature, 1.25);
  assert.equal(saveRequest.body.max_tokens, 9000);
  assert.equal(saveRequest.body.context_window, 200000);
  assert.equal(saveRequest.body.top_p, 0.75);
  assert.equal(saveRequest.body.streaming, false);
  assert.equal(saveRequest.body.example_dialogue, false);
  assert.equal(saveRequest.body.show_timestamps, false);
  assert.equal(saveRequest.body.theme, 'dark');
  assert.equal(saveRequest.body.language, 'en');
  assert.equal(saveRequest.body.font_style, 'system');
  assert.deepEqual(harness.themeStorageCalls, ['dark']);
  assert.deepEqual(harness.fontCalls, ['system', 'system']);
  assert.deepEqual(harness.toastCalls.at(-1), ['settings.saveSuccess', 'success']);
});
