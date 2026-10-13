// 2026-10-13 外部审计：搜索 / 记忆页的 4 个前端缺陷回归。
//   F13 记忆 AI 整理只比较角色 id，A→B→A 后旧运行会污染新运行
//   F17 侧栏搜索的 blur 定时器会卸载正在聚焦的结果
//   F18 侧栏把搜索失败显示成「没有结果」
//   F19 全局搜索把输入法确认用的 Enter 当成选中结果
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
const userEvent = require('@testing-library/user-event').default;

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

function icon() {
  return React.createElement('span', { 'aria-hidden': 'true' });
}

// 身份必须稳定：记忆页把 t / showToast 放在加载角色的 effect 依赖里。
// aiReviewDone 保留占位符，才能从提示文案区分「旧运行」与「新运行」的结果。
const translate = key => (key === 'memory.aiReviewDone' ? 'done {reviewed}/{corrected}' : key);
const toasts = [];
const showToast = (...args) => { toasts.push(args); };

function loadComponent(relativePath, mocks = {}) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    if (request === '@/lib/i18n-context') {
      return { useTranslation: () => ({ t: translate }) };
    }
    if (request === '@/components/ui/icons') {
      return new Proxy({}, { get: () => icon });
    }
    if (request === 'next/link') {
      return {
        __esModule: true,
        default: ({ children, href, ...props }) => React.createElement('a', { href, ...props }, children),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const absolutePath = path.join(root, relativePath);
    delete require.cache[require.resolve(absolutePath)];
    return require(absolutePath).default;
  } finally {
    Module._load = originalLoad;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const pause = ms => act(async () => new Promise(resolve => setTimeout(resolve, ms)));

// 旧实现的 blur 定时器是 150ms；等待必须越过它，否则测不出面板被卸载。
const PAST_LEGACY_BLUR_TIMER_MS = 220;

function searchResult(id, snippet) {
  return {
    messageId: `message-${id}`,
    snippet,
    role: 'user',
    createdAt: '2026-10-13T00:00:00.000Z',
    conversationId: `conversation-${id}`,
    conversationTitle: `Conversation ${id}`,
    characterId: 'character-a',
    characterName: 'Alice',
    avatarUrl: null,
    highlightRanges: [],
  };
}

// 每个用例改写这份状态来驱动被 mock 的 useMessageSearch。
let searchState;
function resetSearchState(overrides = {}) {
  searchState = {
    results: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    loadMore: () => {},
    clearSearch: () => {},
    ...overrides,
  };
}

const characterListMock = {
  __esModule: true,
  default: () => React.createElement('button', { type: 'button' }, 'character list'),
};

function loadSidebar({ realSearchHook = false } = {}) {
  const mocks = { './CharacterList': characterListMock };
  if (!realSearchHook) {
    mocks['@/hooks/use-message-search'] = { useMessageSearch: () => searchState };
  }
  return loadComponent('src/components/sidebar/Sidebar.tsx', mocks);
}

function renderSidebar(Sidebar, onConversationSelect = () => {}) {
  return render(React.createElement(Sidebar, {
    selectedCharacterId: null,
    onCharacterSelect: () => {},
    onConversationSelect,
  }));
}

async function openSidebarSearch(view, user, query = 'q') {
  const input = within(view.container).getByRole('textbox');
  await user.click(input);
  await user.type(input, query);
  return input;
}

test.beforeEach(() => {
  toasts.length = 0;
  resetSearchState();
});

test.afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
  delete require.extensions['.ts'];
  delete require.extensions['.tsx'];
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

// ---------------------------------------------------------------------------
// F13
// ---------------------------------------------------------------------------

function reviewBatch(overrides = {}) {
  return {
    ok: true,
    reviewed: 1,
    total_active: 1,
    skipped_due_to_limit: 0,
    reviewed_offset: 0,
    next_offset: null,
    has_more: false,
    next_batch_index: null,
    corrected: 0,
    failed_batches: 0,
    failed_messages: [],
    indexing_queued: 0,
    indexing_started: false,
    changes: [],
    merge_suggestions: [],
    ...overrides,
  };
}

// 渲染记忆页并接管 /api/memory-review：每个请求都挂起，由用例决定何时、以什么结果返回。
// 故意不响应 abort signal——模拟「响应已在路上 / 正在解析」时被作废的旧运行。
async function renderMemoriesPage() {
  const MemoriesPage = loadComponent('src/app/memories/page.tsx', {
    '@/components/ui/Toast': { useToast: () => ({ showToast }) },
    '@/components/memories/MemoryList': { __esModule: true, default: () => null },
  });
  const requests = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === '/api/characters') {
      return jsonResponse([{ id: 'A', name: 'Alice' }, { id: 'B', name: 'Bob' }]);
    }
    if (url === '/api/memory-review') {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      requests.push({ resolve, signal: init.signal, body: JSON.parse(init.body) });
      return promise;
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const view = render(React.createElement(MemoriesPage));
  await waitFor(() => assert.equal(view.getByRole('combobox').value, 'A'));
  return { view, requests };
}

// 角色 A 启动整理 → 切到 B → 切回 A 再启动：返回时旧运行（requests[0]）与新运行（requests[1]）都在途。
async function startReviewSwitchAwayAndRestart() {
  const { view, requests } = await renderMemoriesPage();
  const select = view.getByRole('combobox');
  fireEvent.click(view.getByRole('button', { name: 'memory.aiReview' }));
  fireEvent.change(select, { target: { value: 'B' } });
  fireEvent.change(select, { target: { value: 'A' } });
  fireEvent.click(view.getByRole('button', { name: 'memory.aiReview' }));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => request.body.character_id), ['A', 'A']);
  return { view, requests };
}

function assertNewRunStillBusy(view) {
  // 仍显示「整理中」而不是进度文案：旧运行连进度都不能写。
  assert.equal(view.getByRole('button', { name: 'memory.aiReviewRunning' }).disabled, true);
  assert.ok(view.queryByRole('button', { name: 'memory.aiReviewStop' }), 'stop button belongs to the new run');
  assert.ok(view.queryByRole('button', { name: 'memory.hideLatestAiReviewChanges' }) === null);
  assert.ok(view.queryByRole('button', { name: 'memory.viewLatestAiReviewChanges' }) === null);
  assert.deepEqual(toasts, []);
}

test('F13: a superseded AI review that succeeds late cannot touch the new run for the same character', async () => {
  const { view, requests } = await startReviewSwitchAwayAndRestart();

  await act(async () => requests[0].resolve(jsonResponse(reviewBatch({ reviewed: 1, corrected: 0 }))));
  assertNewRunStillBusy(view);

  // 新运行自己的结果照常提交。
  await act(async () => requests[1].resolve(jsonResponse(reviewBatch({ reviewed: 7, total_active: 7, corrected: 3 }))));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'memory.aiReview' }).disabled, false));
  assert.ok(view.queryByRole('button', { name: 'memory.aiReviewStop' }) === null);
  assert.ok(view.getByRole('button', { name: 'memory.hideLatestAiReviewChanges' }));
  assert.deepEqual(toasts, [['done 7/3', 'success']]);
});

test('F13: a superseded AI review that fails late cannot touch the new run for the same character', async () => {
  const { view, requests } = await startReviewSwitchAwayAndRestart();

  await act(async () => requests[0].resolve(jsonResponse({ error: 'upstream exploded' }, 503)));
  assertNewRunStillBusy(view);

  await act(async () => requests[1].resolve(jsonResponse(reviewBatch({ reviewed: 2, total_active: 2, corrected: 1 }))));
  await waitFor(() => assert.equal(view.getByRole('button', { name: 'memory.aiReview' }).disabled, false));
  assert.deepEqual(toasts, [['done 2/1', 'success']]);
});

test('F13: switching characters aborts the in-flight AI review', async () => {
  const { view, requests } = await renderMemoriesPage();
  fireEvent.click(view.getByRole('button', { name: 'memory.aiReview' }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);

  fireEvent.change(view.getByRole('combobox'), { target: { value: 'B' } });

  assert.equal(requests[0].signal.aborted, true, 'the run started for the previous character must be aborted');
  assert.equal(view.getByRole('button', { name: 'memory.aiReview' }).disabled, false);
  // 被切换作废的运行不是「用户点了停止」，也不是故障：不提示。
  await act(async () => requests[0].resolve(jsonResponse(reviewBatch())));
  assert.deepEqual(toasts, []);
});

test('F13: the stop button still aborts the current run after an A→B→A switch', async () => {
  const { view, requests } = await startReviewSwitchAwayAndRestart();
  assert.equal(requests[1].signal.aborted, false);
  fireEvent.click(view.getByRole('button', { name: 'memory.aiReviewStop' }));
  assert.equal(requests[1].signal.aborted, true);
});

// ---------------------------------------------------------------------------
// F17
// ---------------------------------------------------------------------------

test('F17: Sidebar keeps the result panel mounted while keyboard focus is on a result', async () => {
  resetSearchState({ results: [searchResult('1', 'first result'), searchResult('2', 'second result')] });
  const user = userEvent.setup({ document });
  const selections = [];
  const view = renderSidebar(loadSidebar(), (...args) => selections.push(args));
  await openSidebarSearch(view, user);

  await user.tab(); // 清空按钮
  await user.tab(); // 第一条结果
  const firstResult = view.getByText('first result').closest('button');
  assert.ok(document.activeElement === firstResult);

  await pause(PAST_LEGACY_BLUR_TIMER_MS);
  assert.ok(view.queryByText('first result'), 'the panel must not unmount under the focused result');
  assert.ok(document.activeElement === firstResult, 'focus must not be dropped to <body>');

  await user.keyboard('{Enter}');
  assert.deepEqual(selections, [['character-a', 'conversation-1', 'message-1', []]]);
  assert.ok(view.queryByText('first result') === null, 'selecting a result closes the panel');
});

test('F17: Sidebar keeps the result panel mounted while keyboard focus is on "load more"', async () => {
  let loadMoreCalls = 0;
  resetSearchState({
    results: [searchResult('1', 'first result')],
    hasMore: true,
    loadMore: () => { loadMoreCalls += 1; },
  });
  const user = userEvent.setup({ document });
  const view = renderSidebar(loadSidebar());
  await openSidebarSearch(view, user);

  await user.tab(); // 清空按钮
  await user.tab(); // 结果
  await user.tab(); // 查看更多
  const loadMoreButton = view.getByRole('button', { name: 'search.loadMore' });
  assert.ok(document.activeElement === loadMoreButton);

  await pause(PAST_LEGACY_BLUR_TIMER_MS);
  assert.ok(document.activeElement === view.queryByRole('button', { name: 'search.loadMore' }));

  await user.keyboard('{Enter}');
  assert.equal(loadMoreCalls, 1);
  assert.ok(view.queryByText('first result'), 'loading more keeps the panel open');
});

test('F17: Sidebar closes the result panel once focus really leaves the search container', async () => {
  resetSearchState({ results: [searchResult('1', 'first result')] });
  const user = userEvent.setup({ document });
  const view = renderSidebar(loadSidebar());
  const input = await openSidebarSearch(view, user);

  await user.tab(); // 清空按钮
  await user.tab(); // 结果
  await user.tab(); // 离开搜索容器，进入角色列表
  assert.ok(document.activeElement === view.getByRole('button', { name: 'character list' }));
  await waitFor(() => assert.ok(view.queryByText('first result') === null));

  // 回到输入框时面板重新打开（查询还在）。
  await user.click(input);
  assert.ok(view.queryByText('first result'));
});

test('F17: Sidebar still closes the result panel on Escape', async () => {
  resetSearchState({ results: [searchResult('1', 'first result')] });
  const user = userEvent.setup({ document });
  const view = renderSidebar(loadSidebar());
  const input = await openSidebarSearch(view, user);
  assert.ok(view.queryByText('first result'));

  await user.keyboard('{Escape}');
  await waitFor(() => assert.ok(view.queryByText('first result') === null));
  assert.equal(input.value, '');
});

test('F17: clearing the Sidebar query from the keyboard hands focus back to the search input', async () => {
  resetSearchState({ results: [searchResult('1', 'first result')] });
  const user = userEvent.setup({ document });
  const view = renderSidebar(loadSidebar());
  const input = await openSidebarSearch(view, user);

  await user.tab(); // 清空按钮
  assert.equal(document.activeElement.textContent, '×');
  await user.keyboard('{Enter}');

  assert.equal(input.value, '');
  assert.ok(view.queryByText('first result') === null);
  // 清空按钮随查询清空而卸载；焦点不能跟着丢到 <body>。
  assert.ok(document.activeElement === input);
});

// ---------------------------------------------------------------------------
// F18
// ---------------------------------------------------------------------------

test('F18: Sidebar reports a failed search as an error, not as "no results"', async () => {
  resetSearchState({ error: 'service down' });
  const user = userEvent.setup({ document });
  const view = renderSidebar(loadSidebar());
  await openSidebarSearch(view, user);

  const alert = view.getByRole('alert');
  assert.equal(alert.textContent, 'common.loadFailed: service down');
  assert.ok(view.queryByText('search.noResults') === null);
});

test('F18: Sidebar keeps already loaded results visible when loading more fails', async () => {
  resetSearchState({ results: [searchResult('1', 'first result')], hasMore: true, error: 'page 2 failed' });
  const user = userEvent.setup({ document });
  const view = renderSidebar(loadSidebar());
  await openSidebarSearch(view, user);

  assert.equal(view.getByRole('alert').textContent, 'common.loadFailed: page 2 failed');
  assert.ok(view.queryByText('first result'));
  assert.ok(view.queryByRole('button', { name: 'search.loadMore' }), 'load more stays available as the retry');
});

test('F18: Sidebar still says "no results" for a successful empty search', async () => {
  resetSearchState();
  const user = userEvent.setup({ document });
  const view = renderSidebar(loadSidebar());
  await openSidebarSearch(view, user);

  assert.ok(view.getByText('search.noResults'));
  assert.ok(view.queryByRole('alert') === null);
});

test('F18: Sidebar surfaces a real HTTP 503 from the search endpoint (unmocked hook)', async () => {
  const requestedUrls = [];
  global.fetch = async input => {
    requestedUrls.push(String(input));
    return jsonResponse({ error: 'service down' }, 503);
  };
  const user = userEvent.setup({ document });
  const view = renderSidebar(loadSidebar({ realSearchHook: true }));
  await openSidebarSearch(view, user, 'query');

  const alert = await view.findByRole('alert');
  assert.match(alert.textContent, /common\.loadFailed/);
  assert.match(alert.textContent, /service down/);
  assert.ok(view.queryByText('search.noResults') === null);
  assert.ok(requestedUrls.some(url => url.startsWith('/api/messages/search?')));
});

// ---------------------------------------------------------------------------
// F19
// ---------------------------------------------------------------------------

async function renderGlobalSearch() {
  resetSearchState({ results: [searchResult('1', 'first result'), searchResult('2', 'second result')] });
  const GlobalSearch = loadComponent('src/components/search/GlobalSearch.tsx', {
    '@/hooks/use-message-search': { useMessageSearch: () => searchState },
  });
  const selections = [];
  render(React.createElement(GlobalSearch, {
    open: true,
    onClose: () => {},
    onConversationSelect: (...args) => selections.push(args),
  }));
  // 让「打开时重置」的 microtask 先跑完，避免它在按键之后才把高亮项归零。
  await act(async () => {});
  const input = within(within(document.body).getByRole('dialog')).getByRole('textbox');
  fireEvent.change(input, { target: { value: 'ni' } });
  return { input, selections };
}

test('F19: GlobalSearch ignores the Enter that confirms an IME composition', async () => {
  const { input, selections } = await renderGlobalSearch();

  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
  assert.deepEqual(selections, [], 'Enter during composition must not select a result');

  // Safari 先派发 compositionend 再派发 keydown：isComposing 已是 false，只剩 keyCode 229。
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  assert.deepEqual(selections, [], 'keyCode 229 alone must also be treated as composition');

  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
  assert.deepEqual(selections, [['character-a', 'conversation-1', 'message-1', []]], 'a plain Enter still selects');
});

test('F19: GlobalSearch ignores arrow keys that navigate IME candidates', async () => {
  const { input, selections } = await renderGlobalSearch();

  fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true, keyCode: 229 });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
  assert.deepEqual(selections, [['character-a', 'conversation-1', 'message-1', []]]);
});

test('F19: GlobalSearch arrow keys still move the active result outside composition', async () => {
  const { input, selections } = await renderGlobalSearch();

  fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40 });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
  assert.deepEqual(selections, [['character-a', 'conversation-2', 'message-2', []]]);
});
