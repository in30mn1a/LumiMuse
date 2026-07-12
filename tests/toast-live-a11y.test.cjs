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

const { cleanup, fireEvent, render, within } = require('@testing-library/react');

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

function loadModule(modulePath) {
  Module._load = function loadWithMocks(request, parent, isMain) {
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
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test.afterEach(() => cleanup());
test.after(() => {
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('error toast uses alert semantics and a focusable 44px dismiss button', () => {
  const { ToastProvider, useToast } = loadModule('../src/components/ui/Toast.tsx');

  function Controls() {
    const { showToast } = useToast();
    return React.createElement('button', {
      type: 'button',
      onClick: () => showToast('network failed', 'error'),
    }, 'show error');
  }

  const view = render(React.createElement(ToastProvider, null, React.createElement(Controls)));
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = () => 0;
  try {
    fireEvent.click(within(view.container).getByRole('button', { name: 'show error' }));
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  const alert = within(document.body).getByRole('alert');
  assert.equal(alert.textContent.includes('network failed'), true);
  const dismiss = within(alert).getByRole('button', { name: 'common.close' });
  assert.equal(dismiss.tagName, 'BUTTON');
  assert.match(dismiss.className, /min-h-11/);
  assert.match(dismiss.className, /min-w-11/);

  dismiss.focus();
  assert.equal(document.activeElement, dismiss);
  fireEvent.click(dismiss);
  assert.equal(within(document.body).queryByRole('alert'), null);
});

test('chat generation and memory extraction expose concise polite live status', () => {
  const ChatInput = loadModule('../src/components/chat/ChatInput.tsx').default;
  const ChatToolbar = loadModule('../src/components/chat/ChatToolbar.tsx').default;
  const inputView = render(React.createElement(ChatInput, {
    onSend() {},
    onStop() {},
    disabled: true,
    isGenerating: true,
    currentModel: 'model-a',
    onModelChange() {},
    modelList: ['model-a'],
  }));

  const generationStatus = inputView.container.querySelector('[aria-live="polite"]');
  assert.ok(generationStatus);
  assert.equal(generationStatus.textContent, 'status.streaming');
  assert.equal(generationStatus.getAttribute('aria-atomic'), 'true');

  const toolbarView = render(React.createElement(ChatToolbar, {
    activeConversation: { id: 'conv-a', title: 'Conversation' },
    unextractedCount: 1,
    memoryExtractStatus: 'extracting',
    tokenCount: 12,
    onOpenResetExtraction() {},
    onOpenTokenBreakdown() {},
  }));
  const extractionStatus = within(toolbarView.container).getByRole('status');
  assert.equal(extractionStatus.textContent.trim(), 'chat.extracting');
  assert.equal(extractionStatus.getAttribute('aria-live'), 'polite');
  assert.equal(extractionStatus.getAttribute('aria-atomic'), 'true');
});

test('explicit mobile chat icon controls expose 44px touch targets', () => {
  const ChatInput = loadModule('../src/components/chat/ChatInput.tsx').default;
  const ChatHeader = loadModule('../src/components/chat/ChatHeader.tsx').default;
  const inputView = render(React.createElement(ChatInput, {
    onSend() {},
    onStop() {},
    disabled: false,
    isGenerating: false,
    currentModel: 'model-a',
    onModelChange() {},
    modelList: ['model-a'],
  }));
  const attachButton = within(inputView.container).getByRole('button', { name: 'input.attachFileLabel' });
  assert.match(attachButton.className, /min-h-11/);
  assert.match(attachButton.className, /min-w-11/);

  const headerView = render(React.createElement(ChatHeader, {
    character: { id: 'char-a', name: 'Alice', avatar_url: null },
    activeConversation: { id: 'conv-a', title: 'Conversation' },
    conversationsCount: 1,
    memoryCount: 1,
    isStreamingHere: false,
    creating: false,
    summarizing: false,
    duplicating: false,
    toolbarExpanded: false,
    onToggleToolbar() {},
    onOpenSidebar() {},
    onOpenSearch() {},
    onOpenConvDrawer() {},
    onNewChat() {},
    onRename() {},
    onSummarize() {},
    onDuplicate() {},
    onOpenImageManager() {},
    onRequestDelete() {},
  }));

  for (const name of [
    'chat.openCharacterList',
    'chat.switchConversation',
    'chat.newConversation',
    'chat.searchMessages',
    'chat.expandToolbar',
  ]) {
    const button = within(headerView.container).getByRole('button', { name });
    assert.match(button.className, /min-h-11/, `${name} needs a 44px minimum height`);
    assert.match(button.className, /min-w-11/, `${name} needs a 44px minimum width`);
  }
});
