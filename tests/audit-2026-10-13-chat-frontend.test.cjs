const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

// 2026-10-13 外部审计的聊天前端缺陷回归（行为测试）：
// F14 消息/总结编辑保存失败丢草稿、F15 附件读取/上传异常未捕获、F16 重置提取弹窗加载失败后卡在 loading。
// F05 / F12（ChatView 竞态）见 audit-2026-10-13-chat-view-races.test.cjs。
const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 1 });

const { act, cleanup, fireEvent, render, renderHook, waitFor } = require('@testing-library/react');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
const originalFetch = global.fetch;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.extensions['.ts'] = loadTypeScript;
require.extensions['.tsx'] = loadTypeScript;

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

function icon() {
  return React.createElement('span', { 'aria-hidden': 'true' });
}

// 附件类文案保留 {name} 占位符，方便断言「提示的是哪一个文件」
const translate = key => (key.startsWith('input.attach') ? `${key} {name}` : key);

function loadModule(relativePath, extraMocks = {}) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(extraMocks, request)) return extraMocks[request];
    if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t: translate }) };
    if (request === '@/components/ui/icons') return new Proxy({}, { get: () => icon });
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve(path.join(root, relativePath));
    delete require.cache[resolved];
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

const noop = () => {};
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function chatMessage(overrides = {}) {
  return {
    id: 'message-1',
    conversation_id: 'conv-a',
    role: 'user',
    content: 'original text',
    metadata: {},
    token_count: 1,
    created_at: '2026-10-13T00:00:00.000Z',
    seq: 1,
    ...overrides,
  };
}

test.afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  delete global.FileReader;
});
test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

// ── F14：消息 / 总结编辑要等保存结果 ──────────────────────────────────────────

const bubbleMocks = {
  'react-markdown': { __esModule: true, default: ({ children }) => React.createElement('span', null, children) },
  'remark-gfm': { __esModule: true, default: () => {} },
  '@/components/chat/ImageGenCard': { __esModule: true, default: () => null },
  '@/components/chat/ReservedChatImage': { __esModule: true, default: () => null },
};

function loadMessageActionsHook() {
  return loadModule('src/hooks/chat/useChatMessageActions.ts', {
    '@/lib/image-blob-cache': { forgetImageBlobs: async () => {} },
  }).useChatMessageActions;
}

function messageActionOptions(overrides = {}) {
  return {
    activeConvIdRef: { current: 'conv-a' },
    activeStreamsRef: { current: new Set() },
    messagesRef: { current: [] },
    beginStream: noop,
    finishStream: noop,
    scheduleStreamingText: noop,
    setStreamingUsage: noop,
    pollMemoryTask: noop,
    refreshMessagesForConversation: async () => {},
    refreshMessageCountsForConversation: async () => {},
    touchConversation: noop,
    updateMessagesForConversation: noop,
    markSkipNextScroll: noop,
    showToast: noop,
    t: key => key,
    pageSize: 60,
    maybeAutoGenerateImageFromMessages: noop,
    ...overrides,
  };
}

test('F14: handleEditMessage resolves to whether the edit was saved', async () => {
  const useChatMessageActions = loadMessageActionsHook();
  const toasts = [];
  let refreshFails = false;
  const options = messageActionOptions({
    showToast: (text, type) => toasts.push([text, type]),
    refreshMessagesForConversation: async () => {
      if (refreshFails) throw new Error('refresh unavailable');
    },
  });
  const { result } = renderHook(() => useChatMessageActions(options));

  global.fetch = async () => json({ error: 'edit unavailable' }, 503);
  let outcome;
  await act(async () => { outcome = await result.current.handleEditMessage('message-1', 'draft'); });
  assert.equal(outcome, false, 'a rejected PUT must be reported as a failed save');
  assert.deepEqual(toasts, [['edit unavailable', 'error']]);

  global.fetch = async () => json(chatMessage({ content: 'draft' }));
  await act(async () => { outcome = await result.current.handleEditMessage('message-1', 'draft'); });
  assert.equal(outcome, true);

  // PUT 已成功、只是后续重拉失败：编辑本身已落库，不能让编辑框以为保存失败
  refreshFails = true;
  await act(async () => { outcome = await result.current.handleEditMessage('message-1', 'draft'); });
  assert.equal(outcome, true, 'a failed follow-up refresh must not report a saved edit as failed');
  assert.deepEqual(toasts.at(-1), ['refresh unavailable', 'error']);

  options.activeConvIdRef.current = null;
  await act(async () => { outcome = await result.current.handleEditMessage('message-1', 'draft'); });
  assert.equal(outcome, false, 'nothing is saved without an active conversation');
});

test('F14: a failed message edit keeps the editor open with the draft and can be retried', async () => {
  const useChatMessageActions = loadMessageActionsHook();
  const MessageBubble = loadModule('src/components/chat/MessageBubble.tsx', bubbleMocks).default;
  const toasts = [];
  const requests = [];
  global.fetch = async (url, init) => {
    const request = deferred();
    requests.push({ url, body: JSON.parse(init.body), ...request });
    return request.promise;
  };
  const message = chatMessage();
  const options = messageActionOptions({
    messagesRef: { current: [message] },
    showToast: (text, type) => toasts.push([text, type]),
  });
  function Harness() {
    const actions = useChatMessageActions(options);
    return React.createElement(MessageBubble, {
      message,
      characterName: 'Alice',
      avatarUrl: null,
      onEdit: actions.handleEditMessage,
    });
  }
  const view = render(React.createElement(Harness));

  fireEvent.click(view.getByRole('button', { name: 'message.edit' }));
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'draft correction' } });
  fireEvent.click(view.getByRole('button', { name: 'common.save' }));

  // 保存进行中：编辑框还在，保存按钮禁用，重复触发不会再发一次请求
  assert.ok(view.queryByRole('textbox'), 'the editor must stay open until the save settles');
  assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, true);
  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { content: 'draft correction', attachments: [] });

  await act(async () => { requests[0].resolve(json({ error: 'edit unavailable' }, 503)); });
  assert.deepEqual(toasts, [['edit unavailable', 'error']]);
  assert.equal(view.getByRole('textbox').value, 'draft correction', 'the draft must survive a failed save');
  assert.equal(view.getByRole('button', { name: 'common.save' }).disabled, false);

  fireEvent.click(view.getByRole('button', { name: 'common.save' }));
  assert.equal(requests.length, 2);
  await act(async () => { requests[1].resolve(json(chatMessage({ content: 'draft correction' }))); });
  assert.ok(view.queryByRole('textbox') === null, 'a successful save leaves edit mode');
});

test('F14: a failed summary edit keeps the editor open with the draft', async () => {
  const MessageBubble = loadModule('src/components/chat/MessageBubble.tsx', bubbleMocks).default;
  const saves = [];
  const onEdit = (id, content) => {
    const save = deferred();
    saves.push({ id, content, ...save });
    return save.promise;
  };
  const view = render(React.createElement(MessageBubble, {
    message: chatMessage({ id: 'summary-1', role: 'system', content: 'old summary', metadata: { isSummary: true } }),
    characterName: 'Alice',
    avatarUrl: null,
    onEdit,
  }));

  fireEvent.click(view.getByTitle('memory.edit'));
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'rewritten summary' } });
  fireEvent.click(view.getByRole('button', { name: 'memory.save' }));

  assert.ok(view.queryByRole('textbox'), 'the summary editor must stay open until the save settles');
  assert.equal(view.getByRole('button', { name: 'memory.save' }).disabled, true);
  fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  assert.deepEqual(saves.map(save => [save.id, save.content]), [['summary-1', 'rewritten summary']]);

  await act(async () => { saves[0].resolve(false); });
  assert.equal(view.getByRole('textbox').value, 'rewritten summary', 'the summary draft must survive a failed save');
  assert.equal(view.getByRole('button', { name: 'memory.save' }).disabled, false);

  fireEvent.click(view.getByRole('button', { name: 'memory.save' }));
  await act(async () => { saves[1].resolve(true); });
  assert.ok(view.queryByRole('textbox') === null, 'a successful save leaves edit mode');
});

test('F14: onEdit handlers that return nothing still close the editor', async () => {
  const MessageBubble = loadModule('src/components/chat/MessageBubble.tsx', bubbleMocks).default;
  const edits = [];
  const onEdit = (id, content) => { edits.push([id, content]); };

  const bubble = render(React.createElement(MessageBubble, {
    message: chatMessage(),
    characterName: 'Alice',
    avatarUrl: null,
    onEdit,
  }));
  fireEvent.click(bubble.getByRole('button', { name: 'message.edit' }));
  fireEvent.change(bubble.getByRole('textbox'), { target: { value: 'sync edit' } });
  await act(async () => { fireEvent.click(bubble.getByRole('button', { name: 'common.save' })); });
  assert.ok(bubble.queryByRole('textbox') === null);
  cleanup();

  const summary = render(React.createElement(MessageBubble, {
    message: chatMessage({ id: 'summary-1', role: 'system', content: 'old summary', metadata: { isSummary: true } }),
    characterName: 'Alice',
    avatarUrl: null,
    onEdit,
  }));
  fireEvent.click(summary.getByTitle('memory.edit'));
  fireEvent.change(summary.getByRole('textbox'), { target: { value: 'sync summary' } });
  await act(async () => { fireEvent.click(summary.getByRole('button', { name: 'memory.save' })); });
  assert.ok(summary.queryByRole('textbox') === null);

  assert.deepEqual(edits, [['message-1', 'sync edit'], ['summary-1', 'sync summary']]);
});

// ── F15：附件读取 / 上传异常按文件兜住 ────────────────────────────────────────

class FakeFileReader {
  readAsDataURL() {
    this.result = 'data:image/png;base64,QQ==';
    this.onload();
  }
}

// 选中文件并等处理落定；返回渲染结果与期间漏出的未处理 rejection。
async function attachFiles(files) {
  const ChatInput = loadModule('src/components/chat/ChatInput.tsx').default;
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason instanceof Error ? reason.message : String(reason));
  // node:test 自己也监听 unhandledRejection：会直接判当前用例失败并波及后续用例。
  // 这里临时接管，让「不得漏出未处理的 rejection」成为一条明确的断言。
  const runnerListeners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', onUnhandled);
  global.FileReader = FakeFileReader;
  try {
    const view = render(React.createElement(ChatInput, { disabled: false, onSend: noop }));
    fireEvent.change(view.container.querySelector('input[type=file]'), { target: { files } });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    return { view, unhandled };
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    for (const listener of runnerListeners) process.on('unhandledRejection', listener);
  }
}

test('F15: a rejected upload request reports that file and keeps attachments already read', async () => {
  global.fetch = async () => { throw new TypeError('Network unavailable'); };
  const { view, unhandled } = await attachFiles([
    new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    new File(['x'], 'photo.png', { type: 'image/png' }),
  ]);

  assert.deepEqual(unhandled, [], 'the network failure must not escape as an unhandled rejection');
  assert.ok(view.queryByText('input.attachUploadFail photo.png'), 'the failed file must be reported');
  assert.ok(view.queryByText('notes.txt'), 'attachments read before the failure must still be added');
  assert.ok(view.queryByText('photo.png') === null);
});

test('F15: an unparseable upload response fails only that file', async () => {
  global.fetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
  const { view, unhandled } = await attachFiles([
    new File(['x'], 'broken.png', { type: 'image/png' }),
    new File(['later'], 'later.md', { type: 'text/markdown' }),
  ]);

  assert.equal(unhandled.length, 0, `the parse failure must not escape as an unhandled rejection: ${unhandled.join('; ')}`);
  assert.ok(view.queryByText('input.attachUploadFail broken.png'), 'the failed file must be reported');
  assert.ok(view.queryByText('later.md'), 'files after the failed one must still be processed');
});

// ── F16：重置提取弹窗加载失败可见、可重试 ─────────────────────────────────────

function resetModalProps(overrides = {}) {
  return {
    open: true,
    conversationId: 'conv-a',
    conversation: { id: 'conv-a', ignore_memory: 0 },
    serverUnextractedCount: 0,
    memoryExtractStatus: 'idle',
    onClose: noop,
    onSubmit: async () => {},
    onToggleIgnore: async () => {},
    onManualExtract: async () => {},
    ...overrides,
  };
}

function deferredLoader() {
  const attempts = [];
  const loadAllMessages = conversationId => {
    const attempt = deferred();
    attempts.push({ conversationId, ...attempt });
    return attempt.promise;
  };
  return { attempts, loadAllMessages };
}

test('F16: ResetExtractionModal shows a retryable error when loading messages fails', async () => {
  const ResetExtractionModal = loadModule('src/components/chat/ResetExtractionModal.tsx').default;
  const { attempts, loadAllMessages } = deferredLoader();
  const view = render(React.createElement(ResetExtractionModal, resetModalProps({ loadAllMessages })));
  assert.ok(view.getByText('common.loading'));

  await act(async () => { attempts[0].reject(new Error('503')); });
  const alert = view.queryByRole('alert');
  assert.ok(alert, 'a failed load must surface an alert instead of spinning forever');
  assert.match(alert.textContent, /common\.loadFailed/);
  assert.ok(view.queryByText('common.loading') === null);

  fireEvent.click(view.getByRole('button', { name: 'common.retry' }));
  assert.deepEqual(attempts.map(attempt => attempt.conversationId), ['conv-a', 'conv-a']);
  assert.ok(view.queryByRole('alert') === null);
  assert.ok(view.getByText('common.loading'));

  await act(async () => {
    attempts[1].resolve([chatMessage({ content: 'remember the lighthouse' })]);
  });
  assert.ok(view.getByText('remember the lighthouse'));
  assert.ok(view.queryByRole('alert') === null);
  assert.ok(view.queryByText('common.loading') === null);
});

test('F16: a superseded load that fails late does not flip the newer attempt into the error state', async () => {
  const ResetExtractionModal = loadModule('src/components/chat/ResetExtractionModal.tsx').default;
  const first = deferredLoader();
  const second = deferredLoader();
  const view = render(React.createElement(ResetExtractionModal, resetModalProps({ loadAllMessages: first.loadAllMessages })));
  // 父组件重渲染换了 loadAllMessages 引用：effect 重跑，上一轮加载被取消
  view.rerender(React.createElement(ResetExtractionModal, resetModalProps({ loadAllMessages: second.loadAllMessages })));
  assert.equal(second.attempts.length, 1);

  await act(async () => { first.attempts[0].reject(new Error('late 503')); });
  assert.ok(view.queryByRole('alert') === null, 'a cancelled load must not report failure');
  assert.ok(view.getByText('common.loading'));

  await act(async () => { second.attempts[0].resolve([chatMessage({ content: 'fresh message' })]); });
  assert.ok(view.getByText('fresh message'));
});
