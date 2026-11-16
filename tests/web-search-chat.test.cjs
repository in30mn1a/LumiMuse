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
  if (call.url === 'https://api.tavily.com/search') {
    return new Response(JSON.stringify({ results: [{ title: SOURCES[0].title, url: SOURCES[0].url, content: '首周末三亿' }] }), { status: 200 });
  }
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

  // 本机 shell 里可能设着真实的搜索密钥，测试期间全部移走，结束后还原。
  const envKeys = ['DEEPSEEK_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY'];
  const savedEnv = Object.fromEntries(envKeys.map(name => [name, process.env[name]]));
  for (const name of envKeys) delete process.env[name];
  t.after(() => {
    for (const name of envKeys) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });
  if (searchKey) process.env.DEEPSEEK_API_KEY = searchKey;

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
  assert.match(searchEvents[1].message, /DeepSeek API error 401/);
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

/** 记录发往搜索服务（非聊天上游）的请求地址与鉴权头。 */
function recordSearchCalls(t) {
  const seen = [];
  const original = ssrfGuardMock.safeFetch;
  ssrfGuardMock.safeFetch = async (url, init = {}) => {
    if (!String(url).startsWith('http://upstream.test/')) seen.push([String(url), init.headers.Authorization]);
    return original(url, init);
  };
  t.after(() => { ssrfGuardMock.safeFetch = original; });
  return seen;
}

test('the key saved in settings wins over the environment variable', async t => {
  setup(t, { searchKey: 'sk-env', settings: { web_search: { enabled: true, api_keys: { deepseek: 'sk-settings' } } } });
  const seen = recordSearchCalls(t);

  await chat({ content: '《潮汐》好看吗？', web_search: true });

  assert.deepEqual(seen, [['https://api.deepseek.com/v1/tools/search', 'Bearer sk-settings']]);
});

test('a key saved before providers existed is used as the DeepSeek key', async t => {
  setup(t, { searchKey: 'sk-env', settings: { web_search: { enabled: true, api_key: 'sk-legacy' } } });
  const seen = recordSearchCalls(t);

  await chat({ content: '《潮汐》好看吗？', web_search: true });

  assert.deepEqual(seen, [['https://api.deepseek.com/v1/tools/search', 'Bearer sk-legacy']]);
});

test('the selected provider is searched with its own key and the reply is unchanged', async t => {
  const db = setup(t, {
    searchKey: 'sk-deepseek-env',
    settings: { web_search: { enabled: true, provider: 'tavily', api_keys: { deepseek: 'sk-deepseek', tavily: 'tvly-key' } } },
  });
  const seen = recordSearchCalls(t);

  const { searchEvents } = await chat({ content: '《潮汐》好看吗？', web_search: true });

  assert.deepEqual(seen, [['https://api.tavily.com/search', 'Bearer tvly-key']]);
  assert.deepEqual(searchEvents, [{ status: 'searching' }, { status: 'done', sources: SOURCES }]);
  assert.equal(messageRow(db, 'user').metadata.web_search.summary, SUMMARY);
  assert.ok(chatRequests()[0].messages.at(-1).content.includes(SUMMARY));
});

test('a provider without a key falls back to its own environment variable only', async t => {
  setup(t, { searchKey: 'sk-deepseek-env', settings: { web_search: { enabled: true, provider: 'tavily' } } });
  const seen = recordSearchCalls(t);

  const { searchEvents } = await chat({ content: '《潮汐》好看吗？', web_search: true });

  // DeepSeek 的密钥不会被发往 Tavily
  assert.deepEqual(seen, []);
  assert.equal(searchEvents.at(-1).status, 'failed');

  process.env.TAVILY_API_KEY = 'tvly-env';
  t.after(() => { delete process.env.TAVILY_API_KEY; });
  await chat({ content: '再查一次', web_search: true });
  assert.deepEqual(seen, [['https://api.tavily.com/search', 'Bearer tvly-env']]);
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

test('settings route masks every provider key and keeps them when masks are written back', async t => {
  const db = setup(t, { settings: { web_search: { enabled: true, api_key: 'sk-real', summary_target_chars: 1500, max_rounds: 6 } } });
  const { NextRequest } = require('next/server');
  const { GET, PUT } = require('../src/app/api/settings/route.ts');
  const { API_KEY_MASK } = require('../src/lib/constants.ts');
  const stored = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'web_search'").get().value);
  const put = async webSearch => (await PUT(new NextRequest('http://localhost/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ web_search: webSearch }),
  }))).json();

  const shown = await (await GET(new NextRequest('http://localhost/api/settings'))).json();
  assert.deepEqual(shown.web_search.api_keys, { deepseek: API_KEY_MASK, tavily: '', exa: '' });
  assert.equal(shown.web_search.provider, 'deepseek');
  assert.equal('api_key' in shown.web_search, false);

  // 旧结构在第一次保存时迁移成按来源存的密钥
  const saved = await put({ api_keys: { deepseek: API_KEY_MASK }, summary_target_chars: 3000, max_rounds: 4 });
  assert.deepEqual(saved.web_search.api_keys, { deepseek: API_KEY_MASK, tavily: '', exa: '' });
  assert.deepEqual(stored(), {
    enabled: true, provider: 'deepseek', api_keys: { deepseek: 'sk-real', tavily: '', exa: '' },
    summary_target_chars: 3000, max_rounds: 4,
  });

  // 切换来源并填新来源的密钥：其他来源的密钥（掩码回写或未提交）都保留
  await put({ provider: 'exa', api_keys: { deepseek: API_KEY_MASK, exa: 'exa-key' } });
  assert.equal(stored().provider, 'exa');
  assert.deepEqual(stored().api_keys, { deepseek: 'sk-real', tavily: '', exa: 'exa-key' });
  await put({ api_keys: { tavily: 'tvly-key' } });
  assert.deepEqual(stored().api_keys, { deepseek: 'sk-real', tavily: 'tvly-key', exa: 'exa-key' });

  // 清空某个来源的密钥是真的清空
  await put({ api_keys: { deepseek: '' } });
  assert.deepEqual(stored().api_keys, { deepseek: '', tavily: 'tvly-key', exa: 'exa-key' });

  // 还没刷新的旧页面只提交 api_key：当作 DeepSeek 密钥写入，掩码照旧表示保留
  await put({ api_key: 'sk-from-old-page' });
  assert.deepEqual(stored().api_keys, { deepseek: 'sk-from-old-page', tavily: 'tvly-key', exa: 'exa-key' });
  assert.equal('api_key' in stored(), false);
  await put({ api_key: API_KEY_MASK });
  assert.equal(stored().api_keys.deepseek, 'sk-from-old-page');

  const unknownProvider = await PUT(new NextRequest('http://localhost/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ web_search: { provider: 'bing' } }),
  }));
  assert.equal(unknownProvider.status, 400);

  const rejected = await PUT(new NextRequest('http://localhost/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ web_search: { max_rounds: 0 } }),
  }));
  assert.equal(rejected.status, 400);
});
