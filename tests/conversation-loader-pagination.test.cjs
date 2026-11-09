const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalLoad = Module._load;
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
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

function requireFreshWithMocks(modulePath, mocks) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createHookRuntime(hookFactory, optionsFactory) {
  const stateValues = [];
  const refValues = [];
  const callbackValues = [];
  const memoValues = [];
  let stateCursor = 0;
  let refCursor = 0;
  let callbackCursor = 0;
  let memoCursor = 0;
  let effectCursor = 0;
  const effects = [];
  let currentResult;
  let isRendering = false;

  function depsChanged(previousDeps, nextDeps) {
    if (!previousDeps || !nextDeps) return true;
    if (previousDeps.length !== nextDeps.length) return true;
    return nextDeps.some((dep, index) => !Object.is(dep, previousDeps[index]));
  }

  function runEffect(callback, deps) {
    const index = effectCursor;
    effectCursor += 1;
    const previous = effects[index];
    if (previous && !depsChanged(previous.deps, deps)) return;
    previous?.cleanup?.();
    effects[index] = { deps, cleanup: callback() };
  }

  const reactMock = {
    useCallback: (callback, deps) => {
      const index = callbackCursor;
      callbackCursor += 1;
      const previous = callbackValues[index];
      if (!previous || depsChanged(previous.deps, deps)) {
        callbackValues[index] = { deps, callback };
      }
      return callbackValues[index].callback;
    },
    useEffect: runEffect,
    useLayoutEffect: callback => {
      callback();
    },
    useMemo: (factory, deps) => {
      const index = memoCursor;
      memoCursor += 1;
      const previous = memoValues[index];
      if (!previous || depsChanged(previous.deps, deps)) {
        memoValues[index] = { deps, value: factory() };
      }
      return memoValues[index].value;
    },
    useRef: initialValue => {
      const index = refCursor;
      refCursor += 1;
      if (!refValues[index]) {
        refValues[index] = { current: initialValue };
      }
      return refValues[index];
    },
    useState: initialValue => {
      const index = stateCursor;
      stateCursor += 1;
      if (stateValues.length <= index) {
        stateValues[index] = typeof initialValue === 'function' ? initialValue() : initialValue;
      }
      const setState = nextValue => {
        const previousValue = stateValues[index];
        const value = typeof nextValue === 'function' ? nextValue(previousValue) : nextValue;
        if (Object.is(previousValue, value)) return;
        stateValues[index] = value;
        if (!isRendering) render();
      };
      return [stateValues[index], setState];
    },
  };

  const hook = hookFactory(reactMock);

  function render() {
    isRendering = true;
    stateCursor = 0;
    refCursor = 0;
    callbackCursor = 0;
    memoCursor = 0;
    effectCursor = 0;
    currentResult = hook(optionsFactory());
    isRendering = false;
    return currentResult;
  }

  return {
    get current() {
      return currentResult;
    },
    render,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

function buildConversationPage(offset, limit) {
  const allConversations = Array.from({ length: 120 }, (_, index) => {
    const number = 119 - index;
    return {
      id: `conv-${String(number).padStart(3, '0')}`,
      character_id: 'char-a',
      title: `Conversation ${number}`,
    };
  });
  return allConversations.slice(offset, offset + limit);
}

test('conversation loader paginates character conversations until the preferred conversation is available', async () => {
  const originalFetch = global.fetch;
  const conversationRequests = [];

  global.fetch = async input => {
    const url = new URL(String(input), 'http://test.local');
    if (url.pathname === '/api/memories') {
      return jsonResponse([]);
    }
    if (url.pathname === '/api/conversations') {
      conversationRequests.push(url.search);
      const limit = Number(url.searchParams.get('limit') || '20');
      const offset = Number(url.searchParams.get('offset') || '0');
      const page = buildConversationPage(offset, limit);
      return jsonResponse(page, {
        headers: {
          'X-Total-Count': '120',
          'X-Has-More': String(offset + page.length < 120),
          'X-Page-Limit': String(limit),
          'X-Page-Offset': String(offset),
        },
      });
    }
    throw new Error(`unexpected fetch: ${input}`);
  };

  try {
    const character = { id: 'char-a', name: 'Alice' };
    const clearMessagesRef = { current: () => {} };
    const clearStreamingTextRef = { current: () => {} };
    const runtime = createHookRuntime(
      reactMock => {
        const { useConversationLoader } = requireFreshWithMocks('../src/hooks/chat/useConversationLoader.ts', {
          react: reactMock,
        });
        return useConversationLoader;
      },
      () => ({
        character,
        conversationId: 'conv-010',
        clearMessagesRef,
        clearStreamingTextRef,
      }),
    );

    runtime.render();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(runtime.current.activeConvId, 'conv-010');
    assert.equal(runtime.current.conversations.length, 120);
    assert.deepEqual(conversationRequests, [
      '?character_id=char-a&limit=100&offset=0',
      '?character_id=char-a&limit=100&offset=100',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('touchConversation bumps updated_at in place without reordering or fetching', async () => {
  const originalFetch = global.fetch;
  const fetchCalls = [];

  global.fetch = async input => {
    fetchCalls.push(String(input));
    const url = new URL(String(input), 'http://test.local');
    if (url.pathname === '/api/memories') {
      return jsonResponse([]);
    }
    if (url.pathname === '/api/conversations') {
      return jsonResponse([
        {
          id: 'conv-old',
          character_id: 'char-a',
          title: 'Older',
          ignore_memory: 0,
          created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-01T00:00:00.000Z',
        },
        {
          id: 'conv-target',
          character_id: 'char-a',
          title: 'Target',
          ignore_memory: 0,
          created_at: '2026-07-02T00:00:00.000Z',
          updated_at: '2026-07-02T00:00:00.000Z',
        },
      ], {
        headers: { 'X-Has-More': 'false' },
      });
    }
    throw new Error(`unexpected fetch: ${input}`);
  };

  try {
    const character = { id: 'char-a', name: 'Alice' };
    const clearMessagesRef = { current: () => {} };
    const clearStreamingTextRef = { current: () => {} };
    const runtime = createHookRuntime(
      reactMock => {
        const { useConversationLoader } = requireFreshWithMocks('../src/hooks/chat/useConversationLoader.ts', {
          react: reactMock,
        });
        return useConversationLoader;
      },
      () => ({
        character,
        conversationId: 'conv-old',
        clearMessagesRef,
        clearStreamingTextRef,
      }),
    );

    runtime.render();
    await new Promise(resolve => setTimeout(resolve, 20));
    const fetchesBeforeTouch = fetchCalls.length;

    runtime.current.touchConversation('conv-target', '2026-07-13T12:00:00.000Z');

    assert.equal(fetchCalls.length, fetchesBeforeTouch, 'touchConversation must not fetch conversations or memories');
    assert.deepEqual(runtime.current.conversations.map(item => item.id), ['conv-old', 'conv-target'], 'drag order must survive a chat bump');
    assert.equal(runtime.current.conversations[1].updated_at, '2026-07-13T12:00:00.000Z');
    assert.equal(runtime.current.conversations[1].title, 'Target');
    assert.equal(runtime.current.activeConvId, 'conv-old');
  } finally {
    global.fetch = originalFetch;
  }
});

function createConversationOrderHarness(t, { withCache = true } = {}) {
  const originalFetch = global.fetch;
  const cache = require(path.resolve(__dirname, '../src/lib/character-context-cache.ts'));
  const reads = [];
  const writes = [];
  const readWaiters = new Map();
  let memoryRows = [];
  let character = { id: 'char-order', name: 'Order' };
  const rows = ['a', 'b', 'c'].map(id => ({ id, character_id: character.id, title: id }));
  const clearMessagesRef = { current: () => {} };
  const clearStreamingTextRef = { current: () => {} };
  cache.clearCharacterContext();
  if (withCache) cache.writeCharacterContext(character.id, { conversations: rows, memories: [] });
  global.fetch = async (input, options) => {
    const url = new URL(String(input), 'http://test.local');
    if (url.pathname === '/api/memories') return jsonResponse(memoryRows);
    if (url.pathname === '/api/conversations') {
      return new Promise(resolve => {
        reads.push({ characterId: url.searchParams.get('character_id'), resolve });
        readWaiters.get(reads.length)?.();
      });
    }
    if (url.pathname === '/api/conversations/reorder') {
      return new Promise(resolve => writes.push({ ...JSON.parse(options.body), resolve }));
    }
    throw new Error(`unexpected fetch: ${input}`);
  };
  const runtime = createHookRuntime(
    reactMock => requireFreshWithMocks('../src/hooks/chat/useConversationLoader.ts', {
      react: reactMock,
    }).useConversationLoader,
    () => ({ character, conversationId: null, clearMessagesRef, clearStreamingTextRef }),
  );
  runtime.render();
  t.after(() => {
    global.fetch = originalFetch;
    cache.clearCharacterContext();
  });
  return {
    runtime,
    rows,
    reads,
    writes,
    cache,
    waitForRead(count) {
      if (reads.length >= count) return Promise.resolve();
      return new Promise(resolve => readWaiters.set(count, resolve));
    },
    async resolveRead(index, conversations = rows) {
      reads[index].resolve(jsonResponse(conversations, { headers: { 'X-Has-More': 'false' } }));
      await new Promise(resolve => setImmediate(resolve));
    },
    selectCharacter(nextCharacter) {
      character = nextCharacter;
      runtime.render();
    },
    setMemoryResponse(memories) {
      memoryRows = memories;
    },
  };
}

test('conversation reorder blocks overlapping writes and unlocks after success', async t => {
  const harness = createConversationOrderHarness(t);
  const { runtime, writes } = harness;
  await harness.waitForRead(1);
  await harness.resolveRead(0);

  const first = runtime.current.reorderConversations(['b', 'a', 'c'], ['a', 'b', 'c']);
  const duplicate = runtime.current.reorderConversations(['b', 'c', 'a'], ['b', 'a', 'c']);
  assert.equal(writes.length, 1, 'a second drag must not send another request while saving');
  await duplicate;
  assert.equal(runtime.current.reorderingConversations, true);
  assert.deepEqual(runtime.current.conversations.map(item => item.id), ['b', 'a', 'c']);

  writes[0].resolve(jsonResponse({ ok: true }));
  await first;
  assert.equal(runtime.current.reorderingConversations, false);
  const next = runtime.current.reorderConversations(['b', 'c', 'a'], ['b', 'a', 'c']);
  assert.equal(writes.length, 2, 'saving must be available again after success');
  writes[1].resolve(jsonResponse({ ok: true }));
  await next;
});

test('conversation reorder discards an older revalidate without leaving loadingThread set', async t => {
  const harness = createConversationOrderHarness(t, { withCache: false });
  const { runtime, rows, writes, cache } = harness;
  await harness.waitForRead(1);
  assert.equal(runtime.current.loadingThread, true);
  // 在已有本地列表可用、首次网络读取尚未完成时进行排序。
  runtime.current.setConversations(rows);
  cache.writeCharacterContext('char-order', { conversations: rows, memories: [] });
  const saving = runtime.current.reorderConversations(['b', 'c', 'a'], ['a', 'b', 'c']);
  writes[0].resolve(jsonResponse({ ok: true }));
  await saving;
  await harness.resolveRead(0);

  assert.deepEqual(runtime.current.conversations.map(item => item.id), ['b', 'c', 'a']);
  assert.deepEqual(cache.readCharacterContext('char-order').conversations.map(item => item.id), ['b', 'c', 'a']);
  assert.equal(runtime.current.loadingThread, false, 'discarding a stale result must still finish loading');
});

test('conversation reorder discards revalidate started while saving even after the write finishes', async t => {
  const harness = createConversationOrderHarness(t);
  const { runtime, writes } = harness;
  await harness.waitForRead(1);
  await harness.resolveRead(0);
  const saving = runtime.current.reorderConversations(['b', 'c', 'a'], ['a', 'b', 'c']);
  harness.selectCharacter({ id: 'char-order', name: 'Updated Order' });
  await harness.waitForRead(2);
  writes[0].resolve(jsonResponse({ ok: true }));
  await saving;
  await harness.resolveRead(1);

  assert.deepEqual(runtime.current.conversations.map(item => item.id), ['b', 'c', 'a']);
  assert.equal(runtime.current.loadingThread, false);
});

test('conversation refresh waits or refetches after sorting and selects the new copy at the top', async t => {
  for (const startsDuringSave of [false, true]) {
    await t.test(startsDuringSave ? 'during saving' : 'before saving', async subtest => {
      const harness = createConversationOrderHarness(subtest);
      const { runtime, reads, writes, cache } = harness;
      await harness.waitForRead(1);
      await harness.resolveRead(0);
      let refresh;
      if (!startsDuringSave) refresh = runtime.current.refreshConversationState('new-copy');
      const saving = runtime.current.reorderConversations(['b', 'c', 'a'], ['a', 'b', 'c']);
      if (startsDuringSave) {
        refresh = runtime.current.refreshConversationState('new-copy');
        assert.equal(reads.length, 1, 'refresh must wait for the write before fetching');
      } else {
        await harness.waitForRead(2);
        await harness.resolveRead(1);
        assert.deepEqual(runtime.current.conversations.map(item => item.id), ['b', 'c', 'a']);
      }
      const freshMemory = { id: 'memory-new', character_id: 'char-order', content: 'fresh memory' };
      harness.setMemoryResponse([freshMemory]);
      writes[0].resolve(jsonResponse({ ok: true }));
      await saving;
      await new Promise(resolve => setImmediate(resolve));
      const freshReadIndex = startsDuringSave ? 1 : 2;
      assert.equal(reads.length, freshReadIndex + 1, 'refresh must obtain a fresh snapshot after saving');
      const freshConversations = [
        { id: 'new-copy', character_id: 'char-order', title: 'Copy', sort_order: -1 },
        ...['b', 'c', 'a'].map(id => harness.rows.find(row => row.id === id)),
      ];
      await harness.resolveRead(freshReadIndex, freshConversations);
      await refresh;

      assert.deepEqual(runtime.current.conversations.map(item => item.id), ['new-copy', 'b', 'c', 'a']);
      assert.equal(runtime.current.activeConvId, 'new-copy');
      assert.deepEqual(runtime.current.memories, [freshMemory]);
      assert.deepEqual(cache.readCharacterContext('char-order').conversations.map(item => item.id), ['new-copy', 'b', 'c', 'a']);
    });
  }
});

test('a newer refresh replaces an older refresh waiting for sorting', async t => {
  const harness = createConversationOrderHarness(t);
  const { runtime, reads, writes } = harness;
  await harness.waitForRead(1);
  await harness.resolveRead(0);
  const saving = runtime.current.reorderConversations(['b', 'c', 'a'], ['a', 'b', 'c']);
  const oldRefresh = runtime.current.refreshConversationState('a');
  const latestRefresh = runtime.current.refreshConversationState('new-copy');
  assert.equal(reads.length, 1, 'both refreshes must wait for sorting');
  writes[0].resolve(jsonResponse({ ok: true }));
  await saving;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2, 'the superseded refresh must exit without another GET');
  await harness.resolveRead(1, [{ id: 'new-copy', character_id: 'char-order', title: 'Copy' }, ...harness.rows]);
  await Promise.all([oldRefresh, latestRefresh]);
  assert.equal(runtime.current.activeConvId, 'new-copy');
});

test('refresh waits again if another sort starts during its fresh GET', async t => {
  const harness = createConversationOrderHarness(t);
  const { runtime, reads, writes } = harness;
  await harness.waitForRead(1);
  await harness.resolveRead(0);
  const firstSave = runtime.current.reorderConversations(['b', 'c', 'a'], ['a', 'b', 'c']);
  const refresh = runtime.current.refreshConversationState('c');
  writes[0].resolve(jsonResponse({ ok: true }));
  await firstSave;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2);
  const nextSave = runtime.current.reorderConversations(['c', 'b', 'a'], ['b', 'c', 'a']);
  await harness.resolveRead(1);
  assert.equal(reads.length, 2, 'no further GET should be sent while the next sort is pending');
  writes[1].resolve(jsonResponse({ ok: true }));
  await nextSave;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 3);
  await harness.resolveRead(2, ['c', 'b', 'a'].map(id => harness.rows.find(row => row.id === id)));
  await refresh;
  assert.deepEqual(runtime.current.conversations.map(item => item.id), ['c', 'b', 'a']);
  assert.equal(runtime.current.activeConvId, 'c');
});

test('refresh waiting for a failed sort still loads and selects the new copy', async t => {
  const harness = createConversationOrderHarness(t);
  const { runtime, reads, writes } = harness;
  await harness.waitForRead(1);
  await harness.resolveRead(0);
  const saving = runtime.current.reorderConversations(['b', 'c', 'a'], ['a', 'b', 'c']);
  const rejection = assert.rejects(saving, /save failed/);
  const refresh = runtime.current.refreshConversationState('new-copy');
  writes[0].resolve(jsonResponse({ error: 'save failed' }, { status: 500 }));
  await rejection;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2, 'failure must also release the pending refresh');
  await harness.resolveRead(1, [{ id: 'new-copy', character_id: 'char-order', title: 'Copy' }, ...harness.rows]);
  await refresh;
  assert.deepEqual(runtime.current.conversations.map(item => item.id), ['new-copy', 'a', 'b', 'c']);
  assert.equal(runtime.current.activeConvId, 'new-copy');
});

test('refresh waiting for sorting stops after switching characters', async t => {
  const harness = createConversationOrderHarness(t);
  const { runtime, reads, writes } = harness;
  await harness.waitForRead(1);
  await harness.resolveRead(0);
  const saving = runtime.current.reorderConversations(['b', 'c', 'a'], ['a', 'b', 'c']);
  const refresh = runtime.current.refreshConversationState('new-copy');
  harness.selectCharacter({ id: 'char-other', name: 'Other' });
  await harness.waitForRead(2);
  await harness.resolveRead(1, [{ id: 'other', character_id: 'char-other', title: 'Other' }]);
  writes[0].resolve(jsonResponse({ ok: true }));
  await saving;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2, 'the old character refresh must not fetch after sorting finishes');
  await refresh;
  assert.deepEqual(runtime.current.conversations.map(item => item.id), ['other']);
  assert.equal(runtime.current.activeConvId, 'other');
});

test('conversation reorder rolls back state and cache on failure and allows the next save', async t => {
  const harness = createConversationOrderHarness(t);
  const { runtime, writes, cache } = harness;
  await harness.waitForRead(1);
  await harness.resolveRead(0);
  const saving = runtime.current.reorderConversations(['b', 'c', 'a'], ['a', 'b', 'c']);
  const rejection = assert.rejects(saving, /save failed/);
  writes[0].resolve(jsonResponse({ error: 'save failed' }, { status: 500 }));
  await rejection;

  assert.deepEqual(runtime.current.conversations.map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(cache.readCharacterContext('char-order').conversations.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(runtime.current.reorderingConversations, false);
  const next = runtime.current.reorderConversations(['c', 'a', 'b'], ['a', 'b', 'c']);
  assert.equal(writes.length, 2);
  writes[1].resolve(jsonResponse({ ok: true }));
  await next;
});

test('conversation reorder failure after switching characters only rolls back the original cache', async t => {
  const harness = createConversationOrderHarness(t);
  const { runtime, writes, cache } = harness;
  await harness.waitForRead(1);
  await harness.resolveRead(0);
  const saving = runtime.current.reorderConversations(['b', 'c', 'a'], ['a', 'b', 'c']);
  const rejection = assert.rejects(saving, /save failed/);
  harness.selectCharacter({ id: 'char-other', name: 'Other' });
  await harness.waitForRead(2);
  await harness.resolveRead(1, [{ id: 'other', character_id: 'char-other', title: 'Other' }]);
  assert.deepEqual(runtime.current.conversations.map(item => item.id), ['other'], 'another character must still load while saving');
  writes[0].resolve(jsonResponse({ error: 'save failed' }, { status: 500 }));
  await rejection;

  assert.deepEqual(runtime.current.conversations.map(item => item.id), ['other']);
  assert.deepEqual(cache.readCharacterContext('char-order').conversations.map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(cache.readCharacterContext('char-other').conversations.map(item => item.id), ['other']);
  assert.equal(runtime.current.reorderingConversations, false);
});

test('conversation loader applies character context cache before network resolves', async () => {
  const originalFetch = global.fetch;
  const {
    clearCharacterContext,
    writeCharacterContext,
  } = require(path.resolve(__dirname, '../src/lib/character-context-cache.ts'));

  clearCharacterContext();
  writeCharacterContext('char-cached', {
    conversations: [
      {
        id: 'conv-cached',
        character_id: 'char-cached',
        title: 'Cached',
        ignore_memory: 0,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
      },
    ],
    memories: [
      {
        id: 'mem-cached',
        character_id: 'char-cached',
        content: 'from cache',
        category: 'fact',
        tags: [],
        importance: 1,
        status: 'active',
        pinned: 0,
        metadata: {},
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
      },
    ],
  });

  let releaseNetwork;
  const networkGate = new Promise(resolve => {
    releaseNetwork = resolve;
  });
  let networkReached = false;

  global.fetch = async input => {
    const url = new URL(String(input), 'http://test.local');
    await networkGate;
    networkReached = true;
    if (url.pathname === '/api/memories') {
      return jsonResponse([{
        id: 'mem-network',
        character_id: 'char-cached',
        content: 'from network',
        category: 'fact',
        tags: [],
        importance: 1,
        status: 'active',
        pinned: 0,
        metadata: {},
        created_at: '2026-07-02T00:00:00.000Z',
        updated_at: '2026-07-02T00:00:00.000Z',
      }]);
    }
    if (url.pathname === '/api/conversations') {
      return jsonResponse([
        {
          id: 'conv-network',
          character_id: 'char-cached',
          title: 'Network',
          ignore_memory: 0,
          created_at: '2026-07-02T00:00:00.000Z',
          updated_at: '2026-07-02T00:00:00.000Z',
        },
      ], {
        headers: { 'X-Has-More': 'false' },
      });
    }
    throw new Error(`unexpected fetch: ${input}`);
  };

  try {
    const character = { id: 'char-cached', name: 'Cached Char' };
    const clearMessagesRef = { current: () => {} };
    const clearStreamingTextRef = { current: () => {} };
    const runtime = createHookRuntime(
      reactMock => {
        const { useConversationLoader } = requireFreshWithMocks('../src/hooks/chat/useConversationLoader.ts', {
          react: reactMock,
        });
        return useConversationLoader;
      },
      () => ({
        character,
        conversationId: null,
        clearMessagesRef,
        clearStreamingTextRef,
      }),
    );

    runtime.render();
    // 缓存应用走 queueMicrotask，再 render 读取结果；网络仍被 gate 拦住
    await new Promise(resolve => queueMicrotask(resolve));
    runtime.render();

    assert.equal(networkReached, false, 'network must still be gated');
    assert.equal(runtime.current.activeConvId, 'conv-cached');
    assert.equal(runtime.current.conversations[0]?.id, 'conv-cached');
    assert.equal(runtime.current.memories[0]?.id, 'mem-cached');
    assert.equal(runtime.current.loadingThread, false);

    releaseNetwork();
    await new Promise(resolve => setTimeout(resolve, 30));
    runtime.render();

    assert.equal(runtime.current.activeConvId, 'conv-network');
    assert.equal(runtime.current.conversations[0]?.id, 'conv-network');
    assert.equal(runtime.current.memories[0]?.id, 'mem-network');
  } finally {
    global.fetch = originalFetch;
    clearCharacterContext();
  }
});

test('conversation loader ignores stale network when character switches quickly', async () => {
  const originalFetch = global.fetch;
  const {
    clearCharacterContext,
  } = require(path.resolve(__dirname, '../src/lib/character-context-cache.ts'));
  clearCharacterContext();

  /** @type {Record<string, () => void>} */
  const releasers = {};
  /** @type {Record<string, Promise<void>>} */
  const gates = {
    'char-a': new Promise(resolve => { releasers['char-a'] = resolve; }),
    'char-b': new Promise(resolve => { releasers['char-b'] = resolve; }),
  };

  global.fetch = async input => {
    const url = new URL(String(input), 'http://test.local');
    const characterId = url.searchParams.get('character_id') || 'unknown';
    await gates[characterId];
    if (url.pathname === '/api/memories') {
      return jsonResponse([]);
    }
    if (url.pathname === '/api/conversations') {
      return jsonResponse([
        {
          id: `conv-${characterId}`,
          character_id: characterId,
          title: characterId,
          ignore_memory: 0,
          created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-01T00:00:00.000Z',
        },
      ], {
        headers: { 'X-Has-More': 'false' },
      });
    }
    throw new Error(`unexpected fetch: ${input}`);
  };

  try {
    let selected = { id: 'char-a', name: 'A' };
    const clearMessagesRef = { current: () => {} };
    const clearStreamingTextRef = { current: () => {} };
    const runtime = createHookRuntime(
      reactMock => {
        const { useConversationLoader } = requireFreshWithMocks('../src/hooks/chat/useConversationLoader.ts', {
          react: reactMock,
        });
        return useConversationLoader;
      },
      () => ({
        character: selected,
        conversationId: null,
        clearMessagesRef,
        clearStreamingTextRef,
      }),
    );

    runtime.render();
    // 关键：等 char-a 的 revalidate 定时器真正触发、fetch 已在飞（挂在 gate 上）后再切换角色。
    // 若立即切换，effect cleanup 会 clearTimeout 取消 char-a 的请求，测不到「过期响应被丢弃」。
    await new Promise(resolve => setTimeout(resolve, 5));
    selected = { id: 'char-b', name: 'B' };
    runtime.render();
    await new Promise(resolve => setTimeout(resolve, 5));

    // 判别性顺序：先放行 char-b 让新角色应用完成，再放行 char-a——
    // 过期响应**最后**到达仍不得覆盖（若无 seq/characterRef 守卫，char-a 会覆盖终态，此测试必挂）
    releasers['char-b']();
    await new Promise(resolve => setTimeout(resolve, 20));
    runtime.render();
    assert.equal(runtime.current.activeConvId, 'conv-char-b', 'char-b must be applied first');

    releasers['char-a']();
    await new Promise(resolve => setTimeout(resolve, 20));
    runtime.render();

    assert.equal(runtime.current.activeConvId, 'conv-char-b', 'stale char-a response must be dropped');
    assert.equal(runtime.current.conversations[0]?.character_id, 'char-b');
    assert.ok(
      !runtime.current.conversations.some(item => item.character_id === 'char-a'),
      'stale char-a response must not leak into state',
    );
  } finally {
    global.fetch = originalFetch;
    clearCharacterContext();
  }
});

test('conversation loader falls back to persisted character context after browser restart', async () => {
  const originalFetch = global.fetch;
  const {
    __setCharacterContextPersistenceForTests,
    clearCharacterContext,
  } = require(path.resolve(__dirname, '../src/lib/character-context-cache.ts'));
  const { createChatCachePersistence } = require(path.resolve(__dirname, '../src/lib/chat-cache-store.ts'));

  clearCharacterContext();
  const fakePersistence = {
    async hydrate() {
      return [{
        id: 'char-idb',
        snapshot: {
          conversations: [
            {
              id: 'conv-idb',
              character_id: 'char-idb',
              title: 'From IndexedDB',
              ignore_memory: 0,
              created_at: '2026-07-01T00:00:00.000Z',
              updated_at: '2026-07-01T00:00:00.000Z',
            },
          ],
          memories: [
            {
              id: 'mem-idb',
              character_id: 'char-idb',
              content: 'persisted memory',
              category: 'fact',
              tags: [],
              importance: 1,
              status: 'active',
              pinned: 0,
              metadata: {},
              created_at: '2026-07-01T00:00:00.000Z',
              updated_at: '2026-07-01T00:00:00.000Z',
            },
          ],
          savedAt: 100,
        },
      }];
    },
    schedulePut() {},
    remove() {},
    removeAll() {},
  };
  __setCharacterContextPersistenceForTests(fakePersistence);

  let releaseNetwork;
  const networkGate = new Promise(resolve => { releaseNetwork = resolve; });
  let networkReached = false;

  global.fetch = async input => {
    const url = new URL(String(input), 'http://test.local');
    await networkGate;
    networkReached = true;
    if (url.pathname === '/api/memories') {
      return jsonResponse([]);
    }
    if (url.pathname === '/api/conversations') {
      return jsonResponse([
        {
          id: 'conv-network',
          character_id: 'char-idb',
          title: 'Network',
          ignore_memory: 0,
          created_at: '2026-07-02T00:00:00.000Z',
          updated_at: '2026-07-02T00:00:00.000Z',
        },
      ], {
        headers: { 'X-Has-More': 'false' },
      });
    }
    throw new Error(`unexpected fetch: ${input}`);
  };

  try {
    const character = { id: 'char-idb', name: 'IDB Char' };
    const clearMessagesRef = { current: () => {} };
    const clearStreamingTextRef = { current: () => {} };
    const runtime = createHookRuntime(
      reactMock => {
        const { useConversationLoader } = requireFreshWithMocks('../src/hooks/chat/useConversationLoader.ts', {
          react: reactMock,
        });
        return useConversationLoader;
      },
      () => ({
        character,
        conversationId: null,
        clearMessagesRef,
        clearStreamingTextRef,
      }),
    );

    runtime.render();
    // 内存 LRU 未命中 → 走 readCharacterContextAsync（fake hydrate）；等微任务链完成
    await new Promise(resolve => setTimeout(resolve, 10));
    runtime.render();

    assert.equal(networkReached, false, 'network must still be gated');
    assert.equal(runtime.current.activeConvId, 'conv-idb');
    assert.equal(runtime.current.conversations[0]?.id, 'conv-idb');
    assert.equal(runtime.current.memories[0]?.id, 'mem-idb');
    assert.equal(runtime.current.loadingThread, false);

    releaseNetwork();
    await new Promise(resolve => setTimeout(resolve, 30));
    runtime.render();

    assert.equal(runtime.current.activeConvId, 'conv-network');
    assert.equal(runtime.current.conversations[0]?.id, 'conv-network');
  } finally {
    global.fetch = originalFetch;
    __setCharacterContextPersistenceForTests(createChatCachePersistence(null));
    clearCharacterContext();
  }
});

test('conversation loader keeps a manual selection when revalidate resolves later', async () => {
  const originalFetch = global.fetch;
  const {
    clearCharacterContext,
    writeCharacterContext,
  } = require(path.resolve(__dirname, '../src/lib/character-context-cache.ts'));

  clearCharacterContext();
  const cachedConversations = ['conv-1', 'conv-2', 'conv-3'].map(id => ({
    id,
    character_id: 'char-keep',
    title: id,
    ignore_memory: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  }));
  writeCharacterContext('char-keep', { conversations: cachedConversations, memories: [] });

  let releaseNetwork;
  const networkGate = new Promise(resolve => { releaseNetwork = resolve; });

  global.fetch = async input => {
    const url = new URL(String(input), 'http://test.local');
    await networkGate;
    if (url.pathname === '/api/memories') {
      return jsonResponse([]);
    }
    if (url.pathname === '/api/conversations') {
      return jsonResponse(cachedConversations, { headers: { 'X-Has-More': 'false' } });
    }
    throw new Error(`unexpected fetch: ${input}`);
  };

  try {
    const character = { id: 'char-keep', name: 'Keep' };
    const clearMessagesRef = { current: () => {} };
    const clearStreamingTextRef = { current: () => {} };
    const runtime = createHookRuntime(
      reactMock => {
        const { useConversationLoader } = requireFreshWithMocks('../src/hooks/chat/useConversationLoader.ts', {
          react: reactMock,
        });
        return useConversationLoader;
      },
      () => ({
        character,
        conversationId: null,
        clearMessagesRef,
        clearStreamingTextRef,
      }),
    );

    runtime.render();
    await new Promise(resolve => queueMicrotask(resolve));
    runtime.render();
    assert.equal(runtime.current.activeConvId, 'conv-1', 'cache should preselect the newest conversation');

    // 网络还没回来时用户手动切到 conv-3
    runtime.current.selectActiveConvId('conv-3');
    releaseNetwork();
    await new Promise(resolve => setTimeout(resolve, 30));
    runtime.render();

    assert.equal(runtime.current.activeConvId, 'conv-3', 'late revalidate must not stomp the manual selection');
  } finally {
    global.fetch = originalFetch;
    clearCharacterContext();
  }
});
