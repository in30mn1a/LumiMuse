const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

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

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          body,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function invalidJsonRequest(url = 'http://test.local/api/test') {
  return {
    nextUrl: new URL(url),
    signal: new AbortController().signal,
    async json() {
      throw new SyntaxError('Unexpected token');
    },
  };
}

function jsonRequest(body, url = 'http://test.local/api/test') {
  return {
    nextUrl: new URL(url),
    signal: new AbortController().signal,
    async json() {
      return body;
    },
  };
}

async function assertJsonError(response, status, error) {
  assert.equal(response.status, status);
  const payload = await response.json();
  assert.equal(payload.error, error);
}

async function withSilencedConsoleError(callback) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.error = originalError;
  }
}

function failIfCalled(name) {
  return () => {
    throw new Error(`${name} should not be called for invalid request body`);
  };
}

test('/api/settings PUT returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/settings/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
  });

  const response = await route.PUT(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/characters/reorder PUT returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/characters/reorder/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.PUT(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/characters/reorder PUT returns 400 for a non-object body', async () => {
  const route = requireFreshWithMocks('../src/app/api/characters/reorder/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.PUT(jsonRequest([]));

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/providers/activate POST returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/providers/activate/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.POST(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/providers/activate POST returns 400 for a non-object body', async () => {
  const route = requireFreshWithMocks('../src/app/api/providers/activate/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.POST(jsonRequest([]));

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/characters/[id]/images DELETE returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/characters/[id]/images/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/character-file-utils': {
      deleteLocalAssetUrls: failIfCalled('deleteLocalAssetUrls'),
      filterUnreferencedLocalAssetUrls: failIfCalled('filterUnreferencedLocalAssetUrls'),
    },
    '@/lib/generated-image-assets': {
      collectUniqueGeneratedImageItems: failIfCalled('collectUniqueGeneratedImageItems'),
      removeGeneratedImageReferences: failIfCalled('removeGeneratedImageReferences'),
    },
  });

  const response = await route.DELETE(invalidJsonRequest(), { params: Promise.resolve({ id: 'char-1' }) });

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/characters/[id]/images DELETE returns 400 for a non-object body', async () => {
  const route = requireFreshWithMocks('../src/app/api/characters/[id]/images/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/character-file-utils': {
      deleteLocalAssetUrls: failIfCalled('deleteLocalAssetUrls'),
      filterUnreferencedLocalAssetUrls: failIfCalled('filterUnreferencedLocalAssetUrls'),
    },
    '@/lib/generated-image-assets': {
      collectUniqueGeneratedImageItems: failIfCalled('collectUniqueGeneratedImageItems'),
      removeGeneratedImageReferences: failIfCalled('removeGeneratedImageReferences'),
    },
  });

  const response = await route.DELETE(jsonRequest([]), { params: Promise.resolve({ id: 'char-1' }) });

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/image-gen/delete POST returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/image-gen/delete/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/character-file-utils': {
      deleteLocalAssetUrls: failIfCalled('deleteLocalAssetUrls'),
      filterUnreferencedLocalAssetUrls: failIfCalled('filterUnreferencedLocalAssetUrls'),
    },
  });

  const response = await route.POST(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/image-gen/delete POST returns 400 for a non-object body', async () => {
  const route = requireFreshWithMocks('../src/app/api/image-gen/delete/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/character-file-utils': {
      deleteLocalAssetUrls: failIfCalled('deleteLocalAssetUrls'),
      filterUnreferencedLocalAssetUrls: failIfCalled('filterUnreferencedLocalAssetUrls'),
    },
  });

  const response = await route.POST(jsonRequest([]));

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/characters/generate POST returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/characters/generate/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
    '@/lib/api-client': { chatCompletion: failIfCalled('chatCompletion') },
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.POST(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/characters/generate POST returns 400 for a non-object body', async () => {
  const route = requireFreshWithMocks('../src/app/api/characters/generate/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
    '@/lib/api-client': { chatCompletion: failIfCalled('chatCompletion') },
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.POST(jsonRequest([]));

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/characters/generate POST does not leak raw upstream errors', async () => {
  const route = requireFreshWithMocks('../src/app/api/characters/generate/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/settings': {
      loadSettings() {
        return {
          api_base: 'https://api.example.test',
          api_key: 'secret',
          model: 'model',
        };
      },
    },
    '@/lib/api-client': {
      async chatCompletion() {
        throw new Error('upstream secret stack detail');
      },
    },
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await withSilencedConsoleError(() => route.POST(jsonRequest({ requirement: '生成一个角色' })));

  await assertJsonError(response, 500, '生成角色失败');
});

test('/api/characters/generate POST passes the request signal to the LLM call', async () => {
  const controller = new AbortController();
  let seenSignal = null;
  const route = requireFreshWithMocks('../src/app/api/characters/generate/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/settings': {
      loadSettings() {
        return {
          api_base: 'https://api.example.test',
          api_key: 'secret',
          model: 'model',
        };
      },
    },
    '@/lib/api-client': {
      async chatCompletion(_settings, _messages, signal) {
        seenSignal = signal;
        return JSON.stringify({
          name: '测试角色',
          basic_info: '',
          personality: '',
          scenario: '',
          greeting: '',
          example_dialogue: '',
          system_prompt: '',
          other_info: '',
          image_tags: '',
        });
      },
    },
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.POST({
    ...jsonRequest({ requirement: '生成一个角色' }),
    signal: controller.signal,
  });

  assert.equal(response.status, 200);
  assert.equal(seenSignal, controller.signal);
});

test('/api/settings PUT returns 400 for a non-object body', async () => {
  const route = requireFreshWithMocks('../src/app/api/settings/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
  });

  const response = await route.PUT(jsonRequest([]));

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/summarize POST returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/summarize/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.POST(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/summarize POST uses NextResponse.json for structured error responses', async () => {
  const calls = [];
  const route = requireFreshWithMocks('../src/app/api/summarize/route.ts', {
    'next/server': {
      NextResponse: {
        json(body, init = {}) {
          calls.push({ body, init });
          return {
            status: init.status ?? 200,
            async json() {
              return body;
            },
          };
        },
      },
    },
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.POST(jsonRequest({}));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: 'Missing conversation_id' });
  assert.deepEqual(calls, [{ body: { error: 'Missing conversation_id' }, init: { status: 400 } }]);
});

test('/api/image-gen POST returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/image-gen/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
    '@/lib/ssrf-guard': { safeFetch: failIfCalled('safeFetch') },
    'fs/promises': { writeFile: failIfCalled('writeFile'), mkdir: failIfCalled('mkdir') },
  });

  const response = await route.POST(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/image-gen POST returns 400 for a non-object override', async () => {
  const route = requireFreshWithMocks('../src/app/api/image-gen/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
    '@/lib/ssrf-guard': { safeFetch: failIfCalled('safeFetch') },
    'fs/promises': { writeFile: failIfCalled('writeFile'), mkdir: failIfCalled('mkdir') },
  });

  const response = await route.POST(jsonRequest({ prompt: 'portrait', override: [] }));

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/image-gen/prompt POST returns 400 for invalid JSON', async () => {
  const route = requireFreshWithMocks('../src/app/api/image-gen/prompt/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/settings': {
      loadSettings: failIfCalled('loadSettings'),
      resolveBackgroundConfig: failIfCalled('resolveBackgroundConfig'),
      buildBackgroundChatExtraBody: failIfCalled('buildBackgroundChatExtraBody'),
      mergeSettingsForBackgroundLlm: failIfCalled('mergeSettingsForBackgroundLlm'),
    },
    '@/lib/api-client': { chatCompletion: failIfCalled('chatCompletion') },
  });

  const response = await route.POST(invalidJsonRequest());

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/image-gen/prompt POST schema rejects missing conversation_id before loading settings', async () => {
  const route = requireFreshWithMocks('../src/app/api/image-gen/prompt/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/settings': {
      loadSettings: failIfCalled('loadSettings'),
      resolveBackgroundConfig: failIfCalled('resolveBackgroundConfig'),
      buildBackgroundChatExtraBody: failIfCalled('buildBackgroundChatExtraBody'),
      mergeSettingsForBackgroundLlm: failIfCalled('mergeSettingsForBackgroundLlm'),
    },
    '@/lib/api-client': { chatCompletion: failIfCalled('chatCompletion') },
  });

  const response = await route.POST(jsonRequest({ user_hint: 'portrait' }));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Invalid request body');
  assert.ok(payload.fieldErrors.conversation_id.length > 0);
});

test('/api/memory-index POST returns 400 for invalid JSON without rebuilding', async () => {
  const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
    '@/lib/memory-embeddings': {
      ensureMemoryEmbeddingTables: failIfCalled('ensureMemoryEmbeddingTables'),
      enqueueRebuildMemoryEmbeddings: failIfCalled('enqueueRebuildMemoryEmbeddings'),
      enqueueUnindexedMemoryEmbeddings: failIfCalled('enqueueUnindexedMemoryEmbeddings'),
      retryFailedMemoryEmbeddings: failIfCalled('retryFailedMemoryEmbeddings'),
      clearMemoryIndex: failIfCalled('clearMemoryIndex'),
      stopCurrentMemoryIndexTasks: failIfCalled('stopCurrentMemoryIndexTasks'),
      getMemoryIndexStatus: failIfCalled('getMemoryIndexStatus'),
    },
    '@/lib/memory-index-trigger': {
      getMemoryIndexProcessingBlockedReason: () => undefined,
      stopMemoryIndexProcessing: failIfCalled('stopMemoryIndexProcessing'),
      triggerMemoryIndexProcessing: failIfCalled('triggerMemoryIndexProcessing'),
    },
  });

  const response = await route.POST(invalidJsonRequest('http://test.local/api/memory-index?character_id=char-1'));

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/memory-index POST returns 400 for a non-object body', async () => {
  const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
    '@/lib/memory-embeddings': {
      ensureMemoryEmbeddingTables: failIfCalled('ensureMemoryEmbeddingTables'),
      enqueueRebuildMemoryEmbeddings: failIfCalled('enqueueRebuildMemoryEmbeddings'),
      enqueueUnindexedMemoryEmbeddings: failIfCalled('enqueueUnindexedMemoryEmbeddings'),
      retryFailedMemoryEmbeddings: failIfCalled('retryFailedMemoryEmbeddings'),
      clearMemoryIndex: failIfCalled('clearMemoryIndex'),
      stopCurrentMemoryIndexTasks: failIfCalled('stopCurrentMemoryIndexTasks'),
      getMemoryIndexStatus: failIfCalled('getMemoryIndexStatus'),
    },
    '@/lib/memory-index-trigger': {
      getMemoryIndexProcessingBlockedReason: () => undefined,
      stopMemoryIndexProcessing: failIfCalled('stopMemoryIndexProcessing'),
      triggerMemoryIndexProcessing: failIfCalled('triggerMemoryIndexProcessing'),
    },
  });

  const response = await route.POST(jsonRequest([], 'http://test.local/api/memory-index?character_id=char-1'));

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/memory-index POST rejects actions outside the enum without rebuilding', async () => {
  const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
    '@/lib/settings': { loadSettings: failIfCalled('loadSettings') },
    '@/lib/memory-embeddings': {
      ensureMemoryEmbeddingTables: failIfCalled('ensureMemoryEmbeddingTables'),
      enqueueRebuildMemoryEmbeddings: failIfCalled('enqueueRebuildMemoryEmbeddings'),
      enqueueUnindexedMemoryEmbeddings: failIfCalled('enqueueUnindexedMemoryEmbeddings'),
      retryFailedMemoryEmbeddings: failIfCalled('retryFailedMemoryEmbeddings'),
      clearMemoryIndex: failIfCalled('clearMemoryIndex'),
      stopCurrentMemoryIndexTasks: failIfCalled('stopCurrentMemoryIndexTasks'),
      getMemoryIndexStatus: failIfCalled('getMemoryIndexStatus'),
    },
    '@/lib/memory-index-trigger': {
      getMemoryIndexProcessingBlockedReason: () => undefined,
      stopMemoryIndexProcessing: failIfCalled('stopMemoryIndexProcessing'),
      triggerMemoryIndexProcessing: failIfCalled('triggerMemoryIndexProcessing'),
    },
  });

  const response = await route.POST(jsonRequest(
    { action: 'rebuild_all' },
    'http://test.local/api/memory-index?character_id=char-1',
  ));

  await assertJsonError(response, 400, 'unsupported memory index action');
});

test('/api/conversations/[id]/reset-extraction POST returns 400 for invalid JSON without updating metadata', async () => {
  const route = requireFreshWithMocks('../src/app/api/conversations/[id]/reset-extraction/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.POST(invalidJsonRequest(), { params: Promise.resolve({ id: 'conv-1' }) });

  await assertJsonError(response, 400, 'Invalid JSON body');
});

test('/api/conversations/[id]/reset-extraction POST rejects actions outside the enum without updating metadata', async () => {
  const route = requireFreshWithMocks('../src/app/api/conversations/[id]/reset-extraction/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: failIfCalled('getDb') },
  });

  const response = await route.POST(
    jsonRequest({ action: 'clear' }),
    { params: Promise.resolve({ id: 'conv-1' }) },
  );

  await assertJsonError(response, 400, 'Invalid request body');
});

test('/api/conversations/[id]/reset-extraction POST accepts an empty object as default reset', async () => {
  const rows = [
    { id: 'msg-user-1', role: 'user', metadata: JSON.stringify({ memory_extracted: true, keep: 'yes' }) },
    { id: 'msg-assistant-1', role: 'assistant', metadata: JSON.stringify({ memory_extracted: true }) },
  ];
  const updates = [];
  const db = {
    prepare(sql) {
      if (sql.startsWith('SELECT id, metadata, role FROM messages')) {
        return { all: (conversationId) => {
          assert.equal(conversationId, 'conv-1');
          return rows;
        } };
      }
      if (sql.startsWith('UPDATE messages SET metadata = ? WHERE id = ?')) {
        return { run: (metadata, id) => updates.push({ metadata, id }) };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    transaction(fn) {
      return () => fn();
    },
  };
  const route = requireFreshWithMocks('../src/app/api/conversations/[id]/reset-extraction/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const response = await route.POST(jsonRequest({}), { params: Promise.resolve({ id: 'conv-1' }) });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { resetCount: 1, action: 'reset' });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'msg-user-1');
  assert.deepEqual(JSON.parse(updates[0].metadata), { keep: 'yes' });
});

test('/api/conversations/[id]/reset-extraction POST rolls back all metadata updates when one update fails', async () => {
  let rows = [
    { id: 'msg-user-1', role: 'user', metadata: JSON.stringify({ memory_extracted: true, keep: 'one' }) },
    { id: 'msg-user-2', role: 'user', metadata: JSON.stringify({ memory_extracted: true, keep: 'two' }) },
  ];
  const db = {
    prepare(sql) {
      if (sql.startsWith('SELECT id, metadata, role FROM messages')) {
        return { all: () => rows.map(row => ({ ...row })) };
      }
      if (sql.startsWith('UPDATE messages SET metadata = ? WHERE id = ?')) {
        return {
          run(metadata, id) {
            if (id === 'msg-user-2') throw new Error('simulated write failure');
            rows = rows.map(row => row.id === id ? { ...row, metadata } : row);
          },
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    transaction(fn) {
      return () => {
        const before = rows.map(row => ({ ...row }));
        try {
          return fn();
        } catch (error) {
          rows = before;
          throw error;
        }
      };
    },
  };
  const route = requireFreshWithMocks('../src/app/api/conversations/[id]/reset-extraction/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const response = await route.POST(jsonRequest({}), { params: Promise.resolve({ id: 'conv-1' }) });
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.error, 'Failed to reset extraction state');
  assert.deepEqual(rows.map(row => JSON.parse(row.metadata)), [
    { memory_extracted: true, keep: 'one' },
    { memory_extracted: true, keep: 'two' },
  ]);
});
