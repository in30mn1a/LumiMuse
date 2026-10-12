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

function createProviderOptions() {
  const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
  let settings = { ...DEFAULT_SETTINGS, active_provider_id: 'a' };
  return {
    settings,
    setSettings: value => { settings = typeof value === 'function' ? value(settings) : value; },
    mergeSettings: next => ({ ...DEFAULT_SETTINGS, ...next }),
    t,
    showToast() {},
    resetModels() {},
    readSettings: () => settings,
  };
}

test('older provider refreshes cannot overwrite a newer list or selection', async () => {
  let count = 0;
  let releaseOlder;
  global.fetch = async () => {
    count += 1;
    if (count === 2) return new Promise(resolve => { releaseOlder = () => resolve(okJson({ providers: [{ id: 'old', name: 'Old' }], active_provider_id: 'old' })); });
    return okJson({ providers: [{ id: count === 1 ? 'initial' : 'new', name: 'Provider' }], active_provider_id: count === 1 ? 'initial' : 'new' });
  };
  const { useSettingsProviders } = require('../src/hooks/settings/useSettingsProviders.ts');
  const options = createProviderOptions();
  const { result } = renderHook(() => useSettingsProviders(options));
  await waitFor(() => assert.equal(result.current.activeProviderId, 'initial'));
  let older;
  act(() => { older = result.current.loadProviders(); });
  await waitFor(() => assert.equal(typeof releaseOlder, 'function'));
  await act(() => result.current.loadProviders());
  await act(async () => { releaseOlder(); await older; });
  assert.equal(result.current.activeProviderId, 'new');
  assert.equal(result.current.providers[0].id, 'new');
  assert.equal(result.current.providersLoading, false);
});

test('a provider refresh started before activation cannot overwrite the activated provider', async () => {
  let count = 0;
  let releaseOlder;
  let active = 'a';
  global.fetch = async (url, init) => {
    if (url === '/api/providers/activate') { active = JSON.parse(init.body).id; return okJson({ ok: true }); }
    if (url === '/api/settings') return okJson({ active_provider_id: active, model: `${active}-model` });
    count += 1;
    if (count === 2) return new Promise(resolve => { releaseOlder = () => resolve(okJson({ providers: [{ id: 'a', name: 'A' }], active_provider_id: 'a' })); });
    return okJson({ providers: [{ id: active, name: active }], active_provider_id: active });
  };
  const { useSettingsProviders } = require('../src/hooks/settings/useSettingsProviders.ts');
  const options = createProviderOptions();
  const { result } = renderHook(() => useSettingsProviders(options));
  await waitFor(() => assert.equal(result.current.activeProviderId, 'a'));
  let older;
  act(() => { older = result.current.loadProviders(); });
  await act(() => result.current.handleActivateProvider('b'));
  await act(async () => { releaseOlder(); await older; });
  assert.equal(result.current.activeProviderId, 'b');
  assert.equal(result.current.providers[0].id, 'b');
  assert.equal(options.readSettings().model, 'b-model');
});

test('unified settings and provider synchronization execute together before queued activation', async () => {
  const writes = [];
  let releaseSettings;
  let active = 'a';
  global.fetch = async (url, init) => {
    if (url === '/api/settings' && init?.method === 'PUT') {
      writes.push('settings');
      await new Promise(resolve => { releaseSettings = resolve; });
      return okJson({ ok: true });
    }
    if (url === '/api/providers' && init?.method === 'PUT') {
      const body = JSON.parse(init.body);
      writes.push(`sync:${body.id}`);
      // 接口字段与密钥只由服务端从已保存设置读取，前端不再随请求重发。
      assert.deepEqual(body, { id: 'a', sync_from_settings: true });
      return okJson({ ok: true });
    }
    if (url === '/api/providers/activate') {
      active = JSON.parse(init.body).id;
      writes.push(`activate:${active}`);
      return okJson({ ok: true });
    }
    if (url === '/api/settings') return okJson({ active_provider_id: active, model: `${active}-model` });
    return okJson({ providers: [{ id: active, name: active }], active_provider_id: active });
  };
  const { useSettingsProviders } = require('../src/hooks/settings/useSettingsProviders.ts');
  const options = createProviderOptions();
  const { result } = renderHook(() => useSettingsProviders(options));
  await waitFor(() => assert.equal(result.current.activeProviderId, 'a'));
  let saving;
  let activating;
  act(() => {
    saving = result.current.runProviderOperation(async () => {
      await fetch('/api/settings', { method: 'PUT' });
      await result.current.handleUpdateCurrentProvider('a');
    });
    activating = result.current.handleActivateProvider('b');
  });
  await waitFor(() => assert.deepEqual(writes, ['settings']));
  assert.equal(result.current.providerBusy, true);
  await act(async () => { releaseSettings(); await Promise.all([saving, activating]); });
  assert.deepEqual(writes, ['settings', 'sync:a', 'activate:b']);
  assert.equal(result.current.activeProviderId, 'b');
  assert.equal(result.current.providerBusy, false);
  assert.equal(options.readSettings().model, 'b-model');
});

test('current-provider synchronization propagates failures for the unified save to handle', async () => {
  global.fetch = async (url, init) => init?.method === 'PUT' ? new Response('sync failed', { status: 500 }) : okJson({ providers: [], active_provider_id: 'a' });
  const { useSettingsProviders } = require('../src/hooks/settings/useSettingsProviders.ts');
  const options = createProviderOptions();
  const { result } = renderHook(() => useSettingsProviders(options));
  await waitFor(() => assert.equal(result.current.activeProviderId, 'a'));
  await assert.rejects(() => result.current.handleUpdateCurrentProvider('a'), /HTTP 500/);
});

test('translation changes do not reload providers or overwrite the active selection', async () => {
  let loads = 0;
  global.fetch = async () => { loads += 1; return okJson({ providers: [], active_provider_id: 'a' }); };
  const { useSettingsProviders } = require('../src/hooks/settings/useSettingsProviders.ts');
  const options = createProviderOptions();
  const { result, rerender } = renderHook(({ translate }) => useSettingsProviders({ ...options, t: translate }), { initialProps: { translate: t } });
  await waitFor(() => assert.equal(result.current.activeProviderId, 'a'));
  rerender({ translate: key => `translated:${key}` });
  await act(async () => {});
  assert.equal(loads, 1);
  assert.equal(result.current.activeProviderId, 'a');
});
