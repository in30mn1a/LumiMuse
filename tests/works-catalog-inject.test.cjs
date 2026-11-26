// 作品片单的聊天注入：驱动真实 runChat，只在出站边界 ssrf-guard.safeFetch 截获请求。
// 数据库用 :memory: 并通过 __setDbForTests 注入单例；时钟固定，保证有无片单两次运行可以逐字节比较。
//
// 锁住的不变量：
//   - 全量、检索两种记忆模式下，片单都在 system 的记忆槽位之后、## 行为要求 之前；
//   - 片单不经过记忆检索：有无片单时检索结果（入选记忆、记忆包文本、token 数）完全相同；
//   - 去掉片单这一段后，请求与没有片单时逐字节相同（空片单 / 条目都已移除时一个字节都不加）；
//   - memory_inject 关闭时不注入片单；重新生成 / 插入历史回复按 first_seen_at 截断；
//   - assistant 消息 metadata 写入 last_works_catalog_injection。

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader({ jsx: true });
require.extensions['.tsx'] = require.extensions['.ts'];

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { createWork, updateWork, loadWorksCatalogText } = require('../src/lib/works-catalog.ts');
const { estimateTokens } = require('../src/lib/token-counter.ts');
const { loadSettings } = require('../src/lib/settings.ts');
const memoryRetrieval = require('../src/lib/memory-retrieval.ts');
const ssrfGuard = require('../src/lib/ssrf-guard.ts');
const { runChat } = require('../src/lib/chat-engine.ts');

const CHAR_ID = 'char-works';
const CONV_ID = 'conv-works';
const NOW_ISO = '2026-11-01T13:37:05.000Z';
const CATALOG_HEADING = '## 用户的作品清单';

const HISTORY = [
  { id: 'msg-1', role: 'assistant', content: '欢迎回来。', created_at: '2026-10-01T10:00:00.000Z' },
  { id: 'msg-2', role: 'user', content: '昨晚把《她》看完了。', created_at: '2026-10-01T10:01:00.000Z' },
  { id: 'msg-3', role: 'assistant', content: '结尾那段好安静呢。', created_at: '2026-10-01T10:02:00.000Z' },
  { id: 'msg-4', role: 'user', content: '最近在追《黑镜》。', created_at: '2026-10-20T10:00:00.000Z' },
  { id: 'msg-5', role: 'assistant', content: '第二季那集我也记得。', created_at: '2026-10-20T10:01:00.000Z' },
];

const MEMORIES = [
  { id: 'mem-fixed', kind: 'user_fact', importance: 0.95, pinned: 1, content: '用户的名字叫阿遥，在城里做插画师。' },
  { id: 'mem-pref', kind: 'user_preference', importance: 0.65, pinned: 0, content: '用户喜欢喝不加糖的桂花乌龙。' },
  { id: 'mem-general', kind: 'general', importance: 0.4, pinned: 0, content: '用户提过想养一只橘猫。' },
];

// 第一部在所有历史消息之前出现，第二部在 msg-3 与 msg-4 之间，第三部已被主人移除
const WORKS = [
  { work_type: 'movie', title: '她', status: 'watched', rating: '9', first_seen_at: '2026-09-15T00:00:00.000Z' },
  { work_type: 'series', title: '黑镜', status: 'watching', progress: '第二季第 2 集', first_seen_at: '2026-10-10T00:00:00.000Z' },
  { work_type: 'book', title: '已移除的书', status: 'want', first_seen_at: '2026-09-01T00:00:00.000Z', dismissed: true },
];

function seed(t, { mode = 'full', works = [] } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  // 只关连接、不清空单例：遗留的异步访问会直接报错，而不是回落去打开真实数据库
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO characters (id, name, basic_info, personality, memory_chat_injection_mode, created_at, updated_at)
    VALUES (?, '星野澪', '旧书店店主', '安静、细心', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  `).run(CHAR_ID, mode);
  db.prepare(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES (?, ?, '片单', '2026-10-01T10:00:00.000Z', '2026-10-20T10:01:00.000Z')
  `).run(CONV_ID, CHAR_ID);
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, ?, ?, ?, 0, ?, ?, '{}')
  `);
  HISTORY.forEach((message, index) => {
    insertMessage.run(message.id, CONV_ID, message.role, message.content, message.created_at, index + 1);
  });
  const insertMemory = db.prepare(`
    INSERT INTO memories (id, character_id, category, content, memory_kind, importance, pinned, status, created_at, updated_at)
    VALUES (?, ?, '话题历史', ?, ?, ?, ?, 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  `);
  for (const memory of MEMORIES) {
    insertMemory.run(memory.id, CHAR_ID, memory.content, memory.kind, memory.importance, memory.pinned);
  }
  for (const { dismissed, ...work } of works) {
    const created = createWork(db, { character_id: CHAR_ID, ...work }, work.first_seen_at);
    if (dismissed) updateWork(db, created.id, { dismissed: true }, work.first_seen_at);
  }
  return db;
}

/** 跑一轮 runChat，返回上游请求体、检索结果与本轮 assistant 消息的 metadata。 */
async function chatOnce(t, db, { settings = {}, userContent = '今晚想看点什么？', options } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW_ISO) });
  const requests = [];
  t.mock.method(ssrfGuard, 'safeFetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '那就从想看的里面挑一部吧。' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const retrievals = [];
  const originalRetrieve = memoryRetrieval.retrieveWorkingMemoryPackage;
  t.mock.method(memoryRetrieval, 'retrieveWorkingMemoryPackage', async (...args) => {
    const result = await originalRetrieve(...args);
    retrievals.push({
      budget: args[0].settings.memory_engine.memory_package_token_budget,
      mode: result.mode,
      text: result.text,
      tokenCount: result.tokenCount,
      selected: result.selectedMemories.map(memory => memory.id),
    });
    return result;
  });

  const errors = [];
  await runChat(CONV_ID, userContent, {
    ...loadSettings(),
    api_base: 'https://upstream.test/v1',
    api_key: 'test-key',
    model: 'test-model',
    streaming: false,
    ...settings,
  }, {
    onChunk() {},
    onDone() {},
    onError(error) { errors.push(error.message); },
  }, options);

  t.mock.restoreAll();
  t.mock.timers.reset();
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 1, 'expected exactly one upstream request');

  const targetId = options?.regenerateAssistantId;
  const row = targetId
    ? db.prepare('SELECT metadata FROM messages WHERE id = ?').get(targetId)
    : db.prepare("SELECT metadata FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1").get(CONV_ID);
  return { body: requests[0], retrievals, meta: JSON.parse(row.metadata) };
}

function lastUserText(body) {
  const last = body.messages.findLast(message => message.role === 'user');
  return typeof last.content === 'string' ? last.content : last.content.map(part => part.text || '').join('');
}

for (const mode of ['full', 'local']) {
  test(`${mode} 模式：片单在 system 的记忆槽位之后，检索结果与没有片单时完全相同`, async t => {
    const withDb = seed(t, { mode, works: WORKS });
    const catalog = loadWorksCatalogText(withDb, CHAR_ID);
    assert.equal(catalog.count, 2, '已移除条目不进片单');
    const withCatalog = await chatOnce(t, withDb);

    const without = await chatOnce(t, seed(t, { mode }));

    // 片单不经过记忆检索：入选记忆、记忆包文本、预算都不变
    assert.equal(withCatalog.retrievals.length, 1);
    assert.deepEqual(withCatalog.retrievals, without.retrievals);
    assert.ok(withCatalog.retrievals[0].selected.length > 0, '样本必须有入选记忆，否则比较没有意义');
    assert.equal(withCatalog.retrievals[0].mode, mode);
    assert.deepEqual(withCatalog.meta.last_memory_injection, without.meta.last_memory_injection);

    // 片单固定在 system：记忆槽位之后、## 行为要求 之前
    const system = withCatalog.body.messages[0].content;
    assert.equal(withCatalog.body.messages[0].role, 'system');
    assert.ok(system.includes(`${catalog.text}\n\n## 行为要求`), '片单必须紧挨在 ## 行为要求 之前');
    assert.equal(system.split(CATALOG_HEADING).length - 1, 1, '片单只出现一次');
    assert.doesNotMatch(system, /已移除的书/);
    if (mode === 'full') {
      assert.ok(system.indexOf('阿遥') < system.indexOf(CATALOG_HEADING), '全量记忆在片单之前');
    } else {
      assert.doesNotMatch(system, /阿遥/, '检索模式的记忆不在 system');
      assert.match(lastUserText(withCatalog.body), /阿遥/, '检索模式的记忆在尾部块');
    }
    assert.ok(!lastUserText(withCatalog.body).includes(CATALOG_HEADING), '片单不得进尾部块');

    // 去掉片单这一段，请求与没有片单时逐字节相同
    const stripped = structuredClone(withCatalog.body);
    stripped.messages[0].content = system.replace(`${catalog.text}\n\n`, '');
    assert.equal(JSON.stringify(stripped), JSON.stringify(without.body));

    // 注入统计写进 assistant 消息 metadata
    assert.deepEqual(withCatalog.meta.last_works_catalog_injection, {
      count: 2,
      tokens: estimateTokens(catalog.text),
    });
    assert.equal(without.meta.last_works_catalog_injection, undefined);
  });
}

test('条目都已移除时请求与没有片单时逐字节相同，也不写注入统计', async t => {
  const dismissedOnly = seed(t, { works: WORKS.filter(work => work.dismissed) });
  const withDismissed = await chatOnce(t, dismissedOnly);
  const without = await chatOnce(t, seed(t));

  assert.equal(JSON.stringify(withDismissed.body), JSON.stringify(without.body));
  assert.equal(withDismissed.meta.last_works_catalog_injection, undefined);
});

test('memory_inject 关闭时不注入片单，也不写注入统计', async t => {
  const db = seed(t, { works: WORKS });
  const result = await chatOnce(t, db, { settings: { memory_inject: false } });

  assert.ok(!JSON.stringify(result.body).includes(CATALOG_HEADING));
  assert.equal(result.retrievals.length, 0);
  assert.equal(result.meta.last_works_catalog_injection, undefined);
  assert.equal(result.meta.last_memory_injection, undefined);
});

test('重新生成历史回复时片单按 first_seen_at 截断，并覆盖旧的注入统计', async t => {
  const db = seed(t, { works: WORKS });
  // 目标消息上残留着旧版本的统计，本轮必须按截断后的片单重写
  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ last_works_catalog_injection: { count: 99, tokens: 999 } }), 'msg-3');
  const result = await chatOnce(t, db, {
    userContent: '',
    options: { regenerateAssistantId: 'msg-3', skipUserInsert: true },
  });

  const system = result.body.messages[0].content;
  assert.match(system, /《她》/, '目标消息之前就有的作品照常注入');
  assert.doesNotMatch(system, /黑镜/, '目标消息之后才出现的作品不得「预知」');
  const expected = loadWorksCatalogText(db, CHAR_ID, { cutoff: HISTORY[2].created_at });
  assert.equal(expected.count, 1);
  assert.ok(system.includes(`${expected.text}\n\n## 行为要求`));
  assert.deepEqual(result.meta.last_works_catalog_injection, {
    count: 1,
    tokens: estimateTokens(expected.text),
  });
});

test('插入历史回复时片单按锚点 user 消息的时间截断', async t => {
  const db = seed(t, { works: WORKS });
  const result = await chatOnce(t, db, {
    userContent: '',
    options: { insertAssistantAfterUserId: 'msg-2', skipUserInsert: true },
  });

  const system = result.body.messages[0].content;
  assert.match(system, /《她》/);
  assert.doesNotMatch(system, /黑镜/);
});

test('first_seen_at 恰好等于截止时刻：重新生成不含（严格早于），插入回复含锚点时刻', async t => {
  // 片单条目的 first_seen_at 取提取批次最后一条消息的时间，正好可能是被重新生成的那条回复
  const works = [
    { work_type: 'movie', title: '她', status: 'watched', first_seen_at: HISTORY[1].created_at },
    { work_type: 'series', title: '黑镜', status: 'watching', first_seen_at: HISTORY[2].created_at },
  ];

  const regenerated = await chatOnce(t, seed(t, { works }), {
    userContent: '',
    options: { regenerateAssistantId: 'msg-3', skipUserInsert: true },
  });
  const regenSystem = regenerated.body.messages[0].content;
  assert.match(regenSystem, /《她》/);
  assert.doesNotMatch(regenSystem, /黑镜/, '从被重新生成的回复里才得知的作品不能出现');
  assert.equal(regenerated.meta.last_works_catalog_injection.count, 1);

  const inserted = await chatOnce(t, seed(t, { works }), {
    userContent: '',
    options: { insertAssistantAfterUserId: 'msg-2', skipUserInsert: true },
  });
  const insertSystem = inserted.body.messages[0].content;
  assert.match(insertSystem, /《她》/, '锚点 user 消息里提到的作品照常注入');
  assert.doesNotMatch(insertSystem, /黑镜/);
});

test('重新生成时截断后没有作品：不注入片单，并清掉旧版本留下的统计', async t => {
  const db = seed(t, { works: WORKS.filter(work => work.title === '黑镜') });
  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ last_works_catalog_injection: { count: 99, tokens: 999 } }), 'msg-3');
  const result = await chatOnce(t, db, {
    userContent: '',
    options: { regenerateAssistantId: 'msg-3', skipUserInsert: true },
  });

  assert.ok(!JSON.stringify(result.body).includes(CATALOG_HEADING));
  assert.equal(result.meta.last_works_catalog_injection, undefined);
});

test('上下文明细弹窗显示片单上一轮的实际占用', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const i18n = require('../src/lib/i18n.ts');
  const mocks = {
    '@/components/ui/Modal': { __esModule: true, default: ({ open, children }) => (open ? React.createElement('section', null, children) : null) },
    '@/lib/i18n-context': { useTranslation: () => ({ t: key => i18n.t(key, 'zh') }) },
  };
  const originalLoad = Module._load;
  Module._load = function loadMocked(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  let TokenBreakdownModal;
  try {
    TokenBreakdownModal = require('../src/components/chat/TokenBreakdownModal.tsx').default;
  } finally {
    Module._load = originalLoad;
  }

  const items = [
    { labelKey: 'token.memories', tokens: 120 },
    { labelKey: 'token.worksCatalog', tokens: 86 },
    { labelKey: 'token.messages', tokens: 300 },
  ];
  const html = renderToStaticMarkup(React.createElement(TokenBreakdownModal, {
    open: true,
    onClose() {},
    items,
    lastWorksCatalogInjection: { count: 2, tokens: 86 },
  }));
  assert.ok(html.includes('作品片单'), '明细里有片单一行');
  assert.ok(html.includes('上轮注入 2 部 · 86 token'), '显示片单上一轮实际注入的条数与 token 数');

  const withoutInjection = renderToStaticMarkup(React.createElement(TokenBreakdownModal, {
    open: true,
    onClose() {},
    items,
    lastWorksCatalogInjection: null,
  }));
  assert.ok(!withoutInjection.includes('上轮注入 2 部'), '没有注入统计时不显示占用说明');
});
