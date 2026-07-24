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
const { cleanup, fireEvent, render } = require('@testing-library/react');

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

function loadChatInput() {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t: key => key }) };
    if (request === '@/components/ui/icons') return new Proxy({}, { get: () => icon });
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const resolved = require.resolve('../src/components/chat/ChatInput.tsx');
    delete require.cache[resolved];
    return require(resolved).default;
  } finally {
    Module._load = originalLoad;
  }
}

const originalMatchMedia = window.matchMedia;

// 只让触屏媒体查询按场景返回，其余查询保持不匹配
function stubMatchMedia(coarse) {
  window.matchMedia = query => ({
    matches: coarse && query.includes('pointer: coarse'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
}

test.afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});
test.after(() => {
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

function renderInput(sent) {
  const ChatInput = loadChatInput();
  const view = render(React.createElement(ChatInput, {
    onSend(content) { sent.push(content); },
    onStop() {},
    disabled: false,
    isGenerating: false,
    currentModel: 'model-a',
    onModelChange() {},
    modelList: ['model-a'],
  }));
  const textarea = view.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: 'hello' } });
  return { view, textarea };
}

test('pointer-fine devices send on plain Enter', () => {
  stubMatchMedia(false);
  const sent = [];
  const { textarea } = renderInput(sent);

  fireEvent.keyDown(textarea, { key: 'Enter' });

  assert.deepEqual(sent, ['hello']);
});

test('pointer-fine devices keep Shift+Enter as a newline', () => {
  stubMatchMedia(false);
  const sent = [];
  const { textarea } = renderInput(sent);

  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

  assert.deepEqual(sent, []);
});

test('touch devices treat Enter as a newline instead of sending', () => {
  stubMatchMedia(true);
  const sent = [];
  const { textarea } = renderInput(sent);

  const notPrevented = fireEvent.keyDown(textarea, { key: 'Enter' });

  assert.deepEqual(sent, []);
  // 未 preventDefault，浏览器才会插入换行
  assert.equal(notPrevented, true);
});

test('touch devices still send through the send button', () => {
  stubMatchMedia(true);
  const sent = [];
  const { view } = renderInput(sent);

  fireEvent.click(view.getByRole('button', { name: 'input.send' }));

  assert.deepEqual(sent, ['hello']);
});
