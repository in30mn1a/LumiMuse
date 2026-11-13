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

// ---- next/navigation：可被 router.replace 改写的地址栏 ----
let currentSearch = '';
const searchListeners = new Set();
const replacedUrls = [];
function setSearch(search) {
  currentSearch = search;
  for (const listener of searchListeners) listener();
}
const router = {
  replace(url) {
    replacedUrls.push(url);
    const index = url.indexOf('?');
    setSearch(index >= 0 ? url.slice(index + 1) : '');
  },
  push(url) {
    router.replace(url);
  },
};
function useSearchParams() {
  const [, force] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    searchListeners.add(force);
    return () => searchListeners.delete(force);
  }, []);
  return new URLSearchParams(currentSearch);
}

// Toast 自带不随卸载清理的定时器，测试里改成同步记录
const toasts = [];
const mocks = {
  '@/components/ui/Toast': { useToast: () => ({ showToast: (message, type) => { toasts.push({ message, type }); } }) },
  '@/lib/i18n-context': { useTranslation: () => ({ t: key => key }) },
  'next/navigation': { useRouter: () => router, useSearchParams },
  'next/link': {
    __esModule: true,
    default: ({ children, href, ...props }) => React.createElement('a', { href, ...props }, children),
  },
  'react-markdown': { __esModule: true, default: ({ children }) => React.createElement('div', { 'data-markdown': '' }, children) },
  'remark-gfm': { __esModule: true, default: () => {} },
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

const AgentPage = require('../src/app/agent/page.tsx').default;
const { buildAgentDisplayItems, groupAgentDisplayItems, hasUndecidedProposal } = require('../src/components/agent/AgentMessageList.tsx');
const { readAgentStream } = require('../src/hooks/agent/agent-stream.ts');

// ---- 虚构数据 ----
const SESSION = {
  id: 'agent-session-1',
  title: '查一下提取失败',
  character_id: null,
  conversation_id: null,
  created_at: '2026-11-01T08:00:00.000Z',
  updated_at: '2026-11-01T08:05:00.000Z',
};
const HISTORY = [
  { id: 1, role: 'user', content: '最近有提取失败吗', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '' },
  {
    id: 2, role: 'assistant', content: '', tool_calls: [{ id: 'call_a', name: 'list_failed_tasks', arguments: '{"limit":5}' }],
    tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '',
  },
  { id: 3, role: 'tool', content: '{"ok":true,"tasks":[]}', tool_calls: null, tool_call_id: 'call_a', tool_name: 'list_failed_tasks', tool_ok: true, event: null, created_at: '' },
  { id: 4, role: 'assistant', content: '没有失败的提取任务。', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '' },
  { id: 5, role: 'event', content: '', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: { kind: 'interrupted' }, created_at: '' },
];
const STATUS = {
  failed_tasks: { extraction: 2, profile: 0, embedding: 1 },
  repairable_candidates: 3,
  recent_errors: 4,
  recent_error_window_hours: 24,
  agent: { configured: true, provider_name: '虚构接口', model: 'fake-model' },
};
/** 输入框的模型选择读取的设置（只含它用到的键） */
const SETTINGS = { model: 'main-model', agent_provider_id: '', agent_model: 'fake-model', agent_reasoning_effort: 'default', pinned_models: [] };

/** 一条入库消息，只写和默认值不同的字段 */
function storedMessage(id, role, fields = {}) {
  return { id, role, content: '', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '', ...fields };
}

/** 工具组标题按真实格式渲染，其余键原样返回 */
function withToolGroupLabels(t) {
  const original = mocks['@/lib/i18n-context'].useTranslation;
  const labels = { 'agent.toolGroup': '{count} 个工具调用', 'agent.toolGroupFailed': '{count} 个失败', 'agent.toolGroupRunning': '正在运行 {name}' };
  mocks['@/lib/i18n-context'].useTranslation = () => ({ t: key => labels[key] ?? key });
  t.after(() => { mocks['@/lib/i18n-context'].useTranslation = original; });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 按事件分段推送的 SSE 响应；`gate`（或按下标的 `gates`）用来把流卡在某个位置等测试推进。 */
function sseResponse(events, options = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const [index, [event, data]] of events.entries()) {
        if (options.gateAt === index) await options.gate;
        if (options.gates?.[index]) await options.gates[index];
        if (options.signal?.aborted) {
          controller.error(new DOMException('aborted', 'AbortError'));
          return;
        }
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function installFetch(handler, { settings = SETTINGS } = {}) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, signal: init.signal, headers: new Headers(init.headers) };
    calls.push(call);
    // 输入框的模型选择挂载时读一次设置；读取统一给虚构设置，写入（PUT）仍交给各测试
    if (call.url === '/api/settings' && call.method === 'GET') return json(settings);
    return handler(call, calls);
  };
  return calls;
}

function renderPage(search) {
  setSearch(search);
  return render(React.createElement(AgentPage));
}

test.afterEach(async () => {
  // 每轮结束后状态条会再取一次数据；先让这些请求落地，避免在拆掉 DOM 之后才回写
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  cleanup();
  global.fetch = originalFetch;
  replacedUrls.length = 0;
  toasts.length = 0;
});
test.after(() => {
  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('display items pair tool calls with results and keep events', () => {
  const items = buildAgentDisplayItems(HISTORY);
  assert.deepEqual(items.map(item => item.kind), ['user', 'tool', 'assistant', 'event']);
  const tool = items[1];
  assert.equal(tool.name, 'list_failed_tasks');
  assert.equal(tool.result, '{"ok":true,"tasks":[]}');
  assert.equal(tool.ok, true);

  const unpaired = buildAgentDisplayItems([HISTORY[0], HISTORY[1]]);
  assert.equal(unpaired[1].result, null, 'a call without a stored result shows no result');
});

test('consecutive tool calls form one group, cards follow it and reused call ids get distinct keys', () => {
  const messages = [
    storedMessage(1, 'user', { content: '帮我整理一下记忆' }),
    storedMessage(2, 'assistant', { tool_calls: [{ id: 'a', name: 'load_skill', arguments: '{"name":"memory-review"}' }] }),
    storedMessage(3, 'tool', { content: '{"ok":true}', tool_call_id: 'a', tool_name: 'load_skill', tool_ok: true }),
    // 正文为空的下一轮不打断分组
    storedMessage(4, 'assistant', {
      tool_calls: [{ id: 'b', name: 'search_memories', arguments: '{}' }, { id: 'c', name: 'create_memory_proposal', arguments: '{}' }],
    }),
    storedMessage(5, 'tool', { content: '{"ok":false,"error":"timeout"}', tool_call_id: 'b', tool_name: 'search_memories', tool_ok: false }),
    storedMessage(6, 'tool', { content: '{"ok":true,"proposal_id":7}', tool_call_id: 'c', tool_name: 'create_memory_proposal', tool_ok: true }),
    storedMessage(7, 'assistant', { content: '已提出一份整理提案。' }),
    // 有的供应商跨轮复用调用 id
    storedMessage(8, 'assistant', { tool_calls: [{ id: 'a', name: 'get_status', arguments: '{}' }] }),
  ];
  const counts = new Map();
  const blocks = groupAgentDisplayItems(buildAgentDisplayItems(messages), counts);
  assert.deepEqual(
    blocks.map(block => (block.kind === 'tools' ? block.calls.map(call => call.callId).join(',') : block.item.kind)),
    ['user', 'a,b,c', 'proposal', 'assistant', 'a'],
  );
  assert.deepEqual(blocks[1].calls.map(call => call.state), ['ok', 'error', 'ok']);
  assert.deepEqual(blocks.filter(block => block.kind === 'tools').map(block => block.key), ['tools:a:0', 'tools:a:1']);
  assert.equal(counts.get('a'), 2, 'live groups continue the numbering after history');
});

test('stream reader handles events split across chunks, including inside a multi-byte character', async () => {
  const bytes = new TextEncoder().encode([
    'event: tool_start\ndata: {"id":"c1","name":"search_memories","arguments":"{}"}\n\n',
    'event: text\ndata: {"text":"记忆正常"}\n\n',
    'event: usage\ndata: {"prompt_tokens":1}\n\n',
    'event: done\ndata: {"status":"done","rounds":2}\n\n',
  ].join(''));
  const textStart = bytes.indexOf(0xe8); // 「记」的第一个字节
  const cuts = [7, textStart + 1, textStart + 2, bytes.length - 3];
  const stream = new ReadableStream({
    start(controller) {
      let previous = 0;
      for (const cut of [...cuts, bytes.length]) {
        controller.enqueue(bytes.slice(previous, cut));
        previous = cut;
      }
      controller.close();
    },
  });
  const events = [];
  await readAgentStream(stream, event => events.push(event));
  assert.deepEqual(events, [
    { type: 'tool_start', id: 'c1', name: 'search_memories', arguments: '{}' },
    { type: 'text', text: '记忆正常' },
    { type: 'done', status: 'done', rounds: 2 },
  ]);
});

test('page restores history, folds tool calls, localizes events and copies replies', async () => {
  const writes = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async text => { writes.push(text); } },
  });
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: HISTORY, running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);

  await view.findByText('没有失败的提取任务。');
  assert.ok(view.getByText('最近有提取失败吗'));
  assert.ok(view.getByText('agent.event.interrupted'));
  assert.ok(view.getAllByText(SESSION.title).length >= 1, 'title shows in the header and the session list');

  const toolRow = view.container.querySelector('details[data-agent-tool="list_failed_tasks"]');
  assert.ok(toolRow, 'tool call renders as a row');
  assert.equal(toolRow.open, false, 'tool calls are folded by default');
  assert.match(toolRow.textContent, /agent\.toolOk/);

  const status = await view.findByRole('region', { name: 'agent.status.title' });
  assert.match(status.querySelector('[data-status="extraction"]').textContent, /2/);
  assert.match(status.querySelector('[data-status="repairable"]').textContent, /3/);
  // 模型名挪到了输入框里，状态条不再显示
  assert.ok(await view.findByRole('button', { name: 'fake-model' }), 'the composer shows the agent model');
  assert.equal(within(status).queryByText('fake-model', { exact: false }), null);

  fireEvent.click(view.getByRole('button', { name: 'agent.copy' }));
  await waitFor(() => assert.deepEqual(writes, ['没有失败的提取任务。']));
  await view.findByText('agent.copied');
});

test('sending streams tools and text, then reloads history and the status bar', async () => {
  let releaseStream;
  const gate = new Promise(resolve => { releaseStream = resolve; });
  let historyAfterTurn = false;
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      const messages = historyAfterTurn
        ? [...HISTORY, { id: 6, role: 'user', content: '再看一下画像', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '' },
          { id: 7, role: 'assistant', content: '画像已更新到最新。', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '' }]
        : HISTORY;
      return json({ session: SESSION, messages, running: false });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') {
      historyAfterTurn = true;
      return sseResponse([
        ['tool_start', { id: 'c9', name: 'get_memory_profile', arguments: '{"character_id":"x"}' }],
        ['tool_end', { id: 'c9', name: 'get_memory_profile', ok: true }],
        ['text', { text: '画像已更新' }],
        ['text', { text: '到最新。' }],
        ['done', { status: 'done', rounds: 2 }],
      ], { gateAt: 3, gate });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('没有失败的提取任务。');
  const statusCallsBefore = calls.filter(call => call.url === '/api/agent/status').length;

  const input = view.getByRole('textbox', { name: 'agent.inputLabel' });
  fireEvent.change(input, { target: { value: '再看一下画像' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));

  await view.findByText('画像已更新');
  assert.equal(input.value, '', 'input clears once sent');
  assert.ok(view.getByText('再看一下画像'), 'the live turn shows the user message');
  assert.ok(view.container.querySelector('details[data-agent-tool="get_memory_profile"]'));
  assert.ok(view.getByRole('button', { name: 'agent.stop' }), 'stop is available while streaming');
  assert.deepEqual(calls.find(call => call.url === '/api/agent/chat').body, { session_id: SESSION.id, content: '再看一下画像' });

  await act(async () => { releaseStream(); });
  await view.findByText('画像已更新到最新。');
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'agent.send' })));
  await waitFor(() => {
    assert.ok(calls.filter(call => call.url === '/api/agent/status').length > statusCallsBefore, 'status bar refreshes after the turn');
  });
});

test('stored tool calls of consecutive rounds fold into one group that expands on click', async t => {
  withToolGroupLabels(t);
  const messages = [
    storedMessage(1, 'user', { content: '最近有提取失败吗' }),
    storedMessage(2, 'assistant', {
      tool_calls: [{ id: 'call_a', name: 'list_failed_tasks', arguments: '{"limit":5}' }, { id: 'call_b', name: 'search_memories', arguments: '{}' }],
    }),
    storedMessage(3, 'tool', { content: '{"ok":true,"tasks":[]}', tool_call_id: 'call_a', tool_name: 'list_failed_tasks', tool_ok: true }),
    storedMessage(4, 'tool', { content: '{"ok":false,"error":"timeout"}', tool_call_id: 'call_b', tool_name: 'search_memories', tool_ok: false }),
    storedMessage(5, 'assistant', { tool_calls: [{ id: 'call_c', name: 'get_memory_profile', arguments: '{}' }] }),
    storedMessage(6, 'tool', { content: '{"ok":true}', tool_call_id: 'call_c', tool_name: 'get_memory_profile', tool_ok: true }),
    storedMessage(7, 'assistant', { content: '没有失败的提取任务。' }),
  ];
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages, running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('没有失败的提取任务。');

  const groups = view.container.querySelectorAll('[data-agent-tool-group]');
  assert.equal(groups.length, 1);
  const header = within(groups[0]).getByRole('button', { name: /^3 个工具调用/ });
  assert.equal(header.getAttribute('aria-expanded'), 'false', 'groups start collapsed');
  assert.ok(within(header).getByText('1 个失败'));
  assert.match(header.textContent, /list_failed_tasks · search_memories · get_memory_profile/);
  const body = view.container.ownerDocument.getElementById(header.getAttribute('aria-controls'));
  assert.ok(body.hasAttribute('inert'), 'collapsed rows are skipped by keyboard and screen readers');
  assert.equal(body.querySelectorAll('details[data-agent-tool]').length, 3);

  fireEvent.click(header);
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.equal(body.hasAttribute('inert'), false);
  fireEvent.click(header);
  assert.equal(header.getAttribute('aria-expanded'), 'false');
});

test('live tool calls stream into one group that stays open when history replaces the live turn', async t => {
  withToolGroupLabels(t);
  const release = {};
  const gates = {};
  for (const index of [2, 4, 5]) gates[index] = new Promise(resolve => { release[index] = resolve; });
  t.after(() => Object.values(release).forEach(resolve => resolve()));
  let turnDone = false;
  const turn = [
    storedMessage(6, 'user', { content: '看看记忆有没有问题' }),
    storedMessage(7, 'assistant', {
      tool_calls: [{ id: 'c1', name: 'search_memories', arguments: '{}' }, { id: 'c2', name: 'list_failed_tasks', arguments: '{}' }],
    }),
    storedMessage(8, 'tool', { content: '{"ok":true}', tool_call_id: 'c1', tool_name: 'search_memories', tool_ok: true }),
    storedMessage(9, 'tool', { content: '{"ok":false,"error":"timeout"}', tool_call_id: 'c2', tool_name: 'list_failed_tasks', tool_ok: false }),
    storedMessage(10, 'assistant', { content: '记忆状态正常。' }),
  ];
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      return json({ session: SESSION, messages: turnDone ? [...HISTORY, ...turn] : HISTORY, running: false });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') {
      return sseResponse([
        ['tool_start', { id: 'c1', name: 'search_memories', arguments: '{}' }],
        ['tool_start', { id: 'c2', name: 'list_failed_tasks', arguments: '{}' }],
        ['tool_end', { id: 'c1', name: 'search_memories', ok: true }],
        ['tool_end', { id: 'c2', name: 'list_failed_tasks', ok: false, error: 'timeout' }],
        ['text', { text: '记忆状态正常。' }],
        ['done', { status: 'done', rounds: 2 }],
      ], { gates });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('没有失败的提取任务。');
  fireEvent.change(view.getByRole('textbox', { name: 'agent.inputLabel' }), { target: { value: '看看记忆有没有问题' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));

  // 两个工具都开始了、结果还没回来：标题显示最后开始的那个，不另显示「思考中」
  const header = await view.findByRole('button', { name: /^2 个工具调用/ });
  await within(header).findByText('正在运行 list_failed_tasks');
  assert.equal(view.queryByText('agent.thinking'), null);
  fireEvent.click(header);
  assert.equal(header.getAttribute('aria-expanded'), 'true');

  // 这一轮的结果回来了，下一轮还没有输出：显示「思考中」
  await act(async () => { release[2](); });
  await within(header).findByText('1 个失败');
  assert.ok(view.getByText('agent.thinking'));

  await act(async () => { release[4](); });
  await view.findByText('记忆状态正常。');
  assert.equal(view.queryByText('agent.thinking'), null, 'streaming text replaces the thinking line');

  turnDone = true;
  await act(async () => { release[5](); });
  await waitFor(() => assert.equal(view.getAllByRole('button', { name: 'agent.copy' }).length, 2), 'the stored reply replaced the live one');
  assert.equal(view.getAllByText('记忆状态正常。').length, 1);
  assert.equal(view.getAllByText('看看记忆有没有问题').length, 1);
  const after = view.getByRole('button', { name: /^2 个工具调用/ });
  assert.ok(after === header, 'the group element is kept, so it does not flash or replay its animation');
  assert.equal(after.getAttribute('aria-expanded'), 'true', 'it stays open');
  assert.ok(within(after).getByText('1 个失败'));
  assert.equal(view.container.querySelectorAll('[data-agent-tool-group]').length, 2);
});

test('a busy session keeps the draft and says why', async () => {
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: HISTORY, running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') return json({ error: 'busy', code: 'agent_busy' }, 409);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('没有失败的提取任务。');
  const input = view.getByRole('textbox', { name: 'agent.inputLabel' });
  fireEvent.change(input, { target: { value: '再试一次' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await waitFor(() => assert.deepEqual(toasts, [{ message: 'agent.busy', type: 'error' }]));
  await waitFor(() => assert.equal(input.value, '再试一次'));
});

test('stop aborts the request, then history reloads with the interruption', async () => {
  let chatSignal = null;
  let stopped = false;
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}/stop` && call.method === 'POST') return json({ stopped: true });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      const messages = stopped
        ? [{ id: 9, role: 'user', content: '慢慢查', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '' },
          { id: 10, role: 'event', content: '', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: { kind: 'round_limit', rounds: 25 }, created_at: '' }]
        : [];
      return json({ session: SESSION, messages, running: false });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') {
      chatSignal = call.signal;
      const never = new Promise(resolve => call.signal.addEventListener('abort', resolve, { once: true }));
      return sseResponse([
        ['tool_start', { id: 'c1', name: 'search_memories', arguments: '{}' }],
        ['text', { text: 'unreachable' }],
      ], { gateAt: 1, gate: never, signal: call.signal });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('agent.emptyTitle');
  fireEvent.change(view.getByRole('textbox', { name: 'agent.inputLabel' }), { target: { value: '慢慢查' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await waitFor(() => assert.ok(view.container.querySelector('details[data-agent-tool="search_memories"]')));

  stopped = true;
  fireEvent.click(view.getByRole('button', { name: 'agent.stop' }));
  assert.equal(chatSignal.aborted, true, 'stop aborts the fetch');
  assert.ok(
    calls.some(call => call.url === `/api/agent/sessions/${SESSION.id}/stop` && call.method === 'POST'),
    'dropping the stream no longer stops the run, so stop must ask the server',
  );
  await view.findByText('agent.event.roundLimit');
  assert.equal(view.queryByText('unreachable'), null);
  assert.equal(view.queryByRole('alert', { name: /AbortError/ }), null, 'a deliberate stop is not shown as an error');
});

test('a run left in the background can be stopped after coming back to the session', async () => {
  let running = true;
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}/stop` && call.method === 'POST') {
      running = false;
      return json({ stopped: true });
    }
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      const messages = running
        ? []
        : [{ id: 10, role: 'event', content: '', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: { kind: 'round_limit', rounds: 25 }, created_at: '' }];
      return json({ session: SESSION, messages, running });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('agent.runningOnServer');

  fireEvent.click(view.getByRole('button', { name: 'agent.stop' }));
  await waitFor(() => assert.ok(calls.some(call => call.url === `/api/agent/sessions/${SESSION.id}/stop` && call.method === 'POST')));
  await view.findByText('agent.event.roundLimit');
  assert.equal(view.queryByText('agent.runningOnServer'), null);
  assert.equal(calls.some(call => call.url === '/api/agent/chat'), false);
});

test('entering with a conversation creates a bound session and switches to it', async () => {
  const bound = { ...SESSION, id: 'agent-session-bound', title: '', conversation_id: 'conv-1', character_id: 'char-1' };
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [], has_more: false });
    if (call.url === '/api/agent/sessions' && call.method === 'POST') return json(bound, 201);
    if (call.url === `/api/agent/sessions/${bound.id}`) return json({ session: bound, messages: [], running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage('conversation=conv-1');
  await view.findByText('agent.boundConversation');
  assert.ok(view.getByRole('button', { name: 'agent.quick.suggestReply' }), 'bound sessions offer reply suggestions');
  const creates = calls.filter(call => call.method === 'POST');
  assert.deepEqual(creates.map(call => call.body), [{ conversation_id: 'conv-1' }], 'exactly one session is created');
  assert.deepEqual(replacedUrls, [`/agent?session=${bound.id}`]);
});

test('status bar stays usable when the agent upstream fails', async () => {
  let failedTurn = false;
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      const messages = failedTurn
        ? [{ id: 1, role: 'user', content: '看看日志', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '' },
          { id: 2, role: 'event', content: '', tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: { kind: 'error', message: 'HTTP 401: 上游拒绝访问' }, created_at: '' }]
        : [];
      return json({ session: SESSION, messages, running: false });
    }
    if (call.url === '/api/agent/status') return json({ ...STATUS, agent: { configured: false, provider_name: null, model: '' } });
    if (call.url === '/api/agent/chat') {
      failedTurn = true;
      return sseResponse([
        ['error', { error: 'HTTP 401: 上游拒绝访问' }],
        ['done', { status: 'error', rounds: 0 }],
      ]);
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  const status = await view.findByRole('region', { name: 'agent.status.title' });
  await within(status).findByText('agent.status.notConfigured');
  assert.match(status.querySelector('[data-status="errors"]').textContent, /4/);

  fireEvent.click(view.getByRole('button', { name: 'agent.quick.recentErrors' }));
  await view.findByText('agent.event.error');
  assert.ok(view.getAllByRole('alert').some(node => node.textContent.includes('agent.event.error')), 'the failure is announced');
  const statusAfter = view.getByRole('region', { name: 'agent.status.title' });
  assert.ok(within(statusAfter).getByText('agent.status.notConfigured'), 'status bar is still there after the failed turn');
  assert.ok(view.getByRole('button', { name: 'agent.send' }), 'the composer is ready for another try');
});

/** 模型切换测试共用的接口：模型列表固定，PUT 的结果由测试决定 */
function installModelFetch(putResponse, settings) {
  return installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: HISTORY, running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/models' && call.method === 'POST') return json({ models: ['main-model', 'fake-model', 'deep-model'] });
    if (call.url === '/api/settings' && call.method === 'PUT') return putResponse();
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  }, { settings });
}

test('the composer switches the Agent model and reasoning effort using the Agent provider', async () => {
  const calls = installModelFetch(() => json({ ok: true }), { ...SETTINGS, agent_provider_id: 'prov-2' });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByRole('region', { name: 'agent.status.title' });
  const statusReads = () => calls.filter(call => call.url === '/api/agent/status').length;
  const puts = () => calls.filter(call => call.url === '/api/settings' && call.method === 'PUT').map(call => call.body);

  const readsBeforeModel = statusReads();
  fireEvent.click(await view.findByRole('button', { name: 'fake-model' }));
  fireEvent.click(await view.findByRole('option', { name: 'deep-model' }));
  await waitFor(() => assert.deepEqual(puts(), [{ agent_model: 'deep-model' }]));
  assert.deepEqual(calls.find(call => call.url === '/api/models').body, { provider_id: 'prov-2' }, 'the list comes from the Agent provider');
  assert.ok(view.getByRole('button', { name: 'deep-model' }));
  await waitFor(() => assert.ok(statusReads() > readsBeforeModel, 'the status bar re-checks the effective model'));

  fireEvent.click(view.getByRole('button', { name: 'input.reasoningEffort: input.reasoningEffortDefault' }));
  fireEvent.click(await view.findByRole('option', { name: 'high' }));
  await waitFor(() => assert.deepEqual(puts(), [{ agent_model: 'deep-model' }, { agent_reasoning_effort: 'high' }]));
  assert.ok(view.getByRole('button', { name: 'input.reasoningEffort: high' }));
  assert.deepEqual(toasts, []);
});

test('a failed model switch says why and returns to the saved model', async () => {
  installModelFetch(() => json({ error: 'disk full' }, 500));
  const view = renderPage(`session=${SESSION.id}`);
  fireEvent.click(await view.findByRole('button', { name: 'fake-model' }));
  fireEvent.click(await view.findByRole('option', { name: 'deep-model' }));
  await waitFor(() => assert.deepEqual(toasts, [{ message: 'settings.saveFailed: disk full', type: 'error' }]));
  await view.findByRole('button', { name: 'fake-model' });
  assert.equal(view.queryByRole('button', { name: 'deep-model' }), null);
});

test('the Agent model picker pins models to the shared list', async () => {
  const calls = installModelFetch(() => json({ ok: true }), { ...SETTINGS, pinned_models: ['deep-model'] });
  const view = renderPage(`session=${SESSION.id}`);
  fireEvent.click(await view.findByRole('button', { name: 'fake-model' }));
  const order = () => view.getAllByRole('option').map(option => option.textContent);
  await waitFor(() => assert.deepEqual(order(), ['deep-model', 'main-model', 'fake-model']), { timeout: 2000 });
  const mainOption = view.getAllByRole('option')[1];
  assert.equal(within(mainOption).getByRole('button').getAttribute('aria-pressed'), 'false');
  fireEvent.click(within(mainOption).getByRole('button'));

  await waitFor(() => assert.deepEqual(
    calls.filter(call => call.url === '/api/settings' && call.method === 'PUT').map(call => call.body),
    [{ pinned_models: ['deep-model', 'main-model'] }],
  ));
  // 置顶组内部保持上游顺序，所以两个置顶的模型按上游顺序排
  assert.deepEqual(order(), ['main-model', 'deep-model', 'fake-model']);
  assert.ok(view.getByRole('button', { name: 'fake-model' }), 'pinning does not change the selected model');
});

test('a failed pin says why and restores the saved list', async () => {
  installModelFetch(() => json({ error: 'disk full' }, 500), { ...SETTINGS, pinned_models: ['deep-model'] });
  const view = renderPage(`session=${SESSION.id}`);
  fireEvent.click(await view.findByRole('button', { name: 'fake-model' }));
  const order = () => view.getAllByRole('option').map(option => option.textContent);
  await waitFor(() => assert.deepEqual(order(), ['deep-model', 'main-model', 'fake-model']), { timeout: 2000 });
  const fakeOption = view.getAllByRole('option')[2];
  fireEvent.click(within(fakeOption).getByRole('button'));
  assert.deepEqual(order(), ['fake-model', 'deep-model', 'main-model'], 'the optimistic order shows immediately');

  await waitFor(() => assert.deepEqual(toasts, [{ message: 'settings.saveFailed: disk full', type: 'error' }]));
  await waitFor(() => assert.deepEqual(order(), ['deep-model', 'main-model', 'fake-model']));
  const restored = view.getAllByRole('option').find(option => option.textContent === 'fake-model');
  assert.equal(within(restored).getByRole('button').getAttribute('aria-pressed'), 'false');
});

test('picking the main model the Agent already follows does not pin it', async () => {
  const calls = installModelFetch(() => json({ ok: true }), { ...SETTINGS, agent_model: '' });
  const view = renderPage(`session=${SESSION.id}`);
  fireEvent.click(await view.findByRole('button', { name: 'main-model' }));
  fireEvent.click(await view.findByRole('option', { name: 'main-model' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0, 'an empty agent_model keeps following the main model');
  assert.ok(view.getByRole('button', { name: 'main-model' }));
});

/** 设置 PUT 由测试逐个放行，聊天在开始时读取已经保存的虚构配置。 */
function pendingModelServer(t, {
  messages = [], createGate = Promise.resolve(), decisionGate = Promise.resolve(), historyGate = Promise.resolve(),
} = {}) {
  const settings = { ...SETTINGS };
  const writes = [];
  const usedChoices = [];
  let draining = false;
  let decided = false;
  const calls = installFetch(async call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === '/api/agent/sessions' && call.method === 'POST') {
      await createGate;
      return json(SESSION, 201);
    }
    if (call.url.startsWith('/api/agent/sessions/')) {
      if (decided) await historyGate;
      return json({ session: { ...SESSION, id: call.url.split('/').at(-1) }, messages, running: false });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/models') return json({ models: ['fake-model', 'deep-model', 'latest-model'] });
    if (call.url === '/api/settings' && call.method === 'PUT') {
      const status = draining ? 200 : await new Promise(resolve => { writes.push({ body: call.body, resolve }); });
      if (status !== 200) return json({ error: 'model save failed' }, status);
      Object.assign(settings, call.body);
      return json({ ok: true });
    }
    if (call.url === '/api/agent/proposals/71') {
      if (call.method === 'POST') {
        decided = true;
        await decisionGate;
      }
      return json({
        id: 71, session_id: SESSION.id, character_id: 'char-a', summary: '待确认的虚构提案',
        status: call.method === 'POST' ? 'decided' : 'pending', created_at: SESSION.created_at,
        items: [{
          id: 72, seq: 1, op: 'create', reason: '虚构理由', confidence: 0.9, evidence: { message_ids: [] },
          before: null, after: { content: '虚构记忆', category: 'fact' }, state: call.method === 'POST' ? 'applied' : 'pending',
        }], evidence_messages: [],
      });
    }
    if (call.url === '/api/agent/chat') {
      usedChoices.push({ model: settings.agent_model, effort: settings.agent_reasoning_effort });
      return sseResponse([['done', { status: 'done', rounds: 1 }]]);
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  }, { settings });
  t.after(() => {
    draining = true;
    writes.forEach(write => write.resolve(200));
  });
  return { calls, writes, usedChoices };
}

async function selectAgentModel(view, current, next) {
  fireEvent.click(await view.findByRole('button', { name: current }));
  fireEvent.click(await view.findByRole('option', { name: next }));
}

for (const entry of ['composer', 'quick prompt', 'approve and continue']) {
  test(`model saves: ${entry} waits for the selected model before sending`, async t => {
    const messages = entry === 'approve and continue' ? [
      storedMessage(1, 'assistant', { tool_calls: [{ id: 'proposal-call', name: 'create_memory_proposal', arguments: '{}' }] }),
      storedMessage(2, 'tool', { tool_call_id: 'proposal-call', tool_name: 'create_memory_proposal', tool_ok: true, content: '{"ok":true,"proposal_id":71}' }),
    ] : [];
    const server = pendingModelServer(t, { messages });
    const view = renderPage(`session=${SESSION.id}`);
    await selectAgentModel(view, 'fake-model', 'deep-model');
    await waitFor(() => assert.equal(server.writes.length, 1));
    if (entry === 'composer') {
      fireEvent.change(view.getByLabelText('agent.inputLabel'), { target: { value: '请用新模型检查' } });
      fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
    } else if (entry === 'quick prompt') {
      fireEvent.click(view.getByRole('button', { name: 'agent.quick.memoryReview' }));
    } else {
      fireEvent.click(await view.findByRole('button', { name: 'agent.proposal.approveContinue' }));
    }
    await act(async () => {});
    const startedBeforeSave = server.usedChoices.length;
    await act(async () => { server.writes[0].resolve(200); });
    await waitFor(() => assert.equal(server.usedChoices.length, 1));
    assert.equal(startedBeforeSave, 0, 'no turn may start with the still-saved old model');
    assert.deepEqual(server.usedChoices, [{ model: 'deep-model', effort: 'default' }]);
  });
}

for (const stage of ['decision', 'history']) {
  test(`model saves: failure during proposal ${stage} cancels automatic continuation`, async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const messages = [
      storedMessage(1, 'assistant', { tool_calls: [{ id: 'proposal-call', name: 'create_memory_proposal', arguments: '{}' }] }),
      storedMessage(2, 'tool', { tool_call_id: 'proposal-call', tool_name: 'create_memory_proposal', tool_ok: true, content: '{"ok":true,"proposal_id":71}' }),
    ];
    const server = pendingModelServer(t, { messages, [`${stage}Gate`]: gate });
    const view = renderPage(`session=${SESSION.id}`);
    await selectAgentModel(view, 'fake-model', 'deep-model');
    await waitFor(() => assert.equal(server.writes.length, 1));
    fireEvent.click(await view.findByRole('button', { name: 'agent.proposal.approveContinue' }));
    await waitFor(() => assert.ok(server.calls.some(call => call.url === '/api/agent/proposals/71' && call.method === 'POST')));
    if (stage === 'history') {
      await waitFor(() => assert.equal(server.calls.filter(call => call.url === `/api/agent/sessions/${SESSION.id}`).length, 2));
    }
    await act(async () => { server.writes[0].resolve(500); });
    await view.findByRole('button', { name: 'fake-model' });
    await act(async () => { release(); });
    assert.equal(server.usedChoices.length, 0, 'a failure after clicking approve must not silently continue with the previous model');
  });
}

test('model saves: rapid choices made while waiting join the send barrier and repeated sends stay locked', async t => {
  const server = pendingModelServer(t);
  const view = renderPage(`session=${SESSION.id}`);
  await selectAgentModel(view, 'fake-model', 'deep-model');
  await waitFor(() => assert.equal(server.writes.length, 1));
  fireEvent.change(view.getByLabelText('agent.inputLabel'), { target: { value: '只发送一轮' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await selectAgentModel(view, 'deep-model', 'latest-model');
  fireEvent.click(view.getByRole('button', { name: 'input.reasoningEffort: input.reasoningEffortDefault' }));
  fireEvent.click(await view.findByRole('option', { name: 'high' }));
  fireEvent.click(view.getByRole('button', { name: 'agent.quick.memoryReview' }));
  await act(async () => { server.writes[0].resolve(200); });
  await waitFor(() => assert.equal(server.writes.length, 2));
  await act(async () => { server.writes[1].resolve(200); });
  await waitFor(() => assert.equal(server.writes.length, 3));
  const startedBeforeLastSave = server.usedChoices.length;
  await act(async () => { server.writes[2].resolve(200); });
  await waitFor(() => assert.equal(server.usedChoices.length, 1));
  assert.equal(startedBeforeLastSave, 0);
  assert.deepEqual(server.usedChoices, [{ model: 'latest-model', effort: 'high' }]);
});

for (const choice of ['model', 'effort']) {
  test(`model saves: failed ${choice} save cancels sending and restores the draft`, async t => {
    const server = pendingModelServer(t);
    const view = renderPage(`session=${SESSION.id}`);
    if (choice === 'model') await selectAgentModel(view, 'fake-model', 'deep-model');
    else {
      fireEvent.click(await view.findByRole('button', { name: 'input.reasoningEffort: input.reasoningEffortDefault' }));
      fireEvent.click(await view.findByRole('option', { name: 'high' }));
    }
    await waitFor(() => assert.equal(server.writes.length, 1));
    const input = view.getByLabelText('agent.inputLabel');
    fireEvent.change(input, { target: { value: '保存失败则保留这份草稿' } });
    fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
    await act(async () => { server.writes[0].resolve(500); });
    assert.equal(server.usedChoices.length, 0);
    await waitFor(() => assert.equal(input.value, '保存失败则保留这份草稿'));
    assert.deepEqual(toasts, [{ message: 'settings.saveFailed: model save failed', type: 'error' }]);
    fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
    await waitFor(() => assert.equal(server.usedChoices.length, 1));
    assert.deepEqual(server.usedChoices, [{ model: 'fake-model', effort: 'default' }], 'a later explicit retry may use the confirmed choice');
  });
}

test('model saves: failed model choices roll back before a later pin write finishes', async t => {
  const server = pendingModelServer(t);
  const view = renderPage(`session=${SESSION.id}`);
  await selectAgentModel(view, 'fake-model', 'deep-model');
  await waitFor(() => assert.equal(server.writes.length, 1));
  fireEvent.click(view.getByRole('button', { name: 'deep-model' }));
  fireEvent.click(within(await view.findByRole('option', { name: 'latest-model' })).getByRole('button'));
  fireEvent.click(view.getByRole('button', { name: 'deep-model' }));
  const input = view.getByLabelText('agent.inputLabel');
  fireEvent.change(input, { target: { value: '失败后等待明确重试' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await act(async () => { server.writes[0].resolve(500); });
  await waitFor(() => assert.equal(server.writes.length, 2));
  await waitFor(() => assert.equal(input.value, '失败后等待明确重试'));
  const confirmedModelVisible = view.queryByRole('button', { name: 'fake-model' }) !== null;
  await act(async () => { server.writes[1].resolve(200); });
  assert.equal(server.usedChoices.length, 0);
  assert.equal(confirmedModelVisible, true, 'the failed model must stop displaying even while unrelated pin persistence is pending');
});

for (const leave of ['switch away and back', 'unmount']) {
  test(`model saves: ${leave} while waiting cancels the queued send`, async t => {
    const server = pendingModelServer(t);
    const view = renderPage(`session=${SESSION.id}`);
    await selectAgentModel(view, 'fake-model', 'deep-model');
    await waitFor(() => assert.equal(server.writes.length, 1));
    const input = view.getByLabelText('agent.inputLabel');
    fireEvent.change(input, { target: { value: '取消过期的发送' } });
    fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
    if (leave === 'unmount') view.unmount();
    else {
      await act(async () => { setSearch('session=other-session'); });
      await act(async () => { setSearch(`session=${SESSION.id}`); });
    }
    await act(async () => { server.writes[0].resolve(200); });
    assert.equal(server.usedChoices.length, 0);
    if (leave !== 'unmount') await waitFor(() => assert.equal(input.value, '取消过期的发送'));
  });
}

test('model saves: failures during a slow session creation still cancel sending', async t => {
  let releaseCreate;
  const createGate = new Promise(resolve => { releaseCreate = resolve; });
  t.after(() => releaseCreate());
  const server = pendingModelServer(t, { createGate });
  const view = renderPage('');
  await selectAgentModel(view, 'fake-model', 'deep-model');
  await waitFor(() => assert.equal(server.writes.length, 1));
  const input = view.getByLabelText('agent.inputLabel');
  fireEvent.change(input, { target: { value: '新会话的未发送草稿' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await act(async () => { server.writes[0].resolve(200); });
  // 首次保存已结束、会话仍在创建时，再发生一次保存失败。
  await selectAgentModel(view, 'deep-model', 'latest-model');
  await waitFor(() => assert.equal(server.writes.length, 2));
  await act(async () => { server.writes[1].resolve(500); });
  await act(async () => { releaseCreate(); });
  assert.equal(server.usedChoices.length, 0);
  await waitFor(() => assert.equal(input.value, '新会话的未发送草稿'));
});

test('model saves: a failed pin does not cancel a send using unchanged configuration', async t => {
  const server = pendingModelServer(t);
  const view = renderPage(`session=${SESSION.id}`);
  fireEvent.click(await view.findByRole('button', { name: 'fake-model' }));
  fireEvent.click(within(await view.findByRole('option', { name: 'deep-model' })).getByRole('button'));
  await waitFor(() => assert.equal(server.writes.length, 1));
  fireEvent.click(view.getByRole('button', { name: 'fake-model' }));
  fireEvent.change(view.getByLabelText('agent.inputLabel'), { target: { value: '不等待置顶保存' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await waitFor(() => assert.equal(server.usedChoices.length, 1));
  await act(async () => { server.writes[0].resolve(500); });
  assert.deepEqual(server.usedChoices, [{ model: 'fake-model', effort: 'default' }]);
});

test('a rejected chat request preserves the unsent draft and shows the network error', async () => {
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: [], running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') throw new TypeError('network unreachable');
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('agent.emptyTitle');
  const input = view.getByRole('textbox', { name: 'agent.inputLabel' });
  fireEvent.change(input, { target: { value: '这条消息还没有发出去' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));

  await waitFor(() => assert.deepEqual(toasts, [{ message: 'agent.sendFailed: network unreachable', type: 'error' }]));
  assert.equal(input.value, '这条消息还没有发出去');
});

test('an accepted stream failure keeps waiting for the server run without an error or a resend', async () => {
  let accepted = false;
  let polls = 0;
  const savedMessage = { ...HISTORY[0], content: '已经保存的请求' };
  const reply = { ...HISTORY[0], id: HISTORY[0].id + 1, role: 'assistant', content: '断线后跑完的回复' };
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      if (!accepted) return json({ session: SESSION, messages: [], running: false });
      polls += 1;
      return polls === 1
        ? json({ session: SESSION, messages: [savedMessage], running: true })
        : json({ session: SESSION, messages: [savedMessage, reply], running: false });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') {
      accepted = true;
      return new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError('stream disconnected')); },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('agent.emptyTitle');
  const input = view.getByRole('textbox', { name: 'agent.inputLabel' });
  fireEvent.change(input, { target: { value: savedMessage.content } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));

  await view.findByText('agent.runningOnServer');
  await view.findByText(reply.content, undefined, { timeout: 5000 });
  assert.equal(view.queryByText('agent.runningOnServer'), null);
  assert.deepEqual(toasts, []);
  assert.equal(input.value, '', 'an accepted message is not offered for accidental duplicate submission');
  assert.equal(view.getAllByText(savedMessage.content).length, 1);
  assert.equal(calls.filter(call => call.url === '/api/agent/chat').length, 1);
});

test('a stream that closes without done is not reported as an error', async () => {
  let accepted = false;
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: accepted ? [HISTORY[0]] : [], running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') {
      accepted = true;
      return sseResponse([['text', { text: '部分回复' }]]);
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('agent.emptyTitle');
  fireEvent.click(view.getByRole('button', { name: 'agent.quick.recentErrors' }));
  await view.findByRole('button', { name: 'agent.send' });
  assert.deepEqual(toasts, []);
  assert.equal(view.getByRole('textbox', { name: 'agent.inputLabel' }).value, '');
});

test('sending while a bound session is being created waits for that same session', async () => {
  let releaseBound;
  const gate = new Promise(resolve => { releaseBound = resolve; });
  const bound = { ...SESSION, id: 'bound-session', conversation_id: 'conv-a' };
  const unbound = { ...SESSION, id: 'unbound-session' };
  const calls = installFetch(async call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [], has_more: false });
    if (call.url === '/api/agent/sessions' && call.method === 'POST') {
      if (call.body.conversation_id) { await gate; return json(bound, 201); }
      return json(unbound, 201);
    }
    if (call.url === `/api/agent/sessions/${bound.id}`) return json({ session: bound, messages: [], running: false });
    if (call.url === `/api/agent/sessions/${unbound.id}`) return json({ session: unbound, messages: [], running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') return sseResponse([['done', { status: 'done', rounds: 1 }]]);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage('conversation=conv-a');
  await waitFor(() => assert.ok(calls.some(call => call.method === 'POST')));
  fireEvent.change(view.getByRole('textbox', { name: 'agent.inputLabel' }), { target: { value: '帮我建议下一句' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await act(async () => { releaseBound(); });
  await waitFor(() => assert.ok(calls.some(call => call.url === '/api/agent/chat')));

  assert.deepEqual(calls.filter(call => call.url === '/api/agent/sessions').map(call => call.body), [{ conversation_id: 'conv-a' }]);
  assert.equal(calls.find(call => call.url === '/api/agent/chat').body.session_id, bound.id);
  assert.equal(currentSearch, `session=${bound.id}`);
});

test('a late bound session response does not replace a selected session or send a queued prompt', async () => {
  let releaseBound;
  const gate = new Promise(resolve => { releaseBound = resolve; });
  const bound = { ...SESSION, id: 'late-bound', conversation_id: 'conv-a' };
  const calls = installFetch(async call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === '/api/agent/sessions' && call.method === 'POST') { await gate; return json(bound, 201); }
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: HISTORY, running: false });
    if (call.url === `/api/agent/sessions/${bound.id}`) return json({ session: bound, messages: [], running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') return sseResponse([['done', { status: 'done', rounds: 1 }]]);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage('conversation=conv-a');
  await view.findByRole('button', { name: new RegExp(`^${SESSION.title}`) });
  fireEvent.change(view.getByRole('textbox', { name: 'agent.inputLabel' }), { target: { value: '等待关联的请求' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  fireEvent.click(view.getByRole('button', { name: new RegExp(`^${SESSION.title}`) }));
  await view.findByText('没有失败的提取任务。');
  await act(async () => { releaseBound(); });

  assert.equal(currentSearch, `session=${SESSION.id}`);
  assert.equal(calls.filter(call => call.url === '/api/agent/chat').length, 0);
});

test('repeated quick prompts while creating a session create and send only once', async () => {
  let releaseCreate;
  const gate = new Promise(resolve => { releaseCreate = resolve; });
  const calls = installFetch(async call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [], has_more: false });
    if (call.url === '/api/agent/sessions' && call.method === 'POST') { await gate; return json(SESSION, 201); }
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: [], running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') return sseResponse([['done', { status: 'done', rounds: 1 }]]);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage('');
  const prompt = await view.findByRole('button', { name: 'agent.quick.recentErrors' });
  fireEvent.click(prompt);
  fireEvent.click(prompt);
  await act(async () => { releaseCreate(); });
  await waitFor(() => assert.ok(calls.some(call => call.url === '/api/agent/chat')));

  assert.equal(calls.filter(call => call.url === '/api/agent/sessions').length, 1);
  assert.equal(calls.filter(call => call.url === '/api/agent/chat').length, 1);
});

test('a quick prompt in a new session shows the sent message once, during and after the turn', async () => {
  // 服务端在一轮开头就写入主人的消息；新会话导航后读到的历史已含这条消息，而流还在进行
  let releaseStream;
  const gate = new Promise(resolve => { releaseStream = resolve; });
  let chatAccepted = false;
  let turnDone = false;
  let midTurnHistoryReads = 0;
  const sent = { ...HISTORY[0], id: 1, content: 'agent.quick.recentErrors' };
  const reply = { ...HISTORY[3], id: 2, content: '最近 24 小时没有报错。' };
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [], has_more: false });
    if (call.url === '/api/agent/sessions' && call.method === 'POST') return json(SESSION, 201);
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      if (chatAccepted && !turnDone) midTurnHistoryReads += 1;
      const messages = turnDone ? [sent, reply] : chatAccepted ? [sent] : [];
      return json({ session: SESSION, messages, running: chatAccepted && !turnDone });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') {
      chatAccepted = true;
      return sseResponse([
        ['text', { text: '正在查看' }],
        ['done', { status: 'done', rounds: 1 }],
      ], { gateAt: 1, gate });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage('');
  fireEvent.click(await view.findByRole('button', { name: 'agent.quick.recentErrors' }));
  await view.findByText('正在查看');
  await waitFor(() => assert.ok(midTurnHistoryReads > 0, 'history is read while the turn is still streaming'));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(view.getAllByText('agent.quick.recentErrors').length, 1, 'no duplicate bubble while streaming');

  turnDone = true;
  await act(async () => { releaseStream(); });
  await view.findByText('最近 24 小时没有报错。');
  await waitFor(() => assert.ok(view.queryByRole('button', { name: 'agent.send' })));
  assert.equal(view.getAllByText('agent.quick.recentErrors').length, 1, 'no duplicate bubble after the turn');
});

test('a pending session creation does not navigate after leaving the page', async () => {
  let releaseCreate;
  const gate = new Promise(resolve => { releaseCreate = resolve; });
  const calls = installFetch(async call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [], has_more: false });
    if (call.url === '/api/agent/sessions' && call.method === 'POST') { await gate; return json(SESSION, 201); }
    if (call.url === '/api/agent/status') return json(STATUS);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage('conversation=conv-a');
  await waitFor(() => assert.ok(calls.some(call => call.method === 'POST')));
  view.unmount();
  await act(async () => { releaseCreate(); });
  assert.deepEqual(replacedUrls, []);
});

test('strict mode effect replay reuses the pending bound session creation', async () => {
  const bound = { ...SESSION, conversation_id: 'conv-a' };
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [], has_more: false });
    if (call.url === '/api/agent/sessions' && call.method === 'POST') return json(bound, 201);
    if (call.url === `/api/agent/sessions/${bound.id}`) return json({ session: bound, messages: [], running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  setSearch('conversation=conv-a');
  const view = render(React.createElement(React.StrictMode, null, React.createElement(AgentPage)));
  await view.findByText('agent.boundConversation');
  assert.equal(calls.filter(call => call.url === '/api/agent/sessions').length, 1);
  assert.deepEqual(replacedUrls, [`/agent?session=${bound.id}`]);
});

for (const oldFails of [false, true]) {
  test(`round2: late pre-send history ${oldFails ? 'failure' : 'success'} cannot overwrite a completed turn`, async t => {
    let releaseInitial;
    const gate = new Promise(resolve => { releaseInitial = resolve; });
    t.after(() => releaseInitial());
    let historyReads = 0;
    const reply = '已经完成的新回复';
    installFetch(async call => {
      if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
      if (call.url === `/api/agent/sessions/${SESSION.id}`) {
        if (++historyReads === 1) {
          const snapshot = oldFails ? json({ error: 'old history failed' }, 500) : json({ session: SESSION, messages: [], running: true });
          await gate;
          return snapshot;
        }
        return json({ session: SESSION, messages: [{ ...HISTORY[0], content: '新消息' }, { ...HISTORY[3], content: reply }], running: false });
      }
      if (call.url === '/api/agent/status') return json(STATUS);
      if (call.url === '/api/agent/chat') return sseResponse([['text', { text: reply }], ['done', { status: 'done', rounds: 1 }]]);
      throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    });
    const view = renderPage(`session=${SESSION.id}`);
    await waitFor(() => assert.equal(historyReads, 1));
    fireEvent.change(view.getByRole('textbox', { name: 'agent.inputLabel' }), { target: { value: '新消息' } });
    fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
    await view.findByText(reply);
    await waitFor(() => assert.ok(view.queryByRole('button', { name: 'agent.send' })));
    assert.equal(historyReads, 2);
    await act(async () => { releaseInitial(); });
    assert.ok(view.queryByText(reply));
    assert.ok(view.queryByText('新消息'));
    assert.ok(view.queryByText('agent.runningOnServer') === null);
    assert.ok(view.queryByText('agent.loadSessionFailed') === null);
  });

  test(`round2: returning to a session invalidates its older history ${oldFails ? 'failure' : 'success'}`, async t => {
    const other = { ...SESSION, id: 'other-session', title: '另一个会话' };
    let releaseInitial;
    const gate = new Promise(resolve => { releaseInitial = resolve; });
    t.after(() => releaseInitial());
    let firstReads = 0;
    installFetch(async call => {
      if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION, other], has_more: false });
      if (call.url === `/api/agent/sessions/${SESSION.id}`) {
        if (++firstReads === 1) {
          const snapshot = oldFails ? json({ error: 'old visit failed' }, 500) : json({ session: SESSION, messages: [], running: true });
          await gate;
          return snapshot;
        }
        return json({ session: SESSION, messages: [{ ...HISTORY[3], content: '重新进入后的最新记录' }], running: false });
      }
      if (call.url === `/api/agent/sessions/${other.id}`) return json({ session: other, messages: [{ ...HISTORY[3], content: '另一个会话的记录' }], running: false });
      if (call.url === '/api/agent/status') return json(STATUS);
      throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    });
    const view = renderPage(`session=${SESSION.id}`);
    await waitFor(() => assert.equal(firstReads, 1));
    fireEvent.click(await view.findByText(other.title));
    await view.findByText('另一个会话的记录');
    fireEvent.click(view.getByText(SESSION.title));
    await view.findByText('重新进入后的最新记录');
    await act(async () => { releaseInitial(); });
    assert.ok(view.queryByText('重新进入后的最新记录'));
    assert.ok(view.queryByText('agent.runningOnServer') === null);
    assert.ok(view.queryByText('agent.loadSessionFailed') === null);
  });
}

test('round2: a late old success cannot clear the latest history error', async t => {
  let releaseInitial;
  const gate = new Promise(resolve => { releaseInitial = resolve; });
  t.after(() => releaseInitial());
  let historyReads = 0;
  installFetch(async call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      if (++historyReads === 1) {
        const snapshot = json({ session: SESSION, messages: [], running: false });
        await gate;
        return snapshot;
      }
      return json({ error: 'latest history failed' }, 500);
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') return sseResponse([['done', { status: 'done', rounds: 1 }]]);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await waitFor(() => assert.equal(historyReads, 1));
  fireEvent.change(view.getByRole('textbox', { name: 'agent.inputLabel' }), { target: { value: '新消息' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await view.findByText('latest history failed');
  await act(async () => { releaseInitial(); });
  assert.ok(view.queryByText('latest history failed'));
  assert.ok(view.queryByText('agent.loadSessionFailed'));
});

test('round2: a rejected send restarts invalidated history loading without delaying draft recovery', async t => {
  let releaseInitial;
  let releaseFresh;
  const initialGate = new Promise(resolve => { releaseInitial = resolve; });
  const freshGate = new Promise(resolve => { releaseFresh = resolve; });
  t.after(() => { releaseInitial(); releaseFresh(); });
  let historyReads = 0;
  installFetch(async call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      if (++historyReads === 1) {
        await initialGate;
        return json({ session: SESSION, messages: [], running: false });
      }
      await freshGate;
      return json({ session: SESSION, messages: [{ ...HISTORY[3], content: '重新读取的历史' }], running: false });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') throw new TypeError('network unreachable');
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await waitFor(() => assert.equal(historyReads, 1));
  const input = view.getByRole('textbox', { name: 'agent.inputLabel' });
  fireEvent.change(input, { target: { value: '发送失败后保留草稿' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await waitFor(() => assert.equal(input.value, '发送失败后保留草稿'));
  assert.ok(toasts.some(item => item.message.includes('network unreachable')));
  assert.equal(historyReads, 2, 'the invalidated initial read needs a new request even if sending fails');
  await act(async () => { releaseFresh(); releaseInitial(); });
  await view.findByText('重新读取的历史');
  assert.ok(view.queryByText('agent.emptyTitle') === null);
});

test('round2: an empty reply error remains visible after final history reload and reopening', async t => {
  const warning = '模型没有返回内容。如果用的是推理模型，可能是思考用完了输出长度。';
  const originalTranslation = mocks['@/lib/i18n-context'].useTranslation;
  mocks['@/lib/i18n-context'].useTranslation = () => ({
    t: key => key === 'agent.event.error' ? 'Agent 出错：{message}' : key,
  });
  t.after(() => { mocks['@/lib/i18n-context'].useTranslation = originalTranslation; });
  let accepted = false;
  const savedHistory = [
    { ...HISTORY[0], content: '请检查当前状态' },
    { ...HISTORY[4], event: { kind: 'error', message: warning } },
  ];
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: accepted ? savedHistory : [], running: false });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') {
      accepted = true;
      return sseResponse([['error', { error: warning }], ['done', { status: 'error', rounds: 1 }]]);
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('agent.emptyTitle');
  fireEvent.change(view.getByRole('textbox', { name: 'agent.inputLabel' }), { target: { value: '请检查当前状态' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await view.findByText(`Agent 出错：${warning}`);
  await waitFor(() => assert.ok(view.queryByRole('button', { name: 'agent.send' })));
  assert.equal(view.getAllByText('请检查当前状态').length, 1);
  assert.ok(view.getByRole('alert').textContent.includes(warning));
  view.unmount();

  const reopened = renderPage(`session=${SESSION.id}`);
  await reopened.findByText(`Agent 出错：${warning}`);
  assert.equal(reopened.getAllByText('请检查当前状态').length, 1);
  assert.ok(reopened.getByRole('alert').textContent.includes(warning));
  assert.equal(reopened.container.querySelectorAll('[data-markdown]').length, 0, 'there is no empty assistant bubble');
});

// ---- 上下文占用与压缩 ----

/** 占用与压缩相关文案按真实格式渲染，其余键原样返回 */
function withContextLabels(t) {
  const original = mocks['@/lib/i18n-context'].useTranslation;
  const labels = {
    'agent.context.label': '上下文占用 {percent}%',
    'agent.context.usedValue': '{used} / {window}（{percent}%）',
    'agent.context.thresholdValue': '超过 {tokens}（{percent}%）时',
    'agent.context.lastUsageValue': '输入 {prompt} · 输出 {completion}',
    'agent.context.cached': '缓存命中 {cached}',
    'agent.event.compaction': '上下文已压缩（压缩前约 {tokens} token）',
  };
  mocks['@/lib/i18n-context'].useTranslation = () => ({ t: key => labels[key] ?? key });
  t.after(() => { mocks['@/lib/i18n-context'].useTranslation = original; });
}

const CONTEXT = { window: 272000, used: 54400, threshold: 204492, last_usage: { prompt_tokens: 51234, completion_tokens: 812, cached_tokens: 48000 } };

test('the composer shows context usage and its details, without real usage when there is none', async t => {
  withContextLabels(t);
  let context = CONTEXT;
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: HISTORY, running: false, context });
    if (call.url === '/api/agent/status') return json(STATUS);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  const meter = await view.findByRole('button', { name: '上下文占用 20%' });
  assert.equal(view.queryByRole('dialog', { name: 'agent.context.title' }), null);
  await act(async () => { meter.focus(); });
  assert.ok(view.getByRole('dialog', { name: 'agent.context.title' }), 'keyboard focus opens the details');
  fireEvent.click(meter);
  const panel = view.getByRole('dialog', { name: 'agent.context.title' });
  assert.ok(within(panel).getByText('54.4k / 272k（20%）'));
  assert.ok(within(panel).getByText('超过 204k（75%）时'));
  assert.ok(within(panel).getByText('输入 51.2k · 输出 812'));
  assert.ok(within(panel).getByText('缓存命中 48k'));
  await act(async () => { view.getByRole('textbox', { name: 'agent.inputLabel' }).focus(); });
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog', { name: 'agent.context.title' }), null);
  assert.equal(document.activeElement, meter, 'focus returns to the meter');

  // 没有真实 usage 时只显示估算
  context = { ...CONTEXT, last_usage: null };
  cleanup();
  const second = renderPage(`session=${SESSION.id}`);
  fireEvent.click(await second.findByRole('button', { name: '上下文占用 20%' }));
  const bare = second.getByRole('dialog', { name: 'agent.context.title' });
  assert.equal(within(bare).queryByText('agent.context.lastUsage'), null);
});

test('switching the composer model refreshes the session context calibration', async t => {
  withContextLabels(t);
  let selected = 'fake-model';
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      return json({ session: SESSION, messages: HISTORY, running: false, context: { ...CONTEXT, used: selected === 'fake-model' ? 163200 : 54400 } });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/models') return json({ models: ['fake-model', 'deep-model'] });
    if (call.url === '/api/settings' && call.method === 'PUT') {
      selected = call.body.agent_model;
      return json({ ok: true });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByRole('button', { name: '上下文占用 60%' });
  fireEvent.click(await view.findByRole('button', { name: 'fake-model' }));
  fireEvent.click(await view.findByRole('option', { name: 'deep-model' }));
  await view.findByRole('button', { name: '上下文占用 20%' });
  assert.equal(selected, 'deep-model');
  assert.equal(calls.filter(call => call.url === `/api/agent/sessions/${SESSION.id}`).length, 2);
});

test('switching the composer model during a turn keeps its live context until the turn finishes', async t => {
  withContextLabels(t);
  let selected = 'fake-model';
  let releaseStream;
  const gate = new Promise(resolve => { releaseStream = resolve; });
  t.after(() => releaseStream());
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      return json({ session: SESSION, messages: HISTORY, running: false, context: { ...CONTEXT, used: selected === 'fake-model' ? 163200 : 54400 } });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/models') return json({ models: ['fake-model', 'deep-model'] });
    if (call.url === '/api/settings' && call.method === 'PUT') {
      selected = call.body.agent_model;
      return json({ ok: true });
    }
    if (call.url === '/api/agent/chat') {
      return sseResponse([
        ['context', { ...CONTEXT, used: 108800 }],
        ['text', { text: '这一轮完成了。' }],
        ['done', { status: 'done', rounds: 1 }],
      ], { gateAt: 1, gate });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByRole('button', { name: '上下文占用 60%' });
  fireEvent.change(view.getByRole('textbox', { name: 'agent.inputLabel' }), { target: { value: '继续' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await view.findByRole('button', { name: '上下文占用 40%' });
  const readsBefore = calls.filter(call => call.url === `/api/agent/sessions/${SESSION.id}`).length;
  const statusReadsBefore = calls.filter(call => call.url === '/api/agent/status').length;
  fireEvent.click(await view.findByRole('button', { name: 'fake-model' }));
  fireEvent.click(await view.findByRole('option', { name: 'deep-model' }));
  await waitFor(() => assert.ok(calls.filter(call => call.url === '/api/agent/status').length > statusReadsBefore));
  assert.equal(selected, 'deep-model');
  assert.equal(calls.filter(call => call.url === `/api/agent/sessions/${SESSION.id}`).length, readsBefore);
  assert.ok(view.getByRole('button', { name: '上下文占用 40%' }), 'the running turn still uses its original model');

  await act(async () => { releaseStream(); });
  await view.findByRole('button', { name: '上下文占用 20%' });
  await view.findByRole('button', { name: 'agent.send' });
  assert.equal(calls.filter(call => call.url === `/api/agent/sessions/${SESSION.id}`).length, readsBefore + 1);
});

test('a session without context data shows no meter', async () => {
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: HISTORY, running: false, context: null });
    if (call.url === '/api/agent/status') return json(STATUS);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByText('没有失败的提取任务。');
  assert.equal(view.queryByRole('button', { name: 'agent.context.label' }), null);
});

test('a live turn updates the meter, shows compaction progress, then the stored divider expands to the summary', async t => {
  withContextLabels(t);
  let releaseStream;
  const gate = new Promise(resolve => { releaseStream = resolve; });
  let afterTurn = false;
  const compactionEvent = { kind: 'compaction', through_id: 5, summary: '主人想清理星野的重复记忆，已查看 mem-1。', tokens_before: 210000 };
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) {
      const messages = afterTurn
        ? [...HISTORY, storedMessage(6, 'user', { content: '继续' }), storedMessage(7, 'event', { event: compactionEvent }), storedMessage(8, 'assistant', { content: '接着整理。' })]
        : HISTORY;
      return json({ session: SESSION, messages, running: false, context: afterTurn ? { ...CONTEXT, used: 13600 } : { ...CONTEXT, used: 209000 } });
    }
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') {
      afterTurn = true;
      return sseResponse([
        ['compaction', { phase: 'start' }],
        ['compaction', { phase: 'done', through_id: 5, summary: compactionEvent.summary, tokens_before: 210000 }],
        ['context', { ...CONTEXT, used: 13600 }],
        ['text', { text: '接着整理。' }],
        ['done', { status: 'done', rounds: 1 }],
      ], { gateAt: 1, gate });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await view.findByRole('button', { name: '上下文占用 77%' });

  fireEvent.change(view.getByRole('textbox', { name: 'agent.inputLabel' }), { target: { value: '继续' } });
  fireEvent.click(view.getByRole('button', { name: 'agent.send' }));
  await view.findByText('agent.event.compacting');

  await act(async () => { releaseStream(); });
  await view.findByText('接着整理。');
  await waitFor(() => assert.ok(view.getByRole('button', { name: '上下文占用 5%' })));
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'agent.send' })));
  assert.equal(view.queryByText('agent.event.compacting'), null);

  const divider = view.getByText('上下文已压缩（压缩前约 210k token）').closest('details');
  assert.equal(divider.open, false);
  assert.ok(within(divider).getByText(compactionEvent.summary));
  fireEvent.click(within(divider).getByText('上下文已压缩（压缩前约 210k token）'));
  assert.equal(divider.open, true);
  assert.equal(view.getAllByText('上下文已压缩（压缩前约 210k token）').length, 1, 'the live divider is replaced by the stored one');
});

const TASK_PLAN = {
  goal: '审查星野全部记忆',
  steps: [{ id: 'duplicates', title: '核对重复事实', status: 'completed', result: 'mem-1 与 mem-2 来源一致' }, { id: 'conflicts', title: '核对时间变化', status: 'pending' }],
  round_goal: '核对第一批重复事实',
  progress: '已审查 mem-1、mem-2，其他批次尚未审查',
  unresolved: ['mem-3 缺少来源，需核验'],
  next_round: '读取下一批并核验时间变化',
  recommend_compaction: true,
};

test('the latest task plan shows results and the next round without rendering its event as an error', async () => {
  const planEvent = storedMessage(6, 'event', { event: { kind: 'task_plan', plan: TASK_PLAN } });
  assert.equal(buildAgentDisplayItems([planEvent]).length, 0, 'the independent plan replaces event-note rendering');
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: [...HISTORY, planEvent], running: false, context: CONTEXT, task_plan: TASK_PLAN });
    if (call.url === '/api/agent/status') return json(STATUS);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  const plan = (await view.findByText('agent.plan.title')).closest('details');
  assert.equal(plan.open, false);
  assert.ok(within(plan).getByText('agent.plan.compactRecommended'));
  fireEvent.click(within(plan).getByText('agent.plan.title'));
  assert.equal(plan.open, true);
  assert.ok(plan.textContent.includes(TASK_PLAN.progress));
  assert.ok(plan.textContent.includes(TASK_PLAN.next_round));
  assert.ok(plan.textContent.includes(TASK_PLAN.steps[0].result));
  assert.ok(plan.textContent.includes(TASK_PLAN.unresolved[0]));
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(view.queryByText('agent.event.error'), null);
});

/** 一轮：主人消息 → 保存计划 → 以工具调用收尾；`after` 是收尾后同一轮里的其他记录 */
function planRound(firstId, plan, { text = '', after = [] } = {}) {
  return [
    storedMessage(firstId, 'user', { content: `第 ${firstId} 条主人消息` }),
    storedMessage(firstId + 1, 'event', { event: { kind: 'task_plan', plan } }),
    storedMessage(firstId + 2, 'assistant', { content: text, tool_calls: [{ id: `call_${firstId}`, name: 'update_task_plan', arguments: '{}' }] }),
    storedMessage(firstId + 3, 'tool', { content: '{"ok":true,"saved":true,"round_complete":true}', tool_call_id: `call_${firstId}`, tool_name: 'update_task_plan', tool_ok: true }),
    ...after.map((fields, index) => storedMessage(firstId + 4 + index, fields.role, fields)),
  ];
}

test('rounds that end on a tool call get a summary from the plan saved in that round', () => {
  const finished = planRound(1, { ...TASK_PLAN, progress: '已读完第 0–1 批', next_round: '读第 2 批' }, {
    text: '现在更新计划并汇报。',
    after: [{ role: 'event', event: { kind: 'proposal_decision', proposal_id: 1, items: [] } }],
  });
  const answered = [
    storedMessage(20, 'user', { content: '为什么停了' }),
    storedMessage(21, 'assistant', { content: '因为本轮目标已达成。' }),
  ];
  const interrupted = planRound(30, TASK_PLAN, { after: [{ role: 'event', event: { kind: 'interrupted' } }] });
  const noPlan = [
    storedMessage(40, 'user', { content: '答辩是 27 号' }),
    storedMessage(41, 'assistant', { content: '', tool_calls: [{ id: 'call_41', name: 'create_memory_proposal', arguments: '{}' }] }),
    storedMessage(42, 'tool', { content: '{"ok":true,"proposal_id":9}', tool_call_id: 'call_41', tool_name: 'create_memory_proposal', tool_ok: true }),
  ];
  const last = planRound(50, { ...TASK_PLAN, progress: '已读完第 2 批', next_round: '' });
  const messages = [...finished, ...answered, ...interrupted, ...noPlan, ...last];

  const items = buildAgentDisplayItems(messages);
  const summaries = items.filter(item => item.kind === 'round_summary');
  assert.deepEqual(summaries.map(item => [item.key, item.progress, item.nextRound]), [
    ['summary-3', '已读完第 0–1 批', '读第 2 批'],
    ['summary-52', '已读完第 2 批', ''],
  ]);
  const kinds = items.map(item => item.kind);
  assert.deepEqual(kinds.slice(0, 5), ['user', 'assistant', 'tool', 'round_summary', 'event'], 'the summary follows the tools, before later decisions');

  const blocks = groupAgentDisplayItems(buildAgentDisplayItems(noPlan.concat(last)));
  assert.deepEqual(blocks.map(block => block.kind === 'tools' ? 'tools' : block.item.kind), ['user', 'tools', 'proposal', 'user', 'tools', 'round_summary']);

  const running = buildAgentDisplayItems(messages, { lastRoundOpen: true }).filter(item => item.kind === 'round_summary');
  assert.deepEqual(running.map(item => item.key), ['summary-3'], 'a round still running on the server gets no summary yet');
});

test('a proposal waiting for a decision holds back the continue button until it is decided', async () => {
  const proposalResult = (id, pending) => storedMessage(id, 'tool', {
    content: `${JSON.stringify({ ok: true, proposal_id: id, pending_items: pending, reported_conflicts: 0 })}\n[提醒] 重复调用`,
    tool_call_id: `call_p${id}`, tool_name: 'create_memory_proposal', tool_ok: true,
  });
  const decision = (id, proposalId) => storedMessage(id, 'event', { event: { kind: 'proposal_decision', proposal_id: proposalId, items: [] } });
  assert.equal(hasUndecidedProposal([proposalResult(1, 2)]), true);
  assert.equal(hasUndecidedProposal([proposalResult(1, 2), decision(2, 1)]), false);
  assert.equal(hasUndecidedProposal([proposalResult(1, 0)]), false, 'a conflict-only proposal has nothing to decide');
  assert.equal(hasUndecidedProposal([proposalResult(1, 2), decision(2, 7)]), true, 'another proposal\'s decision does not count');
  assert.equal(hasUndecidedProposal([storedMessage(1, 'tool', { content: '{"ok":false,"error":"提案未创建"}', tool_name: 'create_memory_proposal', tool_ok: false })]), false);

  let messages = [...planRound(1, TASK_PLAN), storedMessage(5, 'assistant', { content: '', tool_calls: [{ id: 'call_p9', name: 'create_memory_proposal', arguments: '{}' }] }), proposalResult(9, 1)];
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages, running: false, context: CONTEXT, task_plan: TASK_PLAN });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/proposals/9') {
      return json({ id: 9, session_id: SESSION.id, character_id: 'char-a', summary: '虚构提案', status: 'pending', created_at: '', decided_at: null, items: [], evidence_messages: [] });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  await waitFor(() => assert.ok(view.container.querySelector('[data-round-summary]')));
  assert.equal(view.queryByRole('button', { name: 'agent.continueRound' }), null);
  cleanup();

  messages = [...messages, decision(11, 9)];
  const decided = renderPage(`session=${SESSION.id}`);
  assert.ok(await decided.findByRole('button', { name: 'agent.continueRound' }));
});

test('the page shows round summaries and a continue button that sends the continue prompt', async () => {
  const first = { ...TASK_PLAN, progress: '已读完第 0 批', next_round: '读第 1 批' };
  const plan = { ...TASK_PLAN, progress: '已读完第 0–1 批', next_round: '读第 2 批' };
  let messages = [...planRound(1, first), ...planRound(10, plan)];
  let taskPlan = plan;
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages, running: false, context: CONTEXT, task_plan: taskPlan });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/chat') {
      messages = [...messages, storedMessage(5, 'user', { content: call.body.content }), storedMessage(6, 'assistant', { content: '全部完成。' })];
      taskPlan = { ...plan, steps: plan.steps.map(step => ({ ...step, status: 'completed' })) };
      return sseResponse([['text', { text: '全部完成。' }], ['done', { status: 'done', rounds: 1 }]]);
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  const [older, summary] = await waitFor(() => {
    const elements = view.container.querySelectorAll('[data-round-summary]');
    assert.equal(elements.length, 2);
    return elements;
  });
  assert.equal(older.open, false, 'earlier cumulative summaries start collapsed');
  assert.equal(summary.open, true, 'the latest summary is open');
  assert.match(summary.textContent, /已读完第 0–1 批/);
  assert.match(summary.textContent, /读第 2 批/);

  fireEvent.click(await view.findByRole('button', { name: 'agent.continueRound' }));
  await view.findByText('全部完成。');
  assert.deepEqual(calls.find(call => call.url === '/api/agent/chat').body, { session_id: SESSION.id, content: 'agent.proposal.continuePrompt' });
  await waitFor(() => assert.equal(view.queryByRole('button', { name: 'agent.continueRound' }), null, 'a finished plan offers no continue button'));
  assert.equal(view.container.querySelectorAll('[data-round-summary]').length, 2, 'the answered round needs no summary');
});

test('manual compaction sends JSON, blocks decisions and sending, refreshes context, and never starts a round', async t => {
  withContextLabels(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let compacted = false;
  const proposalMessages = [
    storedMessage(6, 'assistant', { tool_calls: [{ id: 'proposal-call', name: 'create_memory_proposal', arguments: '{}' }] }),
    storedMessage(7, 'tool', { tool_call_id: 'proposal-call', tool_name: 'create_memory_proposal', tool_ok: true, content: '{"ok":true,"proposal_id":71}' }),
  ];
  const summary = '已审查 mem-1、mem-2，下一轮继续检查时间变化。';
  const calls = installFetch(async call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}/compact`) {
      await gate;
      compacted = true;
      return json({ compacted: true });
    }
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({
      session: SESSION, running: false, task_plan: TASK_PLAN,
      context: compacted ? { ...CONTEXT, used: 13600 } : CONTEXT,
      messages: [...HISTORY, ...proposalMessages, ...(compacted ? [storedMessage(8, 'event', { event: { kind: 'compaction', through_id: 7, summary, tokens_before: 54400 } })] : [])],
    });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url === '/api/agent/proposals/71') return json({
      id: 71, session_id: SESSION.id, character_id: 'char-a', summary: '待确认的虚构提案', status: 'pending', created_at: SESSION.created_at,
      items: [{ id: 72, seq: 1, op: 'create', reason: '虚构理由', confidence: 0.9, evidence: { message_ids: [] }, before: null, after: { content: '虚构记忆', category: 'fact' }, state: 'pending' }], evidence_messages: [],
    });
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  const approve = await view.findByRole('button', { name: 'agent.proposal.approveContinue' });
  assert.equal(approve.disabled, false);
  const input = view.getByRole('textbox', { name: 'agent.inputLabel' });
  fireEvent.change(input, { target: { value: '继续下一轮' } });
  fireEvent.click(await view.findByRole('button', { name: '上下文占用 20%' }));
  fireEvent.click(view.getByRole('button', { name: 'agent.context.compact' }));
  await waitFor(() => assert.equal(calls.filter(call => call.url.endsWith('/compact')).length, 1));
  const compactCall = calls.find(call => call.url.endsWith('/compact'));
  assert.equal(compactCall.method, 'POST');
  assert.equal(compactCall.headers.get('content-type'), 'application/json');
  assert.ok(view.getAllByText('agent.context.compacting').length > 0);
  assert.equal(approve.disabled, true);
  assert.equal(view.getByRole('button', { name: 'agent.context.compacting' }).disabled, true);
  assert.ok(view.getByRole('button', { name: 'agent.stop' }));
  fireEvent.keyDown(input, { key: 'Enter' });
  assert.equal(calls.filter(call => call.url === '/api/agent/chat').length, 0);
  await act(async () => { release(); });
  await view.findByRole('button', { name: '上下文占用 5%' });
  await waitFor(() => assert.equal(approve.disabled, false));
  assert.equal(input.value, '继续下一轮', 'manual compaction preserves the draft');
  assert.equal(view.getAllByText('上下文已压缩（压缩前约 54.4k token）').length, 1);
  assert.ok(view.getByText(summary));
  assert.equal(calls.filter(call => call.url === '/api/agent/chat').length, 0, 'the next round is explicitly started by the user');
  assert.ok(toasts.some(toast => toast.message === 'agent.context.compacted'));
});

test('stopping manual compaction aborts the request and restores the idle controls without an error', async t => {
  withContextLabels(t);
  let compactSignal;
  let stopCount = 0;
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: HISTORY, running: false, context: CONTEXT });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url.endsWith('/compact')) {
      compactSignal = call.signal;
      return new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => { stopCount += 1; reject(new DOMException('aborted', 'AbortError')); }, { once: true }));
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  fireEvent.click(await view.findByRole('button', { name: '上下文占用 20%' }));
  fireEvent.click(view.getByRole('button', { name: 'agent.context.compact' }));
  await view.findByRole('button', { name: 'agent.stop' });
  fireEvent.click(view.getByRole('button', { name: 'agent.stop' }));
  await view.findByRole('button', { name: 'agent.send' });
  assert.equal(compactSignal.aborted, true);
  assert.equal(stopCount, 1);
  assert.equal(toasts.length, 0);
  assert.equal(calls.filter(call => call.url === '/api/agent/chat').length, 0);
  assert.equal(view.queryByText('agent.event.compactionShort'), null);
});

test('failed manual compaction keeps the history and exposes a usable retry', async t => {
  withContextLabels(t);
  let attempts = 0;
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: HISTORY, running: false, context: CONTEXT });
    if (call.url === '/api/agent/status') return json(STATUS);
    if (call.url.endsWith('/compact')) {
      attempts += 1;
      return attempts === 1 ? json({ error: '虚构摘要接口暂时不可用' }, 500) : json({ compacted: false });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  fireEvent.click(await view.findByRole('button', { name: '上下文占用 20%' }));
  fireEvent.click(view.getByRole('button', { name: 'agent.context.compact' }));
  await waitFor(() => assert.ok(toasts.some(toast => toast.message.includes('虚构摘要接口暂时不可用'))));
  const retry = view.getByRole('button', { name: 'agent.context.compact' });
  assert.equal(retry.disabled, false);
  assert.ok(view.getByText('没有失败的提取任务。'));
  assert.ok(view.getByRole('button', { name: '上下文占用 20%' }));
  fireEvent.click(retry);
  await waitFor(() => assert.equal(attempts, 2));
  await waitFor(() => assert.ok(toasts.some(toast => toast.message === 'agent.context.nothingToCompact')));
  assert.equal(view.queryByText('agent.event.compactionShort'), null);
});

test('a late compaction response stays with its session and an A to B to A navigation suppresses stale notices', async t => {
  withContextLabels(t);
  const other = { ...SESSION, id: 'agent-session-2', title: '另一个会话' };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let compacted = false;
  const calls = installFetch(async call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION, other], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}/compact`) { await gate; compacted = true; return json({ compacted: true }); }
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: HISTORY, running: false, context: compacted ? { ...CONTEXT, used: 13600 } : CONTEXT });
    if (call.url === `/api/agent/sessions/${other.id}`) return json({ session: other, messages: [storedMessage(9, 'assistant', { content: '其他会话的历史' })], running: false, context: { ...CONTEXT, used: 27200 } });
    if (call.url === '/api/agent/status') return json(STATUS);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = renderPage(`session=${SESSION.id}`);
  fireEvent.click(await view.findByRole('button', { name: '上下文占用 20%' }));
  fireEvent.click(view.getByRole('button', { name: 'agent.context.compact' }));
  await view.findByRole('button', { name: 'agent.stop' });
  fireEvent.click(view.getByRole('button', { name: /^另一个会话/ }));
  await view.findByText('其他会话的历史');
  assert.equal(view.queryByText('agent.context.compacting'), null);
  assert.ok(view.getByRole('button', { name: '上下文占用 10%' }));
  assert.equal(view.queryByRole('button', { name: 'agent.stop' }), null);
  fireEvent.click(view.getByRole('button', { name: new RegExp(`^${SESSION.title}`) }));
  await view.findByRole('button', { name: 'agent.stop' });
  await act(async () => { release(); });
  await view.findByRole('button', { name: '上下文占用 5%' });
  await view.findByRole('button', { name: 'agent.send' });
  assert.equal(toasts.length, 0, 'navigation changes invalidate the original operation notice even after returning to A');
  assert.equal(calls.filter(call => call.url === '/api/agent/chat').length, 0);
  assert.equal(calls.filter(call => call.url === `/api/agent/sessions/${other.id}`).length, 1, 'completion only refreshes A');
});
