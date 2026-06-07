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
    cleanup() {
      for (const effect of effects) {
        effect?.cleanup?.();
      }
      effects.length = 0;
    },
  };
}

test('message paging initial load is not restarted by parent callback identity churn', async () => {
  const originalDocument = global.document;
  global.document = {
    visibilityState: 'hidden',
    addEventListener() {},
    removeEventListener() {},
  };

  const activeConvIdRef = { current: 'conv-a' };
  const requests = [];
  const firstMessage = {
    id: 'msg-1',
    conversation_id: 'conv-a',
    role: 'user',
    content: 'hello',
    created_at: '2026-06-08T00:00:00.000Z',
    token_count: 1,
    metadata: {},
  };

  const fetchMessagesPage = (conversationId, options) => {
    requests.push({ conversationId, limit: options.limit, all: options.all ?? false });
    if (requests.length > 1) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    return Promise.resolve({
      messages: [firstMessage],
      hasMore: false,
      oldestSeq: 1,
      unextractedCount: 0,
      totalTokens: 1,
    });
  };

  let runtime;
  try {
    runtime = createHookRuntime(
      reactMock => {
        const realMessageCache = require('../src/lib/chat-message-cache.ts');
        const { useMessagePaging } = requireFreshWithMocks('../src/hooks/chat/useMessagePaging.ts', {
          react: reactMock,
          '@/lib/chat-stream-client': { fetchMessagesPage },
          '@/lib/chat-message-cache': {
            ...realMessageCache,
            readCachedMessages: () => null,
          },
        });
        return useMessagePaging;
      },
      () => ({
        activeConvId: 'conv-a',
        activeConvIdRef,
        targetMessageId: null,
        pageSize: 60,
        onTargetMessageLoaded: () => {},
        onInitialMessagesLoaded: () => {},
        onError: () => {},
      }),
    );

    runtime.render();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(requests.length, 1);
    assert.deepEqual(runtime.current.visibleMessages.map(message => message.id), ['msg-1']);
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    runtime?.cleanup();
    global.document = originalDocument;
  }
});
