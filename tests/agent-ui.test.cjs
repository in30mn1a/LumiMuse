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
const { buildAgentDisplayItems } = require('../src/components/agent/AgentMessageList.tsx');
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 按事件分段推送的 SSE 响应；`gate` 用来把流卡在某个位置等测试推进。 */
function sseResponse(events, options = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const [index, [event, data]] of events.entries()) {
        if (options.gateAt === index) await options.gate;
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

function installFetch(handler) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
    calls.push(call);
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

  const status = view.getByRole('region', { name: 'agent.status.title' });
  await within(status).findByText('fake-model', { exact: false });
  assert.match(status.querySelector('[data-status="extraction"]').textContent, /2/);
  assert.match(status.querySelector('[data-status="repairable"]').textContent, /3/);

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
  installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
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
  await view.findByText('agent.event.roundLimit');
  assert.equal(view.queryByText('unreachable'), null);
  assert.equal(view.queryByRole('alert', { name: /AbortError/ }), null, 'a deliberate stop is not shown as an error');
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

test('an accepted stream failure shows an error without restoring or resending the saved message', async () => {
  let accepted = false;
  const savedMessage = { ...HISTORY[0], content: '已经保存的请求' };
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: accepted ? [savedMessage] : [], running: false });
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

  await waitFor(() => assert.deepEqual(toasts, [{ message: 'agent.streamInterrupted: stream disconnected', type: 'error' }]));
  assert.equal(input.value, '', 'an accepted message is not offered for accidental duplicate submission');
  assert.equal(view.getAllByText(savedMessage.content).length, 1);
  assert.equal(calls.filter(call => call.url === '/api/agent/chat').length, 1);
});

test('a stream that closes without done is reported as interrupted', async () => {
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
  await waitFor(() => assert.ok(toasts.some(toast => toast.message.startsWith('agent.streamInterrupted'))));
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
