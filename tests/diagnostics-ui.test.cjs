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

const { cleanup, render, within } = require('@testing-library/react');
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

function loadWithMocks(relativePath, mocks) {
  Module._load = function loadMocked(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const resolved = require.resolve(relativePath);
    delete require.cache[resolved];
    return require(relativePath);
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

test('memory diagnostics panel renders extraction, profile, and embedding queues separately', () => {
  const { MemoryDiagnosticsPanel } = loadWithMocks(
    '../src/components/settings/memory/MemoryDiagnosticsPanel.tsx',
    {
      '@/components/ui/icons': {
        RefreshIcon: props => React.createElement('span', { ...props, 'aria-hidden': 'true' }),
      },
    },
  );
  const t = key => key;

  const view = render(React.createElement(MemoryDiagnosticsPanel, {
    t,
    diagnostics: {
      index: { total: 13, ready: 10, failed: 3 },
      tasks: { pending: 91, processing: 92, failed: 93 },
      queues: {
        extraction: { pending: 1, processing: 2, failed: 3 },
        profile: { pending: 4, processing: 5, failed: 6 },
        embedding: { pending: 7, processing: 8, failed: 9 },
      },
      candidates: { repairable: 2 },
      profile: { exists: true, filled_fields: 4 },
      archive: { archived: 5, summarized: 1 },
    },
    loading: false,
    error: null,
    onRefresh() {},
  }));

  for (const [label, value] of [
    ['settings.memoryDiagnosticsExtractionQueue', '1/2/3'],
    ['settings.memoryDiagnosticsProfileQueue', '4/5/6'],
    ['settings.memoryDiagnosticsEmbeddingQueue', '7/8/9'],
  ]) {
    const card = view.getByText(label).closest('div');
    assert.ok(card, `expected queue card for ${label}`);
    assert.equal(within(card).getByText(value).textContent, value);
  }
  assert.equal(view.queryByText('91/92/93'), null, 'new queue payload must not fall back to legacy aggregate tasks');
});

test('memory diagnostics panel keeps legacy tasks payload compatible as embedding queue', () => {
  const { MemoryDiagnosticsPanel } = loadWithMocks(
    '../src/components/settings/memory/MemoryDiagnosticsPanel.tsx',
    {
      '@/components/ui/icons': {
        RefreshIcon: props => React.createElement('span', { ...props, 'aria-hidden': 'true' }),
      },
    },
  );
  const view = render(React.createElement(MemoryDiagnosticsPanel, {
    t: key => key,
    diagnostics: {
      index: { total: 0, ready: 0, failed: 0 },
      tasks: { pending: 2, processing: 1, failed: 4 },
      candidates: {},
      profile: { exists: false, filled_fields: 0 },
      archive: {},
    },
    loading: false,
    error: null,
    onRefresh() {},
  }));

  const embeddingCard = view.getByText('settings.memoryDiagnosticsEmbeddingQueue').closest('div');
  assert.ok(embeddingCard);
  assert.equal(within(embeddingCard).getByText('2/1/4').textContent, '2/1/4');
});

test('token breakdown shows a retrieval failed badge from the safe mode field', () => {
  const Modal = ({ open, children, title }) => open
    ? React.createElement('section', { role: 'dialog', 'aria-label': title }, children)
    : null;
  const TokenBreakdownModal = loadWithMocks(
    '../src/components/chat/TokenBreakdownModal.tsx',
    {
      '@/components/ui/Modal': { __esModule: true, default: Modal },
      '@/lib/i18n-context': { useTranslation: () => ({ t: key => key }) },
      '@/lib/i18n': {
        formatTemplate: (template, values) => Object.entries(values)
          .reduce((result, [key, value]) => result.replace(`{${key}}`, String(value)), template),
      },
    },
  ).default;

  const view = render(React.createElement(TokenBreakdownModal, {
    open: true,
    onClose() {},
    items: [{ labelKey: 'token.memories', tokens: 0 }],
    lastMemoryInjection: { count: 0, tokens: 0, mode: 'failed' },
  }));

  const badge = view.getByText('token.mode.failed');
  assert.equal(badge.getAttribute('role'), 'status');
  assert.match(badge.className, /text-red/);
});
