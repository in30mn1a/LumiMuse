// 联网搜索接入聊天链路：真实 route.ts → chat-engine.ts，只在出站边界 safeFetch 截获。
// 关闭联网时请求逐字节不变由 tests/chat-isolation.test.cjs 的快照负责，这里验证开启后的行为。

process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const SSRF_GUARD_PATH = require.resolve('../src/lib/ssrf-guard.ts');
const MEMORY_QUEUE_PATH = require.resolve('../src/lib/memory-queue.ts');
const originalLoad = Module._load;

const SUMMARY = '《潮汐》上周五上映，首周末票房三亿。';
const SOURCES = [{ title: '潮汐票房报道', url: 'https://news.example/tide' }];
const REPLY = '我听说首周末就有三亿了呢。';

let upstream = [];
let searchApiStatus = 200;

function respond(call) {
  if (call.url.startsWith('https://api.deepseek.com/')) {
    return new Response(JSON.stringify(searchApiStatus === 200
      ? { results: [{ title: SOURCES[0].title, url: SOURCES[0].url, site_name: 'News', date: '', summary: '首周末三亿' }] }
      : { error: { message: 'unauthorized' } }), { status: searchApiStatus });
  }
  const body = JSON.parse(call.body);
  if (body.tools) {
    // 后台工具循环：第一次请求调用搜索，拿到工具结果后交摘要
    const searched = body.messages.some(message => message.role === 'tool');
    const message = searched
      ? { content: `${SUMMARY}\nSOURCES: 1` }
      : { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_web', arguments: '{"query":"潮汐 票房"}' } }] };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), { status: 200 });
  }
  return new Response(JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200 });
}

const ssrfGuardMock = {
  ...originalLoad.call(Module, SSRF_GUARD_PATH, module, false),
  async safeFetch(url, init = {}) {
    const call = { url: String(url), body: init.body };
    upstream.push(call);
    return respond(call);
  },
};
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request.includes('ssrf-guard') || request.includes('memory-queue')) {
    let target = null;
    try { target = Module._resolveFilename(request, parent, isMain); } catch { /* fall through */ }
    if (target === SSRF_GUARD_PATH) return ssrfGuardMock;
    if (target === MEMORY_QUEUE_PATH) return { enqueueExtraction() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalLoad; });

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');

function setup(t, { searchKey = 'sk-test', settings = {} } = {}) {
  const db = new Database(':memory:');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => db.close());

  if (searchKey) process.env.DEEPSEEK_API_KEY = searchKey;
  else delete process.env.DEEPSEEK_API_KEY;
  t.after(() => { delete process.env.DEEPSEEK_API_KEY; });

  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  const values = { api_base: 'http://upstream.test/v1', api_key: 'k', model: 'm', streaming: false, memory_inject: false, web_search: { enabled: true }, ...settings };
  for (const [key, value] of Object.entries(values)) upsert.run(key, JSON.stringify(value));

  db.prepare(`INSERT INTO characters (id, name, system_prompt, created_at, updated_at)
    VALUES ('char', '澪', '你是澪。', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES ('conv', 'char', 't', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`).run();

  upstream = [];
  searchApiStatus = 200;
  return db;
}

async function chat(body) {
  const { POST } = require('../src/app/api/chat/route.ts');
  const response = await POST(new Request('http://localhost/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: 'conv',
      client_now_iso: '2026-11-15T01:00:00.000Z',
      client_timezone: 'Asia/Shanghai',
      ...body,
    }),
  }));
  const sse = await response.text();
  const events = sse.split('\n\n').filter(Boolean).map(part => {
    const [eventLine, dataLine] = part.split('\n');
    return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) };
  });
  return { events, searchEvents: events.filter(item => item.event === 'search').map(item => item.data) };
}

/** 发给角色聊天模型的请求（不含后台工具循环和搜索接口）。 */
const chatRequests = () => upstream
  .filter(call => call.url === 'http://upstream.test/v1/chat/completions')
  .map(call => JSON.parse(call.body))
  .filter(body => !body.tools);

const messageRow = (db, role) => {
  const row = db.prepare('SELECT id, metadata FROM messages WHERE role = ? ORDER BY seq DESC LIMIT 1').get(role);
  return { id: row.id, metadata: JSON.parse(row.metadata) };
};

test('search results reach the reply, are saved, and stay byte-stable on later turns', async t => {
  const db = setup(t);

  const first = await chat({ content: '《潮汐》好看吗？', web_search: true });

  assert.deepEqual(first.searchEvents, [{ status: 'searching' }, { status: 'done', sources: SOURCES }]);
  assert.ok(first.events.some(item => item.event === 'done'));

  const [firstRequest] = chatRequests();
  const lastMessage = firstRequest.messages.at(-1);
  assert.equal(lastMessage.role, 'user');
  // 资料排在用户正文之后，不进 system
  assert.match(lastMessage.content, /《潮汐》好看吗？\n\n<web_search_results>\n/);
  assert.ok(lastMessage.content.includes(SUMMARY));
  assert.ok(lastMessage.content.endsWith('</web_search_results>'));
  assert.doesNotMatch(lastMessage.content, /SOURCES:/);
  assert.ok(!firstRequest.messages[0].content.includes(SUMMARY));

  const savedUser = messageRow(db, 'user').metadata.web_search;
  assert.equal(savedUser.summary, SUMMARY);
  assert.deepEqual(savedUser.sources, SOURCES);
  assert.deepEqual(savedUser.queries, ['潮汐 票房']);
  assert.deepEqual(messageRow(db, 'assistant').metadata.web_search_sources, SOURCES);

  // 下一轮不联网：不再搜索，上一轮请求是这一轮请求的严格前缀（资料仍在、逐字不变）
  upstream = [];
  const second = await chat({ content: '那周末一起去看吧。' });

  assert.deepEqual(second.searchEvents, []);
  assert.equal(upstream.length, 1);
  const [secondRequest] = chatRequests();
  assert.equal(
    JSON.stringify(secondRequest.messages.slice(0, firstRequest.messages.length)),
    JSON.stringify(firstRequest.messages),
  );
  // 没联网的这一轮，回复上不带来源
  assert.equal(messageRow(db, 'assistant').metadata.web_search_sources, undefined);
});

test('regenerate reuses saved results when the switch is off and replaces them when it is on', async t => {
  const db = setup(t);
  await chat({ content: '《潮汐》好看吗？', web_search: true });
  const assistantId = messageRow(db, 'assistant').id;
  const userId = messageRow(db, 'user').id;

  upstream = [];
  await chat({ content: '', regenerate_assistant_id: assistantId, skip_user_insert: true });
  assert.equal(upstream.length, 1, 'switch off: no search requests');
  assert.ok(chatRequests()[0].messages.at(-1).content.includes(SUMMARY));
  assert.deepEqual(messageRow(db, 'assistant').metadata.web_search_sources, SOURCES);

  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify({
    web_search: { summary: '旧资料', sources: [], queries: [], searched_at: '2026-11-01T00:00:00.000Z' },
  }), userId);
  upstream = [];
  const again = await chat({ content: '', regenerate_assistant_id: assistantId, skip_user_insert: true, web_search: true });
  assert.equal(again.searchEvents.at(-1).status, 'done');
  const content = chatRequests()[0].messages.at(-1).content;
  assert.ok(content.includes(SUMMARY));
  assert.ok(!content.includes('旧资料'));
});

// 2026-11-15：修复前存下的资料整段是 DSML 文本，重新生成时搜索失败就沿用了它。
test('saved results that are leaked tool-call text are not given to the character', async t => {
  const db = setup(t);
  await chat({ content: 'S16 总决赛', web_search: true });
  const assistantId = messageRow(db, 'assistant').id;
  const userId = messageRow(db, 'user').id;
  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify({
    web_search: {
      summary: '<｜DSML｜ calls>\n<｜DSML｜ invoke name="search_web"></｜DSML｜ invoke>',
      sources: SOURCES, queries: [], searched_at: '2026-11-15T00:00:00.000Z',
    },
  }), userId);

  upstream = [];
  searchApiStatus = 401;
  await chat({ content: '', regenerate_assistant_id: assistantId, skip_user_insert: true, web_search: true });

  assert.doesNotMatch(chatRequests()[0].messages.at(-1).content, /web_search_results|DSML/);
  assert.equal(messageRow(db, 'assistant').metadata.web_search_sources, undefined);
});

test('a failed search does not block the reply', async t => {
  const db = setup(t);
  searchApiStatus = 401;

  const { events, searchEvents } = await chat({ content: '《潮汐》好看吗？', web_search: true });

  assert.equal(searchEvents[0].status, 'searching');
  assert.equal(searchEvents[1].status, 'failed');
  assert.match(searchEvents[1].message, /Search API error 401/);
  assert.ok(events.some(item => item.event === 'done'));
  assert.ok(!events.some(item => item.event === 'error'));
  assert.doesNotMatch(chatRequests()[0].messages.at(-1).content, /web_search_results/);
  assert.equal(messageRow(db, 'user').metadata.web_search, undefined);
  assert.equal(messageRow(db, 'assistant').metadata.web_search_sources, undefined);
});

test('without a search key the reply still goes out and no search request is made', async t => {
  setup(t, { searchKey: '' });

  const { events, searchEvents } = await chat({ content: '《潮汐》好看吗？', web_search: true });

  assert.equal(searchEvents.at(-1).status, 'failed');
  assert.equal(upstream.length, 1);
  assert.ok(events.some(item => item.event === 'done'));
});

test('the request flag is ignored while web search is turned off in settings', async t => {
  const db = setup(t, { settings: { web_search: { enabled: false } } });

  const { events, searchEvents } = await chat({ content: '《潮汐》好看吗？', web_search: true });

  assert.deepEqual(searchEvents, []);
  assert.equal(upstream.length, 1);
  assert.ok(events.some(item => item.event === 'done'));
  assert.equal(messageRow(db, 'user').metadata.web_search, undefined);
});

test('the key saved in settings wins over the environment variable', async t => {
  setup(t, { searchKey: 'sk-env', settings: { web_search: { enabled: true, api_key: 'sk-settings' } } });
  const seen = [];
  const original = ssrfGuardMock.safeFetch;
  ssrfGuardMock.safeFetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.deepseek.com/')) seen.push(init.headers.Authorization);
    return original(url, init);
  };
  t.after(() => { ssrfGuardMock.safeFetch = original; });

  await chat({ content: '《潮汐》好看吗？', web_search: true });

  assert.deepEqual(seen, ['Bearer sk-settings']);
});

test('search results count toward the history budget', async t => {
  setup(t);
  const { buildHistoryMessages } = require('../src/lib/chat-engine.ts');
  const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
  const message = metadata => ({
    id: 'm', conversation_id: 'conv', role: 'user', content: '你好', token_count: 0,
    created_at: '2026-11-15T01:00:00.000Z', metadata,
  });
  const settings = { ...DEFAULT_SETTINGS, show_timestamps: false };

  const plain = await buildHistoryMessages([message({})], settings, undefined, 0);
  const withSearch = await buildHistoryMessages([message({
    web_search: { summary: '很长的资料。'.repeat(200), sources: [], queries: [], searched_at: '' },
  })], settings, undefined, 0);

  assert.equal(plain.history[0].content, '你好');
  assert.ok(withSearch.usedTokens > plain.usedTokens + 200);
});

test('settings route masks the search key and keeps it when the mask is written back', async t => {
  const db = setup(t, { settings: { web_search: { enabled: true, api_key: 'sk-real', summary_target_chars: 1500, max_rounds: 6 } } });
  const { NextRequest } = require('next/server');
  const { GET, PUT } = require('../src/app/api/settings/route.ts');
  const { API_KEY_MASK } = require('../src/lib/constants.ts');
  const stored = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'web_search'").get().value);

  const shown = await (await GET(new NextRequest('http://localhost/api/settings'))).json();
  assert.equal(shown.web_search.api_key, API_KEY_MASK);

  const saved = await (await PUT(new NextRequest('http://localhost/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ web_search: { api_key: API_KEY_MASK, summary_target_chars: 3000, max_rounds: 4 } }),
  }))).json();
  assert.equal(saved.web_search.api_key, API_KEY_MASK);
  assert.deepEqual(stored(), { enabled: true, api_key: 'sk-real', summary_target_chars: 3000, max_rounds: 4 });

  const rejected = await PUT(new NextRequest('http://localhost/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ web_search: { max_rounds: 0 } }),
  }));
  assert.equal(rejected.status, 400);
});
