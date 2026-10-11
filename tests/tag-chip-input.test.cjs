const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { cleanup, render, fireEvent } = require('@testing-library/react');
const filename = require('node:path').resolve(__dirname, '../src/components/ui/TagChipInput.tsx');
const originalLoad = Module._load;
const componentModule = new Module(filename, module);
componentModule.filename = filename;
componentModule.paths = module.paths;
Module._load = function(request, parent, isMain) {
  if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t: key => key }) };
  if (request === '@/components/ui/icons') return { XIcon: () => null };
  return originalLoad.call(this, request, parent, isMain);
};
try {
  componentModule._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText, filename);
} finally {
  Module._load = originalLoad;
}
const TagChipInput = componentModule.exports.default;

function setup(initialValue = '') {
  const changes = [];
  const drafts = [];
  function Harness() {
    const [value, setValue] = React.useState(initialValue);
    return React.createElement(TagChipInput, {
      value,
      onChange: next => { changes.push(next); setValue(next); },
      onDraftChange: next => drafts.push(next),
    });
  }
  const view = render(React.createElement(Harness));
  return { ...view, input: view.container.querySelector('input'), changes, drafts };
}

function paste(input, text) {
  return fireEvent.paste(input, { clipboardData: { getData: () => text } });
}

test.afterEach(cleanup);
test.after(() => { restoreDom(); delete global.IS_REACT_ACT_ENVIRONMENT; });

test('IME composition Enter neither prevents default nor clears the draft', () => {
  const { input, changes, drafts } = setup();
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '中文' } });
  assert.equal(fireEvent.keyDown(input, { key: 'Enter' }), true);
  assert.equal(input.value, '中文');
  assert.deepEqual(changes, []);
  assert.deepEqual(drafts, ['中文']);
  fireEvent.compositionEnd(input);
  assert.equal(fireEvent.keyDown(input, { key: 'Enter' }), false);
  assert.deepEqual(changes, ['中文']);
  assert.deepEqual(drafts, ['中文', '']);
});

test('native isComposing and legacy keyCode 229 guard Enter independently', () => {
  const { input, changes } = setup();
  fireEvent.change(input, { target: { value: '候选' } });
  assert.equal(fireEvent.keyDown(input, { key: 'Enter', isComposing: true }), true);
  assert.equal(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 }), true);
  assert.equal(input.value, '候选');
  assert.deepEqual(changes, []);
});

test('batch paste preserves the unselected existing draft at the caret', () => {
  const { input, changes, drafts } = setup();
  fireEvent.change(input, { target: { value: 'red hair' } });
  input.setSelectionRange(8, 8);
  paste(input, ', blue eyes');
  assert.deepEqual(changes, ['red hair, blue eyes']);
  assert.equal(input.value, '');
  assert.deepEqual(drafts, ['red hair', '']);
});

test('batch paste replaces only the selected draft substring', () => {
  const { input, changes } = setup();
  fireEvent.change(input, { target: { value: 'red old eyes' } });
  input.setSelectionRange(4, 7);
  paste(input, 'hair, blue');
  assert.deepEqual(changes, ['red hair, blue eyes']);
});

test('SD nested weighted groups stay atomic when removing a different tag', () => {
  const value = '(red hair, [blue eyes, {smile}]:1.2), solo';
  const view = setup(value);
  assert.equal(view.container.querySelectorAll('button').length, 2);
  fireEvent.click(view.getByRole('button', { name: 'common.delete solo' }));
  assert.deepEqual(view.changes, ['(red hair, [blue eyes, {smile}]:1.2)']);
});

test('NAI positive and negative weighted groups stay atomic after paste and removal', () => {
  const view = setup();
  paste(view.input, '1.2::red hair, blue eyes::, -0.8::hat, glasses::, solo');
  assert.equal(view.container.querySelectorAll('button').length, 3);
  fireEvent.click(view.getByRole('button', { name: 'common.delete solo' }));
  assert.equal(view.changes.at(-1), '1.2::red hair, blue eyes::, -0.8::hat, glasses::');
});

test('escaped brackets are literal and incomplete weight groups keep their raw text', () => {
  const view = setup('character\\(series\\), solo, (unfinished, blue eyes');
  assert.equal(view.container.querySelectorAll('button').length, 3);
  fireEvent.click(view.getByRole('button', { name: 'common.delete solo' }));
  assert.equal(view.changes.at(-1), 'character\\(series\\), (unfinished, blue eyes');
  cleanup();
  const nai = setup('solo, -1.2::unfinished, blue eyes');
  assert.equal(nai.container.querySelectorAll('button').length, 2);
});

test('plain Enter, blur, comma and Backspace retain existing behavior and notify draft clearing', () => {
  const view = setup('solo');
  fireEvent.change(view.input, { target: { value: 'red hair' } });
  fireEvent.keyDown(view.input, { key: 'Enter' });
  fireEvent.change(view.input, { target: { value: 'blue eyes' } });
  fireEvent.blur(view.input);
  fireEvent.change(view.input, { target: { value: 'smile' } });
  fireEvent.keyDown(view.input, { key: ',' });
  fireEvent.keyDown(view.input, { key: 'Backspace' });
  assert.equal(view.changes.at(-1), 'solo, red hair, blue eyes');
  assert.deepEqual(view.drafts, ['red hair', '', 'blue eyes', '', 'smile', '']);
});

test('commas inside an unfinished SD or NAI group remain native input instead of committing', () => {
  const view = setup();
  for (const [prefix, completed] of [
    ['(red hair', '(red hair, blue eyes:1.2)'],
    ['-1.2::red hair', '-1.2::red hair, blue eyes::'],
  ]) {
    fireEvent.change(view.input, { target: { value: prefix } });
    const count = view.changes.length;
    assert.equal(fireEvent.keyDown(view.input, { key: ',' }), true);
    assert.equal(view.input.value, prefix);
    assert.equal(view.changes.length, count);
    fireEvent.change(view.input, { target: { value: completed } });
    fireEvent.keyDown(view.input, { key: 'Enter' });
    assert.equal(view.changes.at(-1).includes(completed), true);
  }
  assert.equal(view.container.querySelectorAll('button').length, 2);
});

test('case-insensitive duplicate tags and raw textarea editing retain existing behavior', () => {
  const view = setup('solo');
  paste(view.input, 'SOLO, smile');
  assert.equal(view.changes.at(-1), 'solo, smile');
  const textarea = view.container.querySelector('textarea');
  fireEvent.change(textarea, { target: { value: '(red hair, blue eyes:1.2), solo' } });
  assert.equal(view.changes.at(-1), '(red hair, blue eyes:1.2), solo');
  assert.equal(view.container.querySelectorAll('button').length, 2);
});
