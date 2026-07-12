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

test.afterEach(() => cleanup());
test.after(() => {
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

for (const scenario of [
  { isGenerating: false, name: 'input.send' },
  { isGenerating: true, name: 'input.stop' },
]) {
  test(`mobile chat control exposes the ${scenario.name} accessible name`, () => {
    const ChatInput = loadChatInput();
    const view = render(React.createElement(ChatInput, {
      onSend() {},
      onStop() {},
      disabled: false,
      isGenerating: scenario.isGenerating,
      currentModel: 'model-a',
      onModelChange() {},
      modelList: ['model-a'],
    }));

    const button = view.getByRole('button', { name: scenario.name });
    assert.ok(button);
    assert.match(button.querySelector('span:not([aria-hidden])')?.className || '', /hidden md:inline/);
  });
}
