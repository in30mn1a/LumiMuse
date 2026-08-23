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
const originalConsoleWarn = console.warn;

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

const imageBlobCache = require('../src/lib/image-blob-cache.ts');
const originalForgetImageBlobs = imageBlobCache.forgetImageBlobs;

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
    refreshMessageCountsForConversation: () => Promise.resolve(),
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
  console.warn = originalConsoleWarn;
  imageBlobCache.forgetImageBlobs = originalForgetImageBlobs;
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

test('delete waits for invalidating only server-confirmed image URLs before refreshing', async () => {
  const useChatMessageActions = loadHook();
  const events = [];
  let resolveForget;
  imageBlobCache.forgetImageBlobs = urls => {
    events.push({ type: 'forget-start', urls: [...urls] });
    return new Promise(resolve => { resolveForget = resolve; });
  };
  global.fetch = async () => new Response(JSON.stringify({
    ok: true,
    deleted: 'message',
    conversation_id: 'conv-a',
    deletedUrls: ['/api/files/generated/deleted.png'],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const { result } = renderHook(() => useChatMessageActions(createOptions({
    refreshMessagesForConversation: async () => { events.push({ type: 'refresh' }); },
  })));
  let deletion;
  await act(async () => {
    deletion = result.current.handleDeleteMessage('assistant-target');
    await new Promise(resolve => setImmediate(resolve));
  });

  assert.deepEqual(events, [{
    type: 'forget-start',
    urls: ['/api/files/generated/deleted.png'],
  }]);
  await act(async () => {
    resolveForget();
    await deletion;
  });
  assert.deepEqual(events, [
    { type: 'forget-start', urls: ['/api/files/generated/deleted.png'] },
    { type: 'refresh' },
  ]);
});

test('successful delete still commits authoritative state when local image invalidation rejects', async () => {
  const useChatMessageActions = loadHook();
  const warnings = [];
  const toasts = [];
  const refreshed = [];
  let visibleMessages = [
    message('user-nearest', 'user', 'nearest question'),
    message('assistant-target', 'assistant', 'target answer'),
  ];
  imageBlobCache.forgetImageBlobs = async () => {
    throw new Error('cache storage unavailable');
  };
  console.warn = (...args) => warnings.push(args);
  global.fetch = async () => new Response(JSON.stringify({
    ok: true,
    deleted: 'message',
    conversation_id: 'conv-a',
    deletedUrls: ['/api/files/generated/deleted.png'],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const { result } = renderHook(() => useChatMessageActions(createOptions({
    updateMessagesForConversation: (_convId, updater) => {
      visibleMessages = updater(visibleMessages);
    },
    refreshMessagesForConversation: async convId => { refreshed.push(convId); },
    showToast: (messageText, type) => toasts.push({ messageText, type }),
  })));
  await act(async () => {
    await result.current.handleDeleteMessage('assistant-target');
  });

  assert.deepEqual(visibleMessages.map(item => item.id), ['user-nearest']);
  assert.deepEqual(refreshed, ['conv-a']);
  assert.deepEqual(toasts, [], 'cache invalidation failure must not masquerade as an API delete failure');
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /本地图片缓存失效失败/);
});

test('successful edit still refreshes and keeps deletedUrls out of the authoritative Message when invalidation rejects', async () => {
  const useChatMessageActions = loadHook();
  const warnings = [];
  const toasts = [];
  const refreshed = [];
  let committedMessage;
  imageBlobCache.forgetImageBlobs = async () => {
    throw new Error('cache storage unavailable');
  };
  console.warn = (...args) => warnings.push(args);
  global.fetch = async () => new Response(JSON.stringify({
    ...message('assistant-target', 'assistant', 'edited answer'),
    deletedUrls: ['/api/files/generated/deleted.png'],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const { result } = renderHook(() => useChatMessageActions(createOptions({
    updateMessagesForConversation: (_convId, updater) => {
      committedMessage = updater([message('assistant-target', 'assistant', 'old answer')])[0];
    },
    refreshMessagesForConversation: async convId => { refreshed.push(convId); },
    showToast: (messageText, type) => toasts.push({ messageText, type }),
  })));
  await act(async () => {
    await result.current.handleEditMessage('assistant-target', 'edited answer');
  });

  assert.equal(committedMessage.content, 'edited answer');
  assert.equal(Object.hasOwn(committedMessage, 'deletedUrls'), false);
  assert.deepEqual(refreshed, ['conv-a']);
  assert.deepEqual(toasts, []);
  assert.equal(warnings.length, 1);
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

test('edit refreshes the message owner while version switch refreshes only its counts', async () => {
  const useChatMessageActions = loadHook();
  const options = createOptions();
  const refreshed = [];
  const countRefreshes = [];
  imageBlobCache.forgetImageBlobs = async () => {};
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
    refreshMessageCountsForConversation: async convId => { countRefreshes.push(convId); },
  }));
  await act(async () => {
    await result.current.handleEditMessage('assistant-target', 'updated');
    options.activeConvIdRef.current = 'conv-a';
    await result.current.handleSwitchVersion('assistant-target', 0);
  });

  assert.deepEqual(refreshed, ['conv-a']);
  assert.deepEqual(countRefreshes, ['conv-a']);
});

test('inherited message mutations stay scoped to the linked conversation view', async () => {
  const useChatMessageActions = loadHook();
  const options = createOptions();
  options.activeConvIdRef.current = 'conv-child';
  options.messagesRef.current = [{
    ...message('assistant-target', 'assistant', 'shared answer'),
    conversation_id: 'conv-child',
    source_conversation_id: 'conv-parent',
  }];
  const updatedConversationIds = [];
  const refreshed = [];
  const countRefreshes = [];
  const committedConversationIds = [];
  const committedSourceConversationIds = [];

  global.fetch = async (_url, init) => {
    if (init.method === 'DELETE') {
      return new Response(JSON.stringify({
        ok: true,
        deleted: 'version',
        conversation_id: 'conv-parent',
        message: {
          ...message('assistant-target', 'assistant', 'fallback version'),
          conversation_id: 'conv-parent',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = JSON.parse(init.body);
    const response = {
      ...message('assistant-target', 'assistant', body.activeVersion === undefined ? 'edited' : 'version 0'),
      conversation_id: 'conv-parent',
      metadata: body.activeVersion === undefined ? {} : { activeVersion: 0 },
    };
    // 操作完成前即使用户切走，也必须更新操作发起时的 linked view 缓存。
    options.activeConvIdRef.current = 'conv-other';
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { result } = renderHook(() => useChatMessageActions({
    ...options,
    updateMessagesForConversation: (convId, updater) => {
      updatedConversationIds.push(convId);
      const next = updater(options.messagesRef.current);
      options.messagesRef.current = next;
      if (next[0]) {
        committedConversationIds.push(next[0].conversation_id);
        committedSourceConversationIds.push(next[0].source_conversation_id);
      }
    },
    refreshMessagesForConversation: async convId => { refreshed.push(convId); },
    refreshMessageCountsForConversation: async convId => { countRefreshes.push(convId); },
  }));

  await act(async () => {
    await result.current.handleEditMessage('assistant-target', 'edited');
  });

  options.activeConvIdRef.current = 'conv-child';
  options.messagesRef.current = [{
    ...message('assistant-target', 'assistant', 'shared answer'),
    conversation_id: 'conv-child',
    source_conversation_id: 'conv-parent',
  }];
  await act(async () => {
    await result.current.handleDeleteMessage('assistant-target');
  });

  options.activeConvIdRef.current = 'conv-child';
  options.messagesRef.current = [{
    ...message('assistant-target', 'assistant', 'shared answer'),
    conversation_id: 'conv-child',
    source_conversation_id: 'conv-parent',
  }];
  await act(async () => {
    await result.current.handleSwitchVersion('assistant-target', 0);
  });

  assert.deepEqual(updatedConversationIds, ['conv-child', 'conv-child', 'conv-child']);
  assert.deepEqual(refreshed, ['conv-child', 'conv-child']);
  assert.deepEqual(countRefreshes, ['conv-child']);
  assert.deepEqual(committedConversationIds, ['conv-child', 'conv-child', 'conv-child']);
  assert.deepEqual(committedSourceConversationIds, ['conv-parent', 'conv-parent', 'conv-parent']);
});

test('version switch keeps a search-loaded message outside the latest 200-message page', async () => {
  const useChatMessageActions = loadHook();
  const options = createOptions();
  const target = {
    ...message('assistant-target', 'assistant', 'current version'),
    token_count: 3,
    metadata: {
      activeVersion: 1,
      versions: [
        { content: 'older version', token_count: 2 },
        { content: 'current version', token_count: 3 },
      ],
    },
  };
  let visibleMessages = [
    target,
    ...Array.from({ length: 204 }, (_, index) => (
      message(`message-${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `content ${index + 1}`)
    )),
  ];
  options.messagesRef.current = visibleMessages;
  const refreshed = [];
  const countRefreshes = [];
  imageBlobCache.forgetImageBlobs = async () => {};
  global.fetch = async () => new Response(JSON.stringify({
    ...target,
    content: 'older version',
    token_count: 2,
    deletedUrls: ['/api/files/generated/removed-version.png'],
    metadata: {
      ...target.metadata,
      activeVersion: 0,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const { result } = renderHook(() => useChatMessageActions({
    ...options,
    updateMessagesForConversation: (_convId, updater) => {
      visibleMessages = updater(visibleMessages);
      options.messagesRef.current = visibleMessages;
    },
    refreshMessagesForConversation: async convId => {
      refreshed.push(convId);
      visibleMessages = visibleMessages.slice(-200);
      options.messagesRef.current = visibleMessages;
    },
    refreshMessageCountsForConversation: async convId => {
      countRefreshes.push(convId);
    },
  }));
  await act(async () => {
    await result.current.handleSwitchVersion('assistant-target', 0);
  });

  assert.equal(visibleMessages.length, 205);
  assert.equal(visibleMessages[0].id, 'assistant-target');
  assert.equal(visibleMessages[0].content, 'older version');
  assert.equal(visibleMessages[0].metadata.activeVersion, 0);
  assert.equal(Object.hasOwn(visibleMessages[0], 'deletedUrls'), false);
  assert.deepEqual(refreshed, []);
  assert.deepEqual(countRefreshes, ['conv-a']);
});

test('stream finish runs before the auto-image page fetch and only once per stream', async () => {
  const useChatMessageActions = loadHook();
  const events = [];
  const encoder = new TextEncoder();
  global.fetch = async url => {
    if (String(url).startsWith('/api/chat')) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: chunk\ndata: {"text":"hi"}\n\n'));
          controller.close();
        },
      }), { status: 200 });
    }
    events.push('auto-image-page-fetch');
    return new Response(JSON.stringify({ messages: [], hasMore: false, oldestSeq: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { result } = renderHook(() => useChatMessageActions(createOptions({
    refreshMessagesForConversation: async () => { events.push('refresh'); },
    finishStream: () => { events.push('finish'); },
  })));
  await act(async () => {
    await result.current.handleRegenerate('assistant-target');
  });

  // finish 必须早于装饰性收尾（否则真实气泡与流式气泡并存），
  // 且只能执行一次（该窗口内同一对话可能已开新流，二次 finish 会清掉新流的状态）。
  assert.deepEqual(events, ['refresh', 'finish', 'auto-image-page-fetch']);
});
