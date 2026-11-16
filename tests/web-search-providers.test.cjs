// 联网搜索的各来源：请求形状与响应解析。只在出站边界 safeFetch 截获，不连真实服务。

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const SSRF_GUARD_PATH = require.resolve('../src/lib/ssrf-guard.ts');
const originalLoad = Module._load;
let handler = () => { throw new Error('no upstream handler installed'); };
const calls = [];
const ssrfGuardMock = {
  ...originalLoad.call(Module, SSRF_GUARD_PATH, module, false),
  async safeFetch(url, init = {}) {
    const call = { url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    return handler(call);
  },
};
Module._load = function loadWithMock(request, parent, isMain) {
  if (request.includes('ssrf-guard')) {
    try {
      if (Module._resolveFilename(request, parent, isMain) === SSRF_GUARD_PATH) return ssrfGuardMock;
    } catch { /* fall through */ }
  }
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalLoad; });

const { createWebSearchBackend } = require('../src/lib/search/web-search-backend.ts');
const { runWebSearchLoop } = require('../src/lib/search/web-search-loop.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');

const KEY = 'secret-search-key';
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const install = fn => { calls.length = 0; handler = fn; };

test('deepseek: dates given as Beijing midnight in UTC keep their Beijing day', async () => {
  install(() => json({
    results: [
      { title: 'A', url: 'https://a.example/1', site_name: 'A', date: '2026-11-14T16:00:00+00:00', summary: 'a' },
      { title: 'B', url: 'https://b.example/2', site_name: 'B', date: '2026-11-03', summary: 'b' },
      { title: 'C', url: 'https://c.example/3', site_name: 'C', date: '', summary: 'c' },
      // 没有偏移、或用空格分隔时也按 UTC 换算，不随服务器时区变化
      { title: 'D', url: 'https://d.example/4', site_name: 'D', date: '2026-11-14T16:00:00', summary: 'd' },
      { title: 'E', url: 'https://e.example/5', site_name: 'E', date: '2026-11-14 16:00:00+00:00', summary: 'e' },
    ],
  }));

  const results = await createWebSearchBackend('deepseek', KEY).search('q', 8);

  assert.deepEqual(results.map(result => result.date), ['2026-11-15', '2026-11-03', '', '2026-11-15', '2026-11-15']);
});

test('tavily: search request and result parsing', async () => {
  install(() => json({
    query: 'q',
    results: [
      { title: '影评 A', url: 'https://www.a.example/1', content: '摘要 A', score: 0.9, published_date: 'Mon, 02 Nov 2026 08:00:00 GMT' },
      { title: '影评 B', url: 'https://b.example/2', content: '摘要 B', score: 0.5, published_date: 'not a date' },
      { title: '坏链接', url: 'ftp://c.example/3', content: '不应出现' },
    ],
  }));

  const results = await createWebSearchBackend('tavily', KEY).search('新电影 评价', 8);

  assert.deepEqual(calls.map(call => [call.url, call.method, call.headers.Authorization, call.body]), [
    ['https://api.tavily.com/search', 'POST', `Bearer ${KEY}`, { query: '新电影 评价', max_results: 8 }],
  ]);
  assert.deepEqual(results, [
    { title: '影评 A', url: 'https://www.a.example/1', site: 'a.example', date: '2026-11-02', summary: '摘要 A' },
    { title: '影评 B', url: 'https://b.example/2', site: 'b.example', date: '', summary: '摘要 B' },
  ]);
});

test('tavily: extract returns the page and reports failed urls', async () => {
  const backend = createWebSearchBackend('tavily', KEY);
  install(() => json({ results: [{ url: 'https://b.example/2', raw_content: '前言\n\n## 影评 B\n\n正文' }], failed_results: [] }));

  assert.deepEqual(await backend.fetchPage('https://b.example/2'), { title: '影评 B', content: '前言\n\n## 影评 B\n\n正文' });
  assert.deepEqual(calls[0].body, { urls: ['https://b.example/2'], format: 'markdown' });
  assert.equal(calls[0].url, 'https://api.tavily.com/extract');

  // HTTP 200 但全部失败
  install(() => json({ results: [], failed_results: [{ url: 'https://b.example/2', error: 'blocked by robots' }] }));
  await assert.rejects(backend.fetchPage('https://b.example/2'), /Tavily extract failed: blocked by robots/);
});

test('exa: search request and result parsing', async () => {
  install(() => json({
    results: [
      { id: '1', title: '影评 A', url: 'https://a.example/1', publishedDate: '2026-11-03T00:00:00.000Z', highlights: ['第一句', ' ', '第二句'] },
      { id: '2', title: '影评 B', url: 'https://www.b.example/2', publishedDate: null, highlights: [], summary: 'B 的摘要' },
      { id: '3', title: '坏链接', url: 'javascript:alert(1)' },
    ],
  }));

  const results = await createWebSearchBackend('exa', KEY).search('新电影 评价', 8);

  assert.deepEqual(calls.map(call => [call.url, call.headers['x-api-key'], call.body]), [
    ['https://api.exa.ai/search', KEY, { query: '新电影 评价', numResults: 8, contents: { highlights: true } }],
  ]);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.deepEqual(results, [
    { title: '影评 A', url: 'https://a.example/1', site: 'a.example', date: '2026-11-03', summary: '第一句 … 第二句' },
    { title: '影评 B', url: 'https://www.b.example/2', site: 'b.example', date: '', summary: 'B 的摘要' },
  ]);
});

test('exa: contents returns the page and reports crawl errors', async () => {
  const backend = createWebSearchBackend('exa', KEY);
  install(() => json({
    results: [{ url: 'https://a.example/1', title: '影评 A', text: 'A 的正文' }],
    statuses: [{ id: 'https://a.example/1', status: 'success', source: 'cached' }],
  }));

  assert.deepEqual(await backend.fetchPage('https://a.example/1'), { title: '影评 A', content: 'A 的正文' });
  assert.deepEqual(calls[0].body, { urls: ['https://a.example/1'], text: true });
  assert.equal(calls[0].url, 'https://api.exa.ai/contents');

  install(() => json({
    results: [],
    statuses: [{ id: 'https://a.example/1', status: 'error', error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 } }],
  }));
  await assert.rejects(backend.fetchPage('https://a.example/1'), /Exa contents failed: CRAWL_NOT_FOUND/);

  install(() => json({ results: [], statuses: [] }));
  await assert.rejects(backend.fetchPage('https://a.example/1'), /no content returned/);
});

test('every provider strips its key from upstream errors', async () => {
  for (const provider of ['deepseek', 'tavily', 'exa']) {
    install(() => json({ detail: { error: `invalid key ${KEY}` } }, 401));
    await assert.rejects(createWebSearchBackend(provider, KEY).search('q', 8), error => {
      assert.match(error.message, /API error 401/);
      assert.doesNotMatch(error.message, new RegExp(KEY));
      return true;
    });
  }
});

test('the loop behaves the same whichever provider serves the results', async () => {
  const LLM = { ...DEFAULT_SETTINGS, api_base: 'http://llm.test/v1', api_key: 'llm-key', model: 'bg-model' };
  const llmReply = message => json({ choices: [{ finish_reason: 'stop', message }] });
  const toolCall = (name, args) => llmReply({
    content: '', tool_calls: [{ id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  const searchReplies = {
    deepseek: () => json({ results: [
      { title: '影评 A', url: 'https://a.example/1', site_name: 'a.example', date: '', summary: '摘要 A' },
      { title: '影评 B', url: 'https://b.example/2', site_name: 'b.example', date: '', summary: '摘要 B' },
    ] }),
    tavily: () => json({ results: [
      { title: '影评 A', url: 'https://a.example/1', content: '摘要 A' },
      { title: '影评 B', url: 'https://b.example/2', content: '摘要 B' },
    ] }),
    exa: () => json({ results: [
      { title: '影评 A', url: 'https://a.example/1', highlights: ['摘要 A'] },
      { title: '影评 B', url: 'https://b.example/2', highlights: ['摘要 B'] },
    ] }),
  };
  const pageReplies = {
    deepseek: () => json({ title: '影评 B', content: 'B 的正文' }),
    tavily: () => json({ results: [{ url: 'https://b.example/2', raw_content: 'B 的正文' }], failed_results: [] }),
    exa: () => json({ results: [{ url: 'https://b.example/2', title: '影评 B', text: 'B 的正文' }], statuses: [{ status: 'success' }] }),
  };

  const outcomes = [];
  for (const provider of ['deepseek', 'tavily', 'exa']) {
    const llmScript = [
      toolCall('search_web', { query: '新电影 评价' }),
      toolCall('fetch_url', { id: 2 }),
      llmReply({ content: '口碑不错。\nSOURCES: 2' }),
    ];
    let llmIndex = 0;
    install(call => {
      if (call.url.startsWith('http://llm.test/')) return llmScript[llmIndex++];
      return /search$/.test(call.url) ? searchReplies[provider]() : pageReplies[provider]();
    });

    const data = await runWebSearchLoop({
      llm: LLM,
      backend: createWebSearchBackend(provider, KEY),
      conversationText: '用户: 那部新电影好看吗？',
      nowText: '2026-11-15 Sun 06:50',
      summaryTargetChars: 1500,
      maxRounds: 6,
    });
    const llmCalls = calls.filter(call => call.url.startsWith('http://llm.test/'));
    const toolMessages = llmCalls.at(-1).body.messages.filter(message => message.role === 'tool').map(message => message.content);
    outcomes.push({ summary: data.summary, sources: data.sources, queries: data.queries, readPage: toolMessages[1] });
  }

  for (const outcome of outcomes) {
    assert.deepEqual(outcome, {
      summary: '口碑不错。',
      sources: [{ title: '影评 B', url: 'https://b.example/2' }],
      queries: ['新电影 评价'],
      readPage: 'B 的正文',
    });
  }
});
