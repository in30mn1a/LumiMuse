const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

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

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  MAX_CACHED_CHARACTER_CONTEXTS,
  __getCharacterContextCacheSizeForTests,
  __setCharacterContextPersistenceForTests,
  clearCharacterContext,
  hasCharacterContext,
  isValidCharacterContextSnapshot,
  patchCharacterConversation,
  prependCharacterConversation,
  readCharacterContext,
  readCharacterContextAsync,
  removeCharacterConversation,
  touchCharacterConversation,
  updateCharacterMemories,
  writeCharacterContext,
} = require(path.resolve(__dirname, '../src/lib/character-context-cache.ts'));
const { createChatCachePersistence } = require(path.resolve(__dirname, '../src/lib/chat-cache-store.ts'));

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

function resetPersistenceToNoop() {
  __setCharacterContextPersistenceForTests(createChatCachePersistence(null));
}

function conv(id, characterId = 'char-a') {
  return {
    id,
    character_id: characterId,
    title: id,
    ignore_memory: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

function memory(id, characterId = 'char-a') {
  return {
    id,
    character_id: characterId,
    content: `memory ${id}`,
    category: 'fact',
    tags: ['t'],
    importance: 1,
    status: 'active',
    pinned: 0,
    metadata: { k: 1 },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

test('character context returns null before write', () => {
  clearCharacterContext();
  assert.equal(readCharacterContext('char-a'), null);
});

test('character context stores independent snapshots per character', () => {
  clearCharacterContext();
  writeCharacterContext('char-a', {
    conversations: [conv('c1')],
    memories: [memory('m1')],
  });
  writeCharacterContext('char-b', {
    conversations: [conv('c2', 'char-b')],
    memories: [memory('m2', 'char-b')],
  });

  const a = readCharacterContext('char-a');
  const b = readCharacterContext('char-b');
  assert.equal(a.conversations[0].id, 'c1');
  assert.equal(a.memories[0].id, 'm1');
  assert.equal(b.conversations[0].id, 'c2');
  assert.equal(b.memories[0].id, 'm2');
});

test('character context snapshots are defensive copies', () => {
  clearCharacterContext();
  const conversations = [conv('c1')];
  const memories = [memory('m1')];
  writeCharacterContext('char-a', { conversations, memories });

  conversations[0].title = 'mutated';
  memories[0].content = 'mutated';
  memories[0].tags.push('x');

  const cached = readCharacterContext('char-a');
  assert.equal(cached.conversations[0].title, 'c1');
  assert.equal(cached.memories[0].content, 'memory m1');
  assert.deepEqual(cached.memories[0].tags, ['t']);

  cached.conversations[0].title = 'caller-mut';
  assert.equal(readCharacterContext('char-a').conversations[0].title, 'c1');
});

test('update helpers patch one side without wiping the other', () => {
  clearCharacterContext();
  writeCharacterContext('char-a', {
    conversations: [conv('c1')],
    memories: [memory('m1')],
  });
  prependCharacterConversation('char-a', conv('c2'));
  assert.deepEqual(readCharacterContext('char-a').conversations.map(c => c.id), ['c2', 'c1']);
  assert.equal(readCharacterContext('char-a').memories[0].id, 'm1');

  updateCharacterMemories('char-a', [memory('m9')]);
  assert.equal(readCharacterContext('char-a').memories[0].id, 'm9');
  assert.deepEqual(readCharacterContext('char-a').conversations.map(c => c.id), ['c2', 'c1']);
});

test('targeted conversation helpers mutate only matching entries', () => {
  clearCharacterContext();
  writeCharacterContext('char-a', {
    conversations: [conv('c1'), conv('c2'), conv('c3')],
    memories: [memory('m1')],
  });

  patchCharacterConversation('char-a', 'c2', { title: 'renamed', ignore_memory: 1 });
  let snapshot = readCharacterContext('char-a');
  assert.deepEqual(snapshot.conversations.map(c => c.id), ['c1', 'c2', 'c3'], 'patch must not reorder');
  assert.equal(snapshot.conversations[1].title, 'renamed');
  assert.equal(snapshot.conversations[1].ignore_memory, 1);

  touchCharacterConversation('char-a', 'c3', '2026-07-19T12:00:00.000Z');
  snapshot = readCharacterContext('char-a');
  assert.deepEqual(snapshot.conversations.map(c => c.id), ['c3', 'c1', 'c2'], 'touch moves to front');
  assert.equal(snapshot.conversations[0].updated_at, '2026-07-19T12:00:00.000Z');

  removeCharacterConversation('char-a', 'c1');
  snapshot = readCharacterContext('char-a');
  assert.deepEqual(snapshot.conversations.map(c => c.id), ['c3', 'c2']);
  assert.equal(snapshot.memories[0].id, 'm1', 'memories untouched by conversation helpers');
});

test('targeted helpers are no-ops for missing entries, missing conversations, or cross-character data', () => {
  clearCharacterContext();

  // 条目不存在（未加载过 / 已被 LRU 淘汰）时全部 no-op，不得凭空创建半空快照
  prependCharacterConversation('char-none', conv('c1', 'char-none'));
  patchCharacterConversation('char-none', 'c1', { title: 'x' });
  removeCharacterConversation('char-none', 'c1');
  touchCharacterConversation('char-none', 'c1', '2026-07-19T12:00:00.000Z');
  updateCharacterMemories('char-none', [memory('m1', 'char-none')]);
  assert.equal(hasCharacterContext('char-none'), false);
  assert.equal(__getCharacterContextCacheSizeForTests(), 0);

  writeCharacterContext('char-a', { conversations: [conv('c1')], memories: [memory('m1')] });

  // 跨角色数据拒绝写入（防止「切走后迟到的响应」把 B 的数据写进 A 的缓存）
  prependCharacterConversation('char-a', conv('cb', 'char-b'));
  updateCharacterMemories('char-a', [memory('mb', 'char-b')]);
  const snapshot = readCharacterContext('char-a');
  assert.deepEqual(snapshot.conversations.map(c => c.id), ['c1']);
  assert.deepEqual(snapshot.memories.map(m => m.id), ['m1']);

  // 目标会话不在缓存列表中时 no-op
  patchCharacterConversation('char-a', 'c-missing', { title: 'x' });
  removeCharacterConversation('char-a', 'c-missing');
  touchCharacterConversation('char-a', 'c-missing', '2026-07-19T12:00:00.000Z');
  assert.deepEqual(readCharacterContext('char-a').conversations.map(c => c.id), ['c1']);
});

test('character context enforces LRU max size', () => {
  clearCharacterContext();
  for (let i = 0; i < MAX_CACHED_CHARACTER_CONTEXTS + 3; i += 1) {
    writeCharacterContext(`char-${i}`, {
      conversations: [conv(`c-${i}`, `char-${i}`)],
      memories: [],
    });
  }
  assert.equal(__getCharacterContextCacheSizeForTests(), MAX_CACHED_CHARACTER_CONTEXTS);
  assert.equal(readCharacterContext('char-0'), null);
  assert.ok(readCharacterContext(`char-${MAX_CACHED_CHARACTER_CONTEXTS + 2}`));
});

test('clearCharacterContext removes one or all', () => {
  clearCharacterContext();
  writeCharacterContext('char-a', { conversations: [conv('c1')], memories: [] });
  writeCharacterContext('char-b', { conversations: [conv('c2', 'char-b')], memories: [] });
  clearCharacterContext('char-a');
  assert.equal(readCharacterContext('char-a'), null);
  assert.ok(readCharacterContext('char-b'));
  clearCharacterContext();
  assert.equal(readCharacterContext('char-b'), null);
});

test('hasCharacterContext reports presence without copying', () => {
  clearCharacterContext();
  assert.equal(hasCharacterContext('char-a'), false);
  writeCharacterContext('char-a', { conversations: [conv('c1')], memories: [] });
  assert.equal(hasCharacterContext('char-a'), true);
});

test('isValidCharacterContextSnapshot requires both arrays', () => {
  assert.equal(isValidCharacterContextSnapshot({ conversations: [], memories: [] }), true);
  assert.equal(isValidCharacterContextSnapshot({ conversations: [] }), false);
  assert.equal(isValidCharacterContextSnapshot({ memories: [] }), false);
  assert.equal(isValidCharacterContextSnapshot({ conversations: 'x', memories: [] }), false);
});

test('write paths schedule write-through persistence', () => {
  clearCharacterContext();
  const fake = createRecordingPersistence();
  __setCharacterContextPersistenceForTests(fake);
  try {
    writeCharacterContext('char-a', { conversations: [conv('c1')], memories: [memory('m1')] });
    prependCharacterConversation('char-a', conv('c2'));
    updateCharacterMemories('char-a', [memory('m2')]);

    assert.equal(fake.calls.schedulePut.length, 3);
    assert.ok(fake.calls.schedulePut.every(call => call.id === 'char-a'));
    assert.equal(fake.calls.schedulePut[2].snapshot.memories[0].id, 'm2');
    assert.deepEqual(fake.calls.schedulePut[2].snapshot.conversations.map(c => c.id), ['c2', 'c1']);
  } finally {
    resetPersistenceToNoop();
    clearCharacterContext();
  }
});

test('clear and LRU eviction propagate to persistence', () => {
  clearCharacterContext();
  const fake = createRecordingPersistence();
  __setCharacterContextPersistenceForTests(fake);
  try {
    for (let i = 0; i <= MAX_CACHED_CHARACTER_CONTEXTS; i += 1) {
      writeCharacterContext(`char-${i}`, { conversations: [], memories: [] });
    }
    assert.deepEqual(fake.calls.remove, ['char-0']);

    clearCharacterContext('char-1');
    assert.deepEqual(fake.calls.remove, ['char-0', 'char-1']);

    clearCharacterContext();
    assert.equal(fake.calls.removeAll, 1);
  } finally {
    resetPersistenceToNoop();
    clearCharacterContext();
  }
});

test('readCharacterContextAsync hydrates missing keys without overriding memory entries', async () => {
  clearCharacterContext();
  const fake = createRecordingPersistence();
  __setCharacterContextPersistenceForTests(fake);
  try {
    fake.setHydrateResult([
      {
        id: 'char-persisted',
        snapshot: {
          conversations: [conv('c-persisted', 'char-persisted')],
          memories: [memory('m-persisted', 'char-persisted')],
          savedAt: 100,
        },
      },
      {
        id: 'char-live',
        snapshot: {
          conversations: [conv('c-stale', 'char-live')],
          memories: [],
          savedAt: 100,
        },
      },
    ]);
    writeCharacterContext('char-live', {
      conversations: [conv('c-fresh', 'char-live')],
      memories: [],
    });

    const persisted = await readCharacterContextAsync('char-persisted');
    assert.equal(persisted.conversations[0].id, 'c-persisted');
    assert.equal(persisted.memories[0].id, 'm-persisted');

    const live = await readCharacterContextAsync('char-live');
    assert.equal(live.conversations[0].id, 'c-fresh');

    assert.equal(await readCharacterContextAsync('char-missing'), null);
  } finally {
    resetPersistenceToNoop();
    clearCharacterContext();
  }
});
