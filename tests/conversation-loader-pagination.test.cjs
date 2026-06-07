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
