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
const { default: AgentMessageList, buildAgentDisplayItems, groupAgentDisplayItems } = require('../src/components/agent/AgentMessageList.tsx');
const { applyAgentStreamEvent } = require('../src/hooks/agent/useAgentChat.ts');
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

test('reused call ids keep each historical proposal and result in its original round', () => {
  const messages = [
    { id: 1, role: 'assistant', content: '', tool_calls: [{ id: 'reused', name: 'create_memory_proposal', arguments: '{"title":"第一份"}' }] },
    { id: 2, role: 'tool', content: '{"ok":true,"proposal_id":101}', tool_call_id: 'reused', tool_ok: true },
    { id: 3, role: 'assistant', content: '接着审查。', tool_calls: [{ id: 'reused', name: 'create_memory_proposal', arguments: '{"title":"第二份"}' }] },
    { id: 4, role: 'tool', content: '{"ok":true,"proposal_id":202}', tool_call_id: 'reused', tool_ok: true },
  ];
  const items = buildAgentDisplayItems(messages);
  assert.deepEqual(items.filter(item => item.kind === 'proposal').map(item => item.proposalId), [101, 202]);
  assert.deepEqual(items.filter(item => item.kind === 'tool').map(item => item.result), [messages[1].content, messages[3].content]);
  assert.deepEqual(groupAgentDisplayItems(items).filter(block => block.kind === 'tools').map(block => block.key), ['tools:reused:0', 'tools:reused:1']);
});

test('an unpaired historical call cannot borrow a reused id result from a later round', () => {
  const items = buildAgentDisplayItems([
    { id: 1, role: 'assistant', content: '', tool_calls: [{ id: 'reused', name: 'create_memory_proposal', arguments: '{}' }] },
    { id: 2, role: 'event', content: '', event: { kind: 'interrupted' } },
    { id: 3, role: 'assistant', content: '', tool_calls: [{ id: 'reused', name: 'create_memory_proposal', arguments: '{}' }] },
    { id: 4, role: 'tool', content: '{"ok":true,"proposal_id":202}', tool_call_id: 'reused', tool_ok: true },
  ]);
  assert.deepEqual(items.filter(item => item.kind === 'tool').map(item => item.result), [null, '{"ok":true,"proposal_id":202}']);
  assert.deepEqual(items.filter(item => item.kind === 'proposal').map(item => item.proposalId), [202]);
});

test('reused remember ids display distinct notes and undo the version belonging to the clicked note', async () => {
  const notes = [NOTE, { ...NOTE, versionId: 5, content: '主人喜欢完整的来源依据。' }];
  const messages = notes.flatMap((note, index) => [
    { id: index * 2 + 1, role: 'assistant', content: '', tool_calls: [{ id: 'reused', name: 'remember', arguments: JSON.stringify({ content: note.content }) }] },
    { id: index * 2 + 2, role: 'tool', content: JSON.stringify({ ok: true, version_id: note.versionId, content: note.content, session_id: note.sessionId }), tool_call_id: 'reused', tool_ok: true },
  ]);
  const items = buildAgentDisplayItems(messages).filter(item => item.kind === 'memory');
  assert.deepEqual(items.map(item => item.note), notes);
  const bodies = [];
  global.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ document: { content: '' } });
  };
  const view = render(React.createElement(AgentMessageList, { messages, live: null, emptyState: null }));
  assert.deepEqual([...view.container.querySelectorAll('[data-agent-memory-note]')].map(element => element.dataset.agentMemoryNote), ['4', '5']);
  fireEvent.click(view.getAllByRole('button', { name: 'agent.memory.undo' })[0]);
  await waitFor(() => assert.equal(view.getAllByRole('button', { name: 'agent.memory.undone' }).length, 1));
  assert.deepEqual(bodies, [{ undo_version_id: 4, session_id: NOTE.sessionId }]);
  assert.equal(view.getAllByRole('button', { name: 'agent.memory.undo' }).length, 1);

  const undoneItems = buildAgentDisplayItems([...messages, { id: 5, role: 'event', content: '', event: { kind: 'memory_undo', version_id: 4 } }]);
  assert.deepEqual(undoneItems.filter(item => item.kind === 'memory').map(item => item.undone), [true, false]);
});

test('a live reused call id updates only its current running instance', () => {
  let turn = { sessionId: 'fixture', userContent: '继续', afterMessageId: 0, segments: [], error: null };
  const events = [
    { type: 'tool_start', id: 'reused', name: 'search_memories', arguments: '{"query":"第一次"}' },
    { type: 'tool_end', id: 'reused', name: 'search_memories', ok: false, error: '第一次超时' },
    { type: 'tool_start', id: 'reused', name: 'search_memories', arguments: '{"query":"第二次"}' },
    { type: 'tool_end', id: 'reused', name: 'search_memories', ok: true },
    { type: 'tool_start', id: 'reused', name: 'get_memories', arguments: '{"memory_ids":["m1"]}' },
    { type: 'tool_end', id: 'reused', name: 'get_memories', ok: false, error: '第三次失败' },
  ];
  for (const event of events) turn = applyAgentStreamEvent(turn, event);
  assert.deepEqual(turn.segments.map(segment => [segment.state, segment.error]), [
    ['error', '第一次超时'], ['ok', undefined], ['error', '第三次失败'],
  ]);
  const completed = turn;
  turn = applyAgentStreamEvent(turn, events.at(-1));
  assert.deepEqual(turn, completed, 'a repeated completion cannot rewrite a completed call');
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
