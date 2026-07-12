const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

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
  applyMessagesResponseToState,
  cacheMessagesResponse,
  clearCachedMessages,
  readCachedMessages,
  updateCachedMessages,
  updateMessagesForConversationState,
  writeCachedMessages,
} = require(path.resolve(__dirname, '../src/lib/chat-message-cache.ts'));

function message(id, seq, conversationId = 'conv-a') {
  return {
    id,
    conversation_id: conversationId,
    role: 'user',
    content: `message ${id}`,
    token_count: 1,
    created_at: `2026-06-05T12:00:${String(seq).padStart(2, '0')}.000Z`,
    seq,
    metadata: {},
  };
}

test('message cache returns null before a conversation is cached', () => {
  clearCachedMessages();

  assert.equal(readCachedMessages('conv-a'), null);
});

test('message cache stores independent snapshots per conversation', () => {
  clearCachedMessages();

  writeCachedMessages('conv-a', {
    messages: [message('a-1', 1)],
    hasMore: true,
    oldestSeq: 1,
    unextractedCount: 2,
    totalTokens: 8,
  });
  writeCachedMessages('conv-b', {
    messages: [{ ...message('b-1', 1), conversation_id: 'conv-b' }],
    hasMore: false,
    oldestSeq: 1,
  });

  assert.deepEqual(readCachedMessages('conv-a'), {
    messages: [message('a-1', 1)],
    hasMore: true,
    oldestSeq: 1,
    unextractedCount: 2,
    totalTokens: 8,
  });
  assert.equal(readCachedMessages('conv-b')?.messages[0].conversation_id, 'conv-b');
});

test('message cache snapshots are not mutated by callers', () => {
  clearCachedMessages();
  const original = [message('a-1', 1)];

  writeCachedMessages('conv-a', {
    messages: original,
    hasMore: false,
    oldestSeq: 1,
  });

  original.push(message('a-2', 2));
  const cached = readCachedMessages('conv-a');
  cached?.messages.push(message('a-3', 3));

  assert.deepEqual(readCachedMessages('conv-a')?.messages.map(item => item.id), ['a-1']);
});

test('message cache snapshots isolate message objects and metadata', () => {
  clearCachedMessages();
  writeCachedMessages('conv-a', {
    messages: [{ ...message('a-1', 1), metadata: { generatedImages: [{ id: 'img-1', status: 'ready' }] } }],
    hasMore: false,
    oldestSeq: 1,
  });

  const cached = readCachedMessages('conv-a');
  cached.messages[0].content = 'mutated';
  cached.messages[0].metadata.generatedImages[0].status = 'failed';

  const next = readCachedMessages('conv-a');
  assert.equal(next.messages[0].content, 'message a-1');
  assert.equal(next.messages[0].metadata.generatedImages[0].status, 'ready');
});

test('message cache preserves server token provenance without sharing nested references', () => {
  clearCachedMessages();
  const provenance = {
    source: 'server',
    version: 1,
    algorithm: 'cl100k_base-v1',
    fingerprint: 'abc123',
  };
  writeCachedMessages('conv-a', {
    messages: [{ ...message('a-1', 1), metadata: { token_count_provenance: provenance } }],
    hasMore: false,
    oldestSeq: 1,
  });

  const cached = readCachedMessages('conv-a');
  cached.messages[0].metadata.token_count_provenance.algorithm = 'mutated';

  assert.deepEqual(readCachedMessages('conv-a').messages[0].metadata.token_count_provenance, provenance);
});

test('message cache updates cached messages without dropping page metadata', () => {
  clearCachedMessages();
  writeCachedMessages('conv-a', {
    messages: [message('a-1', 1), message('a-2', 2)],
    hasMore: true,
    oldestSeq: 1,
    unextractedCount: 3,
    totalTokens: 10,
  });

  updateCachedMessages('conv-a', messages => messages.filter(item => item.id !== 'a-1'));

  const cached = readCachedMessages('conv-a');
  assert.deepEqual(cached.messages.map(item => item.id), ['a-2']);
  assert.equal(cached.hasMore, true);
  assert.equal(cached.oldestSeq, 1);
  assert.equal(cached.unextractedCount, 3);
  assert.equal(cached.totalTokens, 10);
});

test('message cache preserves previous metadata when a later write only updates messages', () => {
  clearCachedMessages();

  writeCachedMessages('conv-a', {
    messages: [message('a-1', 1)],
    hasMore: true,
    oldestSeq: 1,
    unextractedCount: 3,
    totalTokens: 10,
  });
  writeCachedMessages('conv-a', {
    messages: [message('a-1', 1), message('a-2', 2)],
    hasMore: false,
    oldestSeq: 1,
  });

  const cached = readCachedMessages('conv-a');
  assert.equal(cached?.unextractedCount, 3);
  assert.equal(cached?.totalTokens, 10);
  assert.equal(cached?.hasMore, false);
});

test('message response state helper caches inactive conversation refreshes without touching active UI', () => {
  clearCachedMessages();
  const response = {
    messages: [message('bg-1', 1, 'conv-bg'), message('bg-1', 1, 'conv-bg')],
    hasMore: false,
    oldestSeq: 1,
    unextractedCount: 4,
    totalTokens: 12,
  };
  const calls = [];

  const applied = applyMessagesResponseToState('conv-bg', response, {
    getActiveConversationId: () => 'conv-active',
    replaceMessages: () => calls.push('replaceMessages'),
    setHasOlderMessages: () => calls.push('setHasOlderMessages'),
    setOldestLoadedSeq: () => calls.push('setOldestLoadedSeq'),
    setServerUnextractedCount: () => calls.push('setServerUnextractedCount'),
    setServerTotalTokens: () => calls.push('setServerTotalTokens'),
  });

  assert.equal(applied, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(readCachedMessages('conv-bg')?.messages.map(item => item.id), ['bg-1']);
  assert.equal(readCachedMessages('conv-bg')?.unextractedCount, 4);
  assert.equal(readCachedMessages('conv-bg')?.totalTokens, 12);
});

test('message response state helper applies active conversation response to UI and cache', () => {
  clearCachedMessages();
  const response = {
    messages: [message('a-1', 1), message('a-2', 2)],
    hasMore: true,
    oldestSeq: 1,
    unextractedCount: 2,
    totalTokens: 8,
  };
  const ui = {};

  const applied = applyMessagesResponseToState('conv-a', response, {
    getActiveConversationId: () => 'conv-a',
    replaceMessages: messages => { ui.messages = messages; },
    setHasOlderMessages: hasMore => { ui.hasMore = hasMore; },
    setOldestLoadedSeq: oldestSeq => { ui.oldestSeq = oldestSeq; },
    setServerUnextractedCount: count => { ui.unextractedCount = count; },
    setServerTotalTokens: total => { ui.totalTokens = total; },
  });

  assert.equal(applied, true);
  assert.deepEqual(ui.messages.map(item => item.id), ['a-1', 'a-2']);
  assert.equal(ui.hasMore, true);
  assert.equal(ui.oldestSeq, 1);
  assert.equal(ui.unextractedCount, 2);
  assert.deepEqual(ui.totalTokens, { convId: 'conv-a', value: 8 });
  assert.deepEqual(readCachedMessages('conv-a')?.messages.map(item => item.id), ['a-1', 'a-2']);
});

test('message mutation state helper updates inactive cache without flashing active UI', () => {
  clearCachedMessages();
  writeCachedMessages('conv-active', {
    messages: [message('active-1', 1, 'conv-active')],
    hasMore: false,
    oldestSeq: 1,
    unextractedCount: 7,
    totalTokens: 21,
  });
  writeCachedMessages('conv-bg', {
    messages: [message('bg-1', 1, 'conv-bg'), message('bg-2', 2, 'conv-bg')],
    hasMore: false,
    oldestSeq: 1,
  });
  let uiTouched = false;

  updateMessagesForConversationState('conv-bg', messages => messages.filter(item => item.id !== 'bg-1'), {
    getActiveConversationId: () => 'conv-active',
    updateMessages: () => { uiTouched = true; },
  });

  assert.equal(uiTouched, false);
  assert.deepEqual(readCachedMessages('conv-bg')?.messages.map(item => item.id), ['bg-2']);
  assert.deepEqual(readCachedMessages('conv-active')?.messages.map(item => item.id), ['active-1']);
  assert.equal(readCachedMessages('conv-active')?.unextractedCount, 7);
  assert.equal(readCachedMessages('conv-active')?.totalTokens, 21);
});

test('background message responses interleaved with an active refresh do not pollute current UI or cache', () => {
  clearCachedMessages();
  const ui = {};
  const handlers = {
    getActiveConversationId: () => 'conv-active',
    replaceMessages: messages => { ui.messages = messages; },
    setHasOlderMessages: hasMore => { ui.hasMore = hasMore; },
    setOldestLoadedSeq: oldestSeq => { ui.oldestSeq = oldestSeq; },
    setServerUnextractedCount: count => { ui.unextractedCount = count; },
    setServerTotalTokens: total => { ui.totalTokens = total; },
  };

  assert.equal(applyMessagesResponseToState('conv-active', {
    messages: [message('active-new', 2, 'conv-active')],
    hasMore: false,
    oldestSeq: 2,
    unextractedCount: 1,
    totalTokens: 11,
  }, handlers), true);
  assert.equal(applyMessagesResponseToState('conv-bg', {
    messages: [message('bg-old', 1, 'conv-bg')],
    hasMore: true,
    oldestSeq: 1,
    unextractedCount: 9,
    totalTokens: 99,
  }, handlers), false);

  assert.deepEqual(ui.messages.map(item => item.id), ['active-new']);
  assert.equal(ui.hasMore, false);
  assert.equal(ui.oldestSeq, 2);
  assert.equal(ui.unextractedCount, 1);
  assert.deepEqual(ui.totalTokens, { convId: 'conv-active', value: 11 });
  assert.deepEqual(readCachedMessages('conv-active')?.messages.map(item => item.id), ['active-new']);
  assert.equal(readCachedMessages('conv-active')?.unextractedCount, 1);
  assert.equal(readCachedMessages('conv-active')?.totalTokens, 11);
  assert.deepEqual(readCachedMessages('conv-bg')?.messages.map(item => item.id), ['bg-old']);
  assert.equal(readCachedMessages('conv-bg')?.unextractedCount, 9);
  assert.equal(readCachedMessages('conv-bg')?.totalTokens, 99);
});

test('message mutation state helper updates active UI and cached metadata together', () => {
  clearCachedMessages();
  const initialMessage = {
    ...message('a-1', 1),
    metadata: { generatedImages: [{ id: 'img-1', status: 'pending_image' }] },
  };
  writeCachedMessages('conv-a', {
    messages: [initialMessage],
    hasMore: false,
    oldestSeq: 1,
  });
  let uiMessages = [initialMessage];

  updateMessagesForConversationState('conv-a', messages => messages.map(item => (
    item.id === 'a-1'
      ? { ...item, metadata: { generatedImages: [{ id: 'img-1', status: 'ready' }] } }
      : item
  )), {
    getActiveConversationId: () => 'conv-a',
    updateMessages: updater => { uiMessages = updater(uiMessages); },
  });

  assert.equal(uiMessages[0].metadata.generatedImages[0].status, 'ready');
  assert.equal(readCachedMessages('conv-a')?.messages[0].metadata.generatedImages[0].status, 'ready');
});

test('cacheMessagesResponse deduplicates server responses before storing the snapshot', () => {
  clearCachedMessages();

  const nextMessages = cacheMessagesResponse('conv-a', {
    messages: [message('a-1', 1), message('a-1', 1), message('a-2', 2)],
    hasMore: false,
    oldestSeq: 1,
  });

  assert.deepEqual(nextMessages.map(item => item.id), ['a-1', 'a-2']);
  assert.deepEqual(readCachedMessages('conv-a')?.messages.map(item => item.id), ['a-1', 'a-2']);
});

test('message cache evicts least-recently-used conversations when it grows past the cache limit', () => {
  clearCachedMessages();

  for (let i = 0; i < 55; i += 1) {
    writeCachedMessages(`conv-${String(i).padStart(2, '0')}`, {
      messages: [message(`msg-${i}`, i, `conv-${String(i).padStart(2, '0')}`)],
      hasMore: false,
      oldestSeq: i,
    });
  }
  readCachedMessages('conv-10');
  writeCachedMessages('conv-new', {
    messages: [message('msg-new', 100, 'conv-new')],
    hasMore: false,
    oldestSeq: 100,
  });

  assert.equal(readCachedMessages('conv-00'), null);
  assert.notEqual(readCachedMessages('conv-10'), null);
  assert.notEqual(readCachedMessages('conv-new'), null);
});
