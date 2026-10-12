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
const { act, cleanup, fireEvent, render, waitFor, within } = require('@testing-library/react');

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

function createPageHarness(options = {}) {
  const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
  const initialSettings = {
    ...DEFAULT_SETTINGS,
    api_base: 'https://initial.example/v1',
    api_key: 'initial-key',
    model: 'initial-model',
    top_p: 0.9,
    active_provider_id: 'provider-a',
    ...options.initialSettings,
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
  const fontSizeCalls = [];
  const themeStorageCalls = [];
  const toastCalls = [];
  const routeCalls = [];
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
    clearingOther: false,
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
    handleClearOtherTargetMemoryIndex: noop,
    handleStopCurrentMemoryTask: noop,
  };
  const memoryManagementPanel = {
    memoryManagementCharacterId: '',
    memoryManagementCharacterIdRef: { current: '' },
    handleMemoryManagementCharacterChange: noop,
    loadMemoryManagementCharacters: asyncNoop,
  };
  const memoryProfilePanel = { resetProfile: noop, loadMemoryProfile: asyncNoop, ...options.profile };
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
    const override = await options.fetch?.(url, init, initialSettings);
    if (override) return override;
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
    if (url === '/api/providers' && method === 'GET') return new Response(JSON.stringify({ providers, active_provider_id: 'provider-a' }));
    if (url === '/api/providers' && method === 'PUT') return new Response(JSON.stringify({ ok: true }));
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === 'next/navigation') return { useRouter: () => ({ push: route => routeCalls.push(route), replace: route => routeCalls.push(route) }) };
    if (request === 'next/link') {
      return {
        __esModule: true,
        default: ({ children, href, ...props }) => React.createElement('a', { href, ...props }, children),
      };
    }
    if (request === '@/lib/i18n-context') return { useTranslation: () => translation };
    if (request === '@/components/ui/Toast') return { useToast: () => toast };
    if (request === '@/components/ui/icons') {
      return new Proxy({}, { get: () => () => React.createElement('span', { 'aria-hidden': 'true' }) });
    }
    if (request === '@/lib/font-stacks') {
      return {
        applyFontStyle: value => fontCalls.push(value),
        applyFontSize: value => fontSizeCalls.push(value),
      };
    }
    if (request === '@/lib/theme-provider') return { writeThemeStorage: value => themeStorageCalls.push(value) };
    if (request === '@/hooks/settings/useSettingsAuth') {
      return { useSettingsAuth: () => ({ authEnabled: false, handleLogout: noop }) };
    }
    if (request === '@/hooks/settings/useSettingsProviders') {
      if (options.realProviders) return originalLoad.call(this, request, parent, isMain);
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
          runProviderOperation: operation => operation(),
          isProviderOperationPending: () => false,
          loadProviders: asyncNoop,
          providerBusy: false,
        }),
      };
    }
    if (request === '@/hooks/settings/useMemoryIndexPanel') return { useMemoryIndexPanel: () => memoryIndexPanel };
    if (request === '@/hooks/settings/useMemoryManagementCharacters') return { useMemoryManagementCharacters: () => memoryManagementPanel };
    if (request === '@/hooks/settings/useMemoryProfilePanel') return { useMemoryProfilePanel: () => memoryProfilePanel };
    if (request === '@/hooks/settings/useMemoryArchivePanel') return { useMemoryArchivePanel: () => memoryArchivePanel };
    if (request === '@/hooks/settings/useMemoryCandidatesPanel') return { useMemoryCandidatesPanel: () => memoryCandidatesPanel };
    if (request === '@/components/settings/memory/MemoryEngineSection') {
      if (options.realMemorySection) return originalLoad.call(this, request, parent, isMain);
      return { MemoryEngineSection: ({ children }) => React.createElement(React.Fragment, null, children) };
    }
    if (/^@\/components\/settings\/memory\//.test(request)) {
      const exportName = path.basename(request);
      return { [exportName]: options.panelDrafts ? () => React.createElement('input', { 'aria-label': `${exportName} draft`, defaultValue: '' }) : nullPanel };
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
      fontSizeCalls,
      providerCalls,
      requests,
      themeStorageCalls,
      toastCalls,
      routeCalls,
    };
  } finally {
    Module._load = originalLoad;
  }
}

test.afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
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

  fireEvent.click(view.getByRole('button', { name: 'settings.providerSaveCurrent' }));
  fireEvent.click(view.getByRole('radio', { name: 'Provider B' }));
  fireEvent.click(view.getAllByRole('button', { name: 'settings.providerActions' })[1]);
  fireEvent.click(view.getByRole('button', { name: 'common.edit' }));
  fireEvent.click(view.getAllByRole('button', { name: 'settings.providerActions' })[1]);
  fireEvent.click(view.getByRole('button', { name: 'common.delete' }));
  fireEvent.change(view.container.querySelector('#settings-provider-model'), { target: { value: 'edited-model' } });
  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  fireEvent.click(view.getByRole('button', { name: 'common.cancel' }));

  assert.equal(view.queryByRole('button', { name: 'settings.providerUpdateCurrent' }), null);
  assert.equal(harness.providerCalls.updateCurrent.calls.length, 0, 'the active provider only syncs through the unified save');
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
  harness.fontSizeCalls.length = 0;
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
  fireEvent.change(view.getByRole('spinbutton', { name: 'settings.temperature' }), { target: { value: '1.25' } });
  fireEvent.change(view.getByRole('spinbutton', { name: 'settings.maxTokens' }), { target: { value: '9000' } });
  fireEvent.change(view.getByRole('spinbutton', { name: 'settings.contextWindow' }), { target: { value: '200000' } });
  fireEvent.change(view.getByLabelText('settings.topP'), { target: { value: '0.75' } });
  fireEvent.click(view.getByLabelText('settings.streaming'));
  fireEvent.click(view.getByLabelText('settings.exampleDialogue'));
  fireEvent.click(view.getByLabelText('settings.showTimestamps'));

  fireEvent.click(view.getByRole('button', { name: 'settings.tabAppearance' }));
  fireEvent.change(view.getByLabelText('settings.theme'), { target: { value: 'dark' } });
  fireEvent.change(view.getByLabelText('settings.language'), { target: { value: 'en' } });
  fireEvent.click(view.getByRole('button', { name: /settings\.fontNameSystem/ }));
  assert.deepEqual(harness.fontCalls, ['system']);
  fireEvent.click(view.getByRole('button', { name: /settings\.fontSizeLarge/ }));
  assert.deepEqual(harness.fontSizeCalls, ['large']);

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
  await waitFor(() => assert.equal(harness.providerCalls.updateCurrent.calls.length, 1, 'saving settings also updates the active provider'));
  assert.equal(saveRequest.body.max_tokens, 9000);
  assert.equal(saveRequest.body.context_window, 200000);
  assert.equal(saveRequest.body.top_p, 0.75);
  assert.equal(saveRequest.body.streaming, false);
  assert.equal(saveRequest.body.example_dialogue, false);
  assert.equal(saveRequest.body.show_timestamps, false);
  assert.equal(saveRequest.body.theme, 'dark');
  assert.equal(saveRequest.body.language, 'en');
  assert.equal(saveRequest.body.font_style, 'system');
  assert.equal(saveRequest.body.font_size, 'large');
  assert.deepEqual(harness.themeStorageCalls, ['dark']);
  assert.deepEqual(harness.fontCalls, ['system', 'system']);
  assert.deepEqual(harness.fontSizeCalls, ['large', 'large']);
  assert.deepEqual(harness.toastCalls.at(-1), ['settings.saveSuccess', 'success']);
});

test('settings navigation deep-links five memory details and retains hidden panel drafts', async () => {
  window.history.replaceState({ nextState: true }, '', '/settings?section=memory&panel=profile');
  const harness = createPageHarness({ realMemorySection: true, panelDrafts: true });
  const view = render(React.createElement(harness.SettingsPage));
  const profile = await view.findByRole('textbox', { name: 'MemoryProfilePanel draft' });
  assert.equal(view.getAllByRole('button', { name: 'settings.tabGeneration' }).length, 1);
  assert.equal(view.container.querySelectorAll('nav').length, 1);
  fireEvent.change(profile, { target: { value: 'keep this draft' } });

  for (const [label, panel, field] of [
    ['settings.memoryCandidatesTitle', 'candidates', 'MemoryCandidatesPanel draft'],
    ['settings.memoryArchiveTitle', 'archive', 'MemoryArchivePanel draft'],
    ['settings.memoryIndexAndDiagnostics', 'index', 'MemoryIndexPanel draft'],
  ]) {
    fireEvent.click(view.getByRole('button', { name: label }));
    assert.equal(new URLSearchParams(window.location.search).get('panel'), panel);
    assert.ok(view.getByRole('textbox', { name: field }));
    assert.equal(view.queryByRole('textbox', { name: 'MemoryProfilePanel draft' }), null);
    assert.equal(view.queryByRole('spinbutton', { name: 'settings.memoryPackageTokenBudget' }), null);
  }
  fireEvent.click(view.getByRole('button', { name: 'settings.memoryEngineParameters' }));
  assert.ok(view.getByRole('spinbutton', { name: 'settings.memoryPackageTokenBudget' }));
  assert.equal(view.queryByRole('textbox', { name: 'MemoryIndexPanel draft' }), null);
  fireEvent.click(view.getByRole('button', { name: 'settings.tabGeneration' }));
  fireEvent.click(view.getByRole('button', { name: 'settings.memoryProfileTitle' }));
  assert.equal(view.getByRole('textbox', { name: 'MemoryProfilePanel draft' }), profile);
  assert.equal(profile.value, 'keep this draft');
  assert.deepEqual(window.history.state, { nextState: true });

  fireEvent.click(view.getByRole('button', { name: 'settings.backToList' }));
  assert.equal(new URLSearchParams(window.location.search).get('section'), null);
  assert.ok(view.getByRole('navigation').className.startsWith('flex '));
  fireEvent.click(view.getByRole('button', { name: 'settings.tabApi' }));
  assert.ok(view.getByRole('navigation').className.startsWith('hidden '));
});

test('provider menus use radio selection and restore their trigger on Escape', async () => {
  const harness = createPageHarness();
  const view = render(React.createElement(harness.SettingsPage));
  await waitFor(() => assert.equal(view.container.querySelector('#settings-api-base').value, 'https://initial.example/v1'));
  assert.equal(view.getByRole('radio', { name: 'Provider A' }).checked, true);
  assert.equal(view.getByRole('radio', { name: 'Provider B' }).checked, false);
  const trigger = view.getAllByRole('button', { name: 'settings.providerActions' })[1];
  trigger.focus();
  fireEvent.click(trigger);
  assert.equal(document.activeElement, view.getByRole('button', { name: 'common.edit' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('button', { name: 'common.edit' }), null);
  assert.equal(document.activeElement, trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  assert.equal(view.queryByRole('button', { name: 'common.delete' }), null);
});

test('category navigation closes provider menus without discarding their controlled editor draft', async () => {
  const harness = createPageHarness({ realProviders: true });
  const view = render(React.createElement(harness.SettingsPage));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, false));
  fireEvent.click(view.getAllByRole('button', { name: 'settings.providerActions' })[0]);
  fireEvent.click(view.getByRole('button', { name: 'common.edit' }));
  fireEvent.change(view.container.querySelector('#settings-provider-model'), { target: { value: 'provider-editor-draft' } });
  fireEvent.click(view.getAllByRole('button', { name: 'settings.providerActions' })[0]);
  const generation = view.getByRole('button', { name: 'settings.tabGeneration' });
  generation.focus();
  fireEvent.click(generation);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(document.activeElement, generation);
  fireEvent.click(view.getByRole('button', { name: 'settings.tabApi' }));
  assert.equal(view.queryByRole('button', { name: 'common.edit' }), null);
  assert.equal(view.container.querySelector('#settings-provider-model').value, 'provider-editor-draft');
});

test('settings leave and provider activation guard dirty drafts without guarding category changes', async () => {
  const harness = createPageHarness();
  const view = render(React.createElement(harness.SettingsPage));
  await waitFor(() => assert.equal(view.container.querySelector('#settings-model').value, 'initial-model'));
  fireEvent.change(view.container.querySelector('#settings-model'), { target: { value: 'unsaved-model' } });
  fireEvent.click(view.getByRole('button', { name: 'settings.tabGeneration' }));
  assert.equal(view.queryByRole('dialog'), null);
  fireEvent.click(view.getByRole('button', { name: 'settings.tabApi' }));
  assert.equal(view.container.querySelector('#settings-model').value, 'unsaved-model');
  fireEvent.click(view.getByRole('radio', { name: 'Provider B' }));
  assert.equal(harness.providerCalls.activate.calls.length, 0);
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'common.cancel' }));
  assert.equal(view.container.querySelector('#settings-model').value, 'unsaved-model');
  fireEvent.click(view.getByRole('button', { name: 'settings.back' }));
  assert.equal(harness.routeCalls.length, 0);
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'settings.discard' }));
  assert.deepEqual(harness.routeCalls, ['/']);
  assert.equal(view.container.querySelector('#settings-model').value, 'initial-model');
});

test('discard restores the saved form, font preview and unload protection', async () => {
  const harness = createPageHarness();
  const view = render(React.createElement(harness.SettingsPage));
  await waitFor(() => assert.equal(view.container.querySelector('#settings-model').value, 'initial-model'));
  fireEvent.change(view.container.querySelector('#settings-model'), { target: { value: 'unsaved-model' } });
  fireEvent.click(view.getByRole('button', { name: 'settings.tabAppearance' }));
  fireEvent.click(view.getByRole('button', { name: /settings\.fontNameSystem/ }));
  const dirtyUnload = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(dirtyUnload);
  assert.equal(dirtyUnload.defaultPrevented, true);
  fireEvent.click(view.getByRole('button', { name: 'settings.discard' }));
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'settings.discard' }));
  assert.equal(view.container.querySelector('#settings-model').value, 'initial-model');
  assert.equal(harness.fontCalls.at(-1), 'wenkai');
  assert.ok(view.getByText('common.noUnsavedChanges'));
  const cleanUnload = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(cleanUnload);
  assert.equal(cleanUnload.defaultPrevented, false);
});

test('initial provider load blocks saving until an authoritative active provider is available', async () => {
  let releaseProviders;
  let initialLoad = true;
  const harness = createPageHarness({ realProviders: true, fetch: (url, init) => {
    if (url === '/api/providers' && !init.method && initialLoad) {
      initialLoad = false;
      return new Promise(resolve => { releaseProviders = () => resolve(new Response(JSON.stringify({ providers: [], active_provider_id: 'provider-a' }))); });
    }
  } });
  const view = render(React.createElement(harness.SettingsPage));
  await waitFor(() => assert.equal(view.container.querySelector('#settings-model').value, 'initial-model'));
  assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, true);
  fireEvent.click(view.getByRole('button', { name: 'settings.save' }));
  assert.equal(harness.requests.filter(request => request.method === 'PUT').length, 0);
  await act(async () => releaseProviders());
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, false));
  fireEvent.change(view.container.querySelector('#settings-model'), { target: { value: 'saved-after-load' } });
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'settings.save' })));
  const saved = harness.requests.find(request => request.url === '/api/settings' && request.method === 'PUT');
  assert.equal(saved.body.model, 'saved-after-load');
  const sync = harness.requests.find(request => request.url === '/api/providers' && request.method === 'PUT');
  assert.deepEqual(sync.body, { id: 'provider-a', sync_from_settings: true });
});

test('provider load failures expose retry and cannot silently skip provider synchronization', async () => {
  let fail = true;
  const harness = createPageHarness({ realProviders: true, fetch: (url, init) => {
    if (url === '/api/providers' && !init.method && fail) return new Response('provider load failed', { status: 500 });
  } });
  const view = render(React.createElement(harness.SettingsPage));
  await view.findByRole('alert');
  assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, true);
  fail = false;
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'common.retry' })));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, false));
  assert.equal(view.queryByRole('alert'), null);
});

test('saving is also blocked while settings are loading or have failed, even after providers load', async () => {
  let releaseSettings;
  let fail = true;
  const harness = createPageHarness({ realProviders: true, fetch: (url, init) => {
    if (url === '/api/settings' && !init.method && fail) return new Promise(resolve => { releaseSettings = () => resolve(new Response('settings load failed', { status: 500 })); });
  } });
  const view = render(React.createElement(harness.SettingsPage));
  await view.findByRole('radio', { name: 'Provider A' });
  assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, true);
  assert.equal(view.container.querySelector('#settings-model').matches(':disabled'), true);
  await act(async () => releaseSettings());
  await view.findByRole('alert');
  assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, true);
  fail = false;
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'common.retry' })));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, false));
  assert.equal(view.container.querySelector('#settings-model').value, 'initial-model');
});

test('provider sync failures preserve the dirty state and only a successful retry reports success', async () => {
  let failSync = true;
  const harness = createPageHarness({ realProviders: true, fetch: (url, init) => {
    if (url === '/api/providers' && init.method === 'PUT' && failSync) return new Response('sync failed', { status: 500 });
  } });
  const view = render(React.createElement(harness.SettingsPage));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, false));
  fireEvent.change(view.container.querySelector('#settings-model'), { target: { value: 'retry-model' } });
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'settings.save' })));
  assert.ok(harness.toastCalls.some(([message, type]) => type === 'error' && message.includes('settings.providerSyncFailed')));
  assert.equal(harness.toastCalls.filter(([, type]) => type === 'success').length, 0);
  assert.ok(view.getByText('common.unsavedChanges'));
  failSync = false;
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'settings.save' })));
  assert.deepEqual(harness.toastCalls.at(-1), ['settings.saveSuccess', 'success']);
  assert.ok(view.getByText('common.noUnsavedChanges'));
});

test('discard after a partial save restores the actual persisted snapshot, not a claimed rollback', async () => {
  const harness = createPageHarness({ realProviders: true, fetch: (url, init) => {
    if (url === '/api/providers' && init.method === 'PUT') return new Response('sync failed', { status: 500 });
  } });
  const view = render(React.createElement(harness.SettingsPage));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, false));
  fireEvent.change(view.container.querySelector('#settings-model'), { target: { value: 'server-persisted-model' } });
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'settings.save' })));
  fireEvent.change(view.container.querySelector('#settings-model'), { target: { value: 'later-unsaved-model' } });
  fireEvent.click(view.getByRole('button', { name: 'settings.discard' }));
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'settings.discard' }));
  assert.equal(view.container.querySelector('#settings-model').value, 'server-persisted-model');
  assert.ok(view.getByText('common.noUnsavedChanges'));
});

test('normalized empty keys and fresh raw keys reconcile into the form while the provider sync carries no key', async () => {
  const { API_KEY_MASK } = require('../src/lib/constants.ts');
  for (const rawKey of [null, 'fresh-main-key']) {
    const harness = createPageHarness({ realProviders: true, initialSettings: { api_key: API_KEY_MASK }, fetch: (url, init) => {
      if (url === '/api/settings' && init.method === 'PUT') {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({ ...body, api_key: rawKey ? API_KEY_MASK : '' }));
      }
    } });
    const view = render(React.createElement(harness.SettingsPage));
    await waitFor(() => assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, false));
    fireEvent.change(view.container.querySelector('#settings-api-base'), { target: { value: 'https://new.example/v1' } });
    if (rawKey) fireEvent.change(view.container.querySelector('#settings-api-key'), { target: { value: rawKey } });
    await act(async () => fireEvent.click(view.getByRole('button', { name: 'settings.save' })));
    const sync = harness.requests.find(request => request.url === '/api/providers' && request.method === 'PUT');
    // 密钥只随设置保存提交一次；供应商同步由服务端从已保存设置读取。
    assert.deepEqual(sync.body, { id: 'provider-a', sync_from_settings: true });
    assert.equal(view.container.querySelector('#settings-api-key').value, rawKey ? API_KEY_MASK : '');
    assert.ok(view.getByText('common.noUnsavedChanges'));
    view.unmount();
  }
});

test('saving reconciles nested masked keys while retaining edits made during the request and suppresses duplicate writes', async () => {
  const { API_KEY_MASK } = require('../src/lib/constants.ts');
  let releaseSave;
  const harness = createPageHarness({ realProviders: true, realMemorySection: true, fetch: (url, init) => {
    if (url === '/api/settings' && init.method === 'PUT') {
      const snapshot = JSON.parse(init.body);
      return new Promise(resolve => { releaseSave = () => resolve(new Response(JSON.stringify({ ...snapshot, api_key: API_KEY_MASK, memory_engine: { ...snapshot.memory_engine, embedding_api_key: API_KEY_MASK } }))); });
    }
  } });
  const view = render(React.createElement(harness.SettingsPage));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'settings.save' }).disabled, false));
  fireEvent.change(view.container.querySelector('#settings-api-key'), { target: { value: 'new-main-key' } });
  fireEvent.click(view.getByRole('button', { name: 'settings.memoryEngineParameters' }));
  fireEvent.change(view.container.querySelector('#settings-memory-embedding-api-key'), { target: { value: 'new-embedding-key' } });
  fireEvent.click(view.getByRole('button', { name: 'settings.save' }));
  await waitFor(() => assert.equal(typeof releaseSave, 'function'));
  fireEvent.click(view.getByRole('button', { name: 'settings.saving' }));
  fireEvent.change(view.container.querySelector('#settings-memory-embedding-api-base'), { target: { value: 'https://later.example/v1' } });
  await act(async () => releaseSave());
  assert.equal(harness.requests.filter(request => request.url === '/api/settings' && request.method === 'PUT').length, 1);
  assert.equal(view.container.querySelector('#settings-memory-embedding-api-key').value, API_KEY_MASK);
  assert.equal(view.container.querySelector('#settings-memory-embedding-api-base').value, 'https://later.example/v1');
  assert.ok(view.getByText('common.unsavedChanges'));
  const saved = harness.requests.find(request => request.url === '/api/settings' && request.method === 'PUT');
  assert.equal(saved.body.api_key, 'new-main-key');
  const sync = harness.requests.find(request => request.url === '/api/providers' && request.method === 'PUT');
  assert.deepEqual(sync.body, { id: 'provider-a', sync_from_settings: true });
});
