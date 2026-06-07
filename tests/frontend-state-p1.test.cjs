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

function loadTypeScript(module, filename) {
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
}

require.extensions['.ts'] = loadTypeScript;
require.extensions['.tsx'] = loadTypeScript;

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

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

function createDelayedStateHookRuntime(hookFactory, optionsFactory) {
  const stateValues = [];
  const refValues = [];
  const queuedStateUpdates = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  let currentResult;

  const reactMock = {
    useCallback: callback => callback,
    useEffect: (callback) => {
      const index = effectCursor;
      effectCursor += 1;
      if (!queuedStateUpdates.some(update => update.type === 'effect' && update.index === index)) {
        queuedStateUpdates.push({ type: 'effect', index, callback });
      }
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
        queuedStateUpdates.push({ type: 'state', index, nextValue });
      };
      return [stateValues[index], setState];
    },
  };

  const hook = hookFactory(reactMock);

  function render() {
    stateCursor = 0;
    refCursor = 0;
    effectCursor = 0;
    currentResult = hook(optionsFactory());
    return currentResult;
  }

  function flushStateUpdates() {
    while (queuedStateUpdates.length > 0) {
      const update = queuedStateUpdates.shift();
      if (update.type !== 'state') continue;
      stateValues[update.index] = typeof update.nextValue === 'function'
        ? update.nextValue(stateValues[update.index])
        : update.nextValue;
    }
    render();
  }

  return {
    get current() {
      return currentResult;
    },
    flushStateUpdates,
    render,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// 架构契约测试：当前 Node runner 没有 React DOM / Next page render infra，
// 所以这里只固定 Settings 初始化 effect 的依赖边界；不是完整的语言切换行为覆盖。
test('architecture contract: settings initial settings/auth load is isolated from translation-driven memory panel reloads', () => {
  const source = readProjectFile('src/app/settings/page.tsx');
  const settingsLoadBlock = sourceBlock(
    source,
    'const loadInitialSettingsAndAuth = useCallback',
    'const loadMemoryPanelState = useCallback',
  );

  assert.match(settingsLoadBlock, /useCallback\(\(\) => \{/);
  assert.match(settingsLoadBlock, /fetch\('\/api\/settings'\)/);
  assert.match(settingsLoadBlock, /fetch\('\/api\/auth'\)/);
  assert.doesNotMatch(
    settingsLoadBlock,
    /\],\s*\[[^\]]*\bt\b[^\]]*\]\);/,
    'the one-time settings/auth load must not depend on t, or language changes can overwrite unsaved edits',
  );
  assert.match(
    settingsLoadBlock,
    /\},\s*\[\s*showToast\s*\]\);/,
    'first load should still run once and keep a stable visible error callback dependency',
  );

  assert.match(source, /useEffect\(\(\) => \{\s*loadInitialSettingsAndAuth\(\);\s*\}, \[loadInitialSettingsAndAuth\]\);/);
});

test('global error page is a client component with a reset action', () => {
  const source = readProjectFile('src/app/global-error.tsx');

  assert.match(source, /^'use client';/);
  assert.match(source, /export default function GlobalError\(/);
  assert.match(source, /reset: \(\) => void/);
  assert.match(source, /onClick=\{reset\}/);
});

test('ErrorBoundary returns children, fallback, and reset behavior through the real class contract', () => {
  class MockComponent {
    constructor(props) {
      this.props = props;
      this.state = {};
    }

    setState(nextState) {
      const patch = typeof nextState === 'function' ? nextState(this.state, this.props) : nextState;
      this.state = { ...this.state, ...patch };
    }
  }

  const { default: ErrorBoundary } = requireFreshWithMocks('../src/components/ui/ErrorBoundary.tsx', {
    react: { Component: MockComponent },
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    '@/lib/i18n-context': { useTranslation: () => ({ t: key => key }) },
  });

  const boundary = new ErrorBoundary({ children: 'usable subtree', fallback: 'local fallback' });
  assert.equal(boundary.render(), 'usable subtree');

  const error = new Error('render failed');
  boundary.state = ErrorBoundary.getDerivedStateFromError(error);
  assert.equal(boundary.render(), 'local fallback');

  boundary.handleReset();
  assert.deepEqual(boundary.state, { hasError: false, error: null });
  assert.equal(boundary.render(), 'usable subtree');
});

test('conversation loader exposes refresh errors while preserving current state', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('conversation backend down');
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
        conversationId: 'conv-a',
        clearMessagesRef,
        clearStreamingTextRef,
      }),
    );

    runtime.render();
    runtime.current.setConversations([{ id: 'conv-a', character_id: 'char-a', title: 'current' }]);
    runtime.current.setMemories([{ id: 'mem-a', character_id: 'char-a', category: 'preference', content: 'keep me' }]);

    await runtime.current.refreshConversationState();

    assert.equal(runtime.current.conversationLoadError, 'conversation backend down');
    assert.deepEqual(runtime.current.conversations.map(item => item.id), ['conv-a']);
    assert.deepEqual(runtime.current.memories.map(item => item.id), ['mem-a']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ChatView renders conversation loader errors inline without clearing usable chat state', () => {
  const source = readProjectFile('src/components/chat/ChatView.tsx');

  assert.match(source, /conversationLoadError/);
  assert.match(source, /chat\.conversationLoadFailed/);
  assert.match(source, /conversationLoadError &&/);
});

// 架构契约测试：确认高风险子树确实挂在局部边界下；
// ErrorBoundary 自身行为由上面的 class contract 测试覆盖。
test('architecture contract: ChatView and SettingsPage wrap high-risk subtrees with local error boundaries', () => {
  const chatView = readProjectFile('src/components/chat/ChatView.tsx');
  const settingsPage = readProjectFile('src/app/settings/page.tsx');

  assert.match(chatView, /import ErrorBoundary from '@\/components\/ui\/ErrorBoundary';/);
  assert.match(
    chatView,
    /<ErrorBoundary>\s*<ChatMessageList[\s\S]*?\/>\s*<\/ErrorBoundary>/,
    'ChatMessageList should fail locally instead of taking down the full chat shell',
  );
  assert.match(settingsPage, /import ErrorBoundary from '@\/components\/ui\/ErrorBoundary';/);
  assert.match(
    settingsPage,
    /<ErrorBoundary>\s*<ImageGenSettingsSection[\s\S]*?\/>\s*<\/ErrorBoundary>/,
    'the image generation settings panel should fail locally inside SettingsPage',
  );
});

test('SettingsPage extracts the image generation section into a focused settings component', () => {
  const settingsPage = readProjectFile('src/app/settings/page.tsx');
  const imageSection = readProjectFile('src/components/settings/ImageGenSettingsSection.tsx');

  assert.match(settingsPage, /import \{ ImageGenSettingsSection \} from '@\/components\/settings\/ImageGenSettingsSection';/);
  assert.doesNotMatch(settingsPage, /function ImageGenSettingsSection\(/);
  assert.match(imageSection, /export function ImageGenSettingsSection\(/);
  assert.match(imageSection, /DEFAULT_IMAGE_GEN_SETTINGS/);
  assert.match(imageSection, /ArtistString/);
});

test('memory candidates ignore an older character response while the new character is loading', async () => {
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
    assert.ok(deferred, `unexpected candidates request: ${characterId}`);
    return deferred.promise;
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryCandidatesPanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryCandidatesPanel.ts', {
          react: reactMock,
        });
        return useMemoryCandidatesPanel;
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
    const firstLoad = runtime.current.loadMemoryCandidates('A');
    assert.equal(runtime.current.memoryCandidatesLoading, true);

    memoryManagementCharacterIdRef.current = 'B';
    const secondLoad = runtime.current.loadMemoryCandidates('B');
    assert.equal(runtime.current.memoryCandidatesLoading, true);

    responses.get('A').resolve(jsonResponse({
      candidates: [{ id: 1, character_id: 'A', conversation_id: null, raw_candidate: { content: 'A' }, error_reason: null, created_at: '2026-06-07' }],
    }));
    await firstLoad;

    assert.deepEqual(requestedCharacters, ['A', 'B']);
    assert.equal(runtime.current.memoryCandidatesLoading, true);
    assert.deepEqual(runtime.current.memoryCandidates, []);
    assert.equal(runtime.current.memoryCandidatesError, null);

    responses.get('B').resolve(jsonResponse({
      candidates: [{ id: 2, character_id: 'B', conversation_id: null, raw_candidate: { content: 'B' }, error_reason: null, created_at: '2026-06-07' }],
    }));
    await secondLoad;

    assert.equal(runtime.current.memoryCandidatesLoading, false);
    assert.deepEqual(runtime.current.memoryCandidates.map(candidate => candidate.id), [2]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('memory candidate actions keep newer character action state when an older action completes', async () => {
  const actionA = createDeferred();
  const actionB = createDeferred();
  const reloadedCharacters = [];
  let diagnosticsRefreshes = 0;
  let indexRefreshes = 0;
  const memoryManagementCharacterIdRef = { current: 'A' };

  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    if (parsedUrl.pathname === '/api/memory-candidates/1' && init.method === 'POST') {
      return actionA.promise;
    }
    if (parsedUrl.pathname === '/api/memory-candidates/2' && init.method === 'POST') {
      return actionB.promise;
    }
    if (parsedUrl.pathname === '/api/memory-candidates') {
      reloadedCharacters.push(parsedUrl.searchParams.get('character_id'));
      return jsonResponse({ candidates: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useMemoryCandidatesPanel } = requireFreshWithMocks('../src/hooks/settings/useMemoryCandidatesPanel.ts', {
          react: reactMock,
        });
        return useMemoryCandidatesPanel;
      },
      () => ({
        characterId: memoryManagementCharacterIdRef.current,
        memoryManagementCharacterIdRef,
        loadMemoryDiagnostics: async () => { diagnosticsRefreshes += 1; },
        loadMemoryIndexStatus: async () => { indexRefreshes += 1; },
        t: key => key,
        showToast: () => {},
      }),
    );

    runtime.render();
    const firstAction = runtime.current.handleMemoryCandidateAction({
      id: 1,
      character_id: 'A',
      conversation_id: null,
      raw_candidate: { content: 'A' },
      error_reason: null,
      created_at: '2026-06-07',
    }, 'accept');
    assert.equal(runtime.current.memoryCandidateActionId, 1);

    memoryManagementCharacterIdRef.current = 'B';
    runtime.render();
    const secondAction = runtime.current.handleMemoryCandidateAction({
      id: 2,
      character_id: 'B',
      conversation_id: null,
      raw_candidate: { content: 'B' },
      error_reason: null,
      created_at: '2026-06-07',
    }, 'ignore');
    assert.equal(runtime.current.memoryCandidateActionId, 2);

    actionA.resolve(jsonResponse({ ok: true }));
    await firstAction;

    assert.equal(runtime.current.memoryCandidateActionId, 2);
    assert.deepEqual(reloadedCharacters, []);
    assert.equal(diagnosticsRefreshes, 0);
    assert.equal(indexRefreshes, 0);

    actionB.resolve(jsonResponse({ ok: true }));
    await secondAction;

    assert.equal(runtime.current.memoryCandidateActionId, null);
    assert.deepEqual(reloadedCharacters, ['B']);
    assert.equal(diagnosticsRefreshes, 1);
    assert.equal(indexRefreshes, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('chat streaming marks an active stream in the ref before React applies state updaters', () => {
  const runtime = createDelayedStateHookRuntime(
    reactMock => {
      const { useChatStreaming } = requireFreshWithMocks('../src/hooks/chat/useChatStreaming.ts', {
        react: reactMock,
      });
      return useChatStreaming;
    },
    () => ({ activeConvId: 'conv-a' }),
  );

  runtime.render();
  const controller = runtime.current.beginStream('conv-a');

  assert.equal(controller.signal.aborted, false);
  assert.equal(
    runtime.current.activeStreamsRef.current.has('conv-a'),
    true,
    'duplicate-send guards need the ref before React schedules the activeStreams state update',
  );

  runtime.flushStateUpdates();
  assert.equal(runtime.current.activeStreams.has('conv-a'), true);
});

test('scroll controller observes a top sentinel that appears after the first effect pass', () => {
  const observed = [];
  const originalIntersectionObserver = global.IntersectionObserver;
  const originalResizeObserver = global.ResizeObserver;
  const originalRequestAnimationFrame = global.requestAnimationFrame;
  const originalCancelAnimationFrame = global.cancelAnimationFrame;

  global.IntersectionObserver = class FakeIntersectionObserver {
    observe(node) {
      observed.push(node);
    }
    disconnect() {}
  };
  global.ResizeObserver = class FakeResizeObserver {
    observe() {}
    disconnect() {}
  };
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useChatScrollController } = requireFreshWithMocks('../src/hooks/chat/useChatScrollController.ts', {
          react: reactMock,
        });
        return useChatScrollController;
      },
      () => ({
        visibleMessages: [],
        messages: [],
        activeConvId: 'conv-a',
        streamingText: '',
        streamingTargetId: null,
        streamingConvId: null,
        loadOlderMessages: () => {},
      }),
    );

    runtime.render();
    assert.equal(observed.length, 0);
    assert.equal(typeof runtime.current.topSentinelRef, 'function');

    const sentinel = {
      getBoundingClientRect: () => ({ top: 0 }),
    };
    runtime.current.topSentinelRef(sentinel);

    assert.deepEqual(observed, [sentinel]);
  } finally {
    global.IntersectionObserver = originalIntersectionObserver;
    global.ResizeObserver = originalResizeObserver;
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('chat image generation aborts on active conversation change and skips stale writes', async () => {
  const promptRequest = createDeferred();
  const messages = [{
    id: 'msg-a',
    conversation_id: 'conv-a',
    role: 'assistant',
    content: 'draw this',
    token_count: 0,
    created_at: '2026-06-07T00:00:00.000Z',
    metadata: {},
  }];
  const activeConvIdRef = { current: 'conv-a' };
  let activeConvId = 'conv-a';
  let capturedSignal = null;
  const messageWrites = [];
  const localWrites = [];
  const toasts = [];

  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    if (parsedUrl.pathname === '/api/image-gen/prompt') {
      capturedSignal = init.signal;
      return promptRequest.promise;
    }
    if (parsedUrl.pathname === '/api/messages/msg-a') {
      messageWrites.push(JSON.parse(String(init.body)));
      return jsonResponse({ ok: true });
    }
    if (parsedUrl.pathname === '/api/image-gen') {
      return jsonResponse({ url: '/generated/stale.png' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useChatImageGeneration } = requireFreshWithMocks('../src/hooks/chat/useChatImageGeneration.ts', {
          react: reactMock,
        });
        return useChatImageGeneration;
      },
      () => ({
        activeConvId,
        activeConvIdRef,
        characterRef: { current: { id: 'char-a', name: 'Alice' } },
        messagesRef: { current: messages },
        updateMessagesForConversation: (conversationIdToUpdate, updater) => {
          localWrites.push({ conversationIdToUpdate, nextMessages: updater(messages) });
        },
        markSkipNextScroll: () => {},
        showToast: (message, type) => toasts.push({ message, type }),
        t: key => key,
      }),
    );

    runtime.render();
    const generation = runtime.current.handleGenerateImage('msg-a');
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(capturedSignal, 'image prompt fetch should receive an abort signal');
    assert.equal(capturedSignal.aborted, false);

    activeConvIdRef.current = 'conv-b';
    activeConvId = 'conv-b';
    runtime.render();

    assert.equal(capturedSignal.aborted, true, 'switching conversations should abort the in-flight image request');

    promptRequest.resolve(jsonResponse({ prompt: 'stale prompt' }));
    await generation;

    assert.equal(messageWrites.length, 1, 'only the initial placeholder may be persisted before abort');
    assert.equal(localWrites.length, 1, 'stale prompt/image results must not write into the new conversation');
    assert.deepEqual(toasts, [{ message: 'chat.imageGenStart', type: 'info' }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('chat image generation restores an existing image after replacement failure delay even after switching conversations', async () => {
  const messages = [{
    id: 'msg-a',
    conversation_id: 'conv-a',
    role: 'assistant',
    content: 'draw this',
    token_count: 0,
    created_at: '2026-06-07T00:00:00.000Z',
    metadata: {
      generatedImages: [{
        id: 'img-1',
        url: '/generated/old.png',
        prompt: 'old prompt',
        status: 'ready',
      }],
    },
  }];
  const currentMessagesRef = { current: messages };
  const activeConvIdRef = { current: 'conv-a' };
  let restoreTimer = null;
  let restoreDelay = null;
  const messageWrites = [];
  const localWrites = [];

  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay) => {
    restoreTimer = callback;
    restoreDelay = delay;
    return 1;
  };
  global.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url), 'http://localhost');
    if (parsedUrl.pathname === '/api/messages/msg-a') {
      const body = JSON.parse(String(init.body));
      messageWrites.push(body);
      messages[0] = { ...messages[0], metadata: body.metadata };
      return jsonResponse({ ok: true });
    }
    if (parsedUrl.pathname === '/api/image-gen') {
      return jsonResponse({ error: 'image backend down' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const runtime = createHookRuntime(
      reactMock => {
        const { useChatImageGeneration } = requireFreshWithMocks('../src/hooks/chat/useChatImageGeneration.ts', {
          react: reactMock,
        });
        return useChatImageGeneration;
      },
      () => ({
        activeConvId: 'conv-a',
        activeConvIdRef,
        characterRef: { current: { id: 'char-a', name: 'Alice' } },
        messagesRef: currentMessagesRef,
        updateMessagesForConversation: (conversationIdToUpdate, updater) => {
          const nextMessages = updater(messages);
          messages.splice(0, messages.length, ...nextMessages);
          localWrites.push({ conversationIdToUpdate, nextMessages });
        },
        markSkipNextScroll: () => {},
        showToast: () => {},
        t: key => key,
      }),
    );

    runtime.render();
    await runtime.current.handleGenerateImage('msg-a', 'new prompt', 'img-1');

    const failedImage = messages[0].metadata.generatedImages.find(image => image.id === 'img-1');
    assert.equal(failedImage.status, 'failed');
    assert.equal(restoreDelay, 5000);
    assert.equal(typeof restoreTimer, 'function');

    activeConvIdRef.current = 'conv-b';
    currentMessagesRef.current = [{
      id: 'msg-b',
      conversation_id: 'conv-b',
      role: 'assistant',
      content: 'new conversation',
      token_count: 0,
      created_at: '2026-06-07T00:01:00.000Z',
      metadata: {},
    }];

    const writesBeforeRestore = messageWrites.length;
    await restoreTimer();

    const restoredImage = messages[0].metadata.generatedImages.find(image => image.id === 'img-1');
    assert.ok(messageWrites.length > writesBeforeRestore);
    assert.ok(localWrites.length > 0);
    assert.equal(restoredImage.status, 'ready');
    assert.equal(restoredImage.error, undefined);
    assert.equal(restoredImage.url, '/generated/old.png');
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
});
