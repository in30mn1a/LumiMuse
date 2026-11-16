// 联网搜索的后台工具循环：假上游（后台 LLM + DeepSeek 搜索接口），只在出站边界 safeFetch 截获。

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
    const call = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
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

const { runWebSearchLoop } = require('../src/lib/search/web-search-loop.ts');
const { createWebSearchBackend } = require('../src/lib/search/web-search-backend.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');

const SEARCH_KEY = 'sk-search-secret';
const LLM = { ...DEFAULT_SETTINGS, api_base: 'http://llm.test/v1', api_key: 'llm-key', model: 'bg-model' };

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const llmToolCall = (...toolCalls) => json({
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      content: '',
      reasoning_content: 'thinking',
      tool_calls: toolCalls.map(([name, args], index) => ({
        id: `call-${name}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
      })),
    },
  }],
});
const llmText = text => json({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
const searchResults = (...items) => json({
  results: items.map(([title, url, summary]) => ({
    title, url, site_name: 'Site', date: '2026-11-01T00:00:00+00:00', summary, snippet: '', content: '',
  })),
});

/** 按顺序应答后台 LLM；搜索/抓取接口按 URL 分流。 */
function install({ llm, search, fetch }) {
  calls.length = 0;
  let llmIndex = 0;
  handler = call => {
    if (call.url === 'https://api.deepseek.com/v1/tools/search') return search(call);
    if (call.url === 'https://api.deepseek.com/v1/tools/fetch') return fetch(call);
    assert.equal(call.url, 'http://llm.test/v1/chat/completions');
    const next = llm[Math.min(llmIndex, llm.length - 1)];
    llmIndex += 1;
    return typeof next === 'function' ? next(call) : next;
  };
}

const run = (overrides = {}) => runWebSearchLoop({
  llm: LLM,
  backend: createWebSearchBackend('deepseek', SEARCH_KEY),
  conversationText: '用户: 我叫阿遥，那部新电影好看吗？',
  nowText: '2026-11-15 Sun 06:50',
  summaryTargetChars: 1500,
  maxRounds: 6,
  ...overrides,
});

const llmCalls = () => calls.filter(call => call.url.startsWith('http://llm.test'));
const searchApiCalls = () => calls.filter(call => call.url.startsWith('https://api.deepseek.com'));

test('searches, reads a page, and returns the summary with only the cited sources', async () => {
  install({
    llm: [
      llmToolCall(['search_web', { query: '新电影 评价' }]),
      llmToolCall(['fetch_url', { id: 2 }]),
      llmText('这部电影口碑不错。\nSOURCES: 2, 9\n'),
    ],
    search: () => searchResults(
      ['影评 A - 影评 A', 'https://a.example/1', '摘要 A'],
      ['影评 B', 'https://b.example/2', '摘要 B'],
      ['坏链接', 'javascript:alert(1)', '不应出现'],
    ),
    fetch: () => json({ title: '影评 B', content: 'B 的正文' }),
  });

  const data = await run();

  assert.equal(data.summary, '这部电影口碑不错。');
  // 9 不是已有编号，被忽略；没被引用的 1 不进来源
  assert.deepEqual(data.sources, [{ title: '影评 B', url: 'https://b.example/2' }]);
  assert.deepEqual(data.queries, ['新电影 评价']);

  // 发往搜索服务的只有查询词和网址，不带对话原文
  assert.deepEqual(searchApiCalls().map(call => call.body), [
    { query: '新电影 评价', count: 8, need_content: false },
    { url: 'https://b.example/2' },
  ]);
  assert.equal(searchApiCalls()[0].headers.Authorization, `Bearer ${SEARCH_KEY}`);

  // 工具结果回灌：非 http 链接被丢弃，重复标题被整理，上游的思考字段原样带回
  const finalMessages = llmCalls()[2].body.messages;
  const toolMessages = finalMessages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.match(toolMessages[0].content, /^\[1\] 影评 A \| Site \| 2026-11-01\n摘要 A\n\n\[2\] 影评 B/);
  assert.doesNotMatch(toolMessages[0].content, /坏链接|javascript/);
  assert.equal(toolMessages[1].content, 'B 的正文');
  assert.equal(finalMessages.find(message => message.role === 'assistant').reasoning_content, 'thinking');
});

test('pages through long content with start_index', async () => {
  const body = 'x'.repeat(10_000) + 'TAIL';
  install({
    llm: [
      llmToolCall(['search_web', { query: 'q' }]),
      llmToolCall(['fetch_url', { id: 1 }]),
      llmToolCall(['fetch_url', { id: 1, start_index: 10_000 }]),
      llmText('摘要\nSOURCES: 1'),
    ],
    search: () => searchResults(['T', 'https://t.example/', 's']),
    fetch: () => json({ title: 'T', content: body }),
  });

  await run();

  const toolMessages = llmCalls()[3].body.messages.filter(message => message.role === 'tool');
  assert.ok(toolMessages[1].content.endsWith('[正文未完，next_start_index=10000]'));
  assert.equal(toolMessages[2].content, 'TAIL');
  // 同一页只抓一次
  assert.equal(searchApiCalls().filter(call => call.url.endsWith('/fetch')).length, 1);
});

test('stops calling tools at the round limit and writes the summary from what it found', async () => {
  install({
    llm: [call => (call.body.tools
      ? llmToolCall(['search_web', { query: `q${call.body.messages.length}` }])
      : llmText('基于已有资料的摘要'))],
    search: () => searchResults(['T', 'https://t.example/', '搜索摘要正文']),
    fetch: () => json({ title: '', content: '' }),
  });

  const data = await run({ maxRounds: 2 });

  assert.equal(llmCalls().length, 3);
  // 收尾请求不带工具、也没有工具历史，查到的内容平铺在一条消息里
  const synthesis = llmCalls()[2].body;
  assert.equal(synthesis.tools, undefined);
  assert.equal(synthesis.tool_choice, undefined);
  assert.deepEqual(synthesis.messages.map(message => message.role), ['user']);
  assert.match(synthesis.messages[0].content, /<search_results>\n\[1\] T \| Site \| 2026-11-01\n搜索摘要正文/);
  assert.equal(data.summary, '基于已有资料的摘要');
  assert.equal(data.queries.length, 2);
  // 模型没列来源、也没读正文：回退为靠前的搜索结果
  assert.deepEqual(data.sources, [{ title: 'T', url: 'https://t.example/' }]);
});

test('falls back to the pages it read when the model lists no sources', async () => {
  install({
    llm: [
      llmToolCall(['search_web', { query: 'q' }]),
      llmToolCall(['fetch_url', { id: 2 }]),
      llmText('没有来源行的摘要'),
    ],
    search: () => searchResults(['A', 'https://a.example/', 's'], ['B', 'https://b.example/', 's']),
    fetch: () => json({ title: 'B', content: '正文' }),
  });

  const data = await run();

  assert.deepEqual(data.sources, [{ title: 'B', url: 'https://b.example/' }]);
});

// 2026-11-15 实测：deepseek-v4.1-flash 收尾时把工具调用写成 DSML 文本，原样当成了摘要。
test('a tool call leaked into the text is not used as the summary', async () => {
  const leaked = '<｜DSML｜ calls>\n<｜DSML｜ invoke name="search_web">\n<｜DSML｜ parameter name="query" string="true">S16 决赛</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';
  install({
    llm: [
      llmToolCall(['search_web', { query: 'S16 决赛' }]),
      llmText(leaked),
      llmText('决赛前三局 BLG 2:1 领先，最终结果尚未查到。\nSOURCES: 1'),
    ],
    search: () => searchResults(['战报', 'https://news.example/s16', 'BLG 2:1']),
    fetch: () => json({}),
  });

  const data = await run();

  assert.equal(llmCalls().length, 3);
  assert.equal(llmCalls()[2].body.tools, undefined);
  assert.equal(data.summary, '决赛前三局 BLG 2:1 领先，最终结果尚未查到。');
  assert.deepEqual(data.sources, [{ title: '战报', url: 'https://news.example/s16' }]);
});

test('fails instead of passing leaked tool-call text to the character', async () => {
  const leaked = '<｜DSML｜ calls>\n<｜DSML｜ invoke name="search_web"></｜DSML｜ invoke>';
  install({
    llm: [llmToolCall(['search_web', { query: 'q' }]), () => llmText(leaked)],
    search: () => searchResults(['T', 'https://t.example/', 's']),
    fetch: () => json({}),
  });

  await assert.rejects(run(), /没有返回资料摘要/);
});

test('a failed tool call goes back to the model instead of aborting the search', async () => {
  let searchCount = 0;
  install({
    llm: [
      llmToolCall(['search_web', { query: 'first' }]),
      llmToolCall(['search_web', { query: 'second' }]),
      llmText('摘要\nSOURCES: 1'),
    ],
    search: () => {
      searchCount += 1;
      return searchCount === 1
        ? json({ error: { message: `rate limited for ${SEARCH_KEY}` } }, 429)
        : searchResults(['T', 'https://t.example/', 's']);
    },
    fetch: () => json({}),
  });

  const data = await run();

  const firstToolResult = llmCalls()[1].body.messages.find(message => message.role === 'tool').content;
  assert.match(firstToolResult, /^错误：DeepSeek API error 429/);
  assert.doesNotMatch(firstToolResult, new RegExp(SEARCH_KEY));
  assert.equal(data.summary, '摘要');
});

test('fails when nothing was found, reporting the search error without the key', async () => {
  install({
    llm: [llmToolCall(['search_web', { query: 'q' }]), llmText('凭记忆写的内容')],
    search: () => json({ error: { message: `invalid key ${SEARCH_KEY}` } }, 401),
    fetch: () => json({}),
  });

  await assert.rejects(run(), error => {
    assert.match(error.message, /DeepSeek API error 401/);
    assert.doesNotMatch(error.message, new RegExp(SEARCH_KEY));
    return true;
  });
});

test('fails when the model answers without searching', async () => {
  install({ llm: [llmText('我直接回答')], search: () => searchResults(), fetch: () => json({}) });

  await assert.rejects(run(), /没有执行搜索/);
});
