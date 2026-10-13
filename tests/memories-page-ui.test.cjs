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
const { cleanup, fireEvent, render, waitFor, within } = require('@testing-library/react');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

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

function loadMemoriesPage() {
  const translate = key => key;
  const showToast = () => {};

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
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === 'next/link') {
      return {
        __esModule: true,
        default: ({ children, href, ...props }) => React.createElement('a', { href, ...props }, children),
      };
    }
    if (request === '@/components/memories/MemoryList') {
      return { __esModule: true, default: () => React.createElement('div', { 'data-testid': 'memory-list' }) };
    }
    if (request === '@/lib/i18n-context') {
      return { useTranslation: () => ({ t: translate }) };
    }
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
    const absolutePath = path.join(root, 'src/app/memories/page.tsx');
    delete require.cache[require.resolve(absolutePath)];
    return require(absolutePath).default;
  } finally {
    Module._resolveFilename = originalResolveFilename;
    Module._load = originalLoad;
    delete require.extensions['.ts'];
    delete require.extensions['.tsx'];
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test.afterEach(() => {
  cleanup();
  delete global.fetch;
});

test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('/memories waits for the character request before showing the no-character state', async () => {
  let resolve;
  global.fetch = () => new Promise(done => { resolve = done; });
  const MemoriesPage = loadMemoriesPage();
  const view = render(React.createElement(MemoriesPage));
  assert.ok(view.getByRole('status', { name: 'common.loading' }));
  assert.equal(view.queryByText('memories.noCharacter'), null);
  resolve(jsonResponse([]));
  await view.findByText('memories.noCharacter');
  assert.equal(view.queryByRole('status'), null);
});

test('/memories renders a character load failure, not a no-character empty state', async () => {
  global.fetch = async () => jsonResponse({}, 503);
  const MemoriesPage = loadMemoriesPage();
  const view = render(React.createElement(MemoriesPage));
  assert.match((await view.findByRole('alert')).textContent, /common.loadFailed/);
  assert.equal(view.queryByText('memories.noCharacter'), null);
  assert.equal(view.queryByRole('status'), null);
});

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('/memories page places AI review beside character selector and exposes latest changes', () => {
  const memoriesPage = readProjectFile('src/app/memories/page.tsx');
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    "fetch('/api/memory-review'",
    'handleMemoryAiReview',
    'memoryAiReviewRunning',
    'lastMemoryAiReviewResult',
    'showMemoryAiReviewChanges',
    'let nextBatchIndex: number | null = 0;',
    'while (nextBatchIndex !== null)',
    'batch_index: nextBatchIndex',
    'if (planId) body.plan_id = planId;',
    "errBody.code === 'PLAN_NOT_FOUND'",
    "fetch('/api/memory-merge'",
    'handleAcceptMerge',
    'handleUndoMerge',
    'aggregateResult.reviewed += result.reviewed ?? 0;',
    'aggregateResult.changes.push(...(result.changes ?? []));',
    'changes: Array<{ id: string; fields: string[]; content: string; diffs: MemoryReviewChangeDiff[] }>',
    "t('memory.aiReview')",
    "t('memory.viewLatestAiReviewChanges')",
    "t('memory.hideLatestAiReviewChanges')",
    "t('memory.aiReviewMemoryContent')",
    "t('memory.mergeSuggestions')",
    "t('memory.mergeAccept')",
    "setMemoryRefreshNonce(prev => prev + 1)",
    '<MemoryList characterId={selectedCharId} refreshNonce={memoryRefreshNonce} />',
  ]) {
    assert.ok(memoriesPage.includes(snippet), `missing snippet: ${snippet}`);
  }

  assert.match(
    memoriesPage,
    /<details[\s\S]*?\{change\.content\}[\s\S]*?<\/details>[\s\S]*?\{t\('memory\.aiReviewChangedFields'\)\}:[\s\S]*?change\.diffs\.map\(/,
    'AI review changes should keep changed fields visible and collapse only memory content',
  );

  const controlsStart = memoriesPage.indexOf('<div className="flex flex-wrap items-center gap-3">');
  assert.notEqual(controlsStart, -1, 'missing header controls');
  const controlsEnd = memoriesPage.indexOf('<select', controlsStart);
  assert.notEqual(controlsEnd, -1, 'missing character select after controls');
  const controlsBeforeSelect = memoriesPage.slice(controlsStart, controlsEnd);
  assert.ok(controlsBeforeSelect.includes("t('memory.aiReview')"), 'AI review button is not before character selector');

  assert.doesNotMatch(settingsPage, /fetch\('\/api\/memory-review'/);
  assert.doesNotMatch(settingsPage, /t\('settings\.memoryAiReview'\)/);

  for (const key of [
    'memory.aiReview',
    'memory.aiReviewRunning',
    'memory.aiReviewDone',
    'memory.aiReviewFailed',
    'memory.aiReviewPlanExpired',
    'memory.viewLatestAiReviewChanges',
    'memory.hideLatestAiReviewChanges',
    'memory.aiReviewNoChanges',
    'memory.aiReviewChangedFields',
    'memory.aiReviewMemoryContent',
    'memory.mergeSuggestions',
    'memory.mergeAccept',
    'memory.mergeReject',
    'memory.mergeUndo',
    'memory.mergeAccepted',
    'memory.mergeFailed',
    'memory.mergeUndoDone',
    'memory.mergeConflict',
    'memory.tags',
    'memory.aiReviewProgress',
    'memory.aiReviewStop',
    'memory.aiReviewStopped',
    'memory.aiReviewStoppedEmpty',
    'memory.aiReviewFailedBatches',
    'memory.aiReviewCorrections',
    'memory.aiReviewEmptyValue',
    'memory.mergeSuggestionsHint',
    'memory.mergeResult',
    'memory.mergeAcceptedBadge',
    'memory.mergeStaleBadge',
    'memory.mergeStale.not_active',
    'memory.mergeStale.not_found',
    'memory.mergeStale.pinned',
    'memory.mergeStale.reserved',
  ]) {
    // 中英文各定义一次，缺任何一边都会在界面上露出原始 key。
    assert.equal(i18n.split(`'${key}':`).length - 1, 2, `i18n key should exist in zh and en: ${key}`);
  }
});

// 归属判断用「这一轮自己的 AbortController」而不是角色 id：切走又切回同一角色后新开的一轮，
// 角色 id 与旧一轮相同，只比 id 会让旧一轮把结果写进新一轮（审计 2026-10-13 F13）。
test('/memories page binds AI review results to the initiating run', () => {
  const memoriesPage = readProjectFile('src/app/memories/page.tsx');

  for (const snippet of [
    'memoryAiReviewAbortRef.current = abortController;',
    'const requestedCharacterId = selectedCharId;',
    'character_id: requestedCharacterId',
    'batch_index: nextBatchIndex',
    'if (planId) body.plan_id = planId;',
    'if (memoryAiReviewAbortRef.current !== abortController) return;',
  ]) {
    assert.ok(memoriesPage.includes(snippet), `missing snippet: ${snippet}`);
  }
});

test('/memories page keeps AI review loading scoped to the initiating run', () => {
  const memoriesPage = readProjectFile('src/app/memories/page.tsx');
  const handlerStart = memoriesPage.indexOf('const handleMemoryAiReview = async () => {');
  assert.notEqual(handlerStart, -1, 'missing handleMemoryAiReview');
  const handlerEnd = memoriesPage.indexOf('return (', handlerStart);
  assert.notEqual(handlerEnd, -1, 'missing handleMemoryAiReview end marker');
  const handlerBlock = memoriesPage.slice(handlerStart, handlerEnd);

  assert.match(
    handlerBlock,
    /finally \{\s*if \(memoryAiReviewAbortRef\.current === abortController\) \{\s*setMemoryAiReviewRunning\(false\);\s*\}\s*\}/,
    'an old AI review run must not clear the loading state of a newer run',
  );
});

test('/memories page clears AI review running and old result state when changing characters', () => {
  const memoriesPage = readProjectFile('src/app/memories/page.tsx');
  const selectStart = memoriesPage.indexOf('<select');
  assert.notEqual(selectStart, -1, 'missing character select');
  const selectEnd = memoriesPage.indexOf('className="select-rich min-w-56"', selectStart);
  assert.notEqual(selectEnd, -1, 'missing character select end marker');
  const selectBlock = memoriesPage.slice(selectStart, selectEnd);

  for (const snippet of [
    'memoryAiReviewAbortRef.current?.abort();',
    'memoryAiReviewAbortRef.current = null;',
    'setSelectedCharId(nextCharacterId);',
    'setMemoryAiReviewRunning(false);',
    'setLastMemoryAiReviewResult(null);',
    'setShowMemoryAiReviewChanges(false);',
  ]) {
    assert.ok(selectBlock.includes(snippet), `character change does not clear AI review state: ${snippet}`);
  }

  assert.ok(
    selectBlock.indexOf('setMemoryAiReviewRunning(false);') < selectBlock.indexOf('setLastMemoryAiReviewResult(null);'),
    'character change should clear running before resetting old review result state',
  );
});

test('/memories page opens source details and closes them with an explicit button', async () => {
  global.fetch = async input => {
    const url = String(input);
    if (url === '/api/characters') {
      return jsonResponse([{
        id: 'char-a',
        name: '角色 A',
        avatar_url: null,
        description: '',
        personality: '',
        system_prompt: '',
        first_message: '',
        example_dialogues: [],
        tags: [],
        created_at: '2026-07-31T00:00:00.000Z',
        updated_at: '2026-07-31T00:00:00.000Z',
      }]);
    }
    if (url === '/api/memory-review') {
      return jsonResponse({
        ok: true,
        reviewed: 2,
        total_active: 2,
        skipped_due_to_limit: 0,
        reviewed_offset: 0,
        next_offset: null,
        next_batch_index: null,
        has_more: false,
        corrected: 0,
        failed_batches: 0,
        failed_messages: [],
        indexing_queued: 0,
        indexing_started: false,
        changes: [],
        merge_suggestions: [{
          source_ids: ['mem-a', 'mem-b'],
          merged_content: '用户喜欢美式咖啡。',
          kind: 'merge',
          sources: [
            { id: 'mem-a', content: '第一条源记忆全文', category: '偏好习惯', tags: ['咖啡', '饮品'] },
            { id: 'mem-b', content: '第二条源记忆全文', category: '四季日常', tags: ['日常'] },
          ],
        }],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const MemoriesPage = loadMemoriesPage();
  const view = render(React.createElement(MemoriesPage));
  const reviewButton = await view.findByRole('button', { name: 'memory.aiReview' });
  await waitFor(() => assert.equal(reviewButton.disabled, false));
  fireEvent.click(reviewButton);

  const viewSourcesButton = await view.findByRole('button', { name: 'memory.mergeViewSources' });
  fireEvent.click(viewSourcesButton);

  const dialog = await view.findByRole('dialog', { name: 'memory.mergeSources ×2' });
  const dialogQueries = within(dialog);
  assert.ok(dialogQueries.getByText('第一条源记忆全文'));
  assert.ok(dialogQueries.getByText('第二条源记忆全文'));
  assert.ok(dialogQueries.getByText(/偏好习惯/));
  assert.ok(dialogQueries.getByText(/咖啡,饮品/));

  const sourceCard = dialogQueries.getByText('第一条源记忆全文').parentElement;
  assert.ok(sourceCard?.className.includes('bg-surface-2'));
  assert.ok(!sourceCard?.className.includes('dark:bg-white/5'));

  const closeButton = dialogQueries.getByRole('button', { name: 'common.close' });
  assert.equal(closeButton.tagName, 'BUTTON');
  assert.ok(closeButton.tabIndex >= 0);
  fireEvent.click(closeButton);
  await waitFor(() => assert.equal(view.queryByRole('dialog'), null));
});

const reviewCharacter = {
  id: 'char-a',
  name: '角色 A',
  avatar_url: null,
  description: '',
  personality: '',
  system_prompt: '',
  first_message: '',
  example_dialogues: [],
  tags: [],
  created_at: '2026-07-31T00:00:00.000Z',
  updated_at: '2026-07-31T00:00:00.000Z',
};

function reviewPayload(overrides = {}) {
  return {
    ok: true,
    reviewed: 2,
    total_active: 2,
    skipped_due_to_limit: 0,
    reviewed_offset: 0,
    next_offset: null,
    next_batch_index: null,
    has_more: false,
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

test('/memories page marks a merge suggestion as expired when its sources can no longer be merged', async () => {
  global.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/characters') return jsonResponse([reviewCharacter]);
    if (url === '/api/memory-review') {
      return jsonResponse(reviewPayload({
        reviewed: 4,
        total_active: 4,
        merge_suggestions: [
          {
            source_ids: ['mem-a', 'mem-b'],
            merged_content: '用户喜欢美式咖啡。',
            kind: 'merge',
            sources: [
              { id: 'mem-a', content: '第一条源记忆全文', category: '偏好习惯', tags: [] },
              { id: 'mem-b', content: '第二条源记忆全文', category: '偏好习惯', tags: [] },
            ],
          },
          {
            source_ids: ['mem-c', 'mem-d'],
            merged_content: '用户养了一只猫。',
            kind: 'merge',
            sources: [
              { id: 'mem-c', content: '第三条源记忆全文', category: '四季日常', tags: [] },
              { id: 'mem-d', content: '第四条源记忆全文', category: '四季日常', tags: [] },
            ],
          },
        ],
      }));
    }
    if (url === '/api/memory-merge') {
      const body = JSON.parse(init.body);
      // 第一条：源记忆已不是 active（真实 bug 场景）；第二条：与源记忆状态无关的普通失败。
      return body.source_ids.includes('mem-a')
        ? jsonResponse({ ok: false, error: 'Only active memories can be merged', reason: 'not_active' }, 400)
        : jsonResponse({ ok: false, error: '合并记忆失败' }, 400);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const MemoriesPage = loadMemoriesPage();
  const view = render(React.createElement(MemoriesPage));
  const reviewButton = await view.findByRole('button', { name: 'memory.aiReview' });
  await waitFor(() => assert.equal(reviewButton.disabled, false));
  fireEvent.click(reviewButton);

  const staleCard = (await view.findByText('用户喜欢美式咖啡。')).parentElement;
  const failedCard = view.getByText('用户养了一只猫。').parentElement;
  // 源记忆内容直接展示在建议卡片上，不必先打开弹窗才能判断。
  assert.ok(within(staleCard).getByText('第一条源记忆全文'));
  assert.ok(within(staleCard).getByText('第二条源记忆全文'));

  fireEvent.click(within(staleCard).getByRole('button', { name: 'memory.mergeAccept' }));
  await within(staleCard).findByText('memory.mergeStale.not_active');
  assert.ok(within(staleCard).getByText('memory.mergeStaleBadge'));
  assert.equal(within(staleCard).queryByText('Only active memories can be merged'), null);
  assert.equal(
    within(staleCard).queryByRole('button', { name: 'memory.mergeAccept' }),
    null,
    'an expired suggestion must not offer a retry that can never succeed',
  );

  fireEvent.click(within(failedCard).getByRole('button', { name: 'memory.mergeAccept' }));
  await within(failedCard).findByText('合并记忆失败');
  assert.equal(within(failedCard).queryByText('memory.mergeStaleBadge'), null);
  assert.ok(
    within(failedCard).getByRole('button', { name: 'memory.mergeAccept' }),
    'a failure unrelated to the sources stays retryable',
  );

  // 失效与失败的建议都可以手动清掉。
  fireEvent.click(within(staleCard).getByRole('button', { name: 'memory.mergeReject' }));
  await waitFor(() => assert.equal(view.queryByText('用户喜欢美式咖啡。'), null));
  fireEvent.click(within(failedCard).getByRole('button', { name: 'memory.mergeReject' }));
  await waitFor(() => assert.equal(view.queryByText('用户养了一只猫。'), null));
});

test('/memories page shows corrections as before and after values and lists failed batches', async () => {
  global.fetch = async input => {
    const url = String(input);
    if (url === '/api/characters') return jsonResponse([reviewCharacter]);
    if (url === '/api/memory-review') {
      return jsonResponse(reviewPayload({
        corrected: 1,
        failed_batches: 1,
        failed_messages: ['批次 2: 上游超时'],
        changes: [{
          id: 'mem-a',
          fields: ['category→四季日常', 'tags→[午餐]', 'importance→0.4'],
          diffs: [
            { field: 'category', before: '重要事件', after: '四季日常' },
            { field: 'tags', before: [], after: ['午餐', '面条'] },
            { field: 'importance', before: 0.9, after: 0.4 },
          ],
          content: '用户午饭吃了面。',
        }],
      }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const MemoriesPage = loadMemoriesPage();
  const view = render(React.createElement(MemoriesPage));
  const reviewButton = await view.findByRole('button', { name: 'memory.aiReview' });
  await waitFor(() => assert.equal(reviewButton.disabled, false));
  fireEvent.click(reviewButton);

  const diffRow = (await view.findByText('memory.aiReviewChangedFields:')).parentElement;
  const text = diffRow.textContent.replace(/\s+/g, ' ');
  assert.match(text, /memory\.category 重要事件 → 四季日常/);
  assert.match(text, /memory\.tags memory\.aiReviewEmptyValue → 午餐、面条/);
  assert.match(text, /memory\.importance 0\.9 → 0\.4/);
  assert.doesNotMatch(text, /category→/, 'raw field→value strings must not be shown to the user');

  assert.ok(view.getByText('memory.aiReviewFailedBatches'));
  assert.ok(view.getByText('批次 2: 上游超时'));
});

test('/memories page reports progress and lets the user stop a multi-batch AI review', async () => {
  const reviewRequests = [];
  global.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/characters') return jsonResponse([reviewCharacter]);
    if (url === '/api/memory-review') {
      const body = JSON.parse(init.body);
      reviewRequests.push(body);
      if (body.batch_index === 0) {
        return jsonResponse(reviewPayload({
          plan_id: 'plan-1',
          batch_count: 2,
          reviewed: 500,
          total_active: 800,
          next_batch_index: 1,
          has_more: true,
        }));
      }
      // 第二批一直挂起，直到被用户中止。
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const MemoriesPage = loadMemoriesPage();
  const view = render(React.createElement(MemoriesPage));
  const reviewButton = await view.findByRole('button', { name: 'memory.aiReview' });
  await waitFor(() => assert.equal(reviewButton.disabled, false));
  fireEvent.click(reviewButton);

  // t 是恒等函数，占位符替换后只剩 key；按钮文案切到进度 key 即表示进度已上报。
  await view.findByRole('button', { name: 'memory.aiReviewProgress' });
  await waitFor(() => assert.equal(reviewRequests.length, 2));
  fireEvent.click(view.getByRole('button', { name: 'memory.aiReviewStop' }));

  await view.findByRole('button', { name: 'memory.aiReview' });
  assert.equal(view.queryByRole('button', { name: 'memory.aiReviewStop' }), null);
  // 已完成批次的结果保留可见，而不是随中止一起丢掉。
  assert.ok(view.getByText('memory.aiReviewDone'));
});

test('memory list accumulates clicked tag filters and shows removable tag chips without label text', () => {
  const memoryList = readProjectFile('src/components/memories/MemoryList.tsx');
  const memoryCard = readProjectFile('src/components/memories/MemoryCard.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  for (const snippet of [
    'refreshNonce?: number;',
    'const [tagFilters, setTagFilters] = useState<string[]>([]);',
    "tagFilters.forEach(tag => params.append('tag', tag));",
    'const handleTagFilterClick = useCallback((tag: string) => {',
    'setTagFilters(prev => (prev.includes(tag) ? prev : [...prev, tag]));',
    'const clearTagFilter = useCallback((tag: string) => {',
    'setTagFilters(prev => prev.filter(item => item !== tag));',
    'setPage(1);',
    'onTagClick={handleTagFilterClick}',
    "t('memory.clearTagFilter')",
  ]) {
    assert.ok(memoryList.includes(snippet), `missing snippet: ${snippet}`);
  }

  assert.ok(memoryList.includes('refreshNonce'), 'MemoryList does not accept external refresh trigger');
  assert.doesNotMatch(memoryList, /memory\.activeTagFilter/);
  assert.doesNotMatch(i18n, /'memory\.activeTagFilter'/);
  assert.ok(memoryCard.includes('onTagClick?: (tag: string) => void;'));
  // selectMode 下根节点可能是 label；标签点击需 preventDefault+stopPropagation，避免误触批选。
  assert.ok(
    memoryCard.includes('onClick={e => { e.preventDefault(); e.stopPropagation(); onTagClick?.(tag); }}')
      || memoryCard.includes('onClick={e => { e.stopPropagation(); onTagClick?.(tag); }}'),
  );
  assert.ok(memoryCard.includes("title={t('memory.filterByTag').replace('{tag}', tag)}"));

  for (const key of [
    'memory.clearTagFilter',
    'memory.filterByTag',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});

test('memory list guards stale loads and sends character_id for single delete', () => {
  const memoryList = readProjectFile('src/components/memories/MemoryList.tsx');

  for (const snippet of [
    'useRef',
    'const requestSeqRef = useRef(0);',
    'signal?: AbortSignal',
    'const requestSeq = ++requestSeqRef.current;',
    "fetch(`/api/memories?${params}`, { signal })",
    'signal?.aborted || requestSeq !== requestSeqRef.current',
    "error instanceof DOMException && error.name === 'AbortError'",
    'const controller = new AbortController();',
    'void fetchMemories(page, controller.signal);',
    'return () => controller.abort();',
    "body: JSON.stringify({ character_id: characterId || undefined })",
  ]) {
    assert.ok(memoryList.includes(snippet), `missing snippet: ${snippet}`);
  }

  assert.match(
    memoryList,
    /fetch\(`\/api\/memories\/\$\{id\}`,\s*\{\s*method: 'DELETE',\s*headers: \{ 'Content-Type': 'application\/json' \},\s*body: JSON\.stringify\(\{ character_id: characterId \|\| undefined \}\),/s,
    'single delete must send character_id while preserving JSON Content-Type',
  );
});

test('memory list refetches after write operations and disables in-flight write buttons', () => {
  const memoryList = readProjectFile('src/components/memories/MemoryList.tsx');
  const memoryCard = readProjectFile('src/components/memories/MemoryCard.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  assert.doesNotMatch(memoryList, /setMemories\(prev => prev\.map/);
  assert.doesNotMatch(memoryList, /setMemories\(prev => \[newMemory, \.\.\.prev\]/);
  assert.doesNotMatch(memoryList, /setSortOrder\('newest'\)/);

  for (const snippet of [
    'const [addingMemory, setAddingMemory] = useState(false);',
    'const [batchDeleting, setBatchDeleting] = useState(false);',
    'await fetchMemories(page);',
    'await fetchMemories(1);',
    "disabled={!characterId || selectMode || addingMemory}",
    "addingMemory ? t('memory.adding') : t('memory.add')",
    'disabled={batchDeleting}',
    "batchDeleting ? t('memory.deleting') : t('memory.batchDelete')",
  ]) {
    assert.ok(memoryList.includes(snippet), `missing MemoryList snippet: ${snippet}`);
  }

  for (const snippet of [
    "const [pendingAction, setPendingAction] = useState<'save' | 'delete' | 'pin' | null>(null);",
    'const isPending = pendingAction !== null;',
    "setPendingAction('save');",
    "setPendingAction('delete');",
    "setPendingAction('pin');",
    'disabled={isPending}',
    "pendingAction === 'save' ? t('memory.saving') : t('memory.save')",
    "pendingAction === 'delete' ? t('memory.deleting') : t('memory.delete')",
    "pendingAction === 'pin' ? t('memory.updating')",
    'aria-busy={pendingAction ===',
  ]) {
    assert.ok(memoryCard.includes(snippet), `missing MemoryCard snippet: ${snippet}`);
  }

  for (const key of [
    'memory.adding',
    'memory.saving',
    'memory.deleting',
    'memory.updating',
  ]) {
    assert.match(i18n, new RegExp(`'${key}'`));
  }
});
