const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader({ jsx: true });
require.extensions['.tsx'] = require.extensions['.ts'];
const dbModule = require('../src/lib/db.ts');
const { serializeTypedMessages } = require('../src/lib/messages.ts');
const messagesRoute = require('../src/app/api/messages/route.ts');

let db;
test.beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  dbModule.__migrateForTests(db);
  dbModule.__setDbForTests(db);
  db.prepare("INSERT INTO characters(id,name) VALUES('char','Alice')").run();
  db.prepare("INSERT INTO conversations(id,character_id,title) VALUES('conv','char','Test')").run();
});
test.afterEach(() => dbModule.__resetDbForTests());

function add(id, seq, tokens, metadata = {}, conversationId = 'conv') {
  db.prepare('INSERT INTO messages(id,conversation_id,role,content,seq,token_count,metadata) VALUES(?,?,?,?,?,?,?)')
    .run(id, conversationId, metadata.isSummary ? 'system' : 'user', id, seq, tokens, JSON.stringify(metadata));
}
function summary(ids) {
  return { isSummary: true, summaryCoverageVersion: 1, summarizedIds: ids };
}
async function page(query = 'limit=80') {
  const response = await messagesRoute.GET({ nextUrl: new URL(`http://test/api/messages?conversation_id=conv&${query}`) });
  assert.equal(response.status, 200);
  return response.json();
}
function allMessages() {
  return serializeTypedMessages(db.prepare('SELECT * FROM messages ORDER BY seq').all());
}

// 实际渲染 ChatView，只有它的加载 Hook 和子视图被隔离；统计 useMemo 与传给工具栏的值保持真实。
function renderTokenCount(messages, serverTotalTokens = null) {
  const originalLoad = Module._load;
  const noop = () => {};
  const Empty = () => null;
  const hooks = {
    useConversationLoader: () => ({ conversations: [], memories: [], activeConvId: 'conv',
      activeConvIdRef: { current: 'conv' }, characterRef: { current: { id: 'char' } } }),
    useChatStreaming: () => ({ activeStreams: new Set(), activeStreamsRef: { current: new Set() } }),
    useMessagePaging: () => ({ messages, visibleMessages: messages, messagesRef: { current: messages }, serverTotalTokens }),
    useNewChat: () => ({}),
    useChatScrollController: () => ({}),
    useMemoryTaskPolling: () => ({}),
    useChatImageGeneration: () => ({}),
    useChatMessageActions: () => ({}),
  };
  Module._load = function(request, parent, isMain) {
    if (request === 'next/dynamic') return { __esModule: true, default: () => Empty };
    if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t: key => key }) };
    if (request === '@/components/ui/Toast') return { useToast: () => ({ showToast: noop }) };
    if (request === './ChatToolbar') return { __esModule: true,
      default: props => React.createElement('output', null, props.tokenCount) };
    // 状态条经 ChatHeader 的 status 插槽渲染
    if (request === './ChatHeader') return { __esModule: true, default: props => props.status ?? null };
    if (request.startsWith('@/hooks/chat/')) {
      const name = request.split('/').at(-1);
      if (hooks[name]) return { [name]: hooks[name] };
    }
    if (parent?.filename.endsWith('ChatView.tsx') && request.startsWith('./')) {
      return { __esModule: true, default: Empty, ConversationDrawer: Empty };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const filename = require.resolve('../src/components/chat/ChatView.tsx');
    delete require.cache[filename];
    const ChatView = require(filename).default;
    const rendered = renderToStaticMarkup(React.createElement(ChatView, {
      character: { id: 'char', name: 'Alice' }, conversationId: 'conv',
    }));
    return Number(rendered.match(/<output>(\d+)<\/output>/)?.[1]);
  } finally {
    Module._load = originalLoad;
  }
}

test('总结生成期间的新消息在服务端总量和真实 ChatView 中保留', async () => {
  add('covered-user', 1, 100);
  add('covered-assistant', 2, 100);
  add('during-user', 3, 250);
  add('during-assistant', 4, 250);
  add('summary', 5, 2, summary(['covered-user', 'covered-assistant']));
  const result = await page();
  assert.equal(result.totalTokens, 502);
  assert.equal(renderTokenCount(allMessages()), 502);
});

test('跨页总结和并发消息的服务端统计不会随旧页重复或丢失', async () => {
  add('covered', 1, 100);
  add('during', 2, 250);
  add('summary', 3, 2, summary(['covered']));
  add('after-1', 4, 20);
  add('after-2', 5, 30);
  const first = await page('limit=2');
  assert.equal(first.totalTokens, 302);
  assert.equal(first.hasMore, true);
  const server = { convId: 'conv', value: first.totalTokens };
  assert.equal(renderTokenCount(first.messages, server), 302);
  const older = await page(`limit=2&before_seq=${first.oldestSeq}`);
  assert.equal(Object.hasOwn(older, 'totalTokens'), false);
  assert.equal(renderTokenCount([...older.messages, ...first.messages], server), 302);
  assert.equal(renderTokenCount(allMessages(), server), 302);
});

test('只采用 seq 最新总结的覆盖集合，不计旧总结或已覆盖的晚序号消息', async () => {
  add('first', 1, 100);
  add('old-summary', 2, 500, summary(['first']));
  add('during', 3, 30);
  add('latest-summary', 4, 10, summary(['first', 'old-summary', 'covered-late']));
  add('covered-late', 5, 100);
  assert.equal((await page()).totalTokens, 40);
  // 输入顺序不作为总结新旧依据（独立会话可以带历史导入时间戳）。
  const rows = allMessages();
  assert.equal(renderTokenCount([rows[0], rows[3], rows[2], rows[4], rows[1]]), 40);
});

test('旧总结沿用 seq 边界，即使已有旧版单批 summarizedIds', async () => {
  add('before', 1, 100);
  add('legacy-summary', 2, 10, { isSummary: true, summarizedIds: [] });
  add('after', 3, 20);
  assert.equal((await page()).totalTokens, 30);
  const rows = allMessages();
  assert.equal(renderTokenCount([rows[2], rows[0], rows[1]]), 30);
});

test('无总结时保留全量统计，并忽略其他会话的服务端缓存', async () => {
  add('one', 1, 10);
  add('two', 2, 20);
  assert.equal((await page()).totalTokens, 30);
  assert.equal(renderTokenCount(allMessages(), { convId: 'other', value: 999 }), 30);
  assert.equal(renderTokenCount(allMessages(), { convId: 'conv', value: 15 }), 30);
});

test('关联会话只统计继承范围内的未覆盖消息', async () => {
  db.prepare("INSERT INTO conversations(id,character_id,title,parent_id,parent_seq_end) VALUES('child','char','Child','conv',3)").run();
  add('covered', 1, 100);
  add('during', 2, 20);
  add('summary', 3, 10, summary(['covered']));
  add('outside', 4, 999);
  add('child-new', 4, 30, {}, 'child');
  const response = await messagesRoute.GET({ nextUrl: new URL('http://test/api/messages?conversation_id=child&limit=80') });
  assert.equal((await response.json()).totalTokens, 60);
});
