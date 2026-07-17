const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const { createChatCachePersistence } = require(path.resolve(__dirname, '../src/lib/chat-cache-store.ts'));
const {
  __setChatCachePersistenceForTests,
  clearCachedMessages,
  readCachedMessages,
  readCachedMessagesAsync,
  updateCachedMessages,
  writeCachedMessages,
} = require(path.resolve(__dirname, '../src/lib/chat-message-cache.ts'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function message(id, seq, conversationId = 'conv-a') {
  return {
    id,
    conversation_id: conversationId,
    role: 'user',
    content: `message ${id}`,
    token_count: 1,
    created_at: `2026-07-17T12:00:${String(seq).padStart(2, '0')}.000Z`,
    seq,
    metadata: {},
  };
}

function snapshot(conversationId, ids = ['m1']) {
  return {
    messages: ids.map((id, index) => message(id, index + 1, conversationId)),
    hasMore: false,
    oldestSeq: 1,
  };
}

function createMemoryBackend() {
  const store = new Map();
  const calls = { put: 0, delete: 0, clear: 0, getAll: 0 };
  return {
    store,
    calls,
    async getAll() {
      calls.getAll += 1;
      return [...store.entries()].map(([id, record]) => ({ id, record }));
    },
    async put(id, record) {
      calls.put += 1;
      store.set(id, record);
    },
    async delete(id) {
      calls.delete += 1;
      store.delete(id);
    },
    async clear() {
      calls.clear += 1;
      store.clear();
    },
  };
}

function createRecordingPersistence() {
  const calls = { schedulePut: [], remove: [], removeAll: 0 };
  let hydrateResult = [];
  return {
    calls,
    setHydrateResult(entries) { hydrateResult = entries; },
    async hydrate() { return hydrateResult; },
    schedulePut(id, getSnapshot) { calls.schedulePut.push({ id, snapshot: getSnapshot() }); },
    remove(id) { calls.remove.push(id); },
    removeAll() { calls.removeAll += 1; },
  };
}

// ---- createChatCachePersistence（持久层工厂） ----

test('schedulePut 防抖合并：短时间多次调度只落盘一次且取最新快照', async () => {
  const backend = createMemoryBackend();
  const persistence = createChatCachePersistence(backend, { debounceMs: 10 });
  let value = snapshot('conv-a', ['m1']);
  persistence.schedulePut('conv-a', () => value);
  value = snapshot('conv-a', ['m1', 'm2']);
  persistence.schedulePut('conv-a', () => value);
  await sleep(40);
  assert.equal(backend.calls.put, 1);
  assert.equal(backend.store.get('conv-a').snapshot.messages.length, 2);
  assert.equal(backend.store.get('conv-a').v, 1);
});

test('schedulePut 触发时快照已被清除（getSnapshot 返回 null）则跳过落盘', async () => {
  const backend = createMemoryBackend();
  const persistence = createChatCachePersistence(backend, { debounceMs: 10 });
  persistence.schedulePut('conv-a', () => null);
  await sleep(40);
  assert.equal(backend.calls.put, 0);
});

test('remove 取消同会话 pending 落盘并删除持久记录', async () => {
  const backend = createMemoryBackend();
  const persistence = createChatCachePersistence(backend, { debounceMs: 10 });
  persistence.schedulePut('conv-a', () => snapshot('conv-a'));
  persistence.remove('conv-a');
  await sleep(40);
  assert.equal(backend.calls.put, 0);
  assert.equal(backend.calls.delete, 1);
});

test('hydrate 丢弃版本不符与结构不完整的记录，并按 savedAt 升序返回', async () => {
  const backend = createMemoryBackend();
  backend.store.set('conv-new', { v: 1, savedAt: 200, snapshot: snapshot('conv-new') });
  backend.store.set('conv-old', { v: 1, savedAt: 100, snapshot: snapshot('conv-old') });
  backend.store.set('conv-future', { v: 2, savedAt: 300, snapshot: snapshot('conv-future') });
  backend.store.set('conv-broken', { v: 1, savedAt: 400, snapshot: { hasMore: false } });
  backend.store.set('conv-junk', 'not-a-record');
  const persistence = createChatCachePersistence(backend);
  const entries = await persistence.hydrate();
  assert.deepEqual(entries.map(e => e.id), ['conv-old', 'conv-new']);
});

test('hydrate 只执行一次（结果 memoize）', async () => {
  const backend = createMemoryBackend();
  const persistence = createChatCachePersistence(backend);
  await persistence.hydrate();
  await persistence.hydrate();
  assert.equal(backend.calls.getAll, 1);
});

test('backend 出错后持久化静默关闭，后续操作不再触碰 backend', async () => {
  const backend = createMemoryBackend();
  backend.put = async () => { backend.calls.put += 1; throw new Error('quota exceeded'); };
  const persistence = createChatCachePersistence(backend, { debounceMs: 10 });
  persistence.schedulePut('conv-a', () => snapshot('conv-a'));
  await sleep(40);
  assert.equal(backend.calls.put, 1);
  persistence.schedulePut('conv-b', () => snapshot('conv-b'));
  await sleep(40);
  assert.equal(backend.calls.put, 1);
  persistence.remove('conv-a');
  persistence.removeAll();
  assert.equal(backend.calls.delete, 0);
  assert.equal(backend.calls.clear, 0);
});

test('backend 为 null（SSR/不支持）时所有操作为安全 no-op', async () => {
  const persistence = createChatCachePersistence(null, { debounceMs: 10 });
  persistence.schedulePut('conv-a', () => snapshot('conv-a'));
  persistence.remove('conv-a');
  persistence.removeAll();
  assert.deepEqual(await persistence.hydrate(), []);
});

// ---- chat-message-cache 接线（注入 fake 持久层） ----

test('writeCachedMessages 触发 write-through 落盘调度', () => {
  clearCachedMessages();
  const fake = createRecordingPersistence();
  __setChatCachePersistenceForTests(fake);
  writeCachedMessages('conv-a', snapshot('conv-a'));
  assert.equal(fake.calls.schedulePut.length, 1);
  assert.equal(fake.calls.schedulePut[0].id, 'conv-a');
  assert.equal(fake.calls.schedulePut[0].snapshot.messages.length, 1);
});

test('clearCachedMessages 联动持久层删除（单会话与全量）', () => {
  clearCachedMessages();
  const fake = createRecordingPersistence();
  __setChatCachePersistenceForTests(fake);
  writeCachedMessages('conv-a', snapshot('conv-a'));
  clearCachedMessages('conv-a');
  assert.deepEqual(fake.calls.remove, ['conv-a']);
  clearCachedMessages();
  assert.equal(fake.calls.removeAll, 1);
});

test('LRU 淘汰会话时联动持久层删除', () => {
  clearCachedMessages();
  const fake = createRecordingPersistence();
  __setChatCachePersistenceForTests(fake);
  for (let i = 0; i < 56; i += 1) {
    writeCachedMessages(`conv-${i}`, snapshot(`conv-${i}`));
  }
  assert.deepEqual(fake.calls.remove, ['conv-0']);
  assert.equal(readCachedMessages('conv-0'), null);
  assert.ok(readCachedMessages('conv-55'));
});

test('readCachedMessagesAsync 用持久层快照填充缺失 key，且不覆盖内存中已有条目', async () => {
  clearCachedMessages();
  const fake = createRecordingPersistence();
  __setChatCachePersistenceForTests(fake);
  fake.setHydrateResult([
    { id: 'conv-persisted', snapshot: snapshot('conv-persisted', ['old-1', 'old-2']) },
    { id: 'conv-live', snapshot: snapshot('conv-live', ['stale']) },
  ]);
  writeCachedMessages('conv-live', snapshot('conv-live', ['fresh-1', 'fresh-2', 'fresh-3']));

  const persisted = await readCachedMessagesAsync('conv-persisted');
  assert.equal(persisted.messages.length, 2);
  const live = await readCachedMessagesAsync('conv-live');
  assert.deepEqual(live.messages.map(m => m.id), ['fresh-1', 'fresh-2', 'fresh-3']);
});

test('updateCachedMessages 同样触发 write-through 落盘调度', () => {
  clearCachedMessages();
  const fake = createRecordingPersistence();
  __setChatCachePersistenceForTests(fake);
  writeCachedMessages('conv-a', snapshot('conv-a'));
  updateCachedMessages('conv-a', messages => [...messages, message('m2', 2, 'conv-a')]);
  assert.equal(fake.calls.schedulePut.length, 2);
  assert.equal(fake.calls.schedulePut[1].snapshot.messages.length, 2);
});

test('hydrate 填充后运行期已写入的条目保持在 LRU 尾部，超限时淘汰的是陈旧快照而非活跃会话', async () => {
  clearCachedMessages();
  const fake = createRecordingPersistence();
  __setChatCachePersistenceForTests(fake);
  // 持久层存满 55 条陈旧快照（savedAt 升序 → hydrate 返回顺序即最旧在前）
  fake.setHydrateResult(
    Array.from({ length: 55 }, (_, i) => ({ id: `conv-old-${i}`, snapshot: snapshot(`conv-old-${i}`) })),
  );
  // hydrate 之前，活跃会话已从网络写入内存（重开浏览器后网络先于 hydrate 返回的时序）
  writeCachedMessages('conv-live', snapshot('conv-live', ['fresh']));

  await readCachedMessagesAsync('conv-live');

  // 活跃会话必须存活，被淘汰的应是 hydrate 里最旧的快照
  assert.ok(readCachedMessages('conv-live'));
  assert.equal(readCachedMessages('conv-old-0'), null);
  assert.ok(readCachedMessages('conv-old-54'));
  assert.deepEqual(fake.calls.remove, ['conv-old-0']);
});

test('readCachedMessagesAsync 在持久层无记录时返回 null', async () => {
  clearCachedMessages();
  const fake = createRecordingPersistence();
  __setChatCachePersistenceForTests(fake);
  assert.equal(await readCachedMessagesAsync('conv-missing'), null);
});
