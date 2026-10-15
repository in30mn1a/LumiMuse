const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

// 2026-10-13 外部审计的 ChatView 竞态回归（行为测试，渲染真实 ChatView + 真实数据 hook，只替换展示子组件与网络）：
// F05 删除对话的迟到结果不得改写另一个角色 / 另一段对话的界面；
// F12 模型 / 思考强度连续切换时，旧写入的迟到失败不得覆盖新的选择，界面必须与服务端一致。
const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 1 });

const { act, cleanup, fireEvent, render, waitFor } = require('@testing-library/react');

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

const noop = () => {};
// t / showToast 必须是稳定引用：ChatView 的设置加载 effect 依赖它们
const translate = key => key;
const toasts = [];
const showToast = (text, type) => toasts.push([text, type]);
let latestInput = null;

const scrollController = {
  highlightedId: null,
  activeScrollTargetId: null,
  messagesEndRef: { current: null },
  topSentinelRef: { current: null },
  scrollContainerRef: { current: null },
  markSkipNextScroll: noop,
  requestScrollToBottom: noop,
  markTargetForScroll: noop,
  markScrollToBottomOnLoad: noop,
  scrollToBottom: noop,
};

const mocks = {
  '@/lib/i18n-context': { useTranslation: () => ({ t: translate }) },
  '@/components/ui/icons': new Proxy({}, { get: () => () => React.createElement('span', { 'aria-hidden': 'true' }) }),
  '@/components/ui/Toast': { useToast: () => ({ showToast }) },
  '@/lib/token-counter-client': { estimateClientTokens: () => 1 },
  '@/lib/character-image-list-cache': { loadCharacterImageList: async () => [] },
  '@/lib/image-blob-cache': { forgetImageBlobs: async () => {} },
  '@/hooks/chat/useChatScrollController': { useChatScrollController: () => scrollController },
  '@/hooks/chat/useChatImageGeneration': {
    useChatImageGeneration: () => ({
      handleGenerateImage: noop,
      generatingImageMessageIds: new Set(),
      maybeAutoGenerateImageFromMessages: noop,
      handleDeleteImage: noop,
      handleEditImagePrompt: noop,
      handleSetPrimaryImage: noop,
    }),
  },
  'next/dynamic': { __esModule: true, default: () => () => null },
  './ImageManagerModal': { __esModule: true, default: () => null },
  './MessageBubble': { __esModule: true, default: () => null },
  './ChatToolbar': { __esModule: true, default: () => null },
  './ConversationListPanels': { ConversationDrawer: () => null },
  './ChatHeader': {
    __esModule: true,
    default: props => React.createElement('div', null,
      React.createElement('span', { 'data-testid': 'header' }, props.character.id),
      React.createElement('button', { onClick: props.onRequestDelete }, 'delete')),
  },
  './ChatInput': {
    __esModule: true,
    default: props => {
      latestInput = props;
      return React.createElement('div', null,
        React.createElement('span', { 'data-testid': 'model' }, props.currentModel),
        React.createElement('span', { 'data-testid': 'effort' }, props.reasoningEffort));
    },
  },
  './ChatMessageList': {
    __esModule: true,
    default: props => React.createElement('div', { 'data-testid': 'messages' },
      props.visibleMessages.map(message => message.content).join('|')),
  },
  './ChatModals': {
    __esModule: true,
    default: props => (props.deleteOpen
      ? React.createElement('button', { onClick: props.onConfirmDelete }, 'confirm delete')
      : null),
  },
};

// ChatView 运行期还会懒加载（import('./ImageManagerModal')），所以替身在整个文件期间保持安装
Module._load = function loadWithMocks(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const ChatView = require(path.join(root, 'src/components/chat/ChatView.tsx')).default;

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const character = id => ({ id, name: id, avatar_url: null });
const conversationIds = characterId => [1, 2, 3].map(index => `${characterId}-${index}`);

/**
 * 假后端：每个角色固定三段对话，每段对话一条内容为 `message:<对话 id>` 的消息。
 * DELETE 与 PUT /api/settings 的结果由各用例通过 handlers 控制。
 */
function installBackend(handlers = {}) {
  const server = {
    settings: { model: 'original', reasoning_effort: 'default', reasoning_effort_by_model: {} },
    settingsPuts: [],
    maxConcurrentSettingsPuts: 0,
  };
  let inFlightSettingsPuts = 0;
  global.fetch = async (url, init = {}) => {
    if (url === '/api/settings') {
      if (init.method !== 'PUT') return json(server.settings);
      const body = JSON.parse(init.body);
      server.settingsPuts.push(body);
      inFlightSettingsPuts += 1;
      server.maxConcurrentSettingsPuts = Math.max(server.maxConcurrentSettingsPuts, inFlightSettingsPuts);
      try {
        const outcome = await handlers.putSettings(body);
        if (!outcome.ok) return json({ error: outcome.error }, 503);
        Object.assign(server.settings, body);
        return json({ ok: true });
      } finally {
        inFlightSettingsPuts -= 1;
      }
    }
    if (init.method === 'DELETE') return handlers.deleteConversation(url);
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname === '/api/conversations') {
      const characterId = parsed.searchParams.get('character_id');
      return json(conversationIds(characterId).map(id => ({
        id, character_id: characterId, title: id, ignore_memory: 0, created_at: '', updated_at: '',
      })));
    }
    if (parsed.pathname === '/api/memories') return json([]);
    if (parsed.pathname === '/api/messages') {
      const conversationId = parsed.searchParams.get('conversation_id');
      return json({
        messages: [{
          id: `${conversationId}:m`, conversation_id: conversationId, role: 'user', content: `message:${conversationId}`,
          metadata: {}, token_count: 1, created_at: '', seq: 1,
        }],
        hasMore: false,
        oldestSeq: 1,
        unextractedCount: 1,
        totalTokens: 1,
      });
    }
    throw new Error(`Unexpected request: ${init.method || 'GET'} ${url}`);
  };
  return server;
}

/** 渲染 ChatView，并通过 onSidebarChatChange 观察它对外报告的角色 / 对话列表 / 选中对话。 */
function renderChatView(characterId, conversationId) {
  const sidebar = { current: null };
  const onSidebarChatChange = chat => { sidebar.current = chat; };
  const element = (nextCharacterId, nextConversationId) => React.createElement(ChatView, {
    character: character(nextCharacterId),
    conversationId: nextConversationId,
    onSidebarChatChange,
  });
  const view = render(element(characterId, conversationId));
  const snapshot = () => ({
    header: view.getByTestId('header').textContent,
    sidebarCharacter: sidebar.current?.characterId ?? null,
    conversations: (sidebar.current?.conversations ?? []).map(conversation => conversation.id),
    active: sidebar.current?.activeConversationId ?? null,
    messages: view.getByTestId('messages').textContent,
    deleteDialogOpen: Boolean(view.queryByText('confirm delete')),
  });
  const waitForConversation = (expectedCharacterId, expectedConversationId) => waitFor(() => {
    assert.deepEqual(snapshot(), {
      header: expectedCharacterId,
      sidebarCharacter: expectedCharacterId,
      conversations: conversationIds(expectedCharacterId),
      active: expectedConversationId,
      messages: `message:${expectedConversationId}`,
      deleteDialogOpen: false,
    });
  });
  return {
    view,
    sidebar,
    snapshot,
    waitForConversation,
    switchCharacter: (nextCharacterId, nextConversationId) => view.rerender(element(nextCharacterId, nextConversationId)),
    confirmDelete() {
      fireEvent.click(view.getByText('delete'));
      fireEvent.click(view.getByText('confirm delete'));
    },
  };
}

test.beforeEach(() => {
  toasts.length = 0;
  latestInput = null;
});
test.afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});
test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

// ── F05：删除对话的迟到结果 ───────────────────────────────────────────────────
// 角色缓存 / 消息缓存是模块级的，各用例用不同的角色 id 互不干扰。

test('F05: a delete that fails after switching character leaves the new character view alone', async () => {
  const deletion = deferred();
  installBackend({ deleteConversation: () => deletion.promise });
  const chat = renderChatView('f05a', 'f05a-1');
  await chat.waitForConversation('f05a', 'f05a-1');

  chat.confirmDelete();
  chat.switchCharacter('f05b', 'f05b-2');
  await chat.waitForConversation('f05b', 'f05b-2');

  await act(async () => { deletion.resolve(json({ error: 'delete unavailable' }, 503)); });
  await act(async () => { await pause(30); });

  assert.deepEqual(chat.snapshot(), {
    header: 'f05b',
    sidebarCharacter: 'f05b',
    conversations: conversationIds('f05b'),
    active: 'f05b-2',
    messages: 'message:f05b-2',
    // 重开确认弹窗会让「确认」删掉新角色当前的对话
    deleteDialogOpen: false,
  });
  assert.deepEqual(toasts, [['delete unavailable', 'error']], 'the failure must still be reported');
});

test('F05: a delete that succeeds after switching character does not re-select a conversation in the new character', async () => {
  const deletion = deferred();
  installBackend({ deleteConversation: () => deletion.promise });
  const chat = renderChatView('f05c', 'f05c-1');
  await chat.waitForConversation('f05c', 'f05c-1');

  chat.confirmDelete();
  chat.switchCharacter('f05d', 'f05d-2');
  await chat.waitForConversation('f05d', 'f05d-2');

  await act(async () => { deletion.resolve(json({ ok: true, deletedUrls: [] })); });
  await act(async () => { await pause(30); });

  assert.deepEqual(chat.snapshot(), {
    header: 'f05d',
    sidebarCharacter: 'f05d',
    conversations: conversationIds('f05d'),
    active: 'f05d-2',
    messages: 'message:f05d-2',
    deleteDialogOpen: false,
  });
  assert.deepEqual(toasts, []);
});

test('F05: a delete that fails after the user opened another conversation does not pull them back', async () => {
  const deletion = deferred();
  installBackend({ deleteConversation: () => deletion.promise });
  const chat = renderChatView('f05e', 'f05e-1');
  await chat.waitForConversation('f05e', 'f05e-1');

  chat.confirmDelete();
  await chat.waitForConversation('f05e', 'f05e-2');
  act(() => { chat.sidebar.current.onSelectConversation('f05e-3'); });
  await chat.waitForConversation('f05e', 'f05e-3');

  await act(async () => { deletion.resolve(json({ error: 'delete unavailable' }, 503)); });
  await act(async () => { await pause(30); });

  assert.deepEqual(chat.snapshot(), {
    header: 'f05e',
    sidebarCharacter: 'f05e',
    conversations: conversationIds('f05e'),
    active: 'f05e-3',
    messages: 'message:f05e-3',
    // 此刻选中的已不是当初确认删除的那段对话，弹窗不能重开
    deleteDialogOpen: false,
  });
  assert.deepEqual(toasts, [['delete unavailable', 'error']]);
});

test('F05: a failed delete still rolls back when the view has not moved', async () => {
  const deletion = deferred();
  installBackend({ deleteConversation: () => deletion.promise });
  const chat = renderChatView('f05f', 'f05f-1');
  await chat.waitForConversation('f05f', 'f05f-1');

  chat.confirmDelete();
  await chat.waitForConversation('f05f', 'f05f-2');

  await act(async () => { deletion.resolve(json({ error: 'delete unavailable' }, 503)); });
  await waitFor(() => assert.deepEqual(chat.snapshot(), {
    header: 'f05f',
    sidebarCharacter: 'f05f',
    conversations: conversationIds('f05f'),
    active: 'f05f-1',
    messages: 'message:f05f-1',
    deleteDialogOpen: true,
  }));
  assert.deepEqual(toasts, [['delete unavailable', 'error']]);
});

// ── F12：模型 / 思考强度写入的顺序与回滚 ──────────────────────────────────────

/** 按请求体决定每次 PUT /api/settings 的耗时与成败；默认立即成功。 */
function settingsBackend(plan) {
  const settled = { count: 0 };
  const server = installBackend({
    putSettings: async body => {
      const step = plan(body) ?? {};
      await pause(step.delay ?? 0);
      settled.count += 1;
      return step.fail ? { ok: false, error: step.fail } : { ok: true };
    },
  });
  return { server, settled };
}

async function renderSettledChatView(characterId) {
  const chat = renderChatView(characterId, `${characterId}-1`);
  await chat.waitForConversation(characterId, `${characterId}-1`);
  await waitFor(() => assert.equal(chat.view.getByTestId('model').textContent, 'original'));
  const shown = () => ({
    model: chat.view.getByTestId('model').textContent,
    effort: chat.view.getByTestId('effort').textContent,
  });
  return { ...chat, shown };
}

const serverShown = server => ({ model: server.settings.model, effort: server.settings.reasoning_effort });

test('F12: a superseded model switch that fails late does not roll back the newer saved choice', async () => {
  // 旧代码两次 PUT 并发：C 先成功，B 后失败并把界面回滚到 original，而服务端已是 C
  const { server, settled } = settingsBackend(body => (
    body.model === 'model-B' ? { delay: 40, fail: 'old write failed' } : { delay: 5 }
  ));
  const chat = await renderSettledChatView('f12a');

  act(() => { void latestInput.onModelChange('model-B'); });
  act(() => { void latestInput.onModelChange('model-C'); });
  assert.equal(chat.shown().model, 'model-C');
  await waitFor(() => assert.equal(settled.count, 2));
  await act(async () => { await pause(20); });

  assert.deepEqual(chat.shown(), serverShown(server), 'the UI must match what the server ended up with');
  assert.equal(chat.shown().model, 'model-C');
  assert.deepEqual(server.settingsPuts.map(body => body.model), ['model-B', 'model-C']);
  assert.equal(server.maxConcurrentSettingsPuts, 1, 'writes must reach the server one at a time, in the order they were made');
  assert.deepEqual(toasts, [['old write failed', 'error']]);
});

test('F12: when every pending write fails the UI returns to the last value the server confirmed', async () => {
  // 旧代码：C 的闭包快照是从未保存成功的 B，C 失败后界面停在 B，服务端仍是 original
  const { server, settled } = settingsBackend(body => (
    body.model === 'model-B' ? { delay: 5, fail: 'first write failed' } : { delay: 40, fail: 'second write failed' }
  ));
  const chat = await renderSettledChatView('f12b');

  act(() => { void latestInput.onModelChange('model-B'); });
  act(() => { void latestInput.onModelChange('model-C'); });
  await waitFor(() => assert.equal(settled.count, 2));
  await act(async () => { await pause(20); });

  assert.deepEqual(chat.shown(), serverShown(server));
  assert.deepEqual(chat.shown(), { model: 'original', effort: 'default' });
  assert.deepEqual(toasts, [['first write failed', 'error'], ['second write failed', 'error']]);
});

test('F12: a failed model switch followed by a saved effort change leaves the UI matching the server', async () => {
  // 旧代码：强度先保存成功，模型切换后失败并用闭包快照把强度也回滚成 default，服务端却是 high
  const { server, settled } = settingsBackend(body => (
    body.model ? { delay: 40, fail: 'model write failed' } : { delay: 5 }
  ));
  const chat = await renderSettledChatView('f12c');

  act(() => { void latestInput.onModelChange('model-B'); });
  act(() => { void latestInput.onReasoningEffortChange('high'); });
  assert.deepEqual(chat.shown(), { model: 'model-B', effort: 'high' });
  await waitFor(() => assert.equal(settled.count, 2));
  await act(async () => { await pause(20); });

  assert.deepEqual(chat.shown(), serverShown(server));
  assert.deepEqual(chat.shown(), { model: 'original', effort: 'high' });
  assert.equal(server.maxConcurrentSettingsPuts, 1);
});

test('F12: a lone switch saves normally and a lone failure rolls back', async () => {
  const { server, settled } = settingsBackend(body => (body.model === 'model-X' ? { fail: 'write failed' } : {}));
  const chat = await renderSettledChatView('f12d');

  act(() => { void latestInput.onModelChange('model-B'); });
  await waitFor(() => assert.equal(settled.count, 1));
  await act(async () => { await pause(10); });
  assert.deepEqual(chat.shown(), { model: 'model-B', effort: 'default' });
  assert.deepEqual(server.settingsPuts[0], {
    model: 'model-B',
    reasoning_effort: 'default',
    reasoning_effort_by_model: { original: 'default', 'model-B': 'default' },
  });

  act(() => { void latestInput.onReasoningEffortChange('low'); });
  await waitFor(() => assert.equal(settled.count, 2));
  await act(async () => { await pause(10); });
  assert.deepEqual(chat.shown(), { model: 'model-B', effort: 'low' });
  // 只改强度的写入不携带 model 字段
  assert.deepEqual(server.settingsPuts[1], {
    reasoning_effort: 'low',
    reasoning_effort_by_model: { original: 'default', 'model-B': 'low' },
  });

  act(() => { void latestInput.onModelChange('model-X'); });
  assert.equal(chat.shown().model, 'model-X');
  await waitFor(() => assert.equal(settled.count, 3));
  await act(async () => { await pause(10); });
  assert.deepEqual(chat.shown(), { model: 'model-B', effort: 'low' });
  assert.deepEqual(chat.shown(), serverShown(server));
  assert.deepEqual(toasts, [['write failed', 'error']]);
});

test('pinned models load from settings and save one full list at a time, rolling back to the confirmed list', async () => {
  const { server, settled } = settingsBackend(body => (
    body.pinned_models?.includes('model-B') && !body.pinned_models.includes('model-C')
      ? { delay: 40, fail: 'pin write failed' }
      : { delay: 5 }
  ));
  server.settings.pinned_models = ['model-A'];
  await renderSettledChatView('pin-a');
  await waitFor(() => assert.deepEqual(latestInput.pinnedModels, ['model-A']));

  // B 的写入晚到失败，但随后 C 的写入已带着完整列表成功：界面应停在服务端的最终值
  act(() => { latestInput.onTogglePinnedModel('model-B'); });
  act(() => { latestInput.onTogglePinnedModel('model-C'); });
  assert.deepEqual(latestInput.pinnedModels, ['model-A', 'model-B', 'model-C']);
  await waitFor(() => assert.equal(settled.count, 2));
  await act(async () => { await pause(20); });
  assert.deepEqual(server.settingsPuts.map(body => body.pinned_models), [
    ['model-A', 'model-B'],
    ['model-A', 'model-B', 'model-C'],
  ]);
  assert.equal(server.maxConcurrentSettingsPuts, 1);
  assert.deepEqual(latestInput.pinnedModels, server.settings.pinned_models);
  assert.deepEqual(toasts, [['pin write failed', 'error']]);

  // 取消置顶失败时回到服务端最后确认的列表
  toasts.length = 0;
  act(() => { latestInput.onTogglePinnedModel('model-C'); });
  assert.deepEqual(latestInput.pinnedModels, ['model-A', 'model-B']);
  await waitFor(() => assert.equal(settled.count, 3));
  await act(async () => { await pause(60); });
  assert.deepEqual(latestInput.pinnedModels, ['model-A', 'model-B', 'model-C']);
  assert.deepEqual(toasts, [['pin write failed', 'error']]);
});
