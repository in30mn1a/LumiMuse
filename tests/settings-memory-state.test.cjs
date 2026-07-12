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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHookRuntime(hookFactory, optionsFactory) {
  const stateValues = [];
  const refValues = [];
  let stateCursor = 0;
  let refCursor = 0;
  let currentResult;
  let isRendering = false;

  const reactMock = {
    useCallback: callback => callback,
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
        stateValues[index] = typeof nextValue === 'function' ? nextValue(stateValues[index]) : nextValue;
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
    headers: { 'Content-Type': 'application/json' },
  });
}

test('memory profile loading stays true when an older request finishes after a newer one starts', async () => {
  const responses = new Map([
    ['A', createDeferred()],
    ['B', createDeferred()],
  ]);
  const requestedCharacters = [];
  const memoryManagementCharacterIdRef = { current: 'A' };

  const originalFetch = global.fetch;
  global.fetch = async url => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    const characterId = parsedUrl.searchParams.get('character_id');
    requestedCharacters.push(characterId);
    const deferred = responses.get(characterId);
    assert.ok(deferred, `unexpected character request: ${characterId}`);
    return deferred.promise;
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryProfilePanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryProfilePanel.ts', {
          react: reactMock,
        });
        return useMemoryProfilePanel;
      },
      () => ({
        characterId: memoryManagementCharacterIdRef.current,
        memoryManagementCharacterIdRef,
        loadMemoryDiagnostics: async () => {},
        t: key => key,
        showToast: () => {},
      }),
    );

    runtime.render();
    const firstLoad = runtime.current.loadMemoryProfile('A');
    assert.equal(runtime.current.memoryProfileLoading, true);

    memoryManagementCharacterIdRef.current = 'B';
    const secondLoad = runtime.current.loadMemoryProfile('B');
    assert.equal(runtime.current.memoryProfileLoading, true);

    responses.get('A').resolve(jsonResponse({ profile: null, versions: [], tasks: [] }));
    await firstLoad;

    assert.deepEqual(requestedCharacters, ['A', 'B']);
    assert.equal(
      runtime.current.memoryProfileLoading,
      true,
      'old A finally must not clear B loading while B is still pending',
    );

    responses.get('B').resolve(jsonResponse({ profile: null, versions: [], tasks: [] }));
    await secondLoad;
    assert.equal(runtime.current.memoryProfileLoading, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('memory profile init preserves the no_active_memories business result while using HTTP errors', async () => {
  const toastMessages = [];
  const memoryManagementCharacterIdRef = { current: 'A' };

  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    if (parsedUrl.pathname === '/api/memory-profile' && init.method === 'POST') {
      return jsonResponse({ ok: false, error: 'no_active_memories' }, { status: 400 });
    }
    if (parsedUrl.pathname === '/api/memory-profile') {
      return jsonResponse({ profile: null, versions: [], tasks: [] });
    }
    throw new Error(`unexpected request: ${String(url)}`);
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryProfilePanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryProfilePanel.ts', {
          react: reactMock,
        });
        return useMemoryProfilePanel;
      },
      () => ({
        characterId: memoryManagementCharacterIdRef.current,
        memoryManagementCharacterIdRef,
        loadMemoryDiagnostics: async () => {},
        t: key => key,
        showToast: (message, type) => toastMessages.push({ message, type }),
      }),
    );

    runtime.render();
    await runtime.current.handleMemoryProfileAction('init_from_memories');

    assert.equal(runtime.current.memoryProfileActionLoading, false);
    assert.deepEqual(toastMessages, [
      { message: 'settings.memoryProfileInitFromMemoriesStarted', type: 'success' },
      { message: 'settings.memoryProfileInitFromMemoriesNoMemories', type: 'error' },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('memory archive AI state is aborted and cleared on character change without writing old results', async () => {
  const aiArchiveRequest = createDeferred();
  const followUpRequests = [];
  const toastMessages = [];
  const memoryManagementCharacterIdRef = { current: 'A' };
  let capturedSignal = null;

  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    if (parsedUrl.pathname === '/api/memory-archive' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.action === 'ai_archive') {
        capturedSignal = init.signal;
        return aiArchiveRequest.promise;
      }
    }

    followUpRequests.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    return jsonResponse({ memories: [], batches: [], total: 0, hasMore: false, offset: 0 });
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryArchivePanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryArchivePanel.ts', {
          react: reactMock,
        });
        return useMemoryArchivePanel;
      },
      () => ({
        characterId: memoryManagementCharacterIdRef.current,
        memoryManagementCharacterIdRef,
        loadMemoryDiagnostics: async () => followUpRequests.push({ url: 'diagnostics', body: null }),
        loadMemoryIndexStatus: async () => followUpRequests.push({ url: 'index-status', body: null }),
        t: key => key,
        showToast: message => toastMessages.push(message),
      }),
    );

    runtime.render();
    const archiveAi = runtime.current.handleMemoryArchiveAi();
    assert.equal(runtime.current.memoryArchiveAiRunning, true);
    assert.equal(runtime.current.memoryArchiveLoading, true);

    memoryManagementCharacterIdRef.current = 'B';
    runtime.current.resetArchiveForCharacterChange();

    assert.equal(capturedSignal.aborted, true, 'character change should abort the previous AI archive request');
    assert.equal(runtime.current.memoryArchiveAiRunning, false);
    assert.equal(runtime.current.memoryArchiveLoading, false);

    aiArchiveRequest.resolve(jsonResponse({
      ok: true,
      status: 'archived',
      archive_count: 1,
      summary: 'A summary should stay on A',
      plan: {
        summaryMemory: { id: 'summary-A', content: 'summary A' },
        coveredMemoryUpdates: [{ id: 'memory-A', status: 'summarized' }],
      },
    }));
    await archiveAi;

    assert.equal(runtime.current.memoryArchiveAiRunning, false);
    assert.equal(runtime.current.memoryArchiveLoading, false);
    assert.equal(runtime.current.memoryArchivePlan, null);
    assert.equal(runtime.current.memoryArchiveSummary, '');
    assert.deepEqual(toastMessages, []);
    assert.deepEqual(followUpRequests, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test('memory archive list ignores an older character response while the new character is loading', async () => {
  const responses = new Map([
    ['A', createDeferred()],
    ['B', createDeferred()],
  ]);
  const memoryManagementCharacterIdRef = { current: 'A' };

  const originalFetch = global.fetch;
  global.fetch = async url => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    const characterId = parsedUrl.searchParams.get('character_id');
    const deferred = responses.get(characterId);
    assert.ok(deferred, `unexpected archive list request: ${characterId}`);
    return deferred.promise;
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryArchivePanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryArchivePanel.ts', {
          react: reactMock,
        });
        return useMemoryArchivePanel;
      },
      () => ({
        characterId: memoryManagementCharacterIdRef.current,
        memoryManagementCharacterIdRef,
        loadMemoryDiagnostics: async () => {},
        loadMemoryIndexStatus: async () => {},
        t: key => key,
        showToast: () => {},
      }),
    );

    runtime.render();
    const firstLoad = runtime.current.loadMemoryArchiveMemories('A');
    assert.equal(runtime.current.memoryArchiveListLoading, true);

    memoryManagementCharacterIdRef.current = 'B';
    const secondLoad = runtime.current.loadMemoryArchiveMemories('B');
    assert.equal(runtime.current.memoryArchiveListLoading, true);

    responses.get('A').resolve(jsonResponse({
      memories: [{ id: 'memory-A', category: 'preference', content: 'A memory', status: 'active', pinned: false, updated_at: '2026-06-07' }],
      total: 1,
      hasMore: false,
      offset: 0,
    }));
    await firstLoad;

    assert.equal(runtime.current.memoryArchiveListLoading, true);
    assert.deepEqual(runtime.current.memoryArchiveMemories, []);

    responses.get('B').resolve(jsonResponse({
      memories: [{ id: 'memory-B', category: 'preference', content: 'B memory', status: 'active', pinned: false, updated_at: '2026-06-07' }],
      total: 1,
      hasMore: false,
      offset: 0,
    }));
    await secondLoad;

    assert.equal(runtime.current.memoryArchiveListLoading, false);
    assert.deepEqual(runtime.current.memoryArchiveMemories.map(memory => memory.id), ['memory-B']);
    assert.equal(runtime.current.memoryArchiveTotal, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('memory archive batches ignore an older same-character response after a newer batch load starts', async () => {
  const firstBatches = createDeferred();
  const secondBatches = createDeferred();
  const requestedCharacters = [];
  const memoryManagementCharacterIdRef = { current: 'A' };

  const originalFetch = global.fetch;
  global.fetch = async url => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    assert.equal(parsedUrl.pathname, '/api/memory-archive');
    const characterId = parsedUrl.searchParams.get('character_id');
    requestedCharacters.push(characterId);
    if (requestedCharacters.length === 1) return firstBatches.promise;
    if (requestedCharacters.length === 2) return secondBatches.promise;
    throw new Error(`unexpected archive batch request: ${url}`);
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryArchivePanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryArchivePanel.ts', {
          react: reactMock,
        });
        return useMemoryArchivePanel;
      },
      () => ({
        characterId: memoryManagementCharacterIdRef.current,
        memoryManagementCharacterIdRef,
        loadMemoryDiagnostics: async () => {},
        loadMemoryIndexStatus: async () => {},
        t: key => key,
        showToast: () => {},
      }),
    );

    runtime.render();
    const staleLoad = runtime.current.loadMemoryArchiveBatches('A');
    const currentLoad = runtime.current.loadMemoryArchiveBatches('A');

    secondBatches.resolve(jsonResponse({
      batches: [{
        batch_id: 'batch-new',
        summary_memory_id: 'summary-new',
        summary_content: 'new summary',
        covered_count: 2,
        updated_at: '2026-06-07T00:01:00.000Z',
      }],
    }));
    await currentLoad;

    assert.deepEqual(runtime.current.memoryArchiveBatches.map(batch => batch.batch_id), ['batch-new']);
    assert.equal(runtime.current.selectedMemoryArchiveBatchId, 'batch-new');

    firstBatches.resolve(jsonResponse({
      batches: [{
        batch_id: 'batch-old',
        summary_memory_id: 'summary-old',
        summary_content: 'old summary',
        covered_count: 1,
        updated_at: '2026-06-07T00:00:00.000Z',
      }],
    }));
    await staleLoad;

    assert.deepEqual(requestedCharacters, ['A', 'A']);
    assert.deepEqual(runtime.current.memoryArchiveBatches.map(batch => batch.batch_id), ['batch-new']);
    assert.equal(runtime.current.selectedMemoryArchiveBatchId, 'batch-new');
  } finally {
    global.fetch = originalFetch;
  }
});

test('memory archive preview response cannot overwrite a newer execute action', async () => {
  const previewA = createDeferred();
  const executeB = createDeferred();
  const followUpRequests = [];
  const refreshes = [];
  const memoryManagementCharacterIdRef = { current: 'A' };

  const planA = {
    summaryMemory: { id: 'summary-A', content: 'summary A' },
    coveredMemoryUpdates: [{ id: 'memory-A', status: 'summarized' }],
  };
  const planB = {
    summaryMemory: { id: 'summary-B', content: 'summary B' },
    coveredMemoryUpdates: [{ id: 'memory-B', status: 'summarized' }],
  };

  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    if (parsedUrl.pathname === '/api/memory-archive' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.action === 'preview' && body.character_id === 'A') return previewA.promise;
      if (body.action === 'execute' && body.character_id === 'B') return executeB.promise;
      throw new Error(`unexpected archive action: ${JSON.stringify(body)}`);
    }
    if (parsedUrl.pathname === '/api/memories') {
      followUpRequests.push(`memories:${parsedUrl.searchParams.get('character_id')}`);
      return jsonResponse({ memories: [], total: 0, hasMore: false, offset: 0 });
    }
    if (parsedUrl.pathname === '/api/memory-archive') {
      followUpRequests.push(`batches:${parsedUrl.searchParams.get('character_id')}`);
      return jsonResponse({ batches: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryArchivePanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryArchivePanel.ts', {
          react: reactMock,
        });
        return useMemoryArchivePanel;
      },
      () => ({
        characterId: memoryManagementCharacterIdRef.current,
        memoryManagementCharacterIdRef,
        loadMemoryDiagnostics: async () => refreshes.push('diagnostics'),
        loadMemoryIndexStatus: async () => refreshes.push('index-status'),
        t: key => key,
        showToast: () => {},
      }),
    );

    runtime.render();
    runtime.current.setMemoryArchiveSummary('summary A');
    runtime.current.toggleMemoryArchiveSelection('memory-A');
    const stalePreview = runtime.current.handleMemoryArchivePreview();
    assert.equal(runtime.current.memoryArchiveLoading, true);

    memoryManagementCharacterIdRef.current = 'B';
    runtime.current.resetArchiveForCharacterChange();
    runtime.current.setMemoryArchiveSummary('summary B');
    runtime.current.toggleMemoryArchiveSelection('memory-B');
    const currentExecute = runtime.current.handleMemoryArchiveExecute();
    assert.equal(runtime.current.memoryArchiveLoading, true);

    previewA.resolve(jsonResponse({ plan: planA }));
    await stalePreview;

    assert.equal(runtime.current.memoryArchiveLoading, true);
    assert.equal(runtime.current.memoryArchivePlan, null);
    assert.deepEqual(refreshes, []);
    assert.deepEqual(followUpRequests, []);

    executeB.resolve(jsonResponse({ plan: planB }));
    await currentExecute;

    assert.equal(runtime.current.memoryArchiveLoading, false);
    assert.equal(runtime.current.memoryArchivePlan.summaryMemory.id, 'summary-B');
    assert.deepEqual(runtime.current.selectedMemoryArchiveIds, []);
    assert.deepEqual(refreshes, ['diagnostics', 'index-status']);
    assert.deepEqual(followUpRequests, ['memories:B', 'batches:B']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('memory archive undo and batch detail ignore stale character responses', async () => {
  const detailA = createDeferred();
  const detailB = createDeferred();
  const undoA = createDeferred();
  const undoB = createDeferred();
  const followUpRequests = [];
  const refreshes = [];
  const memoryManagementCharacterIdRef = { current: 'A' };

  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    if (parsedUrl.pathname === '/api/memory-archive' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.action === 'batch_details' && body.character_id === 'A') return detailA.promise;
      if (body.action === 'batch_details' && body.character_id === 'B') return detailB.promise;
      if (body.action === 'undo' && body.character_id === 'A') return undoA.promise;
      if (body.action === 'undo' && body.character_id === 'B') return undoB.promise;
      throw new Error(`unexpected archive action: ${JSON.stringify(body)}`);
    }
    if (parsedUrl.pathname === '/api/memories') {
      followUpRequests.push(`memories:${parsedUrl.searchParams.get('character_id')}`);
      return jsonResponse({ memories: [], total: 0, hasMore: false, offset: 0 });
    }
    if (parsedUrl.pathname === '/api/memory-archive') {
      followUpRequests.push(`batches:${parsedUrl.searchParams.get('character_id')}`);
      return jsonResponse({ batches: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryArchivePanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryArchivePanel.ts', {
          react: reactMock,
        });
        return useMemoryArchivePanel;
      },
      () => ({
        characterId: memoryManagementCharacterIdRef.current,
        memoryManagementCharacterIdRef,
        loadMemoryDiagnostics: async () => refreshes.push('diagnostics'),
        loadMemoryIndexStatus: async () => refreshes.push('index-status'),
        t: key => key,
        showToast: () => {},
      }),
    );

    runtime.render();
    runtime.current.setSelectedMemoryArchiveBatchId('batch-A');
    const staleDetail = runtime.current.loadMemoryArchiveBatchDetail('batch-A');
    const staleUndo = runtime.current.handleMemoryArchiveUndo();
    assert.equal(runtime.current.memoryArchiveLoading, true);

    memoryManagementCharacterIdRef.current = 'B';
    runtime.current.resetArchiveForCharacterChange();
    runtime.current.setSelectedMemoryArchiveBatchId('batch-B');
    const currentDetail = runtime.current.loadMemoryArchiveBatchDetail('batch-B');
    const currentUndo = runtime.current.handleMemoryArchiveUndo();
    assert.equal(runtime.current.memoryArchiveLoading, true);

    detailA.resolve(jsonResponse({
      ok: true,
      covered: [{ id: 'memory-A', category: 'preference', content: 'A memory', status: 'summarized' }],
      summary: { id: 'summary-A', content: 'summary A' },
    }));
    undoA.resolve(jsonResponse({ ok: true }));
    await staleDetail;
    await staleUndo;

    assert.equal(runtime.current.memoryArchiveLoading, true);
    assert.equal(runtime.current.memoryArchiveBatchDetail, null);
    assert.equal(runtime.current.memoryArchiveSummary, '');
    assert.deepEqual(refreshes, []);
    assert.deepEqual(followUpRequests, []);

    detailB.resolve(jsonResponse({
      ok: true,
      covered: [{ id: 'memory-B', category: 'preference', content: 'B memory', status: 'summarized' }],
      summary: { id: 'summary-B', content: 'summary B' },
    }));
    await currentDetail;

    assert.deepEqual(runtime.current.memoryArchiveBatchDetail.covered.map(memory => memory.id), ['memory-B']);
    assert.equal(runtime.current.memoryArchiveSummary, 'summary B');

    undoB.resolve(jsonResponse({ ok: true }));
    await currentUndo;

    assert.equal(runtime.current.memoryArchiveLoading, false);
    assert.equal(runtime.current.selectedMemoryArchiveBatchId, '');
    assert.equal(runtime.current.memoryArchiveBatchDetail, null);
    assert.deepEqual(refreshes, ['diagnostics', 'index-status']);
    assert.deepEqual(followUpRequests, ['memories:B', 'batches:B']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('memory archive AI failure shows an error without reporting success or applying a plan', async () => {
  const toastMessages = [];
  const memoryManagementCharacterIdRef = { current: 'A' };

  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    if (parsedUrl.pathname === '/api/memory-archive' && init.method === 'POST') {
      return jsonResponse({ ok: false, error: 'archive failed' }, { status: 500 });
    }
    return jsonResponse({ memories: [], batches: [], total: 0, hasMore: false, offset: 0 });
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryArchivePanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryArchivePanel.ts', {
          react: reactMock,
        });
        return useMemoryArchivePanel;
      },
      () => ({
        characterId: memoryManagementCharacterIdRef.current,
        memoryManagementCharacterIdRef,
        loadMemoryDiagnostics: async () => {},
        loadMemoryIndexStatus: async () => {},
        t: key => key,
        showToast: (message, type) => toastMessages.push({ message, type }),
      }),
    );

    runtime.render();
    await runtime.current.handleMemoryArchiveAi();

    assert.equal(runtime.current.memoryArchiveAiRunning, false);
    assert.equal(runtime.current.memoryArchiveLoading, false);
    assert.equal(runtime.current.memoryArchiveError, 'archive failed');
    assert.equal(runtime.current.memoryArchivePlan, null);
    assert.deepEqual(toastMessages, [{ message: 'archive failed', type: 'error' }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('memory archive batch detail keeps old state and exposes non-2xx or invalid-shape errors', async () => {
  const memoryManagementCharacterIdRef = { current: 'A' };
  const responses = [
    jsonResponse({
      ok: true,
      covered: [{ id: 'memory-1', category: 'fact', content: 'kept detail', status: 'summarized' }],
      summary: { id: 'summary-1', content: 'kept summary' },
    }),
    jsonResponse({ error: 'detail failed' }, { status: 500 }),
    jsonResponse({ ok: true, covered: 'not-an-array', summary: null }),
  ];

  const originalFetch = global.fetch;
  global.fetch = async () => {
    const response = responses.shift();
    assert.ok(response, 'unexpected extra request');
    return response;
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryArchivePanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryArchivePanel.ts', {
          react: reactMock,
        });
        return useMemoryArchivePanel;
      },
      () => ({
        characterId: memoryManagementCharacterIdRef.current,
        memoryManagementCharacterIdRef,
        loadMemoryDiagnostics: async () => {},
        loadMemoryIndexStatus: async () => {},
        t: key => key,
        showToast: () => {},
      }),
    );

    runtime.render();
    await runtime.current.loadMemoryArchiveBatchDetail('batch-1');
    const oldDetail = runtime.current.memoryArchiveBatchDetail;
    assert.equal(oldDetail.summary.content, 'kept summary');

    await runtime.current.loadMemoryArchiveBatchDetail('batch-1');
    assert.deepEqual(runtime.current.memoryArchiveBatchDetail, oldDetail);
    assert.equal(runtime.current.memoryArchiveError, 'detail failed');

    await runtime.current.loadMemoryArchiveBatchDetail('batch-1');
    assert.deepEqual(runtime.current.memoryArchiveBatchDetail, oldDetail);
    assert.match(runtime.current.memoryArchiveError, /Invalid memory archive batch detail response/);
  } finally {
    global.fetch = originalFetch;
  }
});
