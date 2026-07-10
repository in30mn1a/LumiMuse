const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act, cleanup, renderHook, waitFor } = require('@testing-library/react');

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
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const t = key => key;
const okJson = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

test.afterEach(() => {
  cleanup();
  delete global.fetch;
});
test.after(() => {
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('useSettingsAuth loads auth state and logs out with the required JSON content type', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return url === '/api/auth' && init?.method === 'DELETE'
      ? okJson({ ok: true })
      : okJson({ authEnabled: true });
  };
  window.confirm = () => true;
  const replaced = [];
  const toasts = [];
  const { useSettingsAuth } = require('../src/hooks/settings/useSettingsAuth.ts');
  const { result } = renderHook(() => useSettingsAuth({ t, showToast: (...args) => toasts.push(args), replaceRoute: path => replaced.push(path) }));

  await waitFor(() => assert.equal(result.current.authEnabled, true));
  await act(() => result.current.handleLogout());
  assert.deepEqual(replaced, ['/login']);
  assert.equal(toasts.length, 0);
  const logout = calls.find(call => call.init?.method === 'DELETE');
  assert.equal(logout.init.headers['Content-Type'], 'application/json');
});

test('useSettingsAuth reports logout failures without navigating', async () => {
  global.fetch = async (url, init) => init?.method === 'DELETE'
    ? new Response('denied', { status: 500 })
    : okJson({ authEnabled: true });
  window.confirm = () => true;
  const replaced = [];
  const toasts = [];
  const { useSettingsAuth } = require('../src/hooks/settings/useSettingsAuth.ts');
  const { result } = renderHook(() => useSettingsAuth({ t, showToast: (...args) => toasts.push(args), replaceRoute: path => replaced.push(path) }));
  await waitFor(() => assert.equal(result.current.authEnabled, true));
  await act(() => result.current.handleLogout());
  assert.equal(replaced.length, 0);
  assert.equal(toasts.at(-1)[1], 'error');
});

test('useSettingsProviders serializes activation writes so the latest selection remains authoritative', async () => {
  const activationCalls = [];
  let activeOnServer = 'initial';
  let releaseFirstActivation;
  global.fetch = async (url, init) => {
    if (url === '/api/providers' && !init) return okJson({ providers: [{ id: 'a', name: 'A' }], active_provider_id: 'a' });
    if (url === '/api/providers/activate') {
      const { id } = JSON.parse(init.body);
      activationCalls.push(id);
      if (id === 'a') await new Promise(resolve => { releaseFirstActivation = resolve; });
      activeOnServer = id;
      return okJson({ ok: true });
    }
    if (url === '/api/settings') return okJson({ model: `${activeOnServer}-model` });
    throw new Error(`unexpected fetch ${url}`);
  };
  const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
  const { useSettingsProviders } = require('../src/hooks/settings/useSettingsProviders.ts');
  let currentSettings = DEFAULT_SETTINGS;
  const setSettings = value => { currentSettings = typeof value === 'function' ? value(currentSettings) : value; };
  const resetCalls = [];
  const options = {
    settings: currentSettings,
    setSettings,
    mergeSettings: next => ({ ...DEFAULT_SETTINGS, ...next }),
    t,
    showToast() {},
    resetModels: () => resetCalls.push(true),
  };
  const { result } = renderHook(() => useSettingsProviders(options));
  await waitFor(() => assert.equal(result.current.providers.length, 1));

  let first;
  let second;
  first = result.current.handleActivateProvider('a');
  second = result.current.handleActivateProvider('b');
  await waitFor(() => assert.deepEqual(activationCalls, ['a']));
  releaseFirstActivation();
  await act(() => Promise.all([first, second]));

  assert.deepEqual(activationCalls, ['a', 'b']);
  assert.equal(activeOnServer, 'b');
  assert.equal(result.current.activeProviderId, 'b');
  assert.equal(currentSettings.model, 'b-model');
  assert.equal(resetCalls.length, 1);
});

test('useSettingsProviders reports load errors and preserves provider save payload fields', async () => {
  const requests = [];
  let initialLoad = true;
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url === '/api/providers' && !init && initialLoad) {
      initialLoad = false;
      return new Response('load failed', { status: 500 });
    }
    if (url === '/api/providers' && init) return okJson({ ok: true });
    if (url === '/api/providers') return okJson({ providers: [], active_provider_id: '' });
    if (url === '/api/settings') return okJson({ model: 'saved-model' });
    throw new Error(`unexpected fetch ${url}`);
  };
  const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
  const { useSettingsProviders } = require('../src/hooks/settings/useSettingsProviders.ts');
  const toasts = [];
  let currentSettings = DEFAULT_SETTINGS;
  const options = {
    settings: currentSettings,
    setSettings: value => { currentSettings = typeof value === 'function' ? value(currentSettings) : value; },
    mergeSettings: next => ({ ...DEFAULT_SETTINGS, ...next }),
    t,
    showToast: (...args) => toasts.push(args),
    resetModels() {},
  };
  const { result } = renderHook(() => useSettingsProviders(options));
  await waitFor(() => assert.equal(toasts.at(-1)?.[1], 'error'));
  await act(() => result.current.setEditingProvider({ id: 'provider-1', name: 'Saved', api_key: '********' }));
  await act(() => result.current.handleSaveProvider());

  const save = requests.find(call => call.url === '/api/providers' && call.init?.method === 'PUT');
  assert.ok(save);
  assert.deepEqual(JSON.parse(save.init.body), {
    id: 'provider-1',
    name: 'Saved',
    api_key: '********',
    save_as_current: true,
  });
  assert.equal(currentSettings.model, 'saved-model');
});
