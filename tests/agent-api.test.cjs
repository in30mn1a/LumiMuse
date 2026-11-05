const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const ssrfGuard = require('../src/lib/ssrf-guard.ts');
const chatRoute = require('../src/app/api/agent/chat/route.ts');
const sessionsRoute = require('../src/app/api/agent/sessions/route.ts');
const sessionRoute = require('../src/app/api/agent/sessions/[id]/route.ts');
const stopRoute = require('../src/app/api/agent/sessions/[id]/stop/route.ts');
const compactRoute = require('../src/app/api/agent/sessions/[id]/compact/route.ts');
const proposalRoute = require('../src/app/api/agent/proposals/[id]/route.ts');
const documentsRoute = require('../src/app/api/agent/documents/[key]/route.ts');
const statusRoute = require('../src/app/api/agent/status/route.ts');
const { appendAgentMessage, listAgentMessages } = require('../src/lib/agent/store.ts');

const UPSTREAM_KEY = 'agent-api-test-key';

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries({
    api_base: 'http://upstream.test/v1',
    api_key: UPSTREAM_KEY,
    model: 'agent-api-model',
    streaming: false,
  })) {
    insertSetting.run(key, JSON.stringify(value));
  }
  db.prepare(`INSERT INTO characters (id, name) VALUES ('char-1', '星野')`).run();
  db.prepare(`INSERT INTO conversations (id, character_id, title) VALUES ('conv-1', 'char-1', '午后')`).run();

  const upstream = { calls: [], handlers: [] };
  const originalFetch = ssrfGuard.safeFetch;
  ssrfGuard.safeFetch = async (url, init) => {
    upstream.calls.push({ url, body: JSON.parse(init.body) });
    const handler = upstream.handlers.shift();
    if (!handler) throw new Error('unexpected upstream request');
    return handler(init);
  };
  t.after(() => {
    ssrfGuard.safeFetch = originalFetch;
    __setDbForTests(null);
    db.close();
  });
  return { db, upstream };
}

function completion(message) {
  return () => Response.json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
}

/** 一直挂起，直到请求被中止。 */
function hangingCompletion(started) {
  return init => new Promise((_resolve, reject) => {
    started();
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

function jsonRequest(path, method, body, init = {}) {
  return new NextRequest(`http://test.local${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
}

function routeContext(params) {
  return { params: Promise.resolve(params) };
}

async function readSse(response) {
  const text = await response.text();
  return text.split('\n\n').filter(Boolean).map(block => {
    const [eventLine, dataLine] = block.split('\n');
    return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) };
  });
}

async function createSession(body = { conversation_id: 'conv-1' }) {
  const response = await sessionsRoute.POST(jsonRequest('/api/agent/sessions', 'POST', body));
  assert.equal(response.status, 201);
  return response.json();
}

test('a chat request streams tool progress, text and done in order, then history restores', async t => {
  const { upstream } = setup(t);
  const session = await createSession();
  assert.equal(session.character_id, 'char-1');
  upstream.handlers.push(
    completion({ content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_characters', arguments: '{}' } }] }),
    completion({ content: '你有一个角色：星野。', reasoning_content: '数一下' }),
  );

  const response = await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: session.id, content: '我有几个角色？' }));
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const events = await readSse(response);
  assert.deepEqual(events.map(item => item.event), ['context', 'tool_start', 'tool_end', 'context', 'text', 'done']);
  assert.deepEqual(events[2].data, { id: 'call_1', name: 'list_characters', ok: true });
  assert.equal(events[4].data.text, '你有一个角色：星野。');
  assert.deepEqual(events[5].data, { status: 'done', rounds: 2 });
  // 每次请求前推送占用；第二次多了工具回合
  assert.equal(events[0].data.window, 272000);
  assert.ok(events[3].data.used > events[0].data.used);
  assert.equal(upstream.calls[0].url, 'http://upstream.test/v1/chat/completions');
  assert.ok(upstream.calls[0].body.tools.some(tool => tool.function.name === 'search_memories'));

  const historyResponse = await sessionRoute.GET(jsonRequest(`/api/agent/sessions/${session.id}`, 'GET'), routeContext({ id: session.id }));
  const history = await historyResponse.json();
  assert.equal(history.running, false);
  assert.equal(history.session.title, '我有几个角色？');
  assert.deepEqual(history.messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(history.messages[1].tool_calls, [{ id: 'call_1', name: 'list_characters', arguments: '{}' }]);
  assert.match(history.messages[2].content, /星野/);
  assert.equal(history.context.window, 272000);
  assert.ok(history.context.used > events[3].data.used, 'history now includes the final reply');
  assert.ok(history.context.threshold > 0);
  const raw = JSON.stringify(history);
  assert.equal(raw.includes('数一下'), false, 'reasoning stays server-side');
  assert.equal(raw.includes(UPSTREAM_KEY), false);
});

test('a second request on a running session gets 409, and disconnecting aborts the turn', async t => {
  const { db, upstream } = setup(t);
  const session = await createSession();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  upstream.handlers.push(hangingCompletion(() => markStarted()));

  const client = new AbortController();
  const firstResponse = await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: session.id, content: '慢慢想' }, { signal: client.signal }));
  const firstEvents = readSse(firstResponse);
  await started;

  const busy = await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: session.id, content: '再问一次' }));
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, 'agent_busy');
  const busyDelete = await sessionRoute.DELETE(jsonRequest(`/api/agent/sessions/${session.id}`, 'DELETE'), routeContext({ id: session.id }));
  assert.equal(busyDelete.status, 409);
  const runningView = await (await sessionRoute.GET(jsonRequest(`/api/agent/sessions/${session.id}`, 'GET'), routeContext({ id: session.id }))).json();
  assert.equal(runningView.running, true);

  // 另一个会话不受影响
  const other = await createSession({});
  upstream.handlers.push(completion({ content: '在的' }));
  const otherEvents = await readSse(await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: other.id, content: '在吗' })));
  assert.equal(otherEvents.at(-1).data.status, 'done');

  client.abort();
  const events = await firstEvents;
  assert.deepEqual(events.at(-1), { event: 'done', data: { status: 'aborted', rounds: 1 } });
  const rows = db.prepare('SELECT role, content FROM agent_messages WHERE session_id = ? ORDER BY id').all(session.id);
  assert.deepEqual(rows.map(row => [row.role, row.content]), [['user', '慢慢想'], ['event', '{"kind":"interrupted"}']]);

  upstream.handlers.push(completion({ content: '接着来' }));
  const retry = await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: session.id, content: '继续' }));
  assert.equal(retry.status, 200);
  assert.equal((await readSse(retry)).at(-1).data.status, 'done');
});

test('the stop endpoint aborts a run that the caller does not hold the stream for', async t => {
  const { db, upstream } = setup(t);
  const session = await createSession();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  upstream.handlers.push(hangingCompletion(() => markStarted()));

  // 不持有客户端中止信号：模拟切走后页面已丢掉原来的流
  const response = await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: session.id, content: '慢慢想' }));
  const eventsPromise = readSse(response);
  await started;

  const stop = await stopRoute.POST(jsonRequest(`/api/agent/sessions/${session.id}/stop`, 'POST'), routeContext({ id: session.id }));
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { stopped: true });

  const events = await eventsPromise;
  assert.deepEqual(events.at(-1), { event: 'done', data: { status: 'aborted', rounds: 1 } });
  const rows = db.prepare('SELECT role, content FROM agent_messages WHERE session_id = ? ORDER BY id').all(session.id);
  assert.deepEqual(rows.map(row => [row.role, row.content]), [['user', '慢慢想'], ['event', '{"kind":"interrupted"}']]);
  const view = await (await sessionRoute.GET(jsonRequest(`/api/agent/sessions/${session.id}`, 'GET'), routeContext({ id: session.id }))).json();
  assert.equal(view.running, false);

  const idle = await stopRoute.POST(jsonRequest(`/api/agent/sessions/${session.id}/stop`, 'POST'), routeContext({ id: session.id }));
  assert.deepEqual(await idle.json(), { stopped: false });
  const missing = await stopRoute.POST(jsonRequest('/api/agent/sessions/missing/stop', 'POST'), routeContext({ id: 'missing' }));
  assert.equal(missing.status, 404);
});

test('manual compaction preserves the first turn, creates no new task and is a no-op without new history', async t => {
  const { db, upstream } = setup(t);
  const session = await createSession();
  const path = `/api/agent/sessions/${session.id}/compact`;
  assert.deepEqual(await (await compactRoute.POST(jsonRequest(path, 'POST'), routeContext({ id: session.id }))).json(), { compacted: false });
  upstream.handlers.push(completion({ content: '已核对 mem-1，下一轮核对 mem-2。' }));
  await readSse(await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: session.id, content: '检查虚构记忆' })));
  const before = listAgentMessages(db, session.id);
  upstream.handlers.push(completion({ content: '主人要求检查虚构记忆；mem-1 已核对，下一轮核对 mem-2。' }));
  const response = await compactRoute.POST(jsonRequest(path, 'POST'), routeContext({ id: session.id }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { compacted: true });
  const after = listAgentMessages(db, session.id);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.length, before.length + 1);
  assert.equal(JSON.parse(after.at(-1).content).through_id, before.at(-1).id);
  assert.match(upstream.calls.at(-1).body.messages[1].content, /下一轮核对 mem-2/);
  assert.equal(upstream.calls.length, 2, 'chat and summary only, without starting a following turn');
  assert.deepEqual(await (await compactRoute.POST(jsonRequest(path, 'POST'), routeContext({ id: session.id }))).json(), { compacted: false });
  assert.equal(upstream.calls.length, 2);
  assert.equal((await compactRoute.POST(jsonRequest('/api/agent/sessions/missing/compact', 'POST'), routeContext({ id: 'missing' }))).status, 404);
});

test('manual compaction shares the chat, delete and proposal lock and the stop endpoint cancels it', async t => {
  const { db, upstream } = setup(t);
  const session = await createSession();
  appendAgentMessage(db, session.id, { role: 'user', content: '检查虚构记忆' }, '2026-11-06T02:00:00.000Z');
  appendAgentMessage(db, session.id, { role: 'assistant', content: '本轮完成，下一轮继续。' }, '2026-11-06T02:00:00.000Z');
  const proposalId = Number(db.prepare(`
    INSERT INTO agent_proposals (session_id, character_id, summary, status, created_at)
    VALUES (?, 'char-1', '虚构提案', 'pending', '2026-11-06T02:00:00.000Z')
  `).run(session.id).lastInsertRowid);
  const before = listAgentMessages(db, session.id);
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  upstream.handlers.push(hangingCompletion(markStarted));
  const path = `/api/agent/sessions/${session.id}/compact`;
  const pending = compactRoute.POST(jsonRequest(path, 'POST'), routeContext({ id: session.id }));
  await started;

  const busyRequests = [
    await compactRoute.POST(jsonRequest(path, 'POST'), routeContext({ id: session.id })),
    await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: session.id, content: '继续' })),
    await sessionRoute.DELETE(jsonRequest(`/api/agent/sessions/${session.id}`, 'DELETE'), routeContext({ id: session.id })),
    await proposalRoute.POST(jsonRequest(`/api/agent/proposals/${proposalId}`, 'POST', { action: 'apply', approved_item_ids: [] }), routeContext({ id: String(proposalId) })),
  ];
  for (const response of busyRequests) {
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'agent_busy');
  }
  const running = await (await sessionRoute.GET(jsonRequest(`/api/agent/sessions/${session.id}`, 'GET'), routeContext({ id: session.id }))).json();
  assert.equal(running.running, true);
  const other = await createSession({});
  upstream.handlers.push(completion({ content: '另一会话照常运行' }));
  assert.equal((await readSse(await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: other.id, content: '在吗' })))).at(-1).data.status, 'done');

  assert.deepEqual(await (await stopRoute.POST(jsonRequest(`/api/agent/sessions/${session.id}/stop`, 'POST'), routeContext({ id: session.id }))).json(), { stopped: true });
  const cancelled = await pending;
  assert.equal(cancelled.status, 499);
  assert.equal((await cancelled.json()).code, 'agent_compaction_aborted');
  assert.deepEqual(listAgentMessages(db, session.id), before, 'cancellation writes neither summary nor task interruption');
  const idle = await (await sessionRoute.GET(jsonRequest(`/api/agent/sessions/${session.id}`, 'GET'), routeContext({ id: session.id }))).json();
  assert.equal(idle.running, false);

  upstream.handlers.push(completion({ content: '重试成功摘要' }));
  assert.deepEqual(await (await compactRoute.POST(jsonRequest(path, 'POST'), routeContext({ id: session.id }))).json(), { compacted: true });
});

test('manual compaction disconnect and an already-aborted request save no records and release the lock', async t => {
  const { db, upstream } = setup(t);
  const session = await createSession();
  appendAgentMessage(db, session.id, { role: 'user', content: '虚构任务' }, '2026-11-06T02:00:00.000Z');
  appendAgentMessage(db, session.id, { role: 'assistant', content: '本轮成果' }, '2026-11-06T02:00:00.000Z');
  const before = listAgentMessages(db, session.id);
  const path = `/api/agent/sessions/${session.id}/compact`;
  const already = new AbortController();
  already.abort();
  const rejected = await compactRoute.POST(jsonRequest(path, 'POST', undefined, { signal: already.signal }), routeContext({ id: session.id }));
  assert.equal(rejected.status, 499);
  assert.equal(upstream.calls.length, 0);

  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  upstream.handlers.push(hangingCompletion(markStarted));
  const client = new AbortController();
  const pending = compactRoute.POST(jsonRequest(path, 'POST', undefined, { signal: client.signal }), routeContext({ id: session.id }));
  await started;
  client.abort();
  assert.equal((await pending).status, 499);
  assert.deepEqual(listAgentMessages(db, session.id), before);
  upstream.handlers.push(completion({ content: '取消后可重新压缩' }));
  assert.deepEqual(await (await compactRoute.POST(jsonRequest(path, 'POST'), routeContext({ id: session.id }))).json(), { compacted: true });
});

test('manual compaction reports sanitized upstream failure and can retry without losing history', async t => {
  const { db, upstream } = setup(t);
  const session = await createSession();
  appendAgentMessage(db, session.id, { role: 'user', content: '虚构任务' }, '2026-11-06T02:00:00.000Z');
  appendAgentMessage(db, session.id, { role: 'assistant', content: '本轮成果' }, '2026-11-06T02:00:00.000Z');
  const before = listAgentMessages(db, session.id);
  const path = `/api/agent/sessions/${session.id}/compact`;
  upstream.handlers.push(() => new Response(JSON.stringify({ error: { message: `bad key ${UPSTREAM_KEY}` } }), { status: 401 }));
  const response = await compactRoute.POST(jsonRequest(path, 'POST'), routeContext({ id: session.id }));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.error, /401/);
  assert.equal(JSON.stringify(body).includes(UPSTREAM_KEY), false);
  assert.deepEqual(listAgentMessages(db, session.id), before);
  upstream.handlers.push(completion({ content: '重试成功' }));
  assert.deepEqual(await (await compactRoute.POST(jsonRequest(path, 'POST'), routeContext({ id: session.id }))).json(), { compacted: true });
});

test('upstream failures arrive as an error event before done', async t => {
  const { upstream } = setup(t);
  const session = await createSession();
  upstream.handlers.push(() => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
  const events = await readSse(await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: session.id, content: '在吗' })));
  assert.deepEqual(events.map(item => item.event), ['context', 'error', 'done']);
  assert.match(events[1].data.error, /401/);
  assert.equal(events[2].data.status, 'error');
});

test('chat validates the body and the session', async t => {
  setup(t);
  assert.equal((await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: 'x', content: '   ' }))).status, 400);
  assert.equal((await chatRoute.POST(jsonRequest('/api/agent/chat', 'POST', { session_id: 'missing', content: 'hi' }))).status, 404);
});

test('sessions can be listed, renamed and deleted', async t => {
  setup(t);
  const first = await createSession({ title: '第一个' });
  const second = await createSession({ conversation_id: 'missing-conversation', character_id: 'char-1' });
  assert.equal(second.conversation_id, null);
  assert.equal(second.character_id, 'char-1');

  const list = await (await sessionsRoute.GET(jsonRequest('/api/agent/sessions?limit=1', 'GET'))).json();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.has_more, true);

  const renamed = await sessionRoute.PATCH(jsonRequest(`/api/agent/sessions/${first.id}`, 'PATCH', { title: '改名了' }), routeContext({ id: first.id }));
  assert.equal((await renamed.json()).title, '改名了');
  const deleted = await sessionRoute.DELETE(jsonRequest(`/api/agent/sessions/${first.id}`, 'DELETE'), routeContext({ id: first.id }));
  assert.equal(deleted.status, 200);
  const gone = await sessionRoute.GET(jsonRequest(`/api/agent/sessions/${first.id}`, 'GET'), routeContext({ id: first.id }));
  assert.equal(gone.status, 404);
});

test('documents save versions and restore an old one', async t => {
  setup(t);
  const put = body => documentsRoute.PUT(jsonRequest('/api/agent/documents/agents', 'PUT', body), routeContext({ key: 'agents' }));
  assert.equal((await put({ content: '第一版' })).status, 200);
  await put({ content: '第二版' });
  const view = await (await documentsRoute.GET(jsonRequest('/api/agent/documents/agents', 'GET'), routeContext({ key: 'agents' }))).json();
  assert.equal(view.document.content, '第二版');
  assert.deepEqual(view.versions.map(version => version.content), ['第二版', '第一版']);

  const restored = await (await put({ restore_version_id: view.versions[1].id })).json();
  assert.equal(restored.document.content, '第一版');
  assert.equal((await put({ restore_version_id: 9999 })).status, 404);
  const bad = await documentsRoute.GET(jsonRequest('/api/agent/documents/settings', 'GET'), routeContext({ key: 'settings' }));
  assert.equal(bad.status, 404);
});

test('status counts failures without calling the model', async t => {
  const { db, upstream } = setup(t);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO memory_tasks (character_id, conversation_id, status, error_message) VALUES ('char-1', 'conv-1', 'failed', 'boom')`).run();
  db.prepare(`
    INSERT INTO memory_extraction_candidates (character_id, status, created_at, updated_at)
    VALUES ('char-1', 'repairable', ?, ?), ('char-1', 'ignored', ?, ?)
  `).run(now, now, now, now);
  db.prepare(`INSERT INTO app_events (ts, level, event) VALUES (?, 'error', 'chat.reply_failed'), (?, 'warn', 'x'), (?, 'error', 'old')`)
    .run(now, now, '2020-01-01T00:00:00.000Z');

  const body = await (await statusRoute.GET()).json();
  assert.deepEqual(body.failed_tasks, { extraction: 1, profile: 0, embedding: 0 });
  assert.equal(body.repairable_candidates, 1);
  assert.equal(body.recent_errors, 1);
  assert.deepEqual(body.agent, { configured: true, provider_name: null, model: 'agent-api-model' });
  assert.equal(upstream.calls.length, 0);
  assert.equal(JSON.stringify(body).includes(UPSTREAM_KEY), false);
});

test('agent routes are behind the access password', async t => {
  const previous = { ACCESS_PASSWORD: process.env.ACCESS_PASSWORD, AUTH_SECRET: process.env.AUTH_SECRET };
  process.env.ACCESS_PASSWORD = 'agent-route-password';
  process.env.AUTH_SECRET = 'agent-route-secret';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { proxy } = require('../src/proxy.ts');
  for (const path of ['/api/agent/chat', '/api/agent/sessions', '/api/agent/sessions/session-id/compact', '/api/agent/status', '/api/agent/documents/agents']) {
    const response = await proxy(new NextRequest(`http://test.local${path}`));
    assert.equal(response.status, 401, path);
  }
});
