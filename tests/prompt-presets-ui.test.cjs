const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');
const { cleanupReactDomTestEnvironment } = require('./helpers/react-dom-teardown.cjs');

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

function loadUiModule(relativePath, { unwrapParams = false, translations = {} } = {}) {
  const toastCalls = [];
  const translate = key => translations[key] ?? key;
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

const REPORT_TRANSLATIONS = {
  'preset.importReport': 'Import report',
  'preset.importReportName': 'Imported "{name}"',
  'preset.importSuccess': 'Imported: {total} entries, {enabled} enabled',
  'preset.entryCount': '{total} entries, {enabled} enabled',
  'preset.compatibilityReport': 'Preset compatibility',
  'preset.importWarnings': 'Import compatibility notes',
  'preset.importWarningsHint': 'These notes describe the import, not a new analysis of edited entries.',
  'preset.noEnabledEntries': 'No entries are enabled. These entries will not participate in chat.',
};

function selectImportFile(view, name = 'Standard.json') {
  const input = view.container.querySelector('input[type="file"]');
  assert.ok(input, 'import input exists');
  fireEvent.change(input, {
    target: { files: [{ name, text: async () => JSON.stringify({ prompts: [] }) }] },
  });
  return input;
}

test.afterEach(() => {
  cleanup();
  delete global.fetch;
  window.confirm = () => true;
});

test.after(async () => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
  delete require.extensions['.ts'];
  delete require.extensions['.tsx'];
  window.scrollTo = originalScrollTo;
  await cleanupReactDomTestEnvironment(restoreDom);
});

test('预设列表把非 2xx 加载失败显示在页面上，而不是伪装成空列表', async () => {
  global.fetch = async url => {
    if (String(url) === '/api/prompt-presets') return jsonResponse({ error: 'boom' }, 503);
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

test('预设列表慢加载先显示可访问占位，成功空列表才显示空态', async () => {
  const request = deferred();
  global.fetch = () => request.promise;
  const { Component } = loadUiModule('src/app/settings/prompt-presets/page.tsx');
  const view = render(React.createElement(Component));
  assert.ok(view.getByRole('status', { name: 'preset.loading' }));
  assert.equal(view.queryByText('preset.empty'), null);
  await act(async () => { request.resolve(jsonResponse({ presets: [] })); });
  await view.findByText('preset.empty');
  assert.equal(view.queryByRole('status'), null);
});

test('预设详情慢加载不提前显示不存在或空条目', async () => {
  const request = deferred();
  global.fetch = () => request.promise.then(response => response.clone());
  const { Component } = loadUiModule('src/app/settings/prompt-presets/[id]/page.tsx', { unwrapParams: true });
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  assert.ok(view.getByRole('status', { name: 'preset.loading' }));
  assert.equal(view.queryByText('preset.notFound'), null);
  assert.equal(view.queryByText('preset.noEntries'), null);
  await act(async () => { request.resolve(jsonResponse({ ...PRESET, entries: [] })); });
  await view.findByRole('heading', { name: PRESET.name });
  assert.equal(view.queryByRole('status'), null);
  assert.equal(view.getAllByText('preset.noEntries').length, 2);
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
  let presetReads = 0;
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
    await oldPresets.promise;
  });

  assert.ok(!view.queryByText('Old preset'));
  assert.ok(view.getByText('New preset'));
});

test('预设列表在删除期间阻止重复删除', async () => {
  const deleteRequest = deferred();
  let deleteCalls = 0;
  window.confirm = () => true;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === '/api/prompt-presets' && method === 'GET') {
      return jsonResponse({
        presets: [{ ...PRESET, entry_count: 1, enabled_count: 1, is_built_in: false }],
      });
    }
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'DELETE') {
      deleteCalls += 1;
      return deleteRequest.promise;
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component } = loadUiModule('src/app/settings/prompt-presets/page.tsx');
  const view = render(React.createElement(Component));
  const deleteButton = await view.findByTitle('preset.delete');
  fireEvent.click(deleteButton);
  fireEvent.click(deleteButton);

  assert.equal(deleteCalls, 1);
  assert.equal(deleteButton.disabled, true);

  await act(async () => {
    deleteRequest.resolve(jsonResponse({ ok: true }));
    await deleteRequest.promise;
  });
  await waitFor(() => assert.equal(deleteButton.disabled, false));
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
    'preset.stripTagsUpdateError: write failed',
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

test('剥离规则保存失败优先展示字段原因，并保留输入与原规则', async () => {
  const originalTags = ['content'];
  let patchBody = null;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && !init.method) {
      return jsonResponse({ ...PRESET, story_plot_strip: true, strip_tags: originalTags });
    }
    if (requestUrl.endsWith('/entries') && !init.method) return jsonResponse({ entries: [] });
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && init.method === 'PATCH') {
      patchBody = JSON.parse(init.body);
      return jsonResponse({
        error: 'Invalid request body',
        fieldErrors: { strip_tags: ['Invalid tag name', 'Conflicting strip rule'] },
      }, 400);
    }
    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  const { Component, toastCalls } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  const input = await view.findByPlaceholderText('preset.stripTagPlaceholder');
  const addButton = view.getByRole('button', { name: 'preset.stripTagAdd' });
  fireEvent.change(input, { target: { value: '#bad tag' } });
  fireEvent.click(addButton);

  await waitFor(() => assert.deepEqual(toastCalls.at(-1), [
    'preset.stripTagsUpdateError: Invalid tag name; Conflicting strip rule',
    'error',
  ]));
  assert.deepEqual(patchBody, { strip_tags: ['content', '#bad tag'] });
  assert.equal(input.value, '#bad tag');
  assert.ok(view.getByText('content'), '失败后应保留已保存的规则');
  assert.equal(view.queryByText('#bad tag'), null, '失败规则不应显示为已保存');
  assert.equal(addButton.disabled, false);
});

test('剥离规则保存返回非 JSON 时回退 HTTP 状态并保留重试输入', async () => {
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && !init.method) {
      return jsonResponse({ ...PRESET, story_plot_strip: true, strip_tags: [] });
    }
    if (requestUrl.endsWith('/entries') && !init.method) return jsonResponse({ entries: [] });
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && init.method === 'PATCH') {
      return new Response('<html>Bad gateway</html>', { status: 502 });
    }
    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  const { Component, toastCalls } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  const input = await view.findByPlaceholderText('preset.stripTagPlaceholder');
  fireEvent.change(input, { target: { value: '#draft_notes~' } });
  fireEvent.click(view.getByRole('button', { name: 'preset.stripTagAdd' }));

  await waitFor(() => assert.deepEqual(toastCalls.at(-1), [
    'preset.stripTagsUpdateError: HTTP 502',
    'error',
  ]));
  assert.equal(input.value, '#draft_notes~');
  assert.equal(view.queryByText('#draft_notes~'), null);
});

test('剥离规则输入保留波浪号，并通过真实更新 schema 后才显示保存成功', async () => {
  const { promptPresetUpdateSchema, formatZodFieldErrors } = require('../src/lib/schemas.ts');
  let patchBody = null;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && !init.method) {
      return jsonResponse({ ...PRESET, story_plot_strip: true, strip_tags: [] });
    }
    if (requestUrl.endsWith('/entries') && !init.method) return jsonResponse({ entries: [] });
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && init.method === 'PATCH') {
      patchBody = JSON.parse(init.body);
      const parsed = promptPresetUpdateSchema.safeParse(patchBody);
      return parsed.success
        ? jsonResponse({ ...PRESET, ...parsed.data })
        : jsonResponse({ error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) }, 400);
    }
    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  const { Component, toastCalls } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  const input = await view.findByPlaceholderText('preset.stripTagPlaceholder');
  fireEvent.change(input, { target: { value: '  #draft_notes~  ' } });
  fireEvent.click(view.getByRole('button', { name: 'preset.stripTagAdd' }));

  await waitFor(() => assert.deepEqual(toastCalls.at(-1), [
    'preset.stripTagsUpdateSuccess',
    'success',
  ]));
  assert.deepEqual(patchBody, { strip_tags: ['#draft_notes~'] });
  assert.equal(input.value, '');
  assert.ok(view.getByText('#draft_notes~'));
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

  fireEvent.click(view.getByRole('button', { name: `preset.edit: ${ENTRY.name}` }));
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

test('预设详情条目使用移动端友好的可访问图标操作', async () => {
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'GET') {
      return jsonResponse(PRESET);
    }
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
  const entryName = await view.findByText(ENTRY.name);
  const row = entryName.closest('li');

  assert.match(row.className, /\bflex-col\b/);
  assert.match(row.className, /\bsm:flex-row\b/);
  assert.match(entryName.className, /\bline-clamp-2\b/);
  assert.match(entryName.className, /\bbasis-full\b/);

  const labels = [
    `preset.enabled: ${ENTRY.name}`,
    `preset.edit: ${ENTRY.name}`,
    `preset.delete: ${ENTRY.name}`,
  ];
  const buttons = labels.map(label => view.getByRole('button', { name: label }));

  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');
  assert.match(buttons[0].parentElement.className, /\bself-end\b/);
  for (const [index, button] of buttons.entries()) {
    assert.equal(button.type, 'button');
    assert.equal(button.title, labels[index]);
    assert.equal(button.textContent, '');
    assert.ok(button.querySelector('[aria-hidden="true"]'));
    assert.match(button.className, /\bh-11\b/);
    assert.match(button.className, /\bw-11\b/);
    assert.match(button.className, /\bmin-h-11\b/);
    assert.match(button.className, /\bmin-w-11\b/);
    assert.match(button.className, /\bfocus-visible:ring-2\b/);
    assert.match(button.className, /\bdisabled:opacity-40\b/);
  }
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
  const toggleButton = await view.findByRole('button', { name: `preset.enabled: ${ENTRY.name}` });
  const rowBeforeToggle = view.getByText(ENTRY.name).closest('li');

  fireEvent.click(toggleButton);

  await waitFor(() => assert.equal(toggleCalls, 1));
  assert.equal(view.getByText(ENTRY.name).closest('li'), rowBeforeToggle);
  assert.equal(rowBeforeToggle.isConnected, true);

  await act(async () => {
    toggleRequest.resolve(jsonResponse({ ok: true }));
    await toggleRequest.promise;
  });

  const disabledButton = await view.findByRole('button', { name: `preset.disabled: ${ENTRY.name}` });
  assert.equal(view.getByText(ENTRY.name).closest('li'), rowBeforeToggle);
  assert.equal(rowBeforeToggle.isConnected, true);
  assert.equal(disabledButton.disabled, false);
  assert.equal(disabledButton.getAttribute('aria-pressed'), 'false');
});

test('角色预设选择器保持 none / explicit 两态并在卸载时 abort', async () => {
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
  assert.equal(select.value, '__none__');

  fireEvent.change(select, { target: { value: 'preset-b' } });
  fireEvent.change(select, { target: { value: '__none__' } });
  assert.deepEqual(changes, ['preset-b', '__none__']);

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

test('预设详情页头在窄屏纵向堆叠，避免导出按钮挤扁剥离规则', async () => {
  const kedaiPreset = {
    ...PRESET,
    story_plot_strip: true,
    strip_tags: ['content', 'scene', '#think', '#thinking', '#output-template'],
  };
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const method = init.method || 'GET';
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && method === 'GET') return jsonResponse(kedaiPreset);
    if (requestUrl === `/api/prompt-presets/${PRESET.id}/entries` && method === 'GET') {
      return jsonResponse({ entries: [] });
    }
    throw new Error(`unexpected fetch: ${method} ${requestUrl}`);
  };

  const { Component } = loadUiModule(
    'src/app/settings/prompt-presets/[id]/page.tsx',
    { unwrapParams: true },
  );
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  const heading = await view.findByRole('heading', { name: PRESET.name });
  const header = heading.closest('header');
  assert.ok(header);
  assert.match(header.className, /\bmin-w-0\b/);

  const headerStack = header.firstElementChild;
  assert.match(headerStack.className, /\bflex-col\b/);
  assert.match(headerStack.className, /\bmin-w-0\b/);

  const titleRow = heading.parentElement.parentElement;
  assert.match(titleRow.className, /\bflex-col\b/);
  assert.match(titleRow.className, /\bsm:flex-row\b/);
  assert.equal(heading.parentElement.className.includes('flex-1'), true);

  const backLink = view.getByRole('link', { name: /preset.backList/ });
  const exportLumi = view.getByRole('link', { name: 'preset.exportLumiMuse' });
  const exportSt = view.getByRole('link', { name: 'preset.exportSt' });
  assert.equal(backLink.parentElement, exportLumi.parentElement);
  assert.equal(backLink.parentElement, exportSt.parentElement);
  assert.match(backLink.parentElement.className, /\bflex-wrap\b/);
  assert.match(backLink.parentElement.className, /\bmin-w-0\b/);
  assert.notEqual(
    backLink.parentElement,
    heading.parentElement,
    '导出按钮不得与标题/剥离规则挤在同一个未换行 flex 子项里',
  );

  const hint = view.getByText('preset.stripTagsHint');
  assert.match(hint.className, /\bbreak-words\b/);
  assert.match(hint.className, /\bmin-w-0\b/);
  assert.equal(hint.closest('header'), header);

  const labelText = view.getByText('preset.storyPlotStripLabel');
  assert.equal(labelText.tagName, 'SPAN');
  assert.match(labelText.className, /\bbreak-words\b/);

  const addInput = view.getByPlaceholderText('preset.stripTagPlaceholder');
  assert.match(addInput.className, /\bflex-1\b/);
  assert.match(addInput.className, /\bmin-w-0\b/);
  assert.ok(!/\bw-48\b/.test(addInput.className), '固定 w-48 会在窄屏溢出或把相邻按钮挤出视口');

  const longTag = view.getByText('#output-template');
  assert.match(longTag.className, /\bbreak-all\b/);
  assert.match(longTag.closest('span').className, /\bmax-w-full\b/);

  const addEntry = view.getByRole('button', { name: 'preset.addEntry' });
  const relativeHeading = view.getByRole('heading', { name: 'preset.relativeEntries' });
  assert.match(relativeHeading.className, /\bmin-w-0\b/);
  assert.match(relativeHeading.className, /\bflex-1\b/);
  assert.match(addEntry.className, /\bshrink-0\b/);
  assert.equal(addEntry.parentElement, relativeHeading.parentElement);
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

test('导入报告持续显示0启用及兼容警告，刷新列表失败也不会只留下成功toast', async () => {
  let reads = 0;
  global.fetch = async (url, init = {}) => {
    if (String(url) === '/api/prompt-presets/import') {
      return jsonResponse({
        preset_id: 'imported-zero',
        preset_name: 'Zero preset',
        total: 3,
        enabled: 0,
        markers_recognized: 0,
        markers_disabled: 3,
        warnings: ['No worldbook data is available.', 'Plugin scripts are not executed.'],
      }, 201);
    }
    if (String(url) === '/api/prompt-presets' && !init.method) {
      reads += 1;
      return reads === 1 ? jsonResponse({ presets: [] }) : jsonResponse({ error: 'offline' }, 503);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { Component, toastCalls } = loadUiModule('src/app/settings/prompt-presets/page.tsx', {
    translations: REPORT_TRANSLATIONS,
  });
  const view = render(React.createElement(Component));
  await view.findByText('preset.empty');
  const input = selectImportFile(view);

  await view.findByRole('heading', { name: 'Import report' });
  assert.ok(view.getByRole('status', { name: 'Import report' }));
  await view.findByText('preset.loadError: /api/prompt-presets: HTTP 503');
  assert.ok(view.getByText('Imported "Zero preset"'));
  assert.ok(view.getByText('3 entries, 0 enabled'));
  assert.ok(view.getByText(REPORT_TRANSLATIONS['preset.noEnabledEntries']));
  assert.ok(view.getByText('No worldbook data is available.'));
  assert.ok(view.getByText('Plugin scripts are not executed.'));
  assert.equal(view.getByRole('link', { name: 'preset.manage' }).getAttribute('href'), '/settings/prompt-presets/imported-zero');
  assert.ok(toastCalls.some(([message, type]) => message === 'Imported: 3 entries, 0 enabled' && type === 'info'));
  assert.ok(!toastCalls.some(([, type]) => type === 'success'));
  await waitFor(() => assert.equal(input.disabled, false));
});

test('有启用条目但有兼容警告时使用info提示，下一次无警告导入替换旧报告', async () => {
  let imports = 0;
  global.fetch = async url => {
    if (String(url) === '/api/prompt-presets/import') {
      imports += 1;
      return jsonResponse({
        preset_id: `imported-${imports}`,
        preset_name: imports === 1 ? 'Warning preset' : 'Clean preset',
        total: 2,
        enabled: 2,
        markers_recognized: 0,
        markers_disabled: 0,
        ...(imports === 1 ? { warnings: ['Unsupported macro remains as text.'] } : {}),
      }, 201);
    }
    if (String(url) === '/api/prompt-presets') return jsonResponse({ presets: [] });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { Component, toastCalls } = loadUiModule('src/app/settings/prompt-presets/page.tsx', {
    translations: REPORT_TRANSLATIONS,
  });
  const view = render(React.createElement(Component));
  await view.findByText('preset.empty');
  const input = selectImportFile(view);

  await view.findByText('Unsupported macro remains as text.');
  await waitFor(() => assert.equal(input.disabled, false));
  assert.ok(toastCalls.some(([message, type]) => message === 'Imported: 2 entries, 2 enabled' && type === 'info'));

  selectImportFile(view, 'Clean.json');
  await view.findByText('Imported "Clean preset"');
  await waitFor(() => assert.equal(input.disabled, false));
  assert.ok(!view.queryByText('Unsupported macro remains as text.'));
  assert.ok(!view.queryByText('Imported "Warning preset"'));
  assert.ok(!view.queryByText(REPORT_TRANSLATIONS['preset.noEnabledEntries']));
  assert.ok(toastCalls.some(([message, type]) => message === 'Imported: 2 entries, 2 enabled' && type === 'success'));
});

test('导入期间同步guard阻止重复POST，报告保留服务端实际启用数', async () => {
  const importing = deferred();
  let imports = 0;
  global.fetch = async url => {
    if (String(url) === '/api/prompt-presets/import') {
      imports += 1;
      return importing.promise;
    }
    if (String(url) === '/api/prompt-presets') return jsonResponse({ presets: [] });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { Component } = loadUiModule('src/app/settings/prompt-presets/page.tsx', {
    translations: REPORT_TRANSLATIONS,
  });
  const view = render(React.createElement(Component));
  await view.findByText('preset.empty');
  const input = selectImportFile(view);
  selectImportFile(view);
  await waitFor(() => assert.equal(imports, 1));
  assert.equal(input.disabled, true);
  await act(async () => {
    importing.resolve(jsonResponse({ preset_id: 'guarded', preset_name: 'Guarded preset', total: 7, enabled: 4 }, 201));
    await importing.promise;
  });
  await view.findByText('7 entries, 4 enabled');
  await waitFor(() => assert.equal(input.disabled, false));
});

test('详情直接加载及重新挂载仍显示导入警告，脚本样式内容只作为文字', async () => {
  const scriptText = '<script>window.__presetExecuted = true</script><img src=x onerror="alert(1)">';
  global.fetch = async url => {
    if (String(url).endsWith('/entries')) return jsonResponse({ entries: [ENTRY] });
    return jsonResponse({ ...PRESET, import_warnings: [scriptText, 'story_content tools are not supported.'] });
  };
  const { Component } = loadUiModule('src/app/settings/prompt-presets/[id]/page.tsx', {
    unwrapParams: true,
    translations: REPORT_TRANSLATIONS,
  });
  const props = { params: { value: { id: PRESET.id } } };
  const firstView = render(React.createElement(Component, props));
  await firstView.findByText(scriptText);
  assert.ok(firstView.getByText('story_content tools are not supported.'));
  assert.ok(firstView.getByText(REPORT_TRANSLATIONS['preset.importWarningsHint']));
  assert.ok(!firstView.container.querySelector('script, img'));
  assert.equal(window.__presetExecuted, undefined);
  firstView.unmount();

  const reloadedView = render(React.createElement(Component, props));
  await reloadedView.findByText(scriptText);
  assert.ok(reloadedView.getByRole('heading', { name: 'Preset compatibility' }));
  assert.ok(!reloadedView.container.querySelector('script, img'));
});

test('详情0启用提示随切换更新，但不重写导入兼容快照或其他条目', async () => {
  const dormantEntry = { ...ENTRY, id: 'dormant', name: 'Dormant entry', enabled: false, sort_order: 20 };
  const patches = [];
  global.fetch = async (url, init = {}) => {
    if (init.method === 'PATCH') {
      patches.push({ url: String(url), body: JSON.parse(init.body) });
      return jsonResponse({ ok: true });
    }
    if (String(url).endsWith('/entries')) return jsonResponse({ entries: [ENTRY, dormantEntry] });
    return jsonResponse({ ...PRESET, import_warnings: ['Import snapshot warning.'] });
  };
  const { Component } = loadUiModule('src/app/settings/prompt-presets/[id]/page.tsx', {
    unwrapParams: true,
    translations: REPORT_TRANSLATIONS,
  });
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  const toggle = await view.findByRole('button', { name: 'preset.enabled: Entry A' });
  assert.ok(!view.queryByText(REPORT_TRANSLATIONS['preset.noEnabledEntries']));
  fireEvent.click(toggle);
  await view.findByText(REPORT_TRANSLATIONS['preset.noEnabledEntries']);
  assert.ok(view.getByText('2 entries, 0 enabled'));
  assert.ok(view.getByText('Import snapshot warning.'));
  fireEvent.click(view.getByRole('button', { name: 'preset.disabled: Entry A' }));
  await waitFor(() => assert.ok(!view.queryByText(REPORT_TRANSLATIONS['preset.noEnabledEntries']), '0-enabled notice is removed'));
  assert.ok(view.getByText('2 entries, 1 enabled'));
  assert.deepEqual(patches, [
    { url: `/api/prompt-presets/${PRESET.id}/entries/${ENTRY.id}`, body: { enabled: false } },
    { url: `/api/prompt-presets/${PRESET.id}/entries/${ENTRY.id}`, body: { enabled: true } },
  ]);
  assert.equal(view.getByRole('button', { name: 'preset.disabled: Dormant entry' }).getAttribute('aria-pressed'), 'false');
});

test('详情忽略旧响应中的采样参数，不显示参数覆盖面板或文案', async () => {
  global.fetch = async url => {
    if (String(url).endsWith('/entries')) return jsonResponse({ entries: [ENTRY] });
    return jsonResponse({
      ...PRESET,
      import_warnings: ['Legacy preset compatibility note.'],
      sampling_params: { temperature: 0, top_p: 0.8, max_tokens: 2048, streaming: false, seed: null },
    });
  };
  const { Component } = loadUiModule('src/app/settings/prompt-presets/[id]/page.tsx', {
    unwrapParams: true,
    translations: REPORT_TRANSLATIONS,
  });
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  await view.findByText('Legacy preset compatibility note.');
  assert.ok(view.getByRole('heading', { name: 'Preset compatibility' }));
  assert.ok(view.getByText('1 entries, 1 enabled'));
  assert.ok(!view.container.querySelector('dl'), 'legacy sampling parameters have no display panel');
  assert.doesNotMatch(view.container.textContent, /temperature|max_tokens|Chat parameters for this preset|Only overrides|preset\.samplingParams/);
});

test('导入报告忽略旧响应中的采样参数，保留兼容说明和管理链接', async () => {
  global.fetch = async url => {
    if (String(url) === '/api/prompt-presets/import') {
      return jsonResponse({
        preset_id: 'legacy-sampling',
        preset_name: 'Legacy preset',
        total: 2,
        enabled: 1,
        warnings: ['Legacy import compatibility note.'],
        sampling_params: { temperature: 0, max_tokens: 2048, streaming: false },
      }, 201);
    }
    if (String(url) === '/api/prompt-presets') return jsonResponse({ presets: [] });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { Component, toastCalls } = loadUiModule('src/app/settings/prompt-presets/page.tsx', {
    translations: REPORT_TRANSLATIONS,
  });
  const view = render(React.createElement(Component));
  await view.findByText('preset.empty');
  selectImportFile(view);

  await view.findByText('Legacy import compatibility note.');
  assert.ok(view.getByText('Imported "Legacy preset"'));
  assert.ok(view.getByText('2 entries, 1 enabled'));
  assert.equal(view.getByRole('link', { name: 'preset.manage' }).getAttribute('href'), '/settings/prompt-presets/legacy-sampling');
  assert.ok(toastCalls.some(([message, type]) => message === 'Imported: 2 entries, 1 enabled' && type === 'info'));
  assert.ok(!view.container.querySelector('dl'), 'legacy import sampling parameters have no display panel');
  assert.doesNotMatch(view.container.textContent, /temperature|max_tokens|Chat parameters for this preset|Only overrides|preset\.samplingParams/);
});

const WARNING_TRANSLATIONS = {
  ...REPORT_TRANSLATIONS,
  'preset.warning.unsupported_macro': 'Entry {entry} contains the unsupported macro or syntax {{{macro}}}.',
  'preset.warning.unsupported_fields': 'These preset fields are not applied: {fields}.',
  'preset.warning.unknown': 'Other compatibility note: {code} {details}',
};

test('code 型兼容说明按当前语言渲染，未知 code 兜底显示，旧字符串原样保留', async () => {
  global.fetch = async url => {
    if (String(url) === '/api/prompt-presets/import') {
      return jsonResponse({
        preset_id: 'coded', preset_name: 'Coded preset', total: 1, enabled: 1,
        warnings: [
          { code: 'unsupported_macro', params: { entry: 'Main', macro: 'random' } },
          { code: 'unsupported_fields', params: { fields: 'wi_format, impersonation_prompt' } },
          { code: 'future_code', params: { key: 'value' } },
          'Legacy plain note.',
        ],
      }, 201);
    }
    if (String(url) === '/api/prompt-presets') return jsonResponse({ presets: [] });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { Component } = loadUiModule('src/app/settings/prompt-presets/page.tsx', { translations: WARNING_TRANSLATIONS });
  const view = render(React.createElement(Component));
  await view.findByText('preset.empty');
  selectImportFile(view);

  await view.findByText('Entry Main contains the unsupported macro or syntax {{random}}.');
  assert.ok(view.getByText('These preset fields are not applied: wi_format, impersonation_prompt.'));
  assert.ok(view.getByText('Other compatibility note: future_code key=value'));
  assert.ok(view.getByText('Legacy plain note.'));
  assert.doesNotMatch(view.container.textContent, /preset\.warning\./);
});

test('删除刚导入的预设会清掉报告，避免管理链接指向不存在的页面', async () => {
  let deleted = false;
  window.confirm = () => true;
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    if (requestUrl === '/api/prompt-presets/import') {
      return jsonResponse({ preset_id: PRESET.id, preset_name: PRESET.name, total: 1, enabled: 1 }, 201);
    }
    if (requestUrl === `/api/prompt-presets/${PRESET.id}` && init.method === 'DELETE') {
      deleted = true;
      return jsonResponse({ ok: true });
    }
    if (requestUrl === '/api/prompt-presets') {
      return jsonResponse({ presets: deleted ? [] : [{ ...PRESET, entry_count: 1, enabled_count: 1, is_built_in: false }] });
    }
    throw new Error(`unexpected fetch: ${init.method || 'GET'} ${requestUrl}`);
  };
  const { Component } = loadUiModule('src/app/settings/prompt-presets/page.tsx', { translations: REPORT_TRANSLATIONS });
  const view = render(React.createElement(Component));
  const input = selectImportFile(view);
  await view.findByRole('heading', { name: 'Import report' });
  await waitFor(() => assert.equal(input.disabled, false));

  fireEvent.click(await view.findByTitle('preset.delete'));
  await view.findByText('preset.empty');
  assert.equal(view.queryByRole('heading', { name: 'Import report' }), null);
  assert.equal(view.queryByRole('link', { name: 'preset.manage' }), null);
});

test('重新导入失败时不保留上一次的导入报告', async () => {
  let imports = 0;
  global.fetch = async url => {
    if (String(url) === '/api/prompt-presets/import') {
      imports += 1;
      return imports === 1
        ? jsonResponse({ preset_id: 'first', preset_name: 'First preset', total: 1, enabled: 1 }, 201)
        : jsonResponse({ error: 'broken file' }, 400);
    }
    if (String(url) === '/api/prompt-presets') return jsonResponse({ presets: [] });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { Component, toastCalls } = loadUiModule('src/app/settings/prompt-presets/page.tsx', { translations: REPORT_TRANSLATIONS });
  const view = render(React.createElement(Component));
  await view.findByText('preset.empty');
  const input = selectImportFile(view);
  await view.findByText('Imported "First preset"');
  await waitFor(() => assert.equal(input.disabled, false));

  selectImportFile(view, 'Broken.json');
  await waitFor(() => assert.ok(toastCalls.some(([message, type]) => message === 'preset.importError: broken file' && type === 'error')));
  await waitFor(() => assert.equal(input.disabled, false));
  assert.equal(view.queryByText('Imported "First preset"'), null);
  assert.equal(view.queryByRole('heading', { name: 'Import report' }), null);
});

test('新建的空预设详情不显示兼容报告', async () => {
  global.fetch = async url => {
    if (String(url).endsWith('/entries')) return jsonResponse({ entries: [] });
    return jsonResponse({ ...PRESET, import_warnings: [] });
  };
  const { Component } = loadUiModule('src/app/settings/prompt-presets/[id]/page.tsx', {
    unwrapParams: true,
    translations: REPORT_TRANSLATIONS,
  });
  const view = render(React.createElement(Component, { params: { value: { id: PRESET.id } } }));
  await view.findByRole('heading', { name: PRESET.name });
  assert.equal(view.queryByRole('heading', { name: 'Preset compatibility' }), null);
  assert.equal(view.queryByText(REPORT_TRANSLATIONS['preset.noEnabledEntries']), null);
});
