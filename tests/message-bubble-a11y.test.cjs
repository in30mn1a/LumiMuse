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

const { cleanup, render, within } = require('@testing-library/react');
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
  const image = view.container.querySelector('.generated-image-card img');
  assert.ok(image, 'expected a generated image thumbnail');

  const trigger = image.closest('button');
  assert.ok(trigger, 'generated image thumbnail must be rendered as a real button');
  trigger.focus();
  await user.keyboard('{Enter}');

  assert.ok(within(document.body).getByRole('dialog'));
});

test('image lightbox traps focus, closes with Escape, and restores thumbnail focus', async () => {
  const user = userEvent.setup({ document });
  const view = renderBubble();
  const image = view.container.querySelector('.generated-image-card img');
  assert.ok(image, 'expected a generated image thumbnail');

  await user.click(image);
  const dialog = within(document.body).getByRole('dialog');
  const buttons = within(dialog).getAllByRole('button');
  assert.ok(buttons.length >= 2, 'lightbox should expose navigation and close controls');
  const enabledButtons = buttons.filter(button => !button.disabled);

  enabledButtons.at(-1).focus();
  await user.tab();
  assert.equal(document.activeElement, enabledButtons[0], 'Tab from the final control should loop to the first enabled control');

  await user.keyboard('{Escape}');
  assert.equal(within(document.body).queryByRole('dialog'), null);
  assert.equal(document.activeElement, image.closest('button'));
});
