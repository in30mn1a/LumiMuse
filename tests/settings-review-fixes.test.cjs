const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act, cleanup, fireEvent, render, renderHook } = require('@testing-library/react');
const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
const originalFetch = global.fetch;
const originalTs = require.extensions['.ts'];
const originalTsx = require.extensions['.tsx'];
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolve.call(this, request, ...args);
};
function loadTs(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText, filename);
}
require.extensions['.ts'] = loadTs;
require.extensions['.tsx'] = loadTs;
const { MemoryArchivePanel } = require('../src/components/settings/memory/MemoryArchivePanel.tsx');
const { useMemoryArchivePanel } = require('../src/hooks/settings/useMemoryArchivePanel.ts');
const PromptModal = require('../src/components/ui/PromptModal.tsx').default;

test.afterEach(() => { cleanup(); global.fetch = originalFetch; });
test.after(() => {
  Module._resolveFilename = originalResolve;
  require.extensions['.ts'] = originalTs;
  require.extensions['.tsx'] = originalTsx;
  restoreDom();
});

const t = key => key;
const memory = (id, category) => ({ id, category, content: `content-${id}`, status: 'active', pinned: false, updated_at: '' });
function panelArchive(memories) {
  return { memoryArchiveMemories: memories, memoryArchiveOffset: 0, memoryArchiveTotal: memories.length,
    selectedMemoryArchiveIds: [], memoryArchiveBatches: [], selectedMemoryArchiveBatchId: '', memoryArchiveSummary: '' };
}

for (const switchCharacter of [true, false]) {
  test(`archive category disappears after ${switchCharacter ? 'character switch' : 'same-character refresh'}`, () => {
    const view = render(React.createElement(MemoryArchivePanel, { t, archive: panelArchive([memory('a', 'A'), memory('b', 'B')]), memoryManagementCharacterId: 'one' }));
    fireEvent.change(view.getByLabelText('settings.memoryArchiveAllCategories'), { target: { value: 'A' } });
    assert.ok(view.queryByText('content-a'));
    assert.equal(view.queryByText('content-b'), null);
    view.rerender(React.createElement(MemoryArchivePanel, { t, archive: panelArchive([memory('b', 'B')]), memoryManagementCharacterId: switchCharacter ? 'two' : 'one' }));
    assert.ok(view.queryByText('content-b'), 'remaining category must remain visible');
  });
}

test('character switch resets category and keyword even when categories still exist', () => {
  const props = { t, archive: panelArchive([memory('a', 'A'), memory('b', 'B')]), memoryManagementCharacterId: 'one' };
  const view = render(React.createElement(MemoryArchivePanel, props));
  fireEvent.change(view.getByLabelText('settings.memoryArchiveAllCategories'), { target: { value: 'A' } });
  fireEvent.change(view.getByLabelText('settings.memoryArchiveFilterPlaceholder'), { target: { value: 'content-a' } });
  view.rerender(React.createElement(MemoryArchivePanel, { ...props, memoryManagementCharacterId: 'two' }));
  assert.equal(view.getByLabelText('settings.memoryArchiveAllCategories').value, '');
  assert.equal(view.getByLabelText('settings.memoryArchiveFilterPlaceholder').value, '');
  assert.ok(view.queryByText('content-b'));
});

function archiveHook() {
  return renderHook(() => useMemoryArchivePanel({ characterId: 'one', memoryManagementCharacterIdRef: { current: 'one' },
    loadMemoryDiagnostics: async () => {}, loadMemoryIndexStatus: async () => {}, showToast: () => {}, t }));
}
const plan = { summaryMemory: { id: 'summary', content: 'summary' }, coveredMemoryUpdates: [] };
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function selectAll(archive, ids) {
  // Use the real panel event so the regression covers its hook contract too.
  const view = render(React.createElement(MemoryArchivePanel, { t, archive: { ...archive, memoryArchiveMemories: ids.map(id => memory(id, 'A')) }, memoryManagementCharacterId: 'one' }));
  fireEvent.click(view.getByText('settings.memoryArchiveSelectAll'));
  view.unmount();
}
function clearSelection(archive) {
  const view = render(React.createElement(MemoryArchivePanel, { t, archive: { ...archive, memoryArchiveMemories: [memory('a', 'A')] }, memoryManagementCharacterId: 'one' }));
  fireEvent.click(view.getByText(/^settings.memoryArchiveClearSelection/));
  view.unmount();
}
for (const action of ['selectAll', 'clear', 'toggle']) {
  test(`archive ${action} clears completed preview and ignores deferred old preview`, async () => {
    const hook = archiveHook();
    act(() => { hook.result.current.toggleMemoryArchiveSelection('a'); hook.result.current.setMemoryArchiveSummary('summary'); });
    global.fetch = async () => json({ plan });
    await act(async () => { await hook.result.current.handleMemoryArchivePreview(); });
    assert.deepEqual(hook.result.current.memoryArchivePlan, plan);
    const changeSelection = () => action === 'selectAll' ? selectAll(hook.result.current, ['a', 'b'])
      : action === 'clear' ? clearSelection(hook.result.current) : act(() => hook.result.current.toggleMemoryArchiveSelection('b'));
    changeSelection();
    assert.equal(hook.result.current.memoryArchivePlan, null);
    if (action === 'clear') act(() => hook.result.current.toggleMemoryArchiveSelection('a'));
    let resolve;
    global.fetch = () => new Promise(done => { resolve = done; });
    let pending;
    act(() => { pending = hook.result.current.handleMemoryArchivePreview(); });
    changeSelection();
    await act(async () => { resolve(json({ plan })); await pending; });
    assert.equal(hook.result.current.memoryArchivePlan, null, 'stale response must not restore preview');
    assert.equal(hook.result.current.memoryArchiveLoading, false);
  });
}

for (const closeAction of ['save', 'cancel']) {
  test(`prompt ${closeAction}, reopen resets default but live default changes preserve edits`, () => {
    const values = [];
    const props = { open: true, title: 'Name', defaultValue: 'initial', confirmLabel: 'Save', cancelLabel: 'Cancel', onConfirm: value => values.push(value), onCancel: () => {} };
    const view = render(React.createElement(PromptModal, props));
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'edited' } });
    view.rerender(React.createElement(PromptModal, { ...props, defaultValue: 'changed-while-open' }));
    assert.equal(view.getByRole('textbox').value, 'edited');
    fireEvent.click(view.getByText(closeAction === 'save' ? 'Save' : 'Cancel'));
    if (closeAction === 'save') assert.deepEqual(values, ['edited']);
    view.rerender(React.createElement(PromptModal, { ...props, open: false }));
    view.rerender(React.createElement(PromptModal, props));
    assert.equal(view.getByRole('textbox').value, 'initial');
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'second edit' } });
    view.rerender(React.createElement(PromptModal, { ...props, open: false }));
    view.rerender(React.createElement(PromptModal, { ...props, defaultValue: 'new default' }));
    assert.equal(view.getByRole('textbox').value, 'new default');
  });
}
