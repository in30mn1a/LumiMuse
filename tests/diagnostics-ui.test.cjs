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

const { cleanup, render } = require('@testing-library/react');
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
