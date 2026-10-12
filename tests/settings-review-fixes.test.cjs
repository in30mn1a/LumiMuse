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
    selectedMemoryArchiveIds: [], memoryArchiveBatches: [], selectedMemoryArchiveBatchId: '', memoryArchiveSummary: '',
    memoryArchiveAiProposals: [] };
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

test('AI archive proposals can be edited and only archive after an explicit confirmation', () => {
  const calls = [];
  const proposal = (key, status, overrides = {}) => ({
    key,
    title: `title-${key}`,
    summary: `summary-${key}`,
    status,
    memories: [
      { id: `${key}-1`, category: 'A', content: `covered-${key}-1` },
      { id: `${key}-2`, category: 'A', content: `covered-${key}-2` },
    ],
    selectedIds: [`${key}-1`, `${key}-2`],
    ...overrides,
  });
  const archive = {
    ...panelArchive([]),
    memoryArchiveAiProposals: [
      proposal('p1', 'pending'),
      proposal('p2', 'failed', { error: 'boom' }),
      proposal('p3', 'pending', { selectedIds: [] }),
      proposal('p4', 'archived'),
      proposal('p5', 'stale', { error: 'expired' }),
    ],
    setMemoryArchiveAiProposalSummary: (key, summary) => calls.push(['summary', key, summary]),
    toggleMemoryArchiveAiProposalMemory: (key, id) => calls.push(['toggle', key, id]),
    dismissMemoryArchiveAiProposal: key => calls.push(['dismiss', key]),
    handleExecuteMemoryArchiveAiProposals: keys => { calls.push(['execute', keys]); },
  };
  const view = render(React.createElement(MemoryArchivePanel, { t, archive, memoryManagementCharacterId: 'one' }));

  // 已归档 / 已失效的分组不能再执行；一条记忆都没留下的分组按钮禁用。
  const executeButtons = view.getAllByText('settings.memoryArchiveAiExecuteGroup');
  assert.deepEqual(executeButtons.map(button => button.disabled), [false, false, true]);
  assert.ok(view.getByText('settings.memoryArchiveAiArchivedBadge'));
  assert.ok(view.getByText('settings.memoryArchiveAiStaleBadge'));
  assert.ok(view.getByText('boom'));
  assert.ok(view.getByText('expired'));
  assert.ok(view.queryByText(/covered-p1-1/));
  assert.equal(view.queryByText(/covered-p4-1/), null, 'settled proposals no longer list memories to pick');
  assert.equal(view.getAllByText('settings.memoryArchiveAiDismiss').length, 3);
  assert.equal(view.getAllByText('settings.memoryArchiveAiRemove').length, 2);

  fireEvent.click(executeButtons[0]);
  fireEvent.click(view.getByText('settings.memoryArchiveAiExecuteAll'));
  fireEvent.click(view.getByLabelText(/covered-p1-2/));
  fireEvent.change(view.getAllByLabelText('settings.memoryArchiveSummary')[0], { target: { value: 'edited' } });
  fireEvent.click(view.getAllByText('settings.memoryArchiveAiDismiss')[0]);

  assert.deepEqual(calls, [
    ['execute', ['p1']],
    ['execute', ['p1', 'p2']],
    ['toggle', 'p1', 'p1-2'],
    ['summary', 'p1', 'edited'],
    ['dismiss', 'p1'],
  ]);
});

test('manual archive stays disabled until memories are selected and a summary is written', () => {
  const calls = [];
  const base = {
    ...panelArchive([memory('a', 'A')]),
    handleMemoryArchivePreview: () => { calls.push('preview'); },
    handleMemoryArchiveExecute: () => { calls.push('execute'); },
  };
  const view = render(React.createElement(MemoryArchivePanel, { t, archive: base, memoryManagementCharacterId: 'one' }));
  assert.equal(view.getByText('settings.memoryArchiveExecute').disabled, true);
  assert.equal(view.getByText('settings.memoryArchivePreview').disabled, true);
  assert.ok(view.getByText('settings.memoryArchiveRequired'));

  view.rerender(React.createElement(MemoryArchivePanel, {
    t,
    archive: { ...base, selectedMemoryArchiveIds: ['a'], memoryArchiveSummary: 'summary' },
    memoryManagementCharacterId: 'one',
  }));
  assert.equal(view.queryByText('settings.memoryArchiveRequired'), null);
  fireEvent.click(view.getByText('settings.memoryArchivePreview'));
  fireEvent.click(view.getByText('settings.memoryArchiveExecute'));
  assert.deepEqual(calls, ['preview', 'execute']);
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
