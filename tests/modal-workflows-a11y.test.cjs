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
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 1 });

const { cleanup, render, waitFor, within } = require('@testing-library/react');
const userEvent = require('@testing-library/user-event').default;

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

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

function loadComponent(modulePath, extraMocks = {}) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(extraMocks, request)) return extraMocks[request];
    if (request === '@/lib/i18n-context') {
      return { useTranslation: () => ({ t: key => key }) };
    }
    if (request === '@/components/ui/icons') {
      return new Proxy({}, { get: () => icon });
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath).default;
  } finally {
    Module._load = originalLoad;
  }
}

function memory() {
  return {
    id: 'memory-1',
    character_id: 'char-a',
    content: 'Alice likes blue scarves',
    category: 'preference',
    tags: ['clothes'],
    memory_kind: 'fact',
    importance: 0.8,
    emotional_weight: 0.4,
    confidence: 0.9,
    status: 'active',
    pinned: false,
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  };
}

const searchResults = [
  {
    messageId: 'message-1',
    snippet: 'first result',
    role: 'user',
    createdAt: '2026-07-10T00:00:00.000Z',
    conversationId: 'conv-a',
    conversationTitle: 'First conversation',
    characterId: 'char-a',
    characterName: 'Alice',
    avatarUrl: null,
  },
  {
    messageId: 'message-2',
    snippet: 'second result',
    role: 'assistant',
    createdAt: '2026-07-10T00:01:00.000Z',
    conversationId: 'conv-b',
    conversationTitle: 'Second conversation',
    characterId: 'char-a',
    characterName: 'Alice',
    avatarUrl: null,
  },
];

function loadGlobalSearch() {
  return loadComponent('../src/components/search/GlobalSearch.tsx', {
    '@/hooks/use-message-search': {
      useMessageSearch: () => ({
        results: searchResults,
        loading: false,
        loadingMore: false,
        hasMore: false,
        loadMore() {},
        clearSearch() {},
      }),
    },
  });
}

function SearchHarness({ GlobalSearch }) {
  const [open, setOpen] = React.useState(false);
  return React.createElement(React.Fragment, null,
    React.createElement('button', { type: 'button', onClick: () => setOpen(true) }, 'open search'),
    React.createElement(GlobalSearch, { open, onClose: () => setOpen(false) }),
  );
}

test.afterEach(() => cleanup());
test.after(() => {
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('MemoryCard selection uses a real checkbox and invokes onSelect once per activation', async () => {
  const user = userEvent.setup({ document });
  const MemoryCard = loadComponent('../src/components/memories/MemoryCard.tsx');
  let selectionCalls = 0;

  function Harness() {
    const [selected, setSelected] = React.useState(false);
    return React.createElement(MemoryCard, {
      memory: memory(),
      onUpdate: async () => {},
      onDelete: async () => {},
      selectMode: true,
      selected,
      onSelect: () => {
        selectionCalls += 1;
        setSelected(value => !value);
      },
    });
  }

  const view = render(React.createElement(Harness));
  const checkbox = within(view.container).getByRole('checkbox');
  await user.click(checkbox);
  assert.equal(selectionCalls, 1, 'mouse activation should toggle exactly once');
  assert.equal(checkbox.checked, true);

  checkbox.focus();
  await user.keyboard(' ');
  assert.equal(selectionCalls, 2, 'Space activation should toggle exactly once');
  assert.equal(checkbox.checked, false);
});

test('GlobalSearch traps Tab focus inside the dialog', async () => {
  const user = userEvent.setup({ document });
  const GlobalSearch = loadGlobalSearch();
  const view = render(React.createElement(SearchHarness, { GlobalSearch }));
  const trigger = within(view.container).getByRole('button', { name: 'open search' });
  trigger.focus();
  await user.click(trigger);

  const dialog = within(document.body).getByRole('dialog');
  const input = within(dialog).getByRole('textbox');
  await waitFor(() => assert.equal(document.activeElement, input));
  const resultButtons = within(dialog).getAllByRole('button');
  resultButtons.at(-1).focus();
  await user.tab();

  assert.equal(document.activeElement, input, 'Tab from the last result should loop to the search input');
});

test('GlobalSearch closes with Escape and restores focus to its trigger', async () => {
  const user = userEvent.setup({ document });
  const GlobalSearch = loadGlobalSearch();
  const view = render(React.createElement(SearchHarness, { GlobalSearch }));
  const trigger = within(view.container).getByRole('button', { name: 'open search' });
  trigger.focus();
  await user.click(trigger);

  const dialog = within(document.body).getByRole('dialog');
  const input = within(dialog).getByRole('textbox');
  await waitFor(() => assert.equal(document.activeElement, input));
  await user.keyboard('{Escape}');

  await waitFor(() => assert.equal(within(document.body).queryByRole('dialog'), null));
  assert.equal(document.activeElement, trigger);
});
