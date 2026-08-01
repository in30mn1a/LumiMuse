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

const { act, cleanup, render, waitFor, within } = require('@testing-library/react');
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

const staleResult = {
  messageId: 'message-old',
  snippet: 'old result',
  role: 'user',
  createdAt: '2026-08-01T00:00:00.000Z',
  conversationId: 'conversation-old',
  conversationTitle: 'Old conversation',
  characterId: 'character-old',
  characterName: 'Alice',
  avatarUrl: null,
  highlightRanges: [{ start: 0, end: 3, text: 'old' }],
};

function loadComponent(modulePath) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/hooks/use-message-search') {
      return {
        useMessageSearch: () => ({
          results: [staleResult],
          loading: false,
          loadingMore: false,
          hasMore: false,
          error: null,
          loadMore: () => {},
          clearSearch: () => {},
        }),
      };
    }
    if (request === '@/lib/i18n-context') {
      return { useTranslation: () => ({ t: key => key }) };
    }
    if (request === '@/components/ui/icons') {
      return new Proxy({}, { get: () => icon });
    }
    if (request === './CharacterList') {
      return { __esModule: true, default: () => React.createElement('div') };
    }
    if (request === 'next/link') {
      return { __esModule: true, default: props => React.createElement('a', props) };
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

test.afterEach(() => cleanup());
test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('GlobalSearch selects an old result with the query snapshot that produced it', async () => {
  const user = userEvent.setup({ document });
  const GlobalSearch = loadComponent('../src/components/search/GlobalSearch.tsx');
  let selection = null;
  render(React.createElement(GlobalSearch, {
    open: true,
    onClose: () => {},
    onConversationSelect: (...args) => { selection = args; },
  }));

  const dialog = within(document.body).getByRole('dialog');
  const input = within(dialog).getByRole('textbox');
  await waitFor(() => assert.equal(input.value, ''));
  await user.type(input, 'replacement query');
  await user.click(within(dialog).getByText('old result'));

  assert.deepEqual(selection, [
    'character-old',
    'conversation-old',
    'message-old',
    [{ start: 0, end: 3, text: 'old' }],
  ]);
});

test('Sidebar selects an old result with the query snapshot that produced it', async () => {
  const user = userEvent.setup({ document });
  const Sidebar = loadComponent('../src/components/sidebar/Sidebar.tsx');
  let selection = null;
  const view = render(React.createElement(Sidebar, {
    selectedCharacterId: null,
    onCharacterSelect: () => {},
    onConversationSelect: (...args) => { selection = args; },
  }));

  const input = within(view.container).getByRole('textbox');
  await user.click(input);
  await user.type(input, 'replacement query');
  await user.click(within(view.container).getByText('old result'));
  // Sidebar 延迟收起 blur 面板；在测试环境销毁前让该回调正常完成。
  await act(async () => new Promise(resolve => setTimeout(resolve, 180)));

  assert.deepEqual(selection, [
    'character-old',
    'conversation-old',
    'message-old',
    [{ start: 0, end: 3, text: 'old' }],
  ]);
});
