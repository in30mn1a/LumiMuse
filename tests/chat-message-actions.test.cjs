const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, renderHook } = require('@testing-library/react');

const root = path.resolve(__dirname, '..');
const hookPath = path.join(root, 'src/hooks/chat/useChatMessageActions.ts');
const originalResolveFilename = Module._resolveFilename;
const originalFetch = global.fetch;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.extensions['.ts'] = loadTypeScript;
require.extensions['.tsx'] = loadTypeScript;

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

function loadHook() {
  assert.ok(fs.existsSync(hookPath), 'useChatMessageActions hook should exist');
  delete require.cache[require.resolve(hookPath)];
  return require(hookPath).useChatMessageActions;
}

function message(id, role, content) {
  return {
    id,
    conversation_id: 'conv-a',
    role,
    content,
    created_at: '2026-07-10T00:00:00.000Z',
  };
}

function createOptions(overrides = {}) {
  const activeConvIdRef = { current: 'conv-a' };
  const activeStreamsRef = { current: new Set() };
  const activeStreamConvRef = { current: null };
  const messagesRef = {
    current: [
      message('user-older', 'user', 'older question'),
      message('assistant-older', 'assistant', 'older answer'),
      message('user-nearest', 'user', 'nearest question'),
      message('assistant-target', 'assistant', 'target answer'),
    ],
  };

  return {
    activeConvIdRef,
    activeStreamsRef,
    activeStreamConvRef,
    messagesRef,
    beginStream: () => new AbortController(),
    finishStream: () => {},
    scheduleStreamingText: () => {},
    setStreamingUsage: () => {},
    pollMemoryTask: () => Promise.resolve(),
    refreshMessagesForConversation: () => Promise.resolve(),
    touchConversation: () => {},
    updateMessagesForConversation: () => {},
    markSkipNextScroll: () => {},
    showToast: () => {},
    t: key => key,
    pageSize: 60,
    maybeAutoGenerateImageFromMessages: () => {},
    ...overrides,
  };
}

test.afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  restoreDom();
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

test('regenerate uses the latest translation after rerender when the network fails', async () => {
  const useChatMessageActions = loadHook();
  const toastMessages = [];
  global.fetch = async () => {
    throw new TypeError('network down');
  };

  const { result, rerender } = renderHook(
    ({ prefix }) => useChatMessageActions(createOptions({
      showToast: messageText => toastMessages.push(messageText),
      t: key => `${prefix}:${key}`,
    })),
    { initialProps: { prefix: 'old' } },
  );

  rerender({ prefix: 'new' });
  await act(async () => {
    await result.current.handleRegenerate('assistant-target');
  });

  assert.deepEqual(toastMessages, ['new:chat.errorNetwork']);
});

test('regenerate sends the nearest preceding user, target assistant, and skip-user-insert flag', async () => {
  const useChatMessageActions = loadHook();
  let requestBody;
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ error: 'stop after capture' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { result } = renderHook(() => useChatMessageActions(createOptions()));
  await act(async () => {
    await result.current.handleRegenerate('assistant-target');
  });

  assert.equal(requestBody.conversation_id, 'conv-a');
  assert.equal(requestBody.content, 'nearest question');
  assert.equal(requestBody.regenerate_assistant_id, 'assistant-target');
  assert.equal(requestBody.skip_user_insert, true);
});

test('regenerate-from-here targets the next assistant and skips reinserting the selected user', async () => {
  const useChatMessageActions = loadHook();
  let requestBody;
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ error: 'stop after capture' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { result } = renderHook(() => useChatMessageActions(createOptions()));
  await act(async () => {
    await result.current.handleRegenerateFromHere('user-nearest');
  });

  assert.equal(requestBody.content, 'nearest question');
  assert.equal(requestBody.regenerate_assistant_id, 'assistant-target');
  assert.equal(requestBody.skip_user_insert, true);
});

test('regenerate-from-here without a following assistant inserts after the selected user', async () => {
  const useChatMessageActions = loadHook();
  let requestBody;
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ error: 'stop after capture' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const options = createOptions({
    messagesRef: {
      current: [
        message('user-older', 'user', 'older question'),
        message('user-gap', 'user', 'gap question'),
        message('user-after', 'user', 'later question'),
      ],
    },
  });

  const { result } = renderHook(() => useChatMessageActions(options));
  await act(async () => {
    await result.current.handleRegenerateFromHere('user-gap');
  });

  assert.equal(requestBody.content, 'gap question');
  assert.equal(requestBody.insert_assistant_after_user_id, 'user-gap');
  assert.equal(requestBody.skip_user_insert, true);
  assert.equal(requestBody.regenerate_assistant_id, undefined);
});

test('regenerate-from-here ignores a later assistant when the next message is another user', async () => {
  const useChatMessageActions = loadHook();
  let requestBody;
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ error: 'stop after capture' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const options = createOptions({
    messagesRef: {
      current: [
        message('user-gap', 'user', 'gap question'),
        message('user-after', 'user', 'later question'),
        message('assistant-bottom', 'assistant', 'bottom answer'),
      ],
    },
  });

  const { result } = renderHook(() => useChatMessageActions(options));
  await act(async () => {
    await result.current.handleRegenerateFromHere('user-gap');
  });

  assert.equal(requestBody.insert_assistant_after_user_id, 'user-gap');
  assert.equal(requestBody.regenerate_assistant_id, undefined);
});

test('regenerate refreshes the stream owner even when the active conversation changes', async () => {
  const useChatMessageActions = loadHook();
  const options = createOptions();
  const refreshed = [];
  global.fetch = async () => {
    options.activeConvIdRef.current = 'conv-b';
    return new Response('', { status: 200 });
  };

  const { result } = renderHook(() => useChatMessageActions({
    ...options,
    refreshMessagesForConversation: async convId => { refreshed.push(convId); },
  }));
  await act(async () => {
    await result.current.handleRegenerate('assistant-target');
  });

  assert.deepEqual(refreshed, ['conv-a']);
});

test('delete uses the response conversation id and refreshes its authoritative cache snapshot', async () => {
  const useChatMessageActions = loadHook();
  const options = createOptions();
  const refreshed = [];
  const {
    cacheMessagesResponse,
    clearCachedMessages,
    readCachedMessages,
    writeCachedMessages,
  } = require('../src/lib/chat-message-cache.ts');
  clearCachedMessages();
  writeCachedMessages('conv-a', {
    messages: options.messagesRef.current,
    hasMore: false,
    oldestSeq: 1,
    unextractedCount: 1,
    totalTokens: 99,
  });
  global.fetch = async () => {
    options.activeConvIdRef.current = 'conv-b';
    return new Response(JSON.stringify({
      ok: true,
      deleted: 'message',
      conversation_id: 'conv-a',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { result } = renderHook(() => useChatMessageActions({
    ...options,
    refreshMessagesForConversation: async convId => {
      refreshed.push(convId);
      cacheMessagesResponse(convId, {
        messages: options.messagesRef.current.filter(item => item.id !== 'assistant-target'),
        hasMore: false,
        oldestSeq: 1,
        unextractedCount: 0,
        totalTokens: 42,
      });
    },
  }));
  await act(async () => {
    await result.current.handleDeleteMessage('assistant-target');
  });

  assert.deepEqual(refreshed, ['conv-a']);
  const cached = readCachedMessages('conv-a');
  assert.equal(cached.messages.some(item => item.id === 'assistant-target'), false);
  assert.equal(cached.unextractedCount, 0);
  assert.equal(cached.totalTokens, 42);
});

test('delete failure is consumed and shown as an error toast', async () => {
  const useChatMessageActions = loadHook();
  const toasts = [];
  global.fetch = async () => new Response(JSON.stringify({ error: 'delete denied' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });

  const { result } = renderHook(() => useChatMessageActions(createOptions({
    showToast: (messageText, type) => toasts.push({ messageText, type }),
  })));
  await act(async () => {
    await result.current.handleDeleteMessage('assistant-target');
  });

  assert.deepEqual(toasts, [{ messageText: 'delete denied', type: 'error' }]);
});

test('edit and version switch refresh the message owner response instead of the current conversation', async () => {
  const useChatMessageActions = loadHook();
  const options = createOptions();
  const refreshed = [];
  global.fetch = async (_url, init) => {
    options.activeConvIdRef.current = 'conv-b';
    return new Response(JSON.stringify(message('assistant-target', 'assistant', init.method === 'PUT' ? 'updated' : 'unchanged')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { result } = renderHook(() => useChatMessageActions({
    ...options,
    refreshMessagesForConversation: async convId => { refreshed.push(convId); },
  }));
  await act(async () => {
    await result.current.handleEditMessage('assistant-target', 'updated');
    await result.current.handleSwitchVersion('assistant-target', 0);
  });

  assert.deepEqual(refreshed, ['conv-a', 'conv-a']);
});
