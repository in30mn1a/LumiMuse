const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');
installMemoryOnlyTestGuard(test);
const Module = require('node:module');
const React = require('react');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');
const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const { cleanup, fireEvent, render, waitFor } = require('@testing-library/react');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');
registerTsLoader({ jsx: true });
require.extensions['.tsx'] = require.extensions['.ts'];
const originalLoad = Module._load;
const originalFetch = global.fetch;
const toasts = [];
const mocks = {
  '@/lib/i18n-context': { useTranslation: () => ({ t: key => key }) },
  '@/components/ui/Toast': { useToast: () => ({ showToast(message, type) { toasts.push({ message, type }); } }) },
  'react-markdown': { __esModule: true, default: ({ children }) => React.createElement('div', null, children) },
  'remark-gfm': { __esModule: true, default() {} },
};
Module._load = function (request, ...args) { return request in mocks ? mocks[request] : originalLoad.call(this, request, ...args); };
const AgentMemoryNote = require('../src/components/agent/AgentMemoryNote.tsx').default;
const AgentDocumentEditor = require('../src/components/agent/AgentDocumentEditor.tsx').default;
const { buildAgentDisplayItems } = require('../src/components/agent/AgentMessageList.tsx');
const NOTE = { versionId: 4, content: '主人希望先看结论。', sessionId: 'fixture-session' };
test.afterEach(() => { cleanup(); global.fetch = originalFetch; toasts.length = 0; });
test.after(() => { Module._load = originalLoad; restoreDom(); });

test('the note is visible, undo has loading feedback and sends exactly one request', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); await pending; return Response.json({ document: { content: '' } }); };
  const view = render(React.createElement(AgentMemoryNote, { note: NOTE, undone: false, disabled: false }));
  assert.ok(view.getByText(NOTE.content));
  const button = view.getByRole('button', { name: 'agent.memory.undo' });
  fireEvent.click(button);
  fireEvent.click(button);
  assert.equal(calls.length, 1);
  assert.equal(button.disabled, true);
  assert.equal(view.container.querySelector('section').getAttribute('aria-busy'), 'true');
  release();
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'agent.memory.undone' }).disabled));
  assert.deepEqual(calls[0], { url: '/api/agent/documents/memory', body: { undo_version_id: 4, session_id: 'fixture-session' } });
});

test('a refused undo keeps the note visible and displays a recoverable error', async () => {
  global.fetch = async () => Response.json({ error: '后续编辑已存在，请查看版本。' }, { status: 409 });
  const view = render(React.createElement(AgentMemoryNote, { note: NOTE, undone: false, disabled: false }));
  fireEvent.click(view.getByRole('button', { name: 'agent.memory.undo' }));
  await waitFor(() => assert.match(view.getByRole('alert').textContent, /后续编辑/));
  assert.ok(view.getByText(NOTE.content));
  assert.equal(view.getByRole('button', { name: 'agent.memory.undo' }).disabled, false);
});

test('stored remember results survive repeat reminders and undo state restores from history', () => {
  const result = JSON.stringify({ ok: true, version_id: 4, content: NOTE.content, session_id: NOTE.sessionId });
  const messages = [
    { id: 1, role: 'assistant', content: '', tool_calls: [{ id: 'note-call', name: 'remember', arguments: '{}' }] },
    { id: 2, role: 'tool', content: `${result}\n\n[提醒] 请换个思路`, tool_call_id: 'note-call', tool_ok: true },
    { id: 3, role: 'event', content: '', event: { kind: 'memory_undo', version_id: 4 } },
  ];
  const note = buildAgentDisplayItems(messages).find(item => item.kind === 'memory');
  assert.deepEqual(note.note, NOTE);
  assert.equal(note.undone, true);
  const view = render(React.createElement(AgentMemoryNote, { note: note.note, undone: note.undone, disabled: false }));
  assert.equal(view.getByRole('button', { name: 'agent.memory.undone' }).disabled, true);
});

test('the memory editor sends its saved baseline and retains the draft on a concurrent Agent append', async () => {
  let current = '最初的笔记。';
  let savedBody;
  global.fetch = async (_url, init) => {
    if (init?.method === 'PUT') {
      savedBody = JSON.parse(init.body);
      if (savedBody.expected_content !== current) return Response.json({ error: '笔记已更新，草稿已保留。' }, { status: 409 });
      current = savedBody.content;
      return Response.json({ document: { key: 'memory', content: current, updated_at: '2026-11-04T08:00:00Z' } });
    }
    return Response.json({ document: { key: 'memory', content: current, updated_at: '2026-11-04T08:00:00Z' }, versions: [], has_more: false });
  };
  function Editor() {
    const [state, setState] = React.useState({ document: null, draft: undefined, versions: [], hasMore: false });
    return React.createElement(AgentDocumentEditor, { docKey: 'memory', state, onStateChange: setState, pendingWrite: null, onWriteStart: () => true, onWriteEnd() {} });
  }
  const view = render(React.createElement(Editor));
  await waitFor(() => assert.equal(view.getByRole('textbox').value, '最初的笔记。'));
  fireEvent.change(view.getByRole('textbox'), { target: { value: '主人仍在编辑的草稿。' } });
  current += '\n\nAgent 新追加的笔记。';
  fireEvent.click(view.getByRole('button', { name: /save/i }));
  await waitFor(() => assert.ok(toasts.some(toast => toast.type === 'error' && toast.message.includes('笔记已更新'))));
  assert.equal(savedBody.expected_content, '最初的笔记。');
  assert.equal(view.getByRole('textbox').value, '主人仍在编辑的草稿。');
  assert.match(current, /Agent 新追加/);
});
