const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const React = require('react');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');
const { cleanupReactDomTestEnvironment } = require('./helpers/react-dom-teardown.cjs');

const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const previousTs = require.extensions['.ts'];
const previousTsx = require.extensions['.tsx'];
require('./helpers/register-ts-loader.cjs').registerTsLoader({ jsx: true });
require.extensions['.tsx'] = require.extensions['.ts'];

const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const { cleanup, fireEvent, render } = require('@testing-library/react');
const t = key => key;

let MemoryCard;
Module._load = function(request, ...args) {
  if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t }) };
  return originalLoad.call(this, request, ...args);
};
try {
  MemoryCard = require('../src/components/memories/MemoryCard.tsx').default;
} finally {
  Module._load = originalLoad;
}

const memory = {
  id: 'memory-a', character_id: 'character-a', content: 'Original memory', tags: [],
  category: '重要事件', memory_kind: 'fact', status: 'active', pinned: false,
  importance: 0.5, emotional_weight: 0.2, confidence: 1,
  created_at: '2026-10-12T00:00:00.000Z', updated_at: '2026-10-12T00:00:00.000Z',
};
const baseProps = { memory, onUpdate: async () => {}, onDelete: async () => {} };

test.afterEach(() => cleanup());
test.after(async () => {
  Module._resolveFilename = originalResolve;
  if (previousTs) require.extensions['.ts'] = previousTs; else delete require.extensions['.ts'];
  if (previousTsx) require.extensions['.tsx'] = previousTsx; else delete require.extensions['.tsx'];
  await cleanupReactDomTestEnvironment(restoreDom);
});

test('an edit click at the first DOM commit survives passive mount effects', () => {
  let clicked = false;
  function ClickAtCommit() {
    const host = React.useRef(null);
    React.useLayoutEffect(() => {
      // 父级 layout effect 能观察到子节点，但其首次 passive effect 尚未执行。
      host.current.querySelector('[aria-label="memory.edit"]').click();
      clicked = true;
    }, []);
    return React.createElement('div', { ref: host }, React.createElement(MemoryCard, baseProps));
  }

  const view = render(React.createElement(ClickAtCommit));
  assert.ok(clicked, 'the edit action runs at the first DOM commit');
  const editor = view.container.querySelector('textarea');
  assert.ok(editor, 'mount effects must not undo the edit action');
  fireEvent.change(editor, { target: { value: 'Unsaved user draft' } });
  assert.equal(editor.value, 'Unsaved user draft');
});

test('later initialEditing changes still close and reopen the editor', () => {
  const view = render(React.createElement(MemoryCard, { ...baseProps, initialEditing: true }));
  fireEvent.change(view.container.querySelector('textarea'), { target: { value: 'Unsaved user draft' } });

  view.rerender(React.createElement(MemoryCard, { ...baseProps, initialEditing: false }));
  assert.equal(view.container.querySelector('textarea'), null);
  view.rerender(React.createElement(MemoryCard, { ...baseProps, initialEditing: true }));
  assert.equal(view.container.querySelector('textarea').value, 'Unsaved user draft');
});

test('a memory refresh preserves the same editor and its unsaved draft', () => {
  const view = render(React.createElement(MemoryCard, baseProps));
  fireEvent.click(view.getAllByRole('button', { name: 'memory.edit' })[0]);
  const editor = view.container.querySelector('textarea');
  fireEvent.change(editor, { target: { value: 'Unsaved user draft' } });

  view.rerender(React.createElement(MemoryCard, {
    ...baseProps, memory: { ...memory, content: 'Server revision' },
  }));
  assert.ok(view.container.querySelector('textarea') === editor, 'refresh preserves editor identity');
  assert.equal(editor.value, 'Unsaved user draft');
});

test('selection mode resets the draft from a memory refreshed in the same render', () => {
  const view = render(React.createElement(MemoryCard, { ...baseProps, initialEditing: true }));
  fireEvent.change(view.container.querySelector('textarea'), { target: { value: 'Unsaved user draft' } });
  const revised = {
    ...baseProps, initialEditing: true, memory: { ...memory, content: 'Server revision' },
  };

  view.rerender(React.createElement(MemoryCard, { ...revised, selectMode: true }));
  assert.equal(view.container.querySelector('textarea'), null);
  assert.ok(view.getByRole('checkbox', { name: 'Server revision' }));
  view.rerender(React.createElement(MemoryCard, { ...revised, selectMode: false }));
  assert.equal(view.container.querySelector('textarea').value, 'Server revision');
});
