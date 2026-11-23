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

function loadMessageBubble() {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/lib/i18n-context') {
      return { useTranslation: () => ({ t: key => key }) };
    }
    if (request === '@/components/ui/icons') {
      return new Proxy({}, { get: () => icon });
    }
    if (request === '@/components/chat/ReservedChatImage') {
      return {
        __esModule: true,
        default: ({ src, alt = '', className = '', onClick }) => React.createElement('img', {
          src: `blob:${src}`,
          alt,
          className,
          onClick,
        }),
      };
    }
    if (request === 'react-markdown') {
      return { __esModule: true, default: ({ children }) => React.createElement('span', null, children) };
    }
    if (request === 'remark-gfm') {
      return { __esModule: true, default: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve('../src/components/chat/MessageBubble.tsx');
    delete require.cache[resolved];
    return require('../src/components/chat/MessageBubble.tsx').default;
  } finally {
    Module._load = originalLoad;
  }
}

function assistantMessage() {
  return {
    id: 'assistant-1',
    conversation_id: 'conv-a',
    role: 'assistant',
    content: 'response',
    token_count: 1,
    created_at: '2026-07-10T00:00:00.000Z',
    seq: 1,
    metadata: {
      generatedImages: [{
        id: 'image-1',
        url: '/api/files/generated/image-1.png',
        prompt: 'portrait',
        status: 'ready',
        versions: [
          { id: 'version-1', url: '/api/files/generated/image-1.png', prompt: 'portrait' },
          { id: 'version-2', url: '/api/files/generated/image-2.png', prompt: 'portrait two' },
        ],
        activeVersion: 0,
      }],
    },
  };
}

function renderBubble(overrides = {}) {
  const MessageBubble = loadMessageBubble();
  return render(React.createElement(MessageBubble, {
    message: assistantMessage(),
    characterName: 'Alice',
    avatarUrl: null,
    onSetPrimaryImage() {},
    onDeleteImage() {},
    ...overrides,
  }));
}

test.afterEach(() => cleanup());
test.after(() => {
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('generated image thumbnail is keyboard operable and opens the lightbox', async () => {
  const user = userEvent.setup({ document });
  const view = renderBubble();
  const image = await waitFor(() => {
    const element = view.container.querySelector('.generated-image-card img');
    assert.ok(element, 'expected a generated image thumbnail');
    return element;
  });
  const trigger = image.closest('button');
  assert.ok(trigger, 'generated image thumbnail must be rendered as a real button');
  trigger.focus();
  await user.keyboard('{Enter}');

  assert.ok(within(document.body).getByRole('dialog', { name: 'message.imagePreviewTitle' }));
  assert.ok(within(document.body).getByRole('img', { name: 'message.imagePreviewAlt' }));
});

test('image generation controls expose busy state and reject repeated activation for the same message', async () => {
  let generations = 0;
  const view = renderBubble({
    isGeneratingImage: true,
    onGenerateImage: () => { generations += 1; },
  });

  const generateButton = view.getByRole('button', { name: 'imageGen.button' });
  assert.equal(generateButton.disabled, true);
  assert.equal(generateButton.getAttribute('aria-busy'), 'true');

  generateButton.click();
  assert.equal(generations, 0);
});

test('image lightbox traps focus, closes with Escape, and restores thumbnail focus', async () => {
  const user = userEvent.setup({ document });
  const view = renderBubble();
  const image = await waitFor(() => {
    const element = view.container.querySelector('.generated-image-card img');
    assert.ok(element, 'expected a generated image thumbnail');
    return element;
  });
  await user.click(image);
  const dialog = within(document.body).getByRole('dialog', { name: 'message.imagePreviewTitle' });
  const buttons = within(dialog).getAllByRole('button');
  assert.ok(buttons.length >= 2, 'lightbox should expose navigation and close controls');
  const enabledButtons = buttons.filter(button => !button.disabled);

  enabledButtons.at(-1).focus();
  await user.tab();
  assert.ok(document.activeElement === enabledButtons[0], 'Tab from the final control should loop to the first enabled control');

  await user.keyboard('{Escape}');
  assert.equal(within(document.body).queryByRole('dialog'), null);
  assert.ok(document.activeElement === image.closest('button'), 'focus should return to the lightbox trigger');
});

// 用 http://局域网IP 访问时不是安全上下文，浏览器不提供 navigator.clipboard。
function withoutClipboardApi(t, execCommand) {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const originalExecCommand = document.execCommand;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  document.execCommand = execCommand;
  t.after(() => {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else delete navigator.clipboard;
    document.execCommand = originalExecCommand;
  });
}

test('copy falls back to execCommand when the page has no clipboard API', async t => {
  const copied = [];
  withoutClipboardApi(t, command => {
    copied.push({ command, text: document.activeElement?.value });
    return true;
  });
  const view = renderBubble();
  view.getByRole('button', { name: 'message.copy' }).click();

  await waitFor(() => assert.ok(view.getByRole('button', { name: 'message.copied' })));
  assert.deepEqual(copied, [{ command: 'copy', text: 'response' }]);
  assert.equal(document.querySelector('textarea'), null, 'the temporary textarea must be removed');
});

test('copy reports failure instead of throwing when every copy method is rejected', async t => {
  withoutClipboardApi(t, () => false);
  const view = renderBubble();
  view.getByRole('button', { name: 'message.copy' }).click();

  await waitFor(() => assert.ok(view.getByRole('button', { name: 'message.copyFailed' })));
  assert.equal(document.querySelector('textarea'), null, 'the temporary textarea must be removed');
});
