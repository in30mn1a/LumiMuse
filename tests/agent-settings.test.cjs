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
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const originalFetch = global.fetch;

// Toast 自带不随卸载清理的定时器，测试里改成同步记录
const toasts = [];
const mocks = {
  '@/components/ui/Toast': { useToast: () => ({ showToast: (message, type) => { toasts.push({ message, type }); } }) },
  '@/lib/i18n-context': { useTranslation: () => ({ t: key => key }) },
};

Module._resolveFilename = function resolveFilename(request, parent, ...args) {
  if (request.startsWith('@/')) {
    const base = path.join(root, 'src', request.slice(2));
    for (const file of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return originalResolve.call(this, request, parent, ...args);
};
Module._load = function load(request, ...args) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, ...args);
};
function loadTs(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText, filename);
}
require.extensions['.ts'] = loadTs;
require.extensions['.tsx'] = loadTs;

const AgentSettingsDrawer = require('../src/components/agent/AgentSettingsDrawer.tsx').default;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 按路由语义模拟服务端：文档保存追加版本、恢复也算一次新保存，内容没变不写。 */
function createServer({ versionCount = 3 } = {}) {
  const state = {
    settings: { model: 'main-chat-model', agent_provider_id: '', agent_model: '', agent_reasoning_effort: 'default' },
    docs: { agents: null, memory: null },
    versions: [],
    nextId: 1,
    calls: [],
  };
  const save = (key, content, source) => {
    const doc = state.docs[key];
    if (doc && doc.content === content) return doc;
    const now = new Date(Date.UTC(2026, 10, 1, 8, state.nextId)).toISOString();
    state.docs[key] = { key, content, updated_at: now };
    state.versions.push({ id: state.nextId++, key, content, source, created_at: now });
    return state.docs[key];
  };
  for (let i = 1; i <= versionCount; i += 1) save('memory', `第 ${i} 版笔记：主人喜欢先看结论。`, 'agent');
  save('agents', '叫我队长。', 'user');

  global.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ url: String(url), method, body });
    const u = new URL(String(url), 'http://localhost');
    if (u.pathname === '/api/settings' && method === 'GET') return json({ ...state.settings, api_key: 'MASKED' });
    if (u.pathname === '/api/settings' && method === 'PUT') {
      Object.assign(state.settings, body);
      return json({ ok: true });
    }
    if (u.pathname === '/api/providers') {
      return json({ providers: [{ id: 'p-alt', name: '备用接口', model: 'alt-default' }], active_provider_id: '' });
    }
    if (u.pathname === '/api/models') {
      return json({ models: body.provider_id === 'p-alt' ? ['alt-large', 'alt-small'] : ['main-chat-model'], error: null });
    }
    const match = u.pathname.match(/^\/api\/agent\/documents\/(agents|memory)$/);
    if (match) {
      const key = match[1];
      if (method === 'PUT') {
        if ('restore_version_id' in body) {
          const version = state.versions.find(item => item.id === body.restore_version_id && item.key === key);
          if (!version) return json({ error: 'Version not found' }, 404);
          return json({ document: save(key, version.content, 'user') });
        }
        return json({ document: save(key, body.content, 'user') });
      }
      const offset = Number(u.searchParams.get('versions_offset') || 0);
      const all = state.versions.filter(item => item.key === key).sort((a, b) => b.id - a.id);
      const pageSize = 2;
      return json({
        document: state.docs[key] ?? { key, content: '', updated_at: null },
        versions: all.slice(offset, offset + pageSize),
        has_more: all.length > offset + pageSize,
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return state;
}

function renderDrawer(props = {}) {
  const onModelSaved = props.onModelSaved ?? (() => {});
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return React.createElement(React.Fragment, null,
      React.createElement('button', { type: 'button', onClick: () => setOpen(true) }, 'reopen'),
      React.createElement(AgentSettingsDrawer, { open, onClose: () => setOpen(false), onModelSaved }));
  }
  return render(React.createElement(Harness));
}

test.afterEach(async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  cleanup();
  global.fetch = originalFetch;
  toasts.length = 0;
});
test.after(() => {
  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('model tab saves provider, model and effort as agent settings', async () => {
  const server = createServer();
  let saved = 0;
  const view = renderDrawer({ onModelSaved: () => { saved += 1; } });

  const provider = await view.findByLabelText('agent.settings.provider');
  const saveButton = view.getByRole('button', { name: 'common.save' });
  assert.equal(saveButton.disabled, true, 'nothing to save before a change');
  assert.ok(within(provider).getByRole('option', { name: '备用接口 (alt-default)' }));

  fireEvent.change(provider, { target: { value: 'p-alt' } });
  await waitFor(() => assert.ok(view.getByRole('option', { name: 'alt-large' })));
  assert.deepEqual(server.calls.filter(call => call.url === '/api/models').at(-1).body, { refresh: false, provider_id: 'p-alt' });

  fireEvent.change(view.getByLabelText('agent.settings.model'), { target: { value: 'alt-large' } });
  fireEvent.change(view.getByLabelText('input.reasoningEffort'), { target: { value: 'high' } });
  fireEvent.click(saveButton);

  await waitFor(() => assert.equal(saved, 1));
  const put = server.calls.find(call => call.url === '/api/settings' && call.method === 'PUT');
  // 服务端没有存过窗口时按默认 272000 读出并原样带上
  assert.deepEqual(put.body, {
    agent_provider_id: 'p-alt', agent_model: 'alt-large', agent_reasoning_effort: 'high', agent_context_window: 272000,
  });
  assert.deepEqual(toasts, [{ message: 'agent.settings.saved', type: 'success' }]);
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, true));
});

test('model tab edits the agent context window and refuses values that are not positive integers', async () => {
  const server = createServer();
  server.settings.agent_context_window = 400000;
  server.settings.context_window = 32000;
  let saved = 0;
  const view = renderDrawer({ onModelSaved: () => { saved += 1; } });

  const input = await view.findByLabelText('agent.settings.contextWindow');
  assert.equal(input.value, '400000');
  const saveButton = () => view.getByRole('button', { name: 'common.save' });
  for (const bad of ['0', '', '1.5', '-3', '100000001']) {
    fireEvent.change(input, { target: { value: bad } });
    assert.equal(saveButton().disabled, true, `"${bad}" must not be saveable`);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
  }
  fireEvent.change(input, { target: { value: '128000' } });
  assert.equal(input.getAttribute('aria-invalid'), 'false');
  fireEvent.click(saveButton());

  await waitFor(() => assert.equal(saved, 1));
  const put = server.calls.find(call => call.url === '/api/settings' && call.method === 'PUT');
  assert.equal(put.body.agent_context_window, 128000);
  assert.equal('context_window' in put.body, false, 'the global window is left alone');
  await waitFor(() => assert.equal(saveButton().disabled, true));
});

test('Agents.md drafts survive tab switches and closing, and saving writes a new version', async () => {
  const server = createServer();
  const view = renderDrawer();
  fireEvent.click(await view.findByRole('tab', { name: 'Agents.md' }));
  const editor = await view.findByRole('textbox', { name: 'Agents.md' });
  assert.equal(editor.value, '叫我队长。');

  fireEvent.change(editor, { target: { value: '叫我船长。回答先给结论。' } });
  assert.ok(view.getAllByText('agent.settings.unsaved').length > 0, 'the tab marks unsaved changes');

  fireEvent.click(view.getByRole('tab', { name: 'agent.settings.tabModel' }));
  await view.findByLabelText('agent.settings.provider');
  fireEvent.click(view.getByRole('button', { name: 'common.close' }));
  await waitFor(() => assert.equal(view.queryByRole('dialog'), null));
  fireEvent.click(view.getByRole('button', { name: 'reopen' }));
  fireEvent.click(await view.findByRole('tab', { name: /Agents\.md/ }));
  const reopened = await view.findByRole('textbox', { name: 'Agents.md' });
  assert.equal(reopened.value, '叫我船长。回答先给结论。', 'the draft is still there');

  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  await waitFor(() => assert.deepEqual(toasts, [{ message: 'agent.settings.saved', type: 'success' }]));
  const put = server.calls.find(call => call.method === 'PUT' && call.url === '/api/agent/documents/agents');
  assert.deepEqual(put.body, { content: '叫我船长。回答先给结论。' });
  assert.equal(server.docs.agents.content, '叫我船长。回答先给结论。');
  await waitFor(() => assert.equal(view.container.ownerDocument.querySelectorAll('[data-agent-version]').length, 2));
  assert.equal(view.queryAllByText('agent.settings.unsaved').length, 0, 'saved drafts are cleared');
});

test('memory.md restores an older version and pages through history', async () => {
  const server = createServer({ versionCount: 3 });
  const view = renderDrawer();
  fireEvent.click(await view.findByRole('tab', { name: 'memory.md' }));
  const editor = await view.findByRole('textbox', { name: 'memory.md' });
  assert.equal(editor.value, '第 3 版笔记：主人喜欢先看结论。');

  const doc = view.container.ownerDocument;
  await waitFor(() => assert.equal(doc.querySelectorAll('[data-agent-version]').length, 2));
  fireEvent.click(view.getByRole('button', { name: 'agent.loadMore' }));
  await waitFor(() => assert.equal(doc.querySelectorAll('[data-agent-version]').length, 3));
  assert.ok(server.calls.some(call => call.url === '/api/agent/documents/memory?versions_offset=2'));

  // 有未保存修改时不能恢复
  fireEvent.change(editor, { target: { value: '临时改动' } });
  const oldest = doc.querySelector('[data-agent-version="1"]');
  oldest.open = true;
  const restoreButton = within(oldest).getByRole('button', { name: 'agent.settings.restore' });
  assert.equal(restoreButton.disabled, true);
  assert.ok(view.getByText('agent.settings.restoreBlocked'));

  fireEvent.click(view.getByRole('button', { name: 'agent.settings.discard' }));
  assert.equal(editor.value, '第 3 版笔记：主人喜欢先看结论。');
  assert.equal(restoreButton.disabled, false);
  fireEvent.click(restoreButton);

  await waitFor(() => assert.equal(view.getByRole('textbox', { name: 'memory.md' }).value, '第 1 版笔记：主人喜欢先看结论。'));
  const put = server.calls.find(call => call.method === 'PUT' && call.url === '/api/agent/documents/memory');
  assert.deepEqual(put.body, { restore_version_id: 1, expected_content: '第 3 版笔记：主人喜欢先看结论。' });
  assert.deepEqual(toasts, [{ message: 'agent.settings.restored', type: 'success' }]);
  assert.equal(server.versions.filter(item => item.key === 'memory').length, 4, 'restoring adds a version instead of rewriting history');
});

test('a failed document load can be retried', async () => {
  createServer();
  const realFetch = global.fetch;
  let failures = 1;
  global.fetch = async (url, init) => {
    if (String(url) === '/api/agent/documents/agents' && failures > 0) {
      failures -= 1;
      return json({ error: 'database is locked' }, 500);
    }
    return realFetch(url, init);
  };
  const view = renderDrawer();
  fireEvent.click(await view.findByRole('tab', { name: 'Agents.md' }));
  const alert = await view.findByRole('alert');
  assert.match(alert.textContent, /database is locked/);
  fireEvent.click(within(alert).getByRole('button', { name: 'common.retry' }));
  assert.equal((await view.findByRole('textbox', { name: 'Agents.md' })).value, '叫我队长。');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const reopen of [false, true]) {
  test(`document save preserves later edits${reopen ? ' after reopening' : ''}`, async t => {
    const server = createServer();
    const fetchMock = global.fetch;
    const gate = deferred();
    t.after(() => gate.resolve());
    let saving = false;
    global.fetch = async (url, init = {}) => {
      if (String(url) === '/api/agent/documents/agents' && init.method === 'PUT') {
        saving = true;
        await gate.promise;
      }
      return fetchMock(url, init);
    };
    const view = renderDrawer();
    fireEvent.click(await view.findByRole('tab', { name: 'Agents.md' }));
    let editor = await view.findByRole('textbox', { name: 'Agents.md' });
    fireEvent.change(editor, { target: { value: '提交版本 A' } });
    fireEvent.click(view.getByRole('button', { name: 'common.save' }));
    await waitFor(() => assert.ok(saving));
    if (reopen) {
      fireEvent.click(view.getByRole('button', { name: 'common.close' }));
      fireEvent.click(view.getByRole('button', { name: 'reopen' }));
      editor = await view.findByRole('textbox', { name: 'Agents.md' });
    }
    // 改回保存前的正文也是新编辑，不能被当成“没有草稿”。
    const nextText = reopen ? '叫我队长。' : '继续编辑版本 B';
    fireEvent.change(editor, { target: { value: nextText } });
    await act(async () => { gate.resolve(); });
    await waitFor(() => assert.ok(toasts.some(item => item.message === 'agent.settings.saved')));
    assert.equal(server.docs.agents.content, '提交版本 A');
    assert.equal(editor.value, nextText);
    assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, false);
    assert.ok(view.queryAllByText('agent.settings.unsaved').length > 0);
  });

  test(`model save preserves later selections${reopen ? ' across tabs and reopening' : ''}`, async t => {
    const server = createServer();
    const fetchMock = global.fetch;
    const gate = deferred();
    const modelsGate = deferred();
    let holdModelList = false;
    t.after(() => { gate.resolve(); modelsGate.resolve(); });
    global.fetch = async (url, init = {}) => {
      if (String(url) === '/api/settings' && init.method === 'PUT') await gate.promise;
      if (String(url) === '/api/models' && holdModelList) await modelsGate.promise;
      return fetchMock(url, init);
    };
    const view = renderDrawer();
    fireEvent.change(await view.findByLabelText('agent.settings.provider'), { target: { value: 'p-alt' } });
    await view.findByRole('option', { name: 'alt-large' });
    fireEvent.change(view.getByLabelText('agent.settings.model'), { target: { value: 'alt-large' } });
    fireEvent.click(view.getByRole('button', { name: 'common.save' }));
    if (reopen) {
      holdModelList = true;
      fireEvent.click(view.getByRole('tab', { name: 'Agents.md' }));
      fireEvent.click(view.getByRole('button', { name: 'common.close' }));
      fireEvent.click(view.getByRole('button', { name: 'reopen' }));
      fireEvent.click(view.getByRole('tab', { name: 'agent.settings.tabModel' }));
      await view.findByRole('option', { name: 'alt-large' });
      // 当前草稿也会生成选项，不能用它判断接口模型列表已加载。
      assert.equal(view.queryByRole('option', { name: 'alt-small' }), null, 'the draft option is available before the model list');
      await act(async () => { modelsGate.resolve(); });
      await view.findByRole('option', { name: 'alt-small' });
    }
    fireEvent.change(view.getByLabelText('agent.settings.model'), { target: { value: 'alt-small' } });
    assert.equal(view.getByLabelText('agent.settings.model').value, 'alt-small', 'the later selection is applied before saving finishes');
    await act(async () => { gate.resolve(); });
    await waitFor(() => assert.ok(toasts.some(item => item.message === 'agent.settings.saved')));
    assert.equal(server.settings.agent_model, 'alt-large');
    assert.equal(view.getByLabelText('agent.settings.model').value, 'alt-small');
    assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, false);
  });
}

for (const oldFails of [false, true]) {
  test(`model list ignores an old provider ${oldFails ? 'failure' : 'success'}`, async t => {
    createServer();
    const fetchMock = global.fetch;
    const old = deferred();
    const current = deferred();
    t.after(() => { old.resolve(); current.resolve(); });
    let oldStarted = false;
    let currentStarted = false;
    global.fetch = async (url, init = {}) => {
      if (String(url) === '/api/models') {
        const body = JSON.parse(init.body);
        if (!body.provider_id) {
          oldStarted = true;
          await old.promise;
          if (oldFails) return json({ error: 'old provider failed' }, 500);
        } else {
          currentStarted = true;
          await current.promise;
        }
      }
      return fetchMock(url, init);
    };
    const view = renderDrawer();
    const provider = await view.findByLabelText('agent.settings.provider');
    await waitFor(() => assert.ok(oldStarted));
    fireEvent.change(provider, { target: { value: 'p-alt' } });
    await waitFor(() => assert.ok(currentStarted));
    if (oldFails) {
      await act(async () => { old.resolve(); });
      assert.ok(!view.queryByText(/old provider failed/));
      assert.equal(view.getByRole('button', { name: 'common.loading' }).disabled, true);
    }
    await act(async () => { current.resolve(); });
    await view.findByRole('option', { name: 'alt-large' });
    await act(async () => { old.resolve(); });
    assert.equal(provider.value, 'p-alt');
    assert.deepEqual(Array.from(view.getByLabelText('agent.settings.model').options, item => item.value), ['', 'alt-large', 'alt-small']);
    assert.ok(!view.queryByText(/old provider failed/));
    assert.equal(view.getByRole('button', { name: 'settings.fetchModels' }).disabled, false);
  });
}

test('document save updates the saved baseline after reopening without further edits', async t => {
  const server = createServer();
  const fetchMock = global.fetch;
  const gate = deferred();
  t.after(() => gate.resolve());
  let saving = false;
  global.fetch = async (url, init = {}) => {
    if (String(url) === '/api/agent/documents/agents' && init.method === 'PUT') {
      saving = true;
      await gate.promise;
    }
    return fetchMock(url, init);
  };
  const view = renderDrawer();
  fireEvent.click(await view.findByRole('tab', { name: 'Agents.md' }));
  fireEvent.change(await view.findByRole('textbox', { name: 'Agents.md' }), { target: { value: '提交版本 A' } });
  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  await waitFor(() => assert.ok(saving));
  fireEvent.click(view.getByRole('button', { name: 'common.close' }));
  fireEvent.click(view.getByRole('button', { name: 'reopen' }));
  const reopened = await view.findByRole('textbox', { name: 'Agents.md' });
  assert.equal(reopened.value, '提交版本 A');

  await act(async () => { gate.resolve(); });
  await waitFor(() => assert.ok(toasts.some(item => item.message === 'agent.settings.saved')));
  assert.equal(server.docs.agents.content, '提交版本 A');
  assert.equal(reopened.value, '提交版本 A');
  assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, true);
  await waitFor(() => {
    const latest = view.container.ownerDocument.querySelector(`[data-agent-version="${server.nextId - 1}"]`);
    assert.ok(latest);
    assert.ok(within(latest).getByText('agent.settings.current'));
  });

  fireEvent.change(reopened, { target: { value: '继续编辑版本 B' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.settings.discard' }));
  assert.equal(reopened.value, '提交版本 A');
  assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, true);
});

test('a stale document load cannot overwrite a save completed after reopening', async t => {
  const server = createServer();
  const fetchMock = global.fetch;
  const putGate = deferred();
  const readGate = deferred();
  t.after(() => { putGate.resolve(); readGate.resolve(); });
  let reads = 0;
  let staleReadStarted = false;
  global.fetch = async (url, init = {}) => {
    if (String(url) === '/api/agent/documents/agents') {
      if (init.method === 'PUT') await putGate.promise;
      else if (++reads === 2) {
        const oldResponse = await fetchMock(url, init);
        staleReadStarted = true;
        await readGate.promise;
        return oldResponse;
      }
    }
    return fetchMock(url, init);
  };
  const view = renderDrawer();
  fireEvent.click(await view.findByRole('tab', { name: 'Agents.md' }));
  fireEvent.change(await view.findByRole('textbox', { name: 'Agents.md' }), { target: { value: '提交版本 A' } });
  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  fireEvent.click(view.getByRole('button', { name: 'common.close' }));
  fireEvent.click(view.getByRole('button', { name: 'reopen' }));
  await waitFor(() => assert.ok(staleReadStarted));

  await act(async () => { putGate.resolve(); });
  await waitFor(() => assert.equal(server.docs.agents.content, '提交版本 A'));
  await act(async () => { readGate.resolve(); });
  const editor = await view.findByRole('textbox', { name: 'Agents.md' });
  assert.equal(editor.value, '提交版本 A');
  assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, true);
});

test('round2: document save remains locked across tabs and reopening while preserving later edits', async t => {
  const server = createServer();
  const fetchMock = global.fetch;
  const gate = deferred();
  t.after(() => gate.resolve());
  let puts = 0;
  global.fetch = async (url, init = {}) => {
    if (String(url) === '/api/agent/documents/agents' && init.method === 'PUT' && ++puts === 1) await gate.promise;
    return fetchMock(url, init);
  };
  const view = renderDrawer();
  fireEvent.click(await view.findByRole('tab', { name: 'Agents.md' }));
  fireEvent.change(await view.findByRole('textbox', { name: 'Agents.md' }), { target: { value: '提交 A' } });
  const saveButton = view.getByRole('button', { name: 'common.save' });
  act(() => { fireEvent.click(saveButton); fireEvent.click(saveButton); });
  await waitFor(() => assert.equal(puts, 1, 'synchronous clicks share the same write lock'));
  fireEvent.click(view.getByRole('tab', { name: 'agent.settings.tabModel' }));
  fireEvent.click(view.getByRole('button', { name: 'common.close' }));
  fireEvent.click(view.getByRole('button', { name: 'reopen' }));
  fireEvent.click(view.getByRole('tab', { name: /^Agents\.md/ }));
  const editor = await view.findByRole('textbox', { name: 'Agents.md' });
  fireEvent.change(editor, { target: { value: '继续编辑 B' } });
  const pendingSave = view.getByRole('button', { name: 'common.loading' });
  assert.equal(pendingSave.disabled, true, 'reopening must preserve the pending write');
  fireEvent.click(pendingSave);
  assert.equal(puts, 1);

  await act(async () => { gate.resolve(); });
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, false));
  assert.equal(server.docs.agents.content, '提交 A');
  assert.equal(editor.value, '继续编辑 B');
  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  await waitFor(() => assert.equal(server.docs.agents.content, '继续编辑 B'));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, true));
  assert.equal(puts, 2);
});

test('round2: document restore and save share a lock across reopening', async t => {
  const server = createServer();
  const fetchMock = global.fetch;
  const gate = deferred();
  t.after(() => gate.resolve());
  let puts = 0;
  global.fetch = async (url, init = {}) => {
    if (String(url) === '/api/agent/documents/memory' && init.method === 'PUT' && ++puts === 1) await gate.promise;
    return fetchMock(url, init);
  };
  const view = renderDrawer();
  fireEvent.click(await view.findByRole('tab', { name: 'memory.md' }));
  await view.findByRole('textbox', { name: 'memory.md' });
  const oldVersion = server.versions.find(item => item.key === 'memory' && item.content.includes('第 2 版'));
  const oldRow = view.container.ownerDocument.querySelector(`[data-agent-version="${oldVersion.id}"]`);
  const restoreButton = within(oldRow).getByRole('button', { name: 'agent.settings.restore' });
  act(() => { fireEvent.click(restoreButton); fireEvent.click(restoreButton); });
  await waitFor(() => assert.equal(puts, 1));
  fireEvent.click(view.getByRole('button', { name: 'common.close' }));
  fireEvent.click(view.getByRole('button', { name: 'reopen' }));
  const editor = await view.findByRole('textbox', { name: 'memory.md' });
  const pendingRestore = view.getByRole('button', { name: 'common.loading' });
  assert.equal(pendingRestore.disabled, true);
  fireEvent.change(editor, { target: { value: '恢复期间编辑 B' } });
  const saveButton = view.getByRole('button', { name: 'common.save' });
  assert.equal(saveButton.disabled, true, 'restore must also lock saving');
  fireEvent.click(saveButton);
  assert.equal(puts, 1);

  await act(async () => { gate.resolve(); });
  await waitFor(() => assert.equal(saveButton.disabled, false));
  assert.equal(server.docs.memory.content, oldVersion.content);
  assert.equal(editor.value, '恢复期间编辑 B');
  fireEvent.click(saveButton);
  await waitFor(() => assert.equal(server.docs.memory.content, '恢复期间编辑 B'));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, true));
  assert.equal(puts, 2);
});

test('round2: model save remains locked across tabs and reopening while preserving later selections', async t => {
  const server = createServer();
  const fetchMock = global.fetch;
  const gate = deferred();
  t.after(() => gate.resolve());
  let puts = 0;
  global.fetch = async (url, init = {}) => {
    if (String(url) === '/api/settings' && init.method === 'PUT' && ++puts === 1) await gate.promise;
    return fetchMock(url, init);
  };
  const view = renderDrawer();
  fireEvent.change(await view.findByLabelText('agent.settings.provider'), { target: { value: 'p-alt' } });
  await view.findByRole('option', { name: 'alt-large' });
  fireEvent.change(view.getByLabelText('agent.settings.model'), { target: { value: 'alt-large' } });
  const saveButton = view.getByRole('button', { name: 'common.save' });
  act(() => { fireEvent.click(saveButton); fireEvent.click(saveButton); });
  await waitFor(() => assert.equal(puts, 1));
  fireEvent.click(view.getByRole('tab', { name: 'Agents.md' }));
  fireEvent.click(view.getByRole('button', { name: 'common.close' }));
  fireEvent.click(view.getByRole('button', { name: 'reopen' }));
  fireEvent.click(view.getByRole('tab', { name: 'agent.settings.tabModel' }));
  await view.findByRole('option', { name: 'alt-small' });
  fireEvent.change(view.getByLabelText('agent.settings.model'), { target: { value: 'alt-small' } });
  const pendingSave = view.getByRole('button', { name: 'common.loading' });
  assert.equal(pendingSave.disabled, true);
  fireEvent.click(pendingSave);
  assert.equal(puts, 1);

  await act(async () => { gate.resolve(); });
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, false));
  assert.equal(server.settings.agent_model, 'alt-large');
  assert.equal(view.getByLabelText('agent.settings.model').value, 'alt-small');
  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  await waitFor(() => assert.equal(server.settings.agent_model, 'alt-small'));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, true));
  assert.equal(puts, 2);
});

for (const operation of ['save', 'restore']) {
  test(`round2: failed document ${operation} unlocks the reopened editor without losing its draft`, async t => {
    const server = createServer();
    const fetchMock = global.fetch;
    const gate = deferred();
    t.after(() => gate.resolve());
    let puts = 0;
    global.fetch = async (url, init = {}) => {
      if (String(url) === '/api/agent/documents/memory' && init.method === 'PUT' && ++puts === 1) {
        await gate.promise;
        return json({ error: 'write failed' }, 500);
      }
      return fetchMock(url, init);
    };
    const view = renderDrawer();
    fireEvent.click(await view.findByRole('tab', { name: 'memory.md' }));
    const editor = await view.findByRole('textbox', { name: 'memory.md' });
    if (operation === 'save') {
      fireEvent.change(editor, { target: { value: '提交 A' } });
      fireEvent.click(view.getByRole('button', { name: 'common.save' }));
    } else {
      fireEvent.click(view.getByRole('button', { name: 'agent.settings.restore' }));
    }
    await waitFor(() => assert.equal(puts, 1));
    fireEvent.click(view.getByRole('button', { name: 'common.close' }));
    fireEvent.click(view.getByRole('button', { name: 'reopen' }));
    const reopened = await view.findByRole('textbox', { name: 'memory.md' });
    fireEvent.change(reopened, { target: { value: '失败期间保留 B' } });
    assert.ok(view.getAllByRole('button', { name: /common.save|common.loading/ }).every(button => button.disabled));
    await act(async () => { gate.resolve(); });
    await waitFor(() => assert.ok(toasts.some(item => item.type === 'error' && item.message.includes('write failed'))));
    assert.equal(reopened.value, '失败期间保留 B');
    assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, false);
    fireEvent.click(view.getByRole('button', { name: 'common.save' }));
    await waitFor(() => assert.equal(server.docs.memory.content, '失败期间保留 B'));
  });
}

test('round2: failed model save unlocks after reopening and keeps later selections', async t => {
  const server = createServer();
  const fetchMock = global.fetch;
  const gate = deferred();
  t.after(() => gate.resolve());
  let puts = 0;
  global.fetch = async (url, init = {}) => {
    if (String(url) === '/api/settings' && init.method === 'PUT' && ++puts === 1) {
      await gate.promise;
      return json({ error: 'write failed' }, 500);
    }
    return fetchMock(url, init);
  };
  const view = renderDrawer();
  fireEvent.change(await view.findByLabelText('agent.settings.provider'), { target: { value: 'p-alt' } });
  await view.findByRole('option', { name: 'alt-large' });
  fireEvent.change(view.getByLabelText('agent.settings.model'), { target: { value: 'alt-large' } });
  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  await waitFor(() => assert.equal(puts, 1));
  fireEvent.click(view.getByRole('button', { name: 'common.close' }));
  fireEvent.click(view.getByRole('button', { name: 'reopen' }));
  await view.findByRole('option', { name: 'alt-small' });
  fireEvent.change(view.getByLabelText('agent.settings.model'), { target: { value: 'alt-small' } });
  assert.equal(view.getByRole('button', { name: 'common.loading' }).disabled, true);
  await act(async () => { gate.resolve(); });
  await waitFor(() => assert.ok(toasts.some(item => item.type === 'error' && item.message.includes('write failed'))));
  assert.equal(view.getByLabelText('agent.settings.model').value, 'alt-small');
  assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, false);
  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  await waitFor(() => assert.equal(server.settings.agent_model, 'alt-small'));
});
