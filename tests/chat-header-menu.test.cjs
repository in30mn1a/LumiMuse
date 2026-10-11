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
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const t = key => key;

Module._resolveFilename = function(request, parent, ...args) {
  if (request.startsWith('@/')) {
    const base = path.join(root, 'src', request.slice(2));
    for (const file of [base, `${base}.ts`, `${base}.tsx`]) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return originalResolve.call(this, request, parent, ...args);
};
Module._load = function(request, ...args) {
  if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t }) };
  return originalLoad.call(this, request, ...args);
};
function loadTs(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText, filename);
}
require.extensions['.ts'] = loadTs;
require.extensions['.tsx'] = loadTs;

const ChatHeader = require('../src/components/chat/ChatHeader.tsx').default;
const DuplicateConvModal = require('../src/components/chat/DuplicateConvModal.tsx').default;
const DeleteConvModal = require('../src/components/chat/DeleteConvModal.tsx').default;
const noop = () => {};

function Harness() {
  const [action, setAction] = React.useState(null);
  return React.createElement(React.Fragment, null,
    React.createElement(ChatHeader, {
      character: { id: 'menu-character', name: 'Alice', avatar_url: null },
      activeConversation: { id: 'menu-conversation', title: 'Conversation' },
      conversationsCount: 1,
      memoryCount: 0,
      isStreamingHere: false,
      creating: false,
      summarizing: false,
      duplicating: false,
      toolbarExpanded: false,
      onToggleToolbar: noop,
      onOpenConvDrawer: noop,
      onNewChat: noop,
      onRename: noop,
      onSummarize: noop,
      onDuplicate: () => setAction('duplicate'),
      onOpenImageManager: noop,
      onRequestDelete: () => setAction('delete'),
    }),
    action === 'duplicate' && React.createElement(DuplicateConvModal, {
      open: true, onClose: () => setAction(null), onConfirm: noop,
    }),
    action === 'delete' && React.createElement(DeleteConvModal, {
      open: true, onClose: () => setAction(null), onConfirm: noop,
    }),
  );
}

test.afterEach(() => cleanup());
test.after(() => {
  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

for (const [name, itemName] of [['duplicate', 'chat.duplicate'], ['delete', 'common.delete']]) {
  for (const close of ['escape', 'cancel']) {
    test(`more menu ${name} dialog restores trigger focus after ${close}`, async () => {
      const user = userEvent.setup({ document });
      const view = render(React.createElement(Harness));
      const trigger = view.getByRole('button', { name: 'common.more' });
      await user.click(trigger);
      const item = view.getByRole('menuitem', { name: itemName });
      item.focus();
      await user.keyboard('{Enter}');
      const dialog = view.getByRole('dialog');
      await waitFor(() => assert.equal(dialog.contains(document.activeElement), true));
      assert.equal(view.queryByRole('menu'), null);
      if (close === 'escape') await user.keyboard('{Escape}');
      else await user.click(within(dialog).getByRole('button', { name: 'chat.cancel' }));
      await waitFor(() => assert.equal(view.queryByRole('dialog'), null));
      assert.ok(document.activeElement === trigger, 'closing the dialog must focus the more trigger');
    });
  }
}

test('Escape inside the more menu restores its trigger focus', async () => {
  const user = userEvent.setup({ document });
  const view = render(React.createElement(Harness));
  const trigger = view.getByRole('button', { name: 'common.more' });
  await user.click(trigger);
  view.getByRole('menuitem', { name: 'chat.duplicate' }).focus();
  await user.keyboard('{Escape}');
  assert.equal(view.queryByRole('menu'), null);
  assert.ok(document.activeElement === trigger, 'Escape must focus the more trigger');
});
