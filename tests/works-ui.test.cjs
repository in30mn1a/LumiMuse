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
const { act, cleanup, fireEvent, render, waitFor, within } = require('@testing-library/react');

// 注意：断言里不直接比较 DOM 节点（失败时 diff 会吃掉几十 GB 内存），一律转成布尔或字符串再比。

const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const originalFetch = global.fetch;

Module._resolveFilename = function resolveFilename(request, parent, ...args) {
  if (request.startsWith('@/')) {
    const base = path.join(root, 'src', request.slice(2));
    for (const file of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return originalResolve.call(this, request, parent, ...args);
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

// 用真实中文文案渲染：缺键时界面会显示原始键名，断言会直接失败
const zh = require('../src/lib/i18n.ts').default.zh;
const t = key => zh[key] ?? key;

// ---- next/navigation（只给 Agent 页用） ----
let currentSearch = '';
const router = { replace() {}, push() {} };
function useSearchParams() {
  return new URLSearchParams(currentSearch);
}

// showToast 必须是稳定引用：页面的加载 effect 依赖它，每次渲染换新函数会让请求无限重发
const showToast = () => {};
const mocks = {
  '@/lib/i18n-context': { useTranslation: () => ({ t }) },
  '@/components/ui/Toast': { useToast: () => ({ showToast }) },
  '@/components/memories/MemoryList': {
    __esModule: true,
    default: () => React.createElement('div', { 'data-testid': 'memory-list' }),
  },
  'next/navigation': { useRouter: () => router, useSearchParams },
  'next/link': {
    __esModule: true,
    default: ({ children, href, ...props }) => React.createElement('a', { href, ...props }, children),
  },
  'react-markdown': { __esModule: true, default: ({ children }) => React.createElement('div', null, children) },
  'remark-gfm': { __esModule: true, default: () => {} },
};
Module._load = function load(request, ...args) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, ...args);
};

const MemoriesPage = require('../src/app/memories/page.tsx').default;
const WorksCatalogPanel = require('../src/components/memories/WorksCatalogPanel.tsx').default;
const AgentComposer = require('../src/components/agent/AgentComposer.tsx').default;
const AgentPage = require('../src/app/agent/page.tsx').default;
const { WORK_FIELD_LIMITS } = require('../src/lib/works-catalog-text.ts');

// ---- 虚构数据 ----
const T0 = '2026-05-01T00:00:00.000Z';
const T1 = '2026-06-01T00:00:00.000Z';
function work(id, fields) {
  return {
    id, character_id: 'char-a', aliases: [], rating: '', progress: '', note: '',
    source_memory_ids: [], source_msg_ids: [], first_seen_at: T0, dismissed_at: null,
    created_at: T0, updated_at: T0, ...fields,
  };
}
function fixtureWorks() {
  return [
    work('w-movie', { work_type: 'movie', title: '她', aliases: ['Her'], status: 'watched', rating: '9.5', note: '最爱之一', source_memory_ids: ['m1'], source_msg_ids: ['msg1'] }),
    work('w-book', { work_type: 'book', title: '三体', status: 'watching', progress: '第二部' }),
    work('w-game', { work_type: 'game', title: '塞尔达传说', status: 'want' }),
    work('w-series', { work_type: 'series', title: '黑镜', status: 'watching', progress: '第二季第 2 集', dismissed_at: T1 }),
  ];
}
const MOVIE_SOURCES = {
  memories: [{ id: 'm1', content: '用户说《她》是最爱之一，配乐很好', status: 'archived', created_at: T0 }],
  messages: [{ id: 'msg1', conversation_id: 'conv-a', role: 'user', excerpt: '我昨晚看完了《她》', created_at: T0 }],
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * 内存里的假接口：列表、增改、依据；其它请求一律报错，测试里看得出多余请求。
 * `override(call)` 返回 Response 时直接用它（模拟校验失败等情形）。
 */
function installFakeServer({ works = fixtureWorks(), characters = [{ id: 'char-a', name: '小光' }], listResponses = [], gate, override } = {}) {
  const state = works.map(item => ({ ...item }));
  const calls = [];
  const queuedList = [...listResponses];
  global.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const overridden = override?.(call);
    if (overridden) return overridden;
    const parsed = new URL(call.url, 'http://localhost');
    if (parsed.pathname === '/api/characters') return json(characters);
    if (parsed.pathname === '/api/works' && call.method === 'GET') {
      if (gate) await gate;
      if (queuedList.length > 0) return queuedList.shift()();
      return json(state.map(item => ({ ...item })));
    }
    if (parsed.pathname === '/api/works' && call.method === 'POST') {
      const names = [call.body.title, ...call.body.aliases];
      const hit = state.find(item => item.work_type === call.body.work_type && [item.title, ...item.aliases].some(name => names.includes(name)));
      if (hit) {
        return json({ error: 'conflict', code: hit.dismissed_at ? 'work_dismissed' : 'work_exists', work: hit }, 409);
      }
      const { character_id: characterId, ...fields } = call.body;
      const created = work(`w-new-${state.length}`, { ...fields, character_id: characterId });
      state.push(created);
      return json(created, 201);
    }
    const match = parsed.pathname.match(/^\/api\/works\/([^/]+)$/);
    if (match) {
      const target = state.find(item => item.id === decodeURIComponent(match[1]));
      if (!target) return json({ error: 'Not found' }, 404);
      if (call.method === 'GET') {
        const sources = target.id === 'w-movie' ? MOVIE_SOURCES : { memories: [], messages: [] };
        return json({ ...target, sources });
      }
      if (call.method === 'PUT') {
        const { dismissed, ...fields } = call.body;
        // 与真接口一致：改类型或恢复查全部名称，否则只查这次发来的名称；只和未移除的条目比
        const type = fields.work_type ?? target.work_type;
        const checkAll = type !== target.work_type || (dismissed === false && target.dismissed_at);
        const names = checkAll
          ? [fields.title ?? target.title, ...(fields.aliases ?? target.aliases)]
          : [fields.title, ...(fields.aliases ?? [])].filter(Boolean);
        const hit = state.find(item => item.id !== target.id && !item.dismissed_at && item.work_type === type
          && [item.title, ...item.aliases].some(name => names.includes(name)));
        if (hit && dismissed !== true) return json({ error: 'conflict', code: 'work_exists', work: hit }, 409);
        Object.assign(target, fields, { updated_at: T1 });
        if (dismissed !== undefined) target.dismissed_at = dismissed ? T1 : null;
        return json({ ...target });
      }
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  };
  return { state, calls };
}

function renderPanel() {
  return render(React.createElement(WorksCatalogPanel, { characterId: 'char-a', characterName: '小光' }));
}

function textOf(element) {
  return element ? element.textContent : '';
}

test.afterEach(async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  cleanup();
  global.fetch = originalFetch;
  currentSearch = '';
  window.history.replaceState(null, '', '/');
});

test.after(async () => {
  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;
  delete require.extensions['.ts'];
  delete require.extensions['.tsx'];
  await cleanupReactDomTestEnvironment(restoreDom);
});

test('client components only import the client-safe works helpers', () => {
  // works-catalog.ts 依赖 Node 的 crypto 和数据库类型，不能进浏览器包；works-route-helpers 只许 import type
  for (const file of ['src/components/memories/WorksCatalogPanel.tsx', 'src/components/memories/WorksEntryEditor.tsx']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(/from '@\/lib\/works-catalog'/.test(source), false, `${file} imports the server-only works module`);
    const helperImports = source.match(/^import .*works-route-helpers.*$/gm) ?? [];
    assert.equal(helperImports.every(line => line.startsWith('import type ')), true, `${file}: ${helperImports.join(' | ')}`);
  }
});

test('the editor takes its length limits from the shared WORK_FIELD_LIMITS', async () => {
  installFakeServer();
  const view = renderPanel();
  await view.findByRole('region', { name: '电影' });
  fireEvent.click(view.getByRole('button', { name: '添加作品' }));
  const dialog = await view.findByRole('dialog', { name: '添加作品' });
  for (const [label, field] of [['名称', 'title'], ['评分', 'rating'], ['进度', 'progress'], ['一句话印象', 'note']]) {
    assert.equal(within(dialog).getByLabelText(label).maxLength, WORK_FIELD_LIMITS[field], label);
  }
  const aliasesHint = within(dialog).getByLabelText('别名').getAttribute('placeholder');
  assert.equal(aliasesHint.includes(`最多 ${WORK_FIELD_LIMITS.aliases} 个`), true, aliasesHint);
});

test('each row has a short, distinct name for its edit and evidence buttons', async () => {
  installFakeServer();
  const view = renderPanel();
  await view.findByRole('region', { name: '电影' });
  const labels = pattern => view.getAllByRole('button', { name: pattern }).map(button => button.getAttribute('aria-label'));
  assert.deepEqual(labels(/^编辑《/), ['编辑《她》', '编辑《三体》', '编辑《塞尔达传说》']);
  assert.deepEqual(labels(/的依据$/), ['《她》的依据', '《三体》的依据', '《塞尔达传说》的依据']);
  const movieRow = view.getByRole('button', { name: '编辑《她》' }).closest('li');
  assert.equal(within(movieRow).queryByRole('button', { name: '《她》的依据' }) !== null, true, 'evidence button sits in its own row');
});

test('the memories page switches to the works view and keeps it in the URL', async () => {
  window.history.replaceState(null, '', '/memories');
  installFakeServer({ works: [] });
  const view = render(React.createElement(MemoriesPage));
  await view.findByTestId('memory-list');

  fireEvent.click(view.getByRole('button', { name: '片单' }));
  await view.findByText('片单还是空的');
  assert.equal(window.location.search, '?view=works');
  assert.equal(view.getByRole('button', { name: '片单' }).getAttribute('aria-pressed'), 'true');
  assert.equal(view.queryByTestId('memory-list') === null, true);

  fireEvent.click(view.getByRole('button', { name: '记忆' }));
  await view.findByTestId('memory-list');
  assert.equal(window.location.search, '');
});

test('opening /memories?view=works shows the works catalog directly', async () => {
  window.history.replaceState(null, '', '/memories?view=works');
  const server = installFakeServer();
  const view = render(React.createElement(MemoriesPage));
  await view.findByRole('region', { name: '电影' });
  assert.equal(view.queryByTestId('memory-list') === null, true);
  assert.equal(server.calls.some(call => call.url === '/api/works?character_id=char-a&include_dismissed=1'), true);
});

test('the panel shows loading first, then groups entries by type with per-type status wording', async () => {
  let open;
  installFakeServer({ gate: new Promise(resolve => { open = resolve; }) });
  const view = renderPanel();
  assert.equal(view.queryByRole('status', { name: '加载中...' }) !== null, true);
  open();

  const movies = await view.findByRole('region', { name: '电影' });
  const movieText = textOf(movies);
  for (const snippet of ['看过', '《她》', '评分 9.5', '又名 Her', '最爱之一']) {
    assert.equal(movieText.includes(snippet), true, `movie row missing ${snippet}`);
  }
  assert.equal(textOf(view.getByRole('region', { name: '书' })).includes('在读'), true, 'books say 在读');
  assert.equal(textOf(view.getByRole('region', { name: '书' })).includes('进度 第二部'), true);
  assert.equal(textOf(view.getByRole('region', { name: '游戏' })).includes('想玩'), true, 'games say 想玩');
  assert.equal(view.queryByRole('region', { name: '剧集/动画' }) === null, true, 'a dismissed-only type has no group');
  assert.equal(view.queryByText('3 部') !== null, true, 'count excludes dismissed entries');
  assert.equal(view.queryByText('《黑镜》') === null, true, 'dismissed entries stay folded');
});

test('the agent button links to /agent with a draft naming the character, without sending anything', async () => {
  const server = installFakeServer();
  const view = renderPanel();
  await view.findByRole('region', { name: '电影' });
  const href = view.getByRole('link', { name: '让 Agent 从记忆整理' }).getAttribute('href');
  assert.equal(href.startsWith('/agent?draft='), true);
  const draft = new URLSearchParams(href.slice('/agent?'.length)).get('draft');
  for (const snippet of ['works-catalog', '「小光」', 'char-a']) {
    assert.equal(draft.includes(snippet), true, `draft missing ${snippet}`);
  }
  assert.equal(server.calls.some(call => call.url.startsWith('/api/agent')), false);
});

test('the evidence expander lists source memories and message excerpts, or says there is none', async () => {
  const server = installFakeServer();
  const view = renderPanel();
  const movieRow = (await view.findByRole('button', { name: '编辑《她》' })).closest('li');
  fireEvent.click(within(movieRow).getByRole('button', { name: '《她》的依据' }));
  await within(movieRow).findByText('用户说《她》是最爱之一，配乐很好');
  assert.equal(within(movieRow).queryByText('已归档') !== null, true, 'non-active memories show their status');
  assert.equal(textOf(movieRow).includes('你：我昨晚看完了《她》'), true);
  assert.equal(
    server.calls.some(call => call.url === '/api/works/w-movie?character_id=char-a&include_sources=1'),
    true,
  );

  const bookRow = view.getByRole('button', { name: '编辑《三体》' }).closest('li');
  fireEvent.click(within(bookRow).getByRole('button', { name: '《三体》的依据' }));
  await within(bookRow).findByText('无依据');
});

test('editing a row saves the changed fields and updates the list', async () => {
  const server = installFakeServer();
  const view = renderPanel();
  fireEvent.click(await view.findByRole('button', { name: '编辑《她》' }));
  const dialog = await view.findByRole('dialog', { name: '编辑作品' });
  assert.equal(within(dialog).getByLabelText('名称').value, '她');
  assert.equal(within(dialog).getByLabelText('别名').value, 'Her');

  // 什么都没改就保存：不写库
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(view.queryByRole('dialog') === null, true));
  assert.equal(server.calls.some(call => call.method === 'PUT'), false);

  fireEvent.click(view.getByRole('button', { name: '编辑《她》' }));
  const again = await view.findByRole('dialog', { name: '编辑作品' });
  fireEvent.change(within(again).getByLabelText('一句话印象'), { target: { value: '配乐和配色都好' } });
  fireEvent.change(within(again).getByLabelText('评分'), { target: { value: '' } });
  fireEvent.click(within(again).getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(view.queryByRole('dialog') === null, true));

  const put = server.calls.find(call => call.method === 'PUT');
  assert.equal(put.url, '/api/works/w-movie?character_id=char-a');
  // 只发改过的字段
  assert.deepEqual(put.body, { rating: '', note: '配乐和配色都好' });
  await view.findByText('配乐和配色都好');
  assert.equal(textOf(view.getByRole('region', { name: '电影' })).includes('评分'), false, 'cleared rating is gone');
});

test('a stale editor does not revert fields written while it was open', async () => {
  const server = installFakeServer();
  const view = renderPanel();
  fireEvent.click(await view.findByRole('button', { name: '编辑《三体》' }));
  const dialog = await view.findByRole('dialog', { name: '编辑作品' });

  // 弹窗开着时，自动更新（或批准的提案）推进了进度、加了别名
  const book = server.state.find(item => item.id === 'w-book');
  book.progress = '第三部';
  book.aliases = ['The Three-Body Problem'];

  fireEvent.change(within(dialog).getByLabelText('一句话印象'), { target: { value: '宏大' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(view.queryByRole('dialog') === null, true));

  assert.deepEqual(server.calls.find(call => call.method === 'PUT').body, { note: '宏大' });
  assert.equal(book.progress, '第三部');
  assert.deepEqual(book.aliases, ['The Three-Body Problem']);
  await waitFor(() => assert.equal(textOf(view.getByRole('region', { name: '书' })).includes('进度 第三部'), true));
});

test('an edit that clashes with another entry names that entry and keeps the dialog open', async () => {
  const server = installFakeServer();
  const view = renderPanel();
  fireEvent.click(await view.findByRole('button', { name: '编辑《塞尔达传说》' }));
  const dialog = await view.findByRole('dialog', { name: '编辑作品' });
  fireEvent.change(within(dialog).getByLabelText('类型'), { target: { value: 'movie' } });
  fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'Her' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

  // 撞上的是《她》的别名 Her：提示要说出是哪一条
  await waitFor(() => assert.equal(textOf(within(dialog).queryByRole('alert')), '片单里已有《她》，请直接编辑那一条。'));
  assert.equal(view.queryByRole('dialog') !== null, true);
  assert.deepEqual(server.calls.find(call => call.method === 'PUT').body, { work_type: 'movie', title: 'Her' });
});

test('a refused restore names the entry that already uses the name', async () => {
  const works = [
    ...fixtureWorks(),
    work('w-series-2', { work_type: 'series', title: '黑镜', aliases: ['Black Mirror'], status: 'want' }),
  ];
  installFakeServer({ works });
  const view = renderPanel();
  fireEvent.click(await view.findByRole('button', { name: '已移除（1）' }));
  fireEvent.click(view.getByRole('button', { name: '恢复《黑镜》' }));
  await waitFor(() => assert.equal(
    textOf(view.queryByRole('alert')),
    '片单里已有《黑镜》与它同名，不能恢复；可以先编辑或移除那一条。',
  ));
});

test('a title with nothing left after removing book-title marks and punctuation asks for a title', async () => {
  const server = installFakeServer();
  const view = renderPanel();
  await view.findByRole('region', { name: '电影' });
  fireEvent.click(view.getByRole('button', { name: '添加作品' }));
  const dialog = await view.findByRole('dialog', { name: '添加作品' });
  for (const title of ['《》', '?!', ' 《 》 ']) {
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: title } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    assert.equal(textOf(within(dialog).getByRole('alert')), '请填写名称', JSON.stringify(title));
  }
  assert.equal(server.calls.some(call => call.method === 'POST'), false);
});

test('server field errors are shown by field name, not as the raw English error', async () => {
  installFakeServer({
    override: call => (call.method === 'POST'
      ? json({ error: 'Invalid request body', fieldErrors: { note: ['Must be at most 60 characters'], rating: ['Must be at most 16 characters'] } }, 400)
      : undefined),
  });
  const view = renderPanel();
  await view.findByRole('region', { name: '电影' });
  fireEvent.click(view.getByRole('button', { name: '添加作品' }));
  const dialog = await view.findByRole('dialog', { name: '添加作品' });
  fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '花样年华' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(textOf(within(dialog).queryByRole('alert')), '保存失败：一句话印象、评分不符合要求'));
});

test('adding a work posts it, and a duplicate shows why instead of closing', async () => {
  const server = installFakeServer();
  const view = renderPanel();
  await view.findByRole('region', { name: '电影' });

  fireEvent.click(view.getByRole('button', { name: '添加作品' }));
  const dialog = await view.findByRole('dialog', { name: '添加作品' });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
  assert.equal(textOf(within(dialog).getByRole('alert')), '请填写名称');
  assert.equal(server.calls.some(call => call.method === 'POST'), false);

  fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'Her' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(textOf(within(dialog).queryByRole('alert')), '片单里已有《她》，请直接编辑那一条。'));
  assert.equal(view.queryByRole('dialog') !== null, true, 'dialog stays open on conflict');
  assert.deepEqual(server.calls.find(call => call.method === 'POST').body, {
    character_id: 'char-a', work_type: 'movie', title: 'Her', aliases: [], status: 'watched', rating: '', progress: '', note: '',
  });

  fireEvent.change(within(dialog).getByLabelText('类型'), { target: { value: 'series' } });
  fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '黑镜' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(textOf(within(dialog).queryByRole('alert')), '《黑镜》之前被移除了，请在「已移除」里恢复它。'));

  fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '风骚律师' } });
  fireEvent.change(within(dialog).getByLabelText('状态'), { target: { value: 'want' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(view.queryByRole('dialog') === null, true));
  const series = await view.findByRole('region', { name: '剧集/动画' });
  assert.equal(textOf(series).includes('想看'), true);
  assert.equal(textOf(series).includes('《风骚律师》'), true);
});

test('removing moves an entry to the removed section, and restore brings it back', async () => {
  const server = installFakeServer();
  const view = renderPanel();
  fireEvent.click(await view.findByRole('button', { name: '编辑《三体》' }));
  const dialog = await view.findByRole('dialog', { name: '编辑作品' });
  fireEvent.click(within(dialog).getByRole('button', { name: '移除' }));
  await waitFor(() => assert.equal(view.queryByRole('dialog') === null, true));
  await waitFor(() => assert.equal(view.queryByRole('region', { name: '书' }) === null, true));
  assert.deepEqual(server.calls.find(call => call.method === 'PUT').body, { dismissed: true });

  const toggle = view.getByRole('button', { name: '已移除（2）' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(view.queryByText('《黑镜》') !== null, true);

  fireEvent.click(view.getByRole('button', { name: '恢复《黑镜》' }));
  const series = await view.findByRole('region', { name: '剧集/动画' });
  assert.equal(textOf(series).includes('进度 第二季第 2 集'), true, 'restored entry keeps its fields');
  const restore = server.calls.filter(call => call.method === 'PUT').at(-1);
  assert.equal(restore.url, '/api/works/w-series?character_id=char-a');
  assert.deepEqual(restore.body, { dismissed: false });
  await view.findByRole('button', { name: '已移除（1）' });
});

test('a failed load shows an error with retry, and an empty catalog shows the empty state', async () => {
  installFakeServer({ works: [], listResponses: [() => json({ error: 'boom' }, 500)] });
  const view = renderPanel();
  const alert = await view.findByRole('alert');
  assert.equal(textOf(alert).includes('片单加载失败'), true);
  assert.equal(view.queryByText('片单还是空的') === null, true, 'a failure is not shown as empty');
  fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
  await view.findByText('片单还是空的');
  assert.equal(view.queryByRole('alert') === null, true);
});

// ---- Agent 页的 draft 参数 ----

const MODEL = { ready: false };

test('the composer prefills a draft once and never overwrites what was typed', () => {
  const sent = [];
  const props = { busy: false, canStop: false, onSend: async content => { sent.push(content); return true; }, onStop: () => {}, model: MODEL };
  const view = render(React.createElement(AgentComposer, { ...props, draft: '草稿一' }));
  const input = view.getByRole('textbox', { name: t('agent.inputLabel') });
  assert.equal(input.value, '草稿一');

  fireEvent.change(input, { target: { value: '我自己写的' } });
  view.rerender(React.createElement(AgentComposer, { ...props, draft: '草稿二' }));
  assert.equal(input.value, '我自己写的', 'a typed draft is not clobbered');

  fireEvent.change(input, { target: { value: '' } });
  view.rerender(React.createElement(AgentComposer, { ...props, draft: '草稿二' }));
  assert.equal(input.value, '', 'the same draft is not filled back after clearing');
  assert.deepEqual(sent, []);
});

test('/agent?draft= prefills the input without creating a session or sending', async () => {
  const draft = '请加载 works-catalog 技能，整理「小光」的片单';
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET' };
    calls.push(call);
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [], has_more: false });
    if (call.url === '/api/agent/status') {
      return json({
        failed_tasks: { extraction: 0, profile: 0, embedding: 0 }, repairable_candidates: 0, recent_errors: 0,
        recent_error_window_hours: 24, agent: { configured: true, provider_name: '虚构接口', model: 'fake-model' },
      });
    }
    if (call.url === '/api/settings') {
      return json({ model: 'main-model', agent_provider_id: '', agent_model: 'fake-model', agent_reasoning_effort: 'default', pinned_models: [] });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  };
  currentSearch = new URLSearchParams({ draft }).toString();
  const view = render(React.createElement(AgentPage));
  const input = view.getByRole('textbox', { name: t('agent.inputLabel') });
  await waitFor(() => assert.equal(input.value, draft));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  assert.equal(input.value, draft);
  assert.deepEqual(calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.url}`), []);
  assert.equal(calls.some(call => call.url === '/api/agent/chat'), false);
});
