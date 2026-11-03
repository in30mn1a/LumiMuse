const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);

const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { createMemoryProposal, createMemoryProposalSchema } = require('../src/lib/agent/proposals.ts');
const { applyProposalDecision, proposalDecisionSchema } = require('../src/lib/agent/proposal-apply.ts');
const { appendAgentMessage, createAgentSession } = require('../src/lib/agent/store.ts');
const { startAgentRun, finishAgentRun } = require('../src/lib/agent/runs.ts');
const sessionRoute = require('../src/app/api/agent/sessions/[id]/route.ts');
const proposalsRoute = require('../src/app/api/agent/proposals/route.ts');
const proposalRoute = require('../src/app/api/agent/proposals/[id]/route.ts');
const characterRoute = require('../src/app/api/characters/[id]/route.ts');

const T0 = '2026-10-01T00:00:00.000Z';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 3, 9, 0, 0) + (clock += 1000)).toISOString();

function insertRow(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map(column => row[column]));
}

function addMemory(db, id, characterId, content) {
  insertRow(db, 'memories', {
    id,
    character_id: characterId,
    category: '偏好习惯',
    content,
    confidence: 0.8,
    source_msg_ids: JSON.stringify([]),
    status: 'active',
    created_at: T0,
    updated_at: T0,
  });
}

/** 全部为虚构数据。 */
function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => {
    __setDbForTests(null);
    db.close();
  });

  for (const [id, name, conversation] of [['char-a', '星野', 'conv-a'], ['char-b', '月见', 'conv-b']]) {
    insertRow(db, 'characters', { id, name });
    insertRow(db, 'conversations', { id: conversation, character_id: id, title: '午后' });
    insertRow(db, 'messages', { id: `msg-${id}`, conversation_id: conversation, role: 'user', content: '我不太爱吃甜', created_at: T0 });
  }
  addMemory(db, 'm-sweet', 'char-a', '主人不爱吃甜');
  addMemory(db, 'm-tea', 'char-a', '主人喜欢喝乌龙茶');
  addMemory(db, 'm-rain', 'char-a', '主人喜欢下雨天');
  addMemory(db, 'm-cat', 'char-a', '主人养了一只橘猫');
  addMemory(db, 'm-b', 'char-b', '主人喜欢看海');

  const session = createAgentSession(db, { character_id: 'char-a', conversation_id: 'conv-a' }, now());
  appendAgentMessage(db, session.id, { role: 'user', content: '帮我整理记忆' }, now());
  return { db, sessionId: session.id };
}

function propose(db, sessionId, characterId, items) {
  const input = createMemoryProposalSchema.parse({ character_id: characterId, summary: '整理记忆', items });
  const created = createMemoryProposal(db, input, { sessionId, now: now() });
  assert.equal(created.ok, true, created.errors?.join('\n'));
  return { id: created.proposalId, itemIds: created.items.map(row => row.id) };
}

function approve(db, proposal, itemIds = proposal.itemIds) {
  const decision = proposalDecisionSchema.parse({ action: 'apply', approved_item_ids: itemIds });
  const outcome = applyProposalDecision(db, proposal.id, decision, now());
  assert.equal(outcome.ok, true, outcome.error);
}

function item(op, characterId, rest) {
  return { op, reason: `${op} 的理由`, confidence: 0.8, evidence: { message_ids: [`msg-${characterId}`] }, ...rest };
}

function request(path, method, body) {
  return new NextRequest(`http://test.local${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function routeContext(id) {
  return { params: Promise.resolve({ id: String(id) }) };
}

function deleteSession(sessionId) {
  return sessionRoute.DELETE(request(`/api/agent/sessions/${sessionId}`, 'DELETE'), routeContext(sessionId));
}

async function listHistory(query) {
  const response = await proposalsRoute.GET(request(`/api/agent/proposals?${query}`, 'GET'));
  return { status: response.status, body: await response.json() };
}

function itemRows(db, proposalId) {
  return db.prepare('SELECT * FROM agent_proposal_items WHERE proposal_id = ? ORDER BY seq').all(proposalId);
}

/** 依据、修改前后、理由和结果：会话删除前后必须一字不差。 */
function historyBytes(db, proposalId) {
  return JSON.stringify([
    itemRows(db, proposalId).map(({ state: _state, reject_reason: _reason, ...rest }) => rest),
    db.prepare(`
      SELECT * FROM memory_revisions WHERE proposal_item_id IN (SELECT id FROM agent_proposal_items WHERE proposal_id = ?)
      ORDER BY id
    `).all(proposalId),
  ]);
}

test('deleting a session keeps its history undoable and rejects what can no longer be approved', async t => {
  const ctx = setup(t);
  const applied = propose(ctx.db, ctx.sessionId, 'char-a', [
    item('retire', 'char-a', { memory_id: 'm-sweet' }),
    item('update', 'char-a', { memory_id: 'm-tea', fields: { importance: 0.9 } }),
  ]);
  approve(ctx.db, applied, [applied.itemIds[0]]);
  const pending = propose(ctx.db, ctx.sessionId, 'char-a', [
    item('update', 'char-a', { memory_id: 'm-rain', fields: { importance: 0.7 } }),
    item('report_conflict', 'char-a', { memory_ids: ['m-rain', 'm-cat'] }),
  ]);
  const other = createAgentSession(ctx.db, { character_id: 'char-a', conversation_id: 'conv-a' }, now());
  const untouched = propose(ctx.db, other.id, 'char-a', [item('retire', 'char-a', { memory_id: 'm-cat' })]);

  const appliedBytes = historyBytes(ctx.db, applied.id);
  const memoriesBefore = JSON.stringify(ctx.db.prepare('SELECT * FROM memories ORDER BY id').all());

  const response = await deleteSession(ctx.sessionId);
  assert.equal(response.status, 200);

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE session_id = ?').get(ctx.sessionId).n, 0);
  assert.equal(JSON.stringify(ctx.db.prepare('SELECT * FROM memories ORDER BY id').all()), memoriesBefore);

  // 已决定的提案：依据和修订原样保留，只是不再属于任何会话
  assert.equal(historyBytes(ctx.db, applied.id), appliedBytes);
  const appliedProposal = ctx.db.prepare('SELECT * FROM agent_proposals WHERE id = ?').get(applied.id);
  assert.equal(appliedProposal.session_id, null);
  assert.equal(appliedProposal.status, 'decided');
  assert.deepEqual(itemRows(ctx.db, applied.id).map(row => [row.state, row.reject_reason]), [['applied', null], ['rejected', null]]);

  // 未决定的提案：pending 项记为拒绝，矛盾发现保持只记录
  const pendingProposal = ctx.db.prepare('SELECT * FROM agent_proposals WHERE id = ?').get(pending.id);
  assert.equal(pendingProposal.session_id, null);
  assert.equal(pendingProposal.status, 'decided');
  assert.ok(pendingProposal.decided_at);
  assert.deepEqual(itemRows(ctx.db, pending.id).map(row => [row.state, row.reject_reason]), [['rejected', '会话已删除'], ['reported', null]]);
  const late = await proposalRoute.POST(
    request(`/api/agent/proposals/${pending.id}`, 'POST', { action: 'apply', approved_item_ids: [pending.itemIds[0]] }),
    routeContext(pending.id),
  );
  assert.equal(late.status, 409);
  assert.equal(ctx.db.prepare("SELECT importance FROM memories WHERE id = 'm-rain'").get().importance, 0.5);

  // 别的会话不受影响
  assert.equal(ctx.db.prepare('SELECT session_id FROM agent_proposals WHERE id = ?').get(untouched.id).session_id, other.id);
  assert.equal(itemRows(ctx.db, untouched.id)[0].state, 'pending');

  // 修改历史里仍能看到并撤销
  const history = await listHistory('character_id=char-a');
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.proposals.map(proposal => proposal.id), [untouched.id, pending.id, applied.id]);
  const listed = history.body.proposals[2];
  assert.equal(listed.session_id, null);
  assert.deepEqual(listed.items[0].evidence, { message_ids: ['msg-char-a'] });
  assert.equal(listed.items[0].before.memories[0].snapshot.content, '主人不爱吃甜');
  assert.deepEqual(listed.evidence_messages.map(message => [message.id, message.role, message.content]), [
    ['msg-char-a', 'user', '我不太爱吃甜'],
  ]);

  const undone = await proposalRoute.POST(
    request(`/api/agent/proposals/${applied.id}`, 'POST', { action: 'undo', item_id: applied.itemIds[0] }),
    routeContext(applied.id),
  );
  assert.equal(undone.status, 200);
  assert.equal((await undone.json()).items[0].state, 'undone');
  assert.equal(ctx.db.prepare("SELECT status FROM memories WHERE id = 'm-sweet'").get().status, 'active');

  // 依据消息被删后，卡片只显示 ID，不再带原文
  ctx.db.exec("DELETE FROM messages WHERE id = 'msg-char-a'");
  const afterDelete = await listHistory('character_id=char-a');
  assert.deepEqual(afterDelete.body.proposals[2].evidence_messages, []);
  assert.deepEqual(afterDelete.body.proposals[2].items[0].evidence, { message_ids: ['msg-char-a'] });
});

test('a session cannot be deleted while it runs, and nothing changes', async t => {
  const ctx = setup(t);
  const pending = propose(ctx.db, ctx.sessionId, 'char-a', [item('retire', 'char-a', { memory_id: 'm-sweet' })]);
  const controller = startAgentRun(ctx.sessionId);
  try {
    const response = await deleteSession(ctx.sessionId);
    assert.equal(response.status, 409);
  } finally {
    finishAgentRun(ctx.sessionId, controller);
  }
  assert.equal(ctx.db.prepare('SELECT session_id FROM agent_proposals WHERE id = ?').get(pending.id).session_id, ctx.sessionId);
  assert.equal(itemRows(ctx.db, pending.id)[0].state, 'pending');

  assert.equal((await deleteSession('missing-session')).status, 404);
  assert.equal(itemRows(ctx.db, pending.id)[0].state, 'pending');
});

test('history is listed per character, newest first, in pages', async t => {
  const ctx = setup(t);
  const ids = [];
  for (const memoryId of ['m-sweet', 'm-tea', 'm-rain']) {
    ids.push(propose(ctx.db, ctx.sessionId, 'char-a', [item('update', 'char-a', { memory_id: memoryId, fields: { importance: 0.6 } })]).id);
  }
  const foreign = propose(ctx.db, ctx.sessionId, 'char-b', [item('retire', 'char-b', { memory_id: 'm-b' })]);

  const first = await listHistory('character_id=char-a&limit=2');
  assert.deepEqual(first.body.proposals.map(proposal => proposal.id), [ids[2], ids[1]]);
  assert.equal(first.body.has_more, true);
  const second = await listHistory('character_id=char-a&limit=2&offset=2');
  assert.deepEqual(second.body.proposals.map(proposal => proposal.id), [ids[0]]);
  assert.equal(second.body.has_more, false);
  assert.equal(second.body.proposals[0].items[0].after.importance, 0.6);

  const fallback = await listHistory('character_id=char-a&limit=abc&offset=-1');
  assert.equal(fallback.body.proposals.length, 3);
  assert.deepEqual((await listHistory('character_id=char-b')).body.proposals.map(proposal => proposal.id), [foreign.id]);
  assert.deepEqual((await listHistory('character_id=nobody')).body, { proposals: [], has_more: false });
  assert.equal((await listHistory('limit=5')).status, 400);
  assert.equal((await listHistory('character_id=%20')).status, 400);
});

test('deleting the character removes its history, including proposals of deleted sessions', async t => {
  const ctx = setup(t);
  const kept = propose(ctx.db, ctx.sessionId, 'char-a', [item('retire', 'char-a', { memory_id: 'm-sweet' })]);
  approve(ctx.db, kept);
  propose(ctx.db, ctx.sessionId, 'char-a', [item('update', 'char-a', { memory_id: 'm-tea', fields: { importance: 0.9 } })]);
  const foreign = propose(ctx.db, ctx.sessionId, 'char-b', [item('retire', 'char-b', { memory_id: 'm-b' })]);
  approve(ctx.db, foreign);
  assert.equal((await deleteSession(ctx.sessionId)).status, 200);

  const response = await characterRoute.DELETE(request('/api/characters/char-a', 'DELETE'), routeContext('char-a'));
  assert.equal(response.status, 200);

  const remaining = table => ctx.db.prepare(`SELECT character_id FROM ${table}`).all().map(row => row.character_id);
  assert.deepEqual(remaining('agent_proposals'), ['char-b']);
  assert.deepEqual(remaining('memory_revisions'), ['char-b']);
  assert.deepEqual(
    ctx.db.prepare('SELECT proposal_id FROM agent_proposal_items').all().map(row => row.proposal_id),
    [foreign.id],
  );
  assert.deepEqual((await listHistory('character_id=char-a')).body.proposals, []);
});
