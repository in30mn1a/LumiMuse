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
const { act, cleanup, fireEvent, render } = require('@testing-library/react');
const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const previousTs = require.extensions['.ts'];
const previousTsx = require.extensions['.tsx'];
const replacements = [];
const t = key => key;

Module._resolveFilename = function(request, parent, ...args) {
  if (request.startsWith('@/')) {
    const base = path.join(root, 'src', request.slice(2));
    for (const file of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return originalResolve.call(this, request, parent, ...args);
};

function loadTs(module, filename) {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(result.outputText, filename);
}
require.extensions['.ts'] = loadTs;
require.extensions['.tsx'] = loadTs;

Module._load = function(request, ...args) {
  if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t }) };
  if (request === 'next/navigation') return { useRouter: () => ({ replace: value => replacements.push(value) }), useSearchParams: () => new URLSearchParams() };
  if (request === 'next/image') return { __esModule: true, default: ({ unoptimized, ...props }) => React.createElement('img', props) };
  return originalLoad.call(this, request, ...args);
};

const LoginPage = require('../src/app/login/page.tsx').default;
const ContentState = require('../src/components/ui/ContentState.tsx').default;
const MemoryList = require('../src/components/memories/MemoryList.tsx').default;

test.afterEach(() => { cleanup(); delete global.fetch; replacements.length = 0; });
test.after(() => {
  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;
  if (previousTs) require.extensions['.ts'] = previousTs; else delete require.extensions['.ts'];
  if (previousTsx) require.extensions['.tsx'] = previousTsx; else delete require.extensions['.tsx'];
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('login provides a visible password label, loading name and linked inline errors', async () => {
  let resolve;
  global.fetch = () => new Promise(done => { resolve = done; });
  const view = render(React.createElement(LoginPage));
  const input = view.getByLabelText('login.passwordPrompt');
  assert.equal(input.type, 'password');
  assert.equal(input.autocomplete, 'current-password');
  assert.ok(document.activeElement === input, 'the password input should receive focus');
  fireEvent.change(input, { target: { value: 'fictional-password' } });
  fireEvent.click(view.getByRole('button', { name: 'login.submit' }));
  const busyButton = view.getByRole('button', { name: 'common.loading' });
  assert.equal(busyButton.getAttribute('aria-busy'), 'true');
  assert.equal(busyButton.disabled, true);
  await act(async () => { resolve(new Response(JSON.stringify({ error: 'Wrong password' }), { status: 401 })); });
  const error = await view.findByRole('alert');
  assert.equal(error.textContent, 'Wrong password');
  assert.equal(input.getAttribute('aria-describedby'), error.id);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.value, '');
  assert.ok(document.activeElement === input, 'the password input should receive focus');
  fireEvent.change(input, { target: { value: 'new-password' } });
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(input.getAttribute('aria-invalid'), 'false');
});

test('login preserves the successful in-app redirect', async () => {
  global.fetch = async () => new Response('{}', { status: 200 });
  const view = render(React.createElement(LoginPage));
  fireEvent.change(view.getByLabelText('login.passwordPrompt'), { target: { value: 'fictional-password' } });
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'login.submit' })); });
  assert.deepEqual(replacements, ['/']);
});

test('shared content states expose loading and errors while keeping decorative skeletons hidden', () => {
  const view = render(React.createElement(ContentState, { mode: 'loading', title: 'Loading results' }));
  const loading = view.getByRole('status', { name: 'Loading results' });
  assert.ok(loading.querySelector('[aria-hidden="true"]'));
  assert.ok(loading.querySelector('.motion-safe\\:animate-pulse'));
  view.rerender(React.createElement(ContentState, { mode: 'empty', title: 'No results' }));
  assert.equal(view.queryByRole('status'), null);
  assert.ok(view.getByText('No results'));
  view.rerender(React.createElement(ContentState, { mode: 'error', title: 'Load failed' }));
  assert.equal(view.getByRole('alert').textContent, 'Load failed');
});

test('a same-query background refresh preserves the real memory editor and its unsaved draft', async () => {
  const memory = {
    id: 'memory-a', character_id: 'character-a', content: 'Original memory', tags: [],
    category: '重要事件', memory_kind: 'fact', status: 'active', pinned: false,
    importance: 0.5, emotional_weight: 0.2, confidence: 1,
    created_at: '2026-10-12T00:00:00.000Z', updated_at: '2026-10-12T00:00:00.000Z',
  };
  let calls = 0, resolve;
  global.fetch = () => ++calls === 1
    ? Promise.resolve(new Response(JSON.stringify({ memories: [memory], total: 1, hasMore: false })))
    : new Promise(done => { resolve = done; });
  const view = render(React.createElement(MemoryList, { characterId: 'character-a' }));
  await view.findByText('Original memory');
  fireEvent.click(view.getAllByRole('button', { name: 'memory.edit' })[0]);
  const editor = view.container.querySelector('textarea');
  assert.ok(editor);
  fireEvent.change(editor, { target: { value: 'Unsaved user draft' } });
  view.rerender(React.createElement(MemoryList, { characterId: 'character-a', refreshNonce: 1 }));
  assert.equal(view.container.querySelector('textarea'), editor);
  assert.equal(editor.value, 'Unsaved user draft');
  assert.ok(view.getByRole('status', { name: 'common.loading' }));
  await act(async () => {
    resolve(new Response(JSON.stringify({ memories: [{ ...memory, content: 'Server revision' }], total: 1, hasMore: false })));
  });
  assert.equal(view.container.querySelector('textarea'), editor);
  assert.equal(editor.value, 'Unsaved user draft');
  assert.equal(view.queryByRole('status'), null);
});
