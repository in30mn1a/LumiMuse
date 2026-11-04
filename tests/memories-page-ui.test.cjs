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
const { cleanup, render } = require('@testing-library/react');

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

test.after(async () => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
  // 剩下的用例多是同步的，after 会紧跟加载失败用例执行；先排空 React 调度回调再拆 DOM。
  await cleanupReactDomTestEnvironment(restoreDom);
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

test('/memories page no longer offers AI review or merge suggestions', () => {
  const memoriesPage = readProjectFile('src/app/memories/page.tsx');
  const i18n = readProjectFile('src/lib/i18n.ts');

  // 旧 AI 整理和合并建议已退役，记忆整理改由 Agent 的 memory-review skill 负责。
  for (const snippet of ['/api/memory-review', '/api/memory-merge', 'aiReview', 'mergeSuggestion', 'refreshNonce']) {
    assert.ok(!memoriesPage.includes(snippet), `retired snippet still present: ${snippet}`);
  }
  assert.ok(memoriesPage.includes('<MemoryList characterId={selectedCharId} />'), 'memory list should still render');

  for (const key of ['memory.aiReview', 'memory.aiReviewDone', 'memory.mergeSuggestions', 'memory.mergeAccept', 'memory.mergeStale.not_found']) {
    assert.ok(!i18n.includes(`'${key}':`), `retired i18n key still defined: ${key}`);
  }
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
