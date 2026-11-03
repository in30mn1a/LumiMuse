const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act, cleanup, fireEvent, render, waitFor, within } = require('@testing-library/react');

const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const originalFetch = global.fetch;

// ---- next/navigation：可被 router.replace 改写的地址栏 ----
let currentSearch = '';
const searchListeners = new Set();
function setSearch(search) {
  currentSearch = search;
  for (const listener of searchListeners) listener();
}
const router = {
  replace(url) {
    const index = url.indexOf('?');
    setSearch(index >= 0 ? url.slice(index + 1) : '');
  },
  push(url) {
    router.replace(url);
  },
};
function useSearchParams() {
  const [, force] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    searchListeners.add(force);
    return () => searchListeners.delete(force);
  }, []);
  return new URLSearchParams(currentSearch);
}

// 用真实的中文文案渲染：带参数的文案能断言参数，漏写的键会原样露出来
let zh = {};
const mocks = {
  '@/components/ui/Toast': { useToast: () => ({ showToast: () => {} }) },
  '@/lib/i18n-context': { useTranslation: () => ({ t: key => zh[key] ?? key }) },
  'next/navigation': { useRouter: () => router, useSearchParams },
  'next/link': {
    __esModule: true,
    default: ({ children, href, ...props }) => React.createElement('a', { href, ...props }, children),
  },
  'react-markdown': { __esModule: true, default: ({ children }) => React.createElement('div', { 'data-markdown': '' }, children) },
  'remark-gfm': { __esModule: true, default: () => {} },
};

Module._resolveFilename = function resolveFilename(request, parent, ...args) {
  if (request.startsWith('@/')) {
    const base = path.join(root, 'src', request.slice(2));
    for (const file of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return originalResolve.call(this, request, parent, ...args);
};
Module._load = function load(request, ...args) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
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

zh = require('../src/lib/i18n.ts').default.zh;
const ProposalCard = require('../src/components/agent/ProposalCard.tsx').default;
const AgentProposalHistory = require('../src/components/agent/AgentProposalHistory.tsx').default;
const AgentSettingsDrawer = require('../src/components/agent/AgentSettingsDrawer.tsx').default;
const AgentPage = require('../src/app/agent/page.tsx').default;
const { buildAgentDisplayItems } = require('../src/components/agent/AgentMessageList.tsx');
const { proposalItemFlags, isCheckedByDefault, LOW_CONFIDENCE_THRESHOLD } = require('../src/lib/agent/proposal-flags.ts');
const { diffText } = require('../src/lib/text-diff.ts');
const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { AGENT_TOOLS } = require('../src/lib/agent/tools/index.ts');
const { createAgentSession, listAgentMessages } = require('../src/lib/agent/store.ts');
const { toAgentMessageView } = require('../src/lib/agent/messages.ts');
const { runAgentTurn } = require('../src/lib/agent/loop.ts');

// ---- 虚构数据 ----
function snapshot(content, extra = {}) {
  return {
    content, category: 'preference', confidence: 0.8, tags: [], source_msg_ids: [], memory_kind: 'preference',
    importance: 0.5, emotional_weight: 0.3, status: 'active', pinned: false, metadata: null, ...extra,
  };
}
function candidate(id, task) {
  return {
    id, status: 'repairable', task_id: task ? 20 + id : null, conversation_id: 'conv-a', error_reason: '模型响应不是 JSON',
    task, task_succeeded: Boolean(task && (task.status === 'done' || task.result_committed)),
  };
}
function item(id, op, extra = {}) {
  return {
    id, seq: id, op, reason: `第 ${id} 项的理由`, evidence: { message_ids: [] }, confidence: 0.9, before: null, after: null,
    state: 'pending', reject_reason: null, result: null, applied_at: null, ...extra,
  };
}

const PROPOSAL_ID = 7;
const PENDING_ITEMS = [
  item(1, 'update', {
    evidence: { message_ids: ['msg-1'] },
    before: { memories: [{ id: 'm-1', snapshot: snapshot('用户喜欢吃甜食') }] },
    after: { content: '用户不太喜欢吃甜食', importance: 0.7 },
  }),
  item(2, 'create', { confidence: 0.4, evidence: { message_ids: ['msg-1'] }, after: { content: '用户最近在控糖', category: 'fact' } }),
  item(3, 'retire', {
    evidence: { message_ids: [], note: '无原文依据' },
    before: { memories: [{ id: 'm-2', snapshot: snapshot('用户每天都喝奶茶') }] },
    after: { status: 'superseded' },
  }),
  item(4, 'repair_candidate', {
    evidence: { message_ids: ['msg-gone'] },
    before: { candidate: candidate(11, { status: 'done', result_committed: true, result_insert_count: 2 }) },
    after: { memories: [{ content: '用户养了一只橘猫', category: 'fact' }] },
  }),
  item(5, 'report_conflict', {
    state: 'reported',
    evidence: { message_ids: ['msg-1'] },
    before: { memories: [{ id: 'm-3', snapshot: snapshot('用户住在海边') }, { id: 'm-4', snapshot: snapshot('用户住在山里') }] },
  }),
  item(6, 'discard_candidate', { confidence: 0.8, before: { candidate: candidate(12, null) }, after: { status: 'discarded' } }),
];
function proposalView(overrides = {}) {
  return {
    id: PROPOSAL_ID,
    session_id: 'agent-session-1',
    character_id: 'char-a',
    summary: '整理和甜食有关的记忆',
    status: 'pending',
    created_at: '2026-11-03T08:00:00.000Z',
    decided_at: null,
    items: PENDING_ITEMS,
    evidence_messages: [{ id: 'msg-1', role: 'user', content: '我其实不太爱吃甜的', created_at: '2026-11-02T08:00:00.000Z' }],
    ...overrides,
  };
}
const REJECT_REASON = '这几条先别动';
function decidedView() {
  const states = { 1: 'applied', 2: 'applied', 3: 'rejected', 4: 'rejected', 6: 'applied' };
  return proposalView({
    status: 'decided',
    decided_at: '2026-11-03T08:05:00.000Z',
    items: PENDING_ITEMS.map(entry => (states[entry.id]
      ? { ...entry, state: states[entry.id], reject_reason: states[entry.id] === 'rejected' ? REJECT_REASON : null }
      : entry)),
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch(handler) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return handler(call, calls);
  };
  return calls;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const proposalUrl = `/api/agent/proposals/${PROPOSAL_ID}`;

function itemElement(container, id) {
  return container.querySelector(`[data-proposal-item="${id}"]`);
}
function checkbox(container, id) {
  return itemElement(container, id).querySelector('input[type="checkbox"]');
}

async function renderCard(props = {}) {
  const view = render(React.createElement(ProposalCard, { proposalId: PROPOSAL_ID, ...props }));
  await view.findByText('整理和甜食有关的记忆');
  return view;
}

test.afterEach(async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  cleanup();
  global.fetch = originalFetch;
});
test.after(() => {
  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('flags: low confidence, no evidence and a succeeded original task leave an item unchecked', () => {
  const base = { op: 'update', evidence: { message_ids: ['msg-1'] }, confidence: 0.9, before: null };
  assert.equal(LOW_CONFIDENCE_THRESHOLD, 0.6);
  assert.equal(isCheckedByDefault(proposalItemFlags(base)), true);
  assert.equal(proposalItemFlags({ ...base, confidence: 0.59 }).lowConfidence, true);
  assert.equal(proposalItemFlags({ ...base, confidence: 0.6 }).lowConfidence, false, 'the threshold itself is not low');

  const noEvidence = proposalItemFlags({ ...base, evidence: { message_ids: [], note: '无原文依据' } });
  assert.equal(noEvidence.noEvidence, true);
  assert.equal(isCheckedByDefault(noEvidence), false);
  assert.equal(proposalItemFlags({ ...base, evidence: { message_ids: [] } }).noEvidence, false,
    'evidence that is optional and simply absent is not flagged');
  assert.equal(proposalItemFlags({ ...base, evidence: { message_ids: ['msg-1'], note: '无原文依据' } }).noEvidence, false);

  const repair = { op: 'repair_candidate', evidence: { message_ids: ['msg-1'] }, confidence: 0.9 };
  const succeeded = proposalItemFlags({ ...repair, before: { candidate: candidate(1, { status: 'failed', result_committed: true, result_insert_count: 3 }) } });
  assert.equal(succeeded.duplicateRiskCount, 3);
  assert.equal(isCheckedByDefault(succeeded), false);
  assert.equal(proposalItemFlags({ ...repair, before: { candidate: candidate(1, { status: 'failed', result_committed: false, result_insert_count: 0 }) } }).duplicateRiskCount, null);
  assert.equal(proposalItemFlags({ ...repair, before: { candidate: candidate(1, null) } }).duplicateRiskCount, null);
  assert.equal(proposalItemFlags({ ...repair, op: 'discard_candidate', before: { candidate: candidate(1, { status: 'done', result_committed: true, result_insert_count: 1 }) } }).duplicateRiskCount, null,
    'discarding cannot duplicate anything');
});

test('repair flags use the task\'s current state while the proposal keeps its historical snapshot', async () => {
  const historical = candidate(31, { status: 'failed', result_committed: false, result_insert_count: 0 });
  const current = { status: 'done', result_committed: true, result_insert_count: 2 };
  const repair = item(31, 'repair_candidate', {
    evidence: { message_ids: ['msg-1'] },
    before: { candidate: historical },
    current_candidate_task: current,
    after: { memories: [{ content: '用户养了一只橘猫', category: 'fact' }] },
  });
  const flags = proposalItemFlags(repair);
  assert.equal(flags.duplicateRiskCount, 2);
  assert.equal(isCheckedByDefault(flags), false);

  installFetch(call => {
    if (call.url === proposalUrl && call.method === 'GET') {
      return json(proposalView({ items: [repair] }));
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = await renderCard();
  assert.equal(checkbox(view.container, 31).checked, false);
  const text = itemElement(view.container, 31).textContent;
  assert.match(text, /原提取任务 #51：失败，已写入 0 条/);
  assert.match(text, /任务当前状态：已完成，已写入 2 条/);
  assert.match(text, /原提取任务已经成功（写入 2 条），补回可能重复/);
  assert.equal(historical.task.status, 'failed', 'the historical before snapshot is not rewritten');
});

test('the current-task line appears only when the task really changed', async () => {
  const failed = { status: 'failed', result_committed: false, result_insert_count: 0 };
  const repair = (id, task, current) => item(id, 'repair_candidate', {
    evidence: { message_ids: ['msg-1'] },
    before: { candidate: candidate(id, task) },
    current_candidate_task: current,
    after: { memories: [{ content: '用户养了一只橘猫', category: 'fact' }] },
  });
  installFetch(call => {
    if (call.url === proposalUrl && call.method === 'GET') {
      return json(proposalView({ items: [repair(41, null, null), repair(42, failed, null), repair(43, failed, { ...failed })] }));
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = await renderCard();

  const noTask = itemElement(view.container, 41).textContent;
  assert.match(noTask, /没有关联的提取任务/);
  assert.doesNotMatch(noTask, /原提取任务当前不存在/, 'a candidate that never had a task has nothing that went missing');

  const deleted = itemElement(view.container, 42).textContent;
  assert.match(deleted, /原提取任务 #62：失败，已写入 0 条/);
  assert.match(deleted, /原提取任务当前不存在/);

  const unchanged = itemElement(view.container, 43).textContent;
  assert.match(unchanged, /原提取任务 #63：失败，已写入 0 条/);
  assert.doesNotMatch(unchanged, /任务当前状态|原提取任务当前不存在/);
});

test('text diff keeps the shared prefix and suffix and never splits a surrogate pair', () => {
  assert.deepEqual(diffText('用户喜欢吃甜食', '用户不太喜欢吃甜食'), { prefix: '用户', removed: '', added: '不太', suffix: '喜欢吃甜食' });
  assert.deepEqual(diffText('喜欢猫', '喜欢狗'), { prefix: '喜欢', removed: '猫', added: '狗', suffix: '' });
  assert.deepEqual(diffText('aaa', 'aa'), { prefix: 'aa', removed: 'a', added: '', suffix: '' });
  assert.deepEqual(diffText('喜欢😀', '喜欢😃'), { prefix: '喜欢', removed: '😀', added: '😃', suffix: '' });
  assert.deepEqual(diffText('', '新'), { prefix: '', removed: '', added: '新', suffix: '' });
});

test('a create_memory_proposal result adds a card right after its tool call', () => {
  const base = { tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '' };
  const messages = [
    { ...base, id: 1, role: 'user', content: '整理一下' },
    { ...base, id: 2, role: 'assistant', content: '', tool_calls: [
      { id: 'c1', name: 'create_memory_proposal', arguments: '{}' },
      { id: 'c2', name: 'create_memory_proposal', arguments: '{}' },
    ] },
    { ...base, id: 3, role: 'tool', content: '{"ok":true,"proposal_id":7,"pending_items":2}', tool_call_id: 'c1', tool_name: 'create_memory_proposal', tool_ok: true },
    { ...base, id: 4, role: 'tool', content: '{"ok":false,"error":"提案未创建"}', tool_call_id: 'c2', tool_name: 'create_memory_proposal', tool_ok: false },
  ];
  const items = buildAgentDisplayItems(messages);
  assert.deepEqual(items.map(entry => entry.kind), ['user', 'tool', 'proposal', 'tool']);
  assert.equal(items[2].proposalId, 7);
});

test('proposal card parsing accepts the stored first-line JSON with a repeated-call reminder', () => {
  const messages = [
    { id: 1, role: 'assistant', content: '', tool_calls: [{ id: 'repeat-3', name: 'create_memory_proposal', arguments: '{}' }] },
    { id: 2, role: 'tool', content: '{"ok":true,"proposal_id":37}\n\n[提醒] 你已经连续 3 次用相同参数调用 create_memory_proposal，结果不会变化。', tool_call_id: 'repeat-3', tool_name: 'create_memory_proposal', tool_ok: true },
  ];
  const items = buildAgentDisplayItems(messages);
  assert.deepEqual(items.map(entry => entry.kind), ['tool', 'proposal']);
  assert.equal(items[1].proposalId, 37);
  assert.match(items[0].result, /\[提醒\]/, 'the tool result retains its reminder verbatim');
});

test('the card shows changes, flags and evidence; flagged items start unchecked and conflicts have no checkbox', async () => {
  const calls = installFetch(call => {
    if (call.url === proposalUrl && call.method === 'GET') return json(proposalView());
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = await renderCard();
  const { container } = view;
  assert.equal(calls.length, 1);

  assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 5);
  assert.equal(checkbox(container, 1).checked, true);
  assert.equal(checkbox(container, 6).checked, true, 'optional evidence left out is not a reason to uncheck');
  assert.equal(checkbox(container, 2).checked, false, 'low confidence');
  assert.equal(checkbox(container, 3).checked, false, 'no source evidence');
  assert.equal(checkbox(container, 4).checked, false, 'the original task already succeeded');
  assert.equal(checkbox(container, 5) === null, true, 'a conflict cannot be selected');

  assert.match(itemElement(container, 2).textContent, /把握 40% · 把握较低/);
  assert.match(itemElement(container, 3).textContent, /无原文依据/);
  assert.match(itemElement(container, 4).textContent, /原提取任务已经成功（写入 2 条），补回可能重复/);
  assert.match(itemElement(container, 4).textContent, /待修复记录 #11/);
  assert.match(itemElement(container, 4).textContent, /原提取任务 #31：已完成，已写入 2 条/);
  assert.match(itemElement(container, 6).textContent, /没有关联的提取任务/);

  const update = itemElement(container, 1);
  assert.deepEqual([...update.querySelectorAll('ins')].map(element => element.textContent), ['不太', '0.7']);
  assert.deepEqual([...update.querySelectorAll('del')].map(element => element.textContent), ['0.5'],
    'the content change is an insertion only; the old importance is struck through');
  assert.match(update.textContent, /重要度0\.5→0\.7/);
  assert.match(update.textContent, /依据：1 条消息/);
  assert.match(update.textContent, /我其实不太爱吃甜的/);
  assert.match(itemElement(container, 4).textContent, /消息 msg-gone 已删除/);
  assert.match(itemElement(container, 3).textContent, /用户每天都喝奶茶/);
  assert.match(itemElement(container, 3).textContent, /退场后不再进入角色聊天/);

  const conflict = itemElement(container, 5);
  assert.match(conflict.textContent, /用户住在海边/);
  assert.match(conflict.textContent, /用户住在山里/);
  assert.match(conflict.textContent, /仅记录/);
  assert.ok(view.getByText('矛盾发现（1），只记录，不会执行'));

  assert.ok(view.getByRole('button', { name: '批准所选（2）' }));
  fireEvent.click(checkbox(container, 2));
  assert.ok(view.getByRole('button', { name: '批准所选（3）' }));
});

test('approving the selection sends checked items and the reason for the rest, then shows each state', async () => {
  const decisions = [];
  const calls = installFetch(call => {
    if (call.url === proposalUrl && call.method === 'GET') return json(proposalView());
    if (call.url === proposalUrl && call.method === 'POST') return json(decidedView());
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = await renderCard({ onDecided: continueNext => decisions.push(continueNext) });
  const { container } = view;
  fireEvent.click(checkbox(container, 2));
  fireEvent.change(view.getByLabelText(zh['agent.proposal.rejectReason']), { target: { value: `  ${REJECT_REASON} ` } });
  fireEvent.click(view.getByRole('button', { name: '批准所选（3）' }));

  await view.findByText('已处理');
  assert.deepEqual(calls.find(call => call.method === 'POST').body, {
    action: 'apply',
    approved_item_ids: [1, 2, 6],
    rejected_items: [{ id: 3, reason: REJECT_REASON }, { id: 4, reason: REJECT_REASON }],
  });
  assert.deepEqual(decisions, [false]);
  assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 0, 'decided items cannot be selected again');
  assert.equal(view.queryByRole('button', { name: '全部拒绝' }), null);
  assert.equal(itemElement(container, 1).querySelector('[data-proposal-state]').textContent, '已生效');
  assert.match(itemElement(container, 3).textContent, /已拒绝/);
  assert.match(itemElement(container, 3).textContent, new RegExp(`拒绝原因：${REJECT_REASON}`));
  assert.equal(view.getAllByRole('button', { name: '撤销' }).length, 3, 'only applied items can be undone');
});

test('approve and continue asks for the next turn; reject all approves nothing', async () => {
  const decisions = [];
  const calls = installFetch(call => {
    if (call.url === proposalUrl && call.method === 'GET') return json(proposalView());
    if (call.url === proposalUrl && call.method === 'POST') return json(decidedView());
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const first = await renderCard({ onDecided: continueNext => decisions.push(continueNext) });
  fireEvent.click(first.getByRole('button', { name: '批准并继续' }));
  await first.findByText('已处理');
  assert.deepEqual(calls.filter(call => call.method === 'POST')[0].body, { action: 'apply', approved_item_ids: [1, 6], rejected_items: [] });
  assert.deepEqual(decisions, [true]);
  cleanup();

  const second = await renderCard({ onDecided: continueNext => decisions.push(continueNext) });
  fireEvent.click(second.getByRole('button', { name: '全部拒绝' }));
  await second.findByText('已处理');
  assert.deepEqual(calls.filter(call => call.method === 'POST')[1].body, { action: 'apply', approved_item_ids: [], rejected_items: [] });
  assert.deepEqual(decisions, [true, false]);
});

test('while the agent runs the card can be reviewed but not decided', async () => {
  installFetch(call => {
    if (call.url === proposalUrl && call.method === 'GET') return json(proposalView());
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = await renderCard({ busy: true });
  assert.ok(view.getByText('Agent 正在运行，结束后才能批准。'));
  for (const name of ['批准所选（2）', '批准并继续', '全部拒绝']) {
    assert.equal(view.getByRole('button', { name }).disabled, true, name);
  }
  assert.equal(checkbox(view.container, 2).disabled, false, 'selection still works');
});

test('a proposal decided elsewhere reloads to show its real state; a busy session does not', async () => {
  let decided = false;
  const calls = installFetch(call => {
    if (call.url === proposalUrl && call.method === 'GET') return json(decided ? decidedView() : proposalView());
    if (call.url === proposalUrl && call.method === 'POST') {
      if (calls.filter(entry => entry.method === 'POST').length === 1) {
        return json({ error: '这个会话正在运行，请先停止', code: 'agent_busy' }, 409);
      }
      decided = true;
      return json({ error: '这份提案已经处理过' }, 409);
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = await renderCard();
  fireEvent.click(view.getByRole('button', { name: '批准所选（2）' }));
  await view.findByText('提交失败：这个会话正在运行，请先停止');
  assert.equal(calls.filter(call => call.method === 'GET').length, 1, 'busy is not a reason to reload');
  assert.ok(view.getByRole('button', { name: '批准所选（2）' }), 'the selection is kept for a retry');

  fireEvent.click(view.getByRole('button', { name: '批准所选（2）' }));
  await view.findByText('提交失败：这份提案已经处理过');
  await view.findByText('已处理');
  assert.equal(calls.filter(call => call.method === 'GET').length, 2);
  assert.equal(view.queryByRole('button', { name: '全部拒绝' }), null);
});

test('undo shows why it was refused, and succeeds once allowed', async () => {
  let refuse = true;
  const calls = installFetch(call => {
    if (call.url === proposalUrl && call.method === 'GET') return json(decidedView());
    if (call.url === proposalUrl && call.method === 'POST') {
      if (refuse) return json({ error: '记忆 m-1 在批准后又被改动，不能撤销' }, 409);
      const next = decidedView();
      next.items = next.items.map(entry => (entry.id === 1 ? { ...entry, state: 'undone', result: { undone_at: '2026-11-03T09:00:00.000Z' } } : entry));
      return json(next);
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = await renderCard();
  const target = () => itemElement(view.container, 1);
  fireEvent.click(within(target()).getByRole('button', { name: '撤销' }));
  const alert = await within(target()).findByRole('alert');
  assert.equal(alert.textContent, '无法撤销：记忆 m-1 在批准后又被改动，不能撤销');
  assert.deepEqual(calls.find(call => call.method === 'POST').body, { action: 'undo', item_id: 1 });
  assert.equal(target().querySelector('[data-proposal-state]').textContent, '已生效', 'a refused undo changes nothing');

  refuse = false;
  fireEvent.click(within(target()).getByRole('button', { name: '撤销' }));
  await waitFor(() => assert.equal(target().querySelector('[data-proposal-state]').textContent, '已撤销'));
  assert.equal(within(target()).queryByRole('alert'), null);
  assert.equal(within(target()).queryByRole('button', { name: '撤销' }), null);
  assert.equal(view.getAllByRole('button', { name: '撤销' }).length, 2, 'other applied items stay undoable');
});

test('after a reload the card shows decided states from the server', async () => {
  installFetch(call => {
    if (call.url === proposalUrl && call.method === 'GET') return json(decidedView());
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = await renderCard();
  const { container } = view;
  assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 0);
  const states = [...container.querySelectorAll('[data-proposal-state]')].map(element => element.textContent);
  assert.deepEqual(states, ['已生效', '已生效', '已拒绝', '已拒绝', '已生效', '仅记录']);
  assert.equal(view.queryByLabelText(zh['agent.proposal.rejectReason']), null);
});

test('a failed load can be retried', async () => {
  let fail = true;
  installFetch(call => {
    if (call.url === proposalUrl && call.method === 'GET') return fail ? json({ error: '数据库忙' }, 500) : json(proposalView());
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = render(React.createElement(ProposalCard, { proposalId: PROPOSAL_ID }));
  await view.findByText('提案加载失败：数据库忙');
  fail = false;
  fireEvent.click(view.getByRole('button', { name: zh['common.retry'] }));
  await view.findByText('整理和甜食有关的记忆');
  assert.equal(checkbox(view.container, 1).checked, true);
});

test('history lists proposals per character, including deleted sessions, without deciding there', async () => {
  const deletedSession = { ...decidedView(), id: 9, session_id: null, summary: '已删除会话里的提案' };
  const pendingElsewhere = proposalView({ id: 8, summary: '还在等批准的提案' });
  const calls = installFetch(call => {
    if (call.url === '/api/characters') return json([{ id: 'char-a', name: '小雪' }, { id: 'char-b', name: '阿岚' }]);
    if (call.url === '/api/agent/proposals?character_id=char-b&limit=20&offset=0') return json({ proposals: [deletedSession], has_more: true });
    if (call.url === '/api/agent/proposals?character_id=char-b&limit=20&offset=1') return json({ proposals: [deletedSession, pendingElsewhere], has_more: false });
    if (call.url === '/api/agent/proposals?character_id=char-a&limit=20&offset=0') return json({ proposals: [], has_more: false });
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const view = render(React.createElement(AgentProposalHistory, { defaultCharacterId: 'char-b' }));
  await view.findByText('已删除会话里的提案');
  assert.equal(view.getByLabelText('角色').value, 'char-b');
  assert.ok(view.getByText('来自已删除的会话'));
  assert.equal(view.getAllByRole('button', { name: '撤销' }).length, 3, 'applied items of a deleted session stay undoable');

  fireEvent.click(view.getByRole('button', { name: '加载更多' }));
  await view.findByText('还在等批准的提案');
  assert.equal(view.getAllByText('已删除会话里的提案').length, 1, 'a proposal shifted by paging is not listed twice');
  assert.equal(view.queryByRole('button', { name: '加载更多' }), null);
  assert.equal(view.container.querySelectorAll('input[type="checkbox"]').length, 0, 'history does not decide');
  assert.ok(view.getByText('待批准的项请回到对应会话里处理。'));

  fireEvent.change(view.getByLabelText('角色'), { target: { value: 'char-a' } });
  await view.findByText('这个角色还没有修改历史');
  assert.equal(calls.filter(call => call.url.startsWith('/api/agent/proposals/')).length, 0, 'cards reuse the listed views');
});

test('history falls back to the first character and handles having none', async () => {
  installFetch(call => {
    if (call.url === '/api/characters') return json([{ id: 'char-a', name: '小雪' }]);
    if (call.url === '/api/agent/proposals?character_id=char-a&limit=20&offset=0') return json({ proposals: [], has_more: false });
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const first = render(React.createElement(AgentProposalHistory, { defaultCharacterId: 'char-gone' }));
  await first.findByText('这个角色还没有修改历史');
  assert.equal(first.getByLabelText('角色').value, 'char-a');
  cleanup();

  installFetch(call => {
    if (call.url === '/api/characters') return json([]);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  const second = render(React.createElement(AgentProposalHistory, { defaultCharacterId: null }));
  await second.findByText('还没有角色');
});

test('the settings drawer opens change history for the current character', async () => {
  installFetch(call => {
    if (call.url === '/api/characters') return json([{ id: 'char-a', name: '小雪' }, { id: 'char-b', name: '阿岚' }]);
    if (call.url === '/api/agent/proposals?character_id=char-b&limit=20&offset=0') return json({ proposals: [decidedView()], has_more: false });
    // 默认打开的模型页会读设置和接口列表，空对象就够它渲染
    return json({});
  });
  const view = render(React.createElement(AgentSettingsDrawer, { open: true, onClose: () => {}, onModelSaved: () => {}, characterId: 'char-b' }));
  fireEvent.click(await view.findByRole('tab', { name: '修改历史' }));
  await view.findByText('整理和甜食有关的记忆');
  assert.equal(view.getByLabelText('角色').value, 'char-b');
});

test('approve and continue does not follow the user into another session while history reloads', async () => {
  const sessionA = {
    id: 'agent-session-a', title: '会话 A', character_id: 'char-a', conversation_id: null,
    created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:01:00.000Z',
  };
  const sessionB = {
    id: 'agent-session-b', title: '会话 B', character_id: 'char-a', conversation_id: null,
    created_at: '2026-11-03T08:02:00.000Z', updated_at: '2026-11-03T08:03:00.000Z',
  };
  const base = { tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '' };
  const historyA = [
    { ...base, id: 1, role: 'user', content: '整理会话 A' },
    { ...base, id: 2, role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'create_memory_proposal', arguments: '{}' }] },
    { ...base, id: 3, role: 'tool', content: `{"ok":true,"proposal_id":${PROPOSAL_ID}}`, tool_call_id: 'c1', tool_name: 'create_memory_proposal', tool_ok: true },
  ];
  const historyB = [{ ...base, id: 4, role: 'assistant', content: '这里是会话 B 的历史回复' }];
  const delayedReload = deferred();
  const reloadStarted = deferred();
  let posted = false;
  let aReads = 0;
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [sessionA, sessionB], has_more: false });
    if (call.url === `/api/agent/sessions/${sessionA.id}`) {
      aReads += 1;
      if (posted && aReads === 2) {
        reloadStarted.resolve();
        return delayedReload.promise;
      }
      return json({ session: sessionA, messages: historyA, running: false });
    }
    if (call.url === `/api/agent/sessions/${sessionB.id}`) return json({ session: sessionB, messages: historyB, running: false });
    if (call.url === '/api/agent/status') return json({ failed_tasks: { extraction: 0, profile: 0, embedding: 0 }, repairable_candidates: 0, recent_errors: 0, recent_error_window_hours: 24, agent: { configured: true, provider_name: '虚构接口', model: 'fake-model' } });
    if (call.url === proposalUrl && call.method === 'GET') return json(proposalView());
    if (call.url === proposalUrl && call.method === 'POST') {
      posted = true;
      return json(decidedView());
    }
    if (call.url === '/api/agent/chat') throw new Error('continued into another session');
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  setSearch(`session=${sessionA.id}`);
  const view = render(React.createElement(AgentPage));
  await view.findByText('整理和甜食有关的记忆');

  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: '批准并继续' }));
    await reloadStarted.promise;
  });
  const sessionBButton = view.getAllByRole('button').find(button => button.textContent.includes('会话 B'));
  assert.ok(sessionBButton);
  fireEvent.click(sessionBButton);
  await view.findByText('这里是会话 B 的历史回复');

  await act(async () => {
    delayedReload.resolve(json({ session: sessionA, messages: historyA, running: false }));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.equal(calls.some(call => call.url === '/api/agent/chat'), false);
  assert.equal(currentSearch, `session=${sessionB.id}`);
});

test('approve and continue stays cancelled after A to B to A navigation', async () => {
  const sessionA = {
    id: 'agent-session-a', title: '会话 A', character_id: 'char-a', conversation_id: null,
    created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:01:00.000Z',
  };
  const sessionB = {
    id: 'agent-session-b', title: '会话 B', character_id: 'char-a', conversation_id: null,
    created_at: '2026-11-03T08:02:00.000Z', updated_at: '2026-11-03T08:03:00.000Z',
  };
  const base = { tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '' };
  const historyA = [
    { ...base, id: 1, role: 'user', content: '整理会话 A' },
    { ...base, id: 2, role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'create_memory_proposal', arguments: '{}' }] },
    { ...base, id: 3, role: 'tool', content: `{"ok":true,"proposal_id":${PROPOSAL_ID}}`, tool_call_id: 'c1', tool_name: 'create_memory_proposal', tool_ok: true },
  ];
  const historyB = [{ ...base, id: 4, role: 'assistant', content: '这里是会话 B 的历史回复' }];
  const delayedReload = deferred();
  const reloadStarted = deferred();
  let posted = false;
  let aReads = 0;
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [sessionA, sessionB], has_more: false });
    if (call.url === `/api/agent/sessions/${sessionA.id}`) {
      aReads += 1;
      if (posted && aReads === 2) {
        reloadStarted.resolve();
        return delayedReload.promise;
      }
      return json({ session: sessionA, messages: historyA, running: false });
    }
    if (call.url === `/api/agent/sessions/${sessionB.id}`) return json({ session: sessionB, messages: historyB, running: false });
    if (call.url === '/api/agent/status') return json({ failed_tasks: { extraction: 0, profile: 0, embedding: 0 }, repairable_candidates: 0, recent_errors: 0, recent_error_window_hours: 24, agent: { configured: true, provider_name: '虚构接口', model: 'fake-model' } });
    if (call.url === proposalUrl && call.method === 'GET') return json(proposalView());
    if (call.url === proposalUrl && call.method === 'POST') {
      posted = true;
      return json(decidedView());
    }
    if (call.url === '/api/agent/chat') throw new Error('continued after returning to the same session');
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  setSearch(`session=${sessionA.id}`);
  const view = render(React.createElement(AgentPage));
  await view.findByText('整理和甜食有关的记忆');

  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: '批准并继续' }));
    await reloadStarted.promise;
  });
  const sessionBButton = view.getAllByRole('button').find(button => button.textContent.includes('会话 B'));
  assert.ok(sessionBButton);
  fireEvent.click(sessionBButton);
  await view.findByText('这里是会话 B 的历史回复');
  const sessionAButton = view.getAllByRole('button').find(button => button.textContent.includes('会话 A'));
  assert.ok(sessionAButton);
  fireEvent.click(sessionAButton);
  await waitFor(() => assert.ok(aReads >= 3));

  await act(async () => {
    delayedReload.resolve(json({ session: sessionA, messages: historyA, running: false }));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.equal(calls.some(call => call.url === '/api/agent/chat'), false);
  assert.equal(currentSearch, `session=${sessionA.id}`);
});

test('three repeated conflict calls keep all proposal cards and the third reminder', async t => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => {
    __setDbForTests(null);
    db.close();
  });
  const createdAt = '2026-11-03T08:00:00.000Z';
  const insert = (table, row) => {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map(column => row[column]));
  };
  insert('characters', { id: 'char-a', name: '星野' });
  insert('conversations', { id: 'conv-a', character_id: 'char-a', title: '午后' });
  insert('messages', { id: 'msg-a1', conversation_id: 'conv-a', role: 'user', content: '我住在海边', created_at: createdAt });
  for (const [id, content] of [['m-sea', '用户住在海边'], ['m-hill', '用户住在山里']]) {
    insert('memories', {
      id, character_id: 'char-a', category: '基础信息', content, confidence: 0.8, tags: '[]',
      source_msg_ids: '["msg-a1"]', importance: 0.5, status: 'active', pinned: 0,
      metadata: '{}', created_at: createdAt, updated_at: createdAt,
    });
  }
  const session = createAgentSession(db, { character_id: 'char-a', conversation_id: 'conv-a' }, createdAt);
  const proposalArgs = {
    character_id: 'char-a',
    summary: '发现居住地矛盾',
    items: [{
      op: 'report_conflict',
      memory_ids: ['m-sea', 'm-hill'],
      reason: '两条记忆对居住地给出不同事实',
      evidence: { message_ids: ['msg-a1'] },
      confidence: 0.9,
    }],
  };
  let calls = 0;
  const complete = async () => {
    calls += 1;
    if (calls <= 3) {
      return {
        text: '',
        toolCalls: [{ id: `conflict-${calls}`, name: 'create_memory_proposal', arguments: JSON.stringify(proposalArgs) }],
      };
    }
    return { text: '三份矛盾发现都已记录。', toolCalls: [] };
  };
  const settings = {
    ...DEFAULT_SETTINGS,
    api_base: 'http://upstream.test/v1',
    api_key: 'proposal-ui-loop-test-key',
    model: 'proposal-ui-loop-model',
    streaming: false,
  };
  const result = await runAgentTurn({
    db, sessionId: session.id, userContent: '检查矛盾', tools: AGENT_TOOLS, settings, complete,
    now: () => createdAt,
  });
  assert.deepEqual(result, { status: 'done', rounds: 4 });
  const proposalRows = db.prepare('SELECT id, summary FROM agent_proposals ORDER BY id').all();
  const rawMessages = listAgentMessages(db, session.id);
  assert.equal(proposalRows.length, 3, JSON.stringify({
    proposals: proposalRows,
    tools: rawMessages.filter(row => row.role === 'tool').map(row => row.content),
  }));

  const views = listAgentMessages(db, session.id).map(toAgentMessageView);
  const display = buildAgentDisplayItems(views);
  const cards = display.filter(entry => entry.kind === 'proposal');
  assert.equal(cards.length, 3);
  assert.equal(new Set(cards.map(card => card.proposalId)).size, 3);
  const tools = display.filter(entry => entry.kind === 'tool' && entry.name === 'create_memory_proposal');
  assert.equal(tools.length, 3);
  assert.doesNotMatch(tools[0].result, /\[提醒\]/);
  assert.doesNotMatch(tools[1].result, /\[提醒\]/);
  assert.match(tools[2].result, /\[提醒\]/);
});

test('approve and continue on the page reloads the session and starts the next turn', async () => {
  const SESSION = {
    id: 'agent-session-1', title: '整理甜食记忆', character_id: 'char-a', conversation_id: null,
    created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:01:00.000Z',
  };
  const base = { tool_calls: null, tool_call_id: null, tool_name: null, tool_ok: null, event: null, created_at: '' };
  const history = [
    { ...base, id: 1, role: 'user', content: '帮我整理甜食相关的记忆' },
    { ...base, id: 2, role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'create_memory_proposal', arguments: '{}' }] },
    { ...base, id: 3, role: 'tool', content: `{"ok":true,"proposal_id":${PROPOSAL_ID}}`, tool_call_id: 'c1', tool_name: 'create_memory_proposal', tool_ok: true },
  ];
  const decisionEvent = { ...base, id: 4, role: 'event', content: '', event: { kind: 'proposal_decision', proposal_id: PROPOSAL_ID, items: [{ id: 1, state: 'applied' }, { id: 6, state: 'applied' }] } };
  let decided = false;
  const encoder = new TextEncoder();
  const calls = installFetch(call => {
    if (call.url.startsWith('/api/agent/sessions?')) return json({ sessions: [SESSION], has_more: false });
    if (call.url === `/api/agent/sessions/${SESSION.id}`) return json({ session: SESSION, messages: decided ? [...history, decisionEvent] : history, running: false });
    if (call.url === '/api/agent/status') return json({ failed_tasks: { extraction: 0, profile: 0, embedding: 0 }, repairable_candidates: 0, recent_errors: 0, recent_error_window_hours: 24, agent: { configured: true, provider_name: '虚构接口', model: 'fake-model' } });
    if (call.url === proposalUrl && call.method === 'GET') return json(decided ? decidedView() : proposalView());
    if (call.url === proposalUrl && call.method === 'POST') {
      decided = true;
      return json(decidedView());
    }
    if (call.url === '/api/agent/chat') {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: text\ndata: {"text":"好的，接着整理。"}\n\nevent: done\ndata: {"status":"done","rounds":1}\n\n'));
          controller.close();
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
  setSearch(`session=${SESSION.id}`);
  const view = render(React.createElement(AgentPage));
  await view.findByText('整理和甜食有关的记忆');

  fireEvent.click(view.getByRole('button', { name: '批准并继续' }));
  await waitFor(() => assert.ok(calls.some(call => call.url === '/api/agent/chat')));
  const post = calls.findIndex(call => call.url === proposalUrl && call.method === 'POST');
  const reload = calls.findIndex((call, index) => index > post && call.url === `/api/agent/sessions/${SESSION.id}`);
  const chat = calls.findIndex(call => call.url === '/api/agent/chat');
  assert.ok(post >= 0 && reload > post && chat > reload, 'decide, then reload the session, then start the next turn');
  assert.deepEqual(calls[chat].body, { session_id: SESSION.id, content: '继续' });
  await view.findByText('已处理提案：生效 2 项，拒绝 0 项，跳过 0 项。');
  assert.equal(calls.filter(call => call.url === proposalUrl && call.method === 'GET').length, 1, 'the card keeps its own state across reloads');
});
