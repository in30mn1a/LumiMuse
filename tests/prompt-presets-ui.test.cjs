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
const originalScrollTo = window.scrollTo;

window.scrollTo = () => {};

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function formatTemplate(template, values) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function loadUiModule(relativePath, { unwrapParams = false } = {}) {
  const toastCalls = [];
  const translate = key => key;
  const showToast = (...args) => toastCalls.push(args);
  const reactForPage = unwrapParams
    ? { ...React, use: value => value.value }
    : React;

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === 'react' && unwrapParams) return reactForPage;
    if (request === 'next/link') {
      return {
        __esModule: true,
        default: ({ children, href, ...props }) => React.createElement('a', { href, ...props }, children),
      };
    }
    if (request === '@/lib/i18n-context') {
      return { useTranslation: () => ({ t: translate }) };
    }
    if (request === '@/lib/i18n') return { formatTemplate };
    if (request === '@/components/ui/Toast') {
      return { useToast: () => ({ showToast }) };
    }
    if (request === '@/components/ui/icons') {
      return new Proxy({}, {
        get: () => ({ className }) => React.createElement('span', { className, 'aria-hidden': 'true' }),
      });
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const absolutePath = path.join(root, relativePath);
    delete require.cache[require.resolve(absolutePath)];
    const loaded = require(absolutePath);
    return { Component: loaded.default, toastCalls };
  } finally {
    Module._load = originalLoad;
  }
}

const EMPTY_SETTINGS = { prompt_preset: { default_preset_id: null } };
const PRESET = {
  id: 'preset-a',
  name: 'Preset A',
  description: '',
  story_plot_strip: false,
};
const ENTRY = {
  id: 'entry-a',
  preset_id: PRESET.id,
  name: 'Entry A',
  role: 'user',
  content: 'entry content',
  is_marker: false,
  marker_key: null,
  is_system_prompt: false,
  injection_position: 0,
  injection_depth: 4,
  injection_order: 100,
  forbid_overrides: false,
  enabled: true,
  sort_order: 10,
};

test.afterEach(() => {
  cleanup();
  delete global.fetch;
  window.confirm = () => true;
});

test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
  delete require.extensions['.ts'];
  delete require.extensions['.tsx'];
  window.scrollTo = originalScrollTo;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('预设列表把非 2xx 加载失败显示在页面上，而不是伪装成空列表', async () => {
  global.fetch = async url => {
    if (String(url) === '/api/prompt-presets') return jsonResponse({ error: 'boom' }, 503);
    if (String(url) === '/api/settings') return jsonResponse(EMPTY_SETTINGS);
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { Component, toastCalls } = loadUiModule('src/app/settings/prompt-presets/page.tsx');
  const view = render(React.createElement(Component));

  const alert = await view.findByRole('alert');
  assert.match(alert.textContent, /preset\.loadError/);
  assert.match(alert.textContent, /HTTP 503/);
  assert.equal(view.queryByText('preset.empty'), null);
  assert.deepEqual(toastCalls.at(-1), [
    'preset.loadError: /api/prompt-presets: HTTP 503',
    'error',
  ]);
});

test('预设列表创建使用同步 pending guard，快速双击只发送一次 POST', async () => {
  const createRequest = deferred();
  let createCalls = 0;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === '/api/prompt-presets' && method === 'GET') {
      return jsonResponse({ presets: [] });
    }
    if (requestUrl === '/api/settings') return jsonResponse(EMPTY_SETTINGS);
    if (requestUrl === '/api/prompt-presets' && method === 'POST') {
      createCalls += 1;
      return createRequest.promise;
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component } = loadUiModule('src/app/settings/prompt-presets/page.tsx');
  const view = render(React.createElement(Component));
  await waitFor(() => assert.ok(view.getByText('preset.empty')));

  fireEvent.change(view.getByPlaceholderText('preset.newNamePlaceholder'), {
    target: { value: 'New preset' },
  });
  const createButton = view.getByRole('button', { name: 'preset.create' });
  fireEvent.click(createButton);
  fireEvent.click(createButton);

  assert.equal(createCalls, 1);
  assert.equal(createButton.disabled, true);

  await act(async () => {
    createRequest.resolve(jsonResponse({ id: 'created' }, 201));
    await createRequest.promise;
  });
  await waitFor(() => assert.equal(createButton.disabled, true));
});

test('预设列表忽略刷新前的迟到响应', async () => {
  const oldPresets = deferred();
  const oldSettings = deferred();
  let presetReads = 0;
  let settingsReads = 0;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === '/api/prompt-presets' && method === 'POST') {
      return jsonResponse({ id: 'created' }, 201);
    }
    if (requestUrl === '/api/prompt-presets') {
      presetReads += 1;
      return presetReads === 1
        ? oldPresets.promise
        : jsonResponse({ presets: [{ ...PRESET, name: 'New preset', entry_count: 1, enabled_count: 1 }] });
    }
    if (requestUrl === '/api/settings') {
      settingsReads += 1;
      return settingsReads === 1 ? oldSettings.promise : jsonResponse(EMPTY_SETTINGS);
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component } = loadUiModule('src/app/settings/prompt-presets/page.tsx');
  const view = render(React.createElement(Component));
  fireEvent.change(view.getByPlaceholderText('preset.newNamePlaceholder'), {
    target: { value: 'Refresh' },
  });
  fireEvent.click(view.getByRole('button', { name: 'preset.create' }));

  await view.findByText('New preset');
  await act(async () => {
    oldPresets.resolve(jsonResponse({
      presets: [{ ...PRESET, name: 'Old preset', entry_count: 1, enabled_count: 1 }],
    }));
    oldSettings.resolve(jsonResponse(EMPTY_SETTINGS));
    await Promise.all([oldPresets.promise, oldSettings.promise]);
  });

  assert.ok(!view.queryByText('Old preset'));
  assert.ok(view.getByText('New preset'));
});

test('预设列表在默认项写入期间阻止重复写和其他删除操作', async () => {
  const defaultRequest = deferred();
  let defaultCalls = 0;
  let deleteCalls = 0;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === '/api/prompt-presets' && method === 'GET') {
      return jsonResponse({
        presets: [{ ...PRESET, entry_count: 1, enabled_count: 1, is_built_in: false }],
      });
    }
    if (requestUrl === '/api/settings' && method === 'GET') return jsonResponse(EMPTY_SETTINGS);
    if (requestUrl === '/api/settings' && method === 'PUT') {
      defaultCalls += 1;
      return defaultRequest.promise;
    }
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'DELETE') {
      deleteCalls += 1;
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component } = loadUiModule('src/app/settings/prompt-presets/page.tsx');
  const view = render(React.createElement(Component));
  const defaultButton = await view.findByRole('button', { name: 'preset.setDefault' });
  const deleteButton = view.getByTitle('preset.delete');
  fireEvent.click(defaultButton);
  fireEvent.click(defaultButton);
  fireEvent.click(deleteButton);

  assert.equal(defaultCalls, 1);
  assert.equal(deleteCalls, 0);
  assert.equal(defaultButton.disabled, true);
  assert.equal(deleteButton.disabled, true);

  await act(async () => {
    defaultRequest.resolve(jsonResponse({ ok: true }));
    await defaultRequest.promise;
  });
  await waitFor(() => assert.equal(defaultButton.disabled, false));
});

test('预设详情把非 2xx 加载失败显示为 alert', async () => {
  global.fetch = async url => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/entries')) return jsonResponse({ entries: [] });
    return jsonResponse({ error: 'unavailable' }, 502);
  };

  const { Component, toastCalls } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const params = { value: { id: 'broken' } };
  const view = render(React.createElement(Component, { params }));

  const alert = await view.findByRole('alert');
  assert.match(alert.textContent, /HTTP 502/);
  assert.equal(view.queryByText('preset.notFound'), null);
  assert.deepEqual(toastCalls.at(-1), [
    'preset.loadError: /api/prompt-presets/broken: HTTP 502',
    'error',
  ]);
});

test('预设详情忽略旧 id 的迟到响应', async () => {
  const oldPreset = deferred();
  const oldEntries = deferred();
  global.fetch = async url => {
    const requestUrl = String(url);
    if (requestUrl === '/api/prompt-presets/old') return oldPreset.promise;
    if (requestUrl === '/api/prompt-presets/old/entries') return oldEntries.promise;
    if (requestUrl === '/api/prompt-presets/new') {
      return jsonResponse({ ...PRESET, id: 'new', name: 'New preset' });
    }
    if (requestUrl === '/api/prompt-presets/new/entries') {
      return jsonResponse({ entries: [{ ...ENTRY, id: 'new-entry', preset_id: 'new', name: 'New entry' }] });
    }
    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  const { Component } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: 'old' } } }));
  view.rerender(React.createElement(Component, { params: { value: { id: 'new' } } }));

  await view.findByRole('heading', { name: 'New preset' });
  assert.ok(view.getByText('New entry'));

  await act(async () => {
    oldPreset.resolve(jsonResponse({ ...PRESET, id: 'old', name: 'Old preset' }));
    oldEntries.resolve(jsonResponse({ entries: [{ ...ENTRY, id: 'old-entry', name: 'Old entry' }] }));
    await Promise.all([oldPreset.promise, oldEntries.promise]);
  });

  assert.equal(view.queryByRole('heading', { name: 'Old preset' }), null);
  assert.equal(view.queryByText('Old entry'), null);
  assert.ok(view.getByRole('heading', { name: 'New preset' }));
});

test('预设详情新增 strip tag：PATCH 失败保留输入，重试成功后才清空', async () => {
  let patchCalls = 0;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'GET') {
      return jsonResponse({
        ...PRESET,
        story_plot_strip: true,
        strip_tags: [],
      });
    }
    if (requestUrl === `/api/prompt-presets/${PRESET.id}/entries` && method === 'GET') {
      return jsonResponse({ entries: [] });
    }
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'PATCH') {
      patchCalls += 1;
      return patchCalls === 1
        ? jsonResponse({ error: 'write failed' }, 500)
        : jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component, toastCalls } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  const input = await view.findByPlaceholderText('preset.stripTagPlaceholder');
  const addButton = view.getByRole('button', { name: 'preset.stripTagAdd' });

  fireEvent.change(input, { target: { value: 'content' } });
  fireEvent.click(addButton);

  await waitFor(() => assert.deepEqual(toastCalls.at(-1), [
    'preset.toggleError: HTTP 500',
    'error',
  ]));
  assert.equal(input.value, 'content', '失败后应保留输入，允许原样重试');
  assert.equal(addButton.disabled, false, '失败请求结束后应恢复重试按钮');

  fireEvent.click(addButton);

  await waitFor(() => assert.equal(patchCalls, 2));
  await waitFor(() => assert.equal(input.value, ''));
  assert.ok(view.getByText('content'));
  assert.deepEqual(toastCalls.at(-1), [
    'preset.stripTagsUpdateSuccess',
    'success',
  ]);
});

test('预设详情新增和保存都用 pending guard 防止重复写请求', async () => {
  const addRequest = deferred();
  const saveRequest = deferred();
  let addCalls = 0;
  let saveCalls = 0;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'GET') return jsonResponse(PRESET);
    if (requestUrl === `/api/prompt-presets/${PRESET.id}/entries` && method === 'GET') {
      return jsonResponse({ entries: [ENTRY] });
    }
    if (requestUrl === `/api/prompt-presets/${PRESET.id}/entries` && method === 'POST') {
      addCalls += 1;
      return addRequest.promise;
    }
    if (requestUrl === `/api/prompt-presets/${PRESET.id}/entries/${ENTRY.id}` && method === 'PATCH') {
      saveCalls += 1;
      return saveRequest.promise;
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  await view.findByRole('heading', { name: PRESET.name });

  const addButton = view.getByRole('button', { name: 'preset.addEntry' });
  fireEvent.click(addButton);
  fireEvent.click(addButton);
  assert.equal(addCalls, 1);
  assert.equal(addButton.disabled, true);

  await act(async () => {
    addRequest.resolve(jsonResponse({ id: 'new-entry' }, 201));
    await addRequest.promise;
  });
  await waitFor(() => assert.equal(addButton.disabled, false));

  fireEvent.click(view.getByRole('button', { name: 'preset.edit' }));
  const saveButton = view.getByRole('button', { name: 'preset.save' });
  fireEvent.click(saveButton);
  fireEvent.click(saveButton);
  assert.equal(saveCalls, 1);
  assert.equal(saveButton.disabled, true);

  await act(async () => {
    saveRequest.resolve(jsonResponse({ ok: true }));
    await saveRequest.promise;
  });
  await waitFor(() => assert.equal(view.queryByRole('button', { name: 'preset.save' }), null));
});

test('预设详情切换条目时保持行 DOM 节点稳定', async () => {
  const toggleRequest = deferred();
  let toggleCalls = 0;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'GET') {
      return jsonResponse(PRESET);
    }
    if (requestUrl === `/api/prompt-presets/${PRESET.id}/entries` && method === 'GET') {
      return jsonResponse({ entries: [ENTRY] });
    }
    if (requestUrl === `/api/prompt-presets/${PRESET.id}/entries/${ENTRY.id}` && method === 'PATCH') {
      toggleCalls += 1;
      return toggleRequest.promise;
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  const toggleButton = await view.findByRole('button', { name: 'preset.enabled' });
  const rowBeforeToggle = view.getByText(ENTRY.name).closest('li');

  fireEvent.click(toggleButton);

  await waitFor(() => assert.equal(toggleCalls, 1));
  assert.equal(view.getByText(ENTRY.name).closest('li'), rowBeforeToggle);
  assert.equal(rowBeforeToggle.isConnected, true);

  await act(async () => {
    toggleRequest.resolve(jsonResponse({ ok: true }));
    await toggleRequest.promise;
  });

  const disabledButton = await view.findByRole('button', { name: 'preset.disabled' });
  assert.equal(view.getByText(ENTRY.name).closest('li'), rowBeforeToggle);
  assert.equal(rowBeforeToggle.isConnected, true);
  assert.equal(disabledButton.disabled, false);
});

test('角色预设选择器保持 follow / none / explicit 三态并在卸载时 abort', async () => {
  let capturedSignal;
  global.fetch = async (url, init = {}) => {
    assert.equal(String(url), '/api/prompt-presets');
    capturedSignal = init.signal;
    return jsonResponse({
      presets: [
        { id: 'preset-a', name: 'Preset A', entry_count: 2 },
        { id: 'preset-b', name: 'Preset B', entry_count: 3 },
      ],
    });
  };

  const changes = [];
  const { Component } = loadUiModule('src/components/ui/PresetSelectField.tsx');
  const view = render(React.createElement(Component, {
    value: null,
    onChange: value => changes.push(value),
  }));

  const select = await view.findByLabelText('preset.fieldLabel');
  await waitFor(() => assert.equal(select.disabled, false));
  assert.equal(select.value, '__follow_global__');

  fireEvent.change(select, { target: { value: '__none__' } });
  fireEvent.change(select, { target: { value: 'preset-b' } });
  fireEvent.change(select, { target: { value: '__follow_global__' } });
  assert.deepEqual(changes, ['__none__', 'preset-b', null]);

  view.unmount();
  assert.equal(capturedSignal.aborted, true);
});

test('RONG 旧协议预设：不生效的 strip_tags 被划掉并给出模式提示', async () => {
  const rongPreset = {
    ...PRESET,
    story_plot_strip: true,
    // story_plot 令整个预设走 RONG 硬编码剥离，#thinking / content 都不会参与
    strip_tags: ['story_plot', 'story_body', '#thinking', 'content'],
  };
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'GET') return jsonResponse(rongPreset);
    if (requestUrl === `/api/prompt-presets/${PRESET.id}/entries` && method === 'GET') {
      return jsonResponse({ entries: [ENTRY] });
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));

  await view.findByText('preset.stripTagsLegacyHint');

  const chipClass = tag => view.getByText(tag).closest('span').className;
  assert.ok(!chipClass('story_plot').includes('line-through'), 'story_plot 由旧逻辑处理，应正常显示');
  assert.ok(!chipClass('story_body').includes('line-through'), 'story_body 由旧逻辑处理，应正常显示');
  assert.ok(chipClass('#thinking').includes('line-through'), '#thinking 在旧协议下不生效，应划掉');
  assert.ok(chipClass('content').includes('line-through'), 'content 在旧协议下不生效，应划掉');
});

test('参数化预设：strip_tags 全部生效，不显示旧协议提示', async () => {
  const kedaiPreset = {
    ...PRESET,
    story_plot_strip: true,
    strip_tags: ['content', 'scene', '#think'],
  };
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'GET') return jsonResponse(kedaiPreset);
    if (requestUrl === `/api/prompt-presets/${PRESET.id}/entries` && method === 'GET') {
      return jsonResponse({ entries: [ENTRY] });
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));

  await view.findByText('content');
  assert.equal(view.queryByText('preset.stripTagsLegacyHint'), null);
  for (const tag of ['content', 'scene', '#think']) {
    assert.ok(
      !view.getByText(tag).closest('span').className.includes('line-through'),
      `${tag} 走参数化路径应生效`,
    );
  }
});

test('预设响应缺 strip_tags 时详情页仍能增删规则（入口归一化）', async () => {
  // 老响应形状：story_plot_strip=true 但整个 strip_tags 字段缺失
  const legacyResponse = { id: PRESET.id, name: PRESET.name, description: '', story_plot_strip: true };
  let patchBody = null;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'GET') return jsonResponse(legacyResponse);
    if (requestUrl === `/api/prompt-presets/${PRESET.id}/entries` && method === 'GET') {
      return jsonResponse({ entries: [ENTRY] });
    }
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'PATCH') {
      patchBody = JSON.parse(init.body);
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));

  const input = await view.findByPlaceholderText('preset.stripTagPlaceholder');
  fireEvent.change(input, { target: { value: 'content' } });
  fireEvent.click(view.getByRole('button', { name: 'preset.stripTagAdd' }));

  // 归一化前这里会 TypeError: Cannot read properties of undefined (reading 'includes')
  await waitFor(() => assert.deepEqual(patchBody, { strip_tags: ['content'] }));
  await waitFor(() => assert.equal(input.value, ''));
});
