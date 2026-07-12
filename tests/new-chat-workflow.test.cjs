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
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const character = {
  id: 'char-a',
  name: 'Alice',
  avatar_url: null,
  basic_info: '',
  personality: '',
  scenario: '',
  greeting: '欢迎回来',
  example_dialogue: '',
  system_prompt: '',
  other_info: '',
  image_tags: '',
  user_image_tags: '',
  created_at: '2026-07-11T00:00:00.000Z',
  updated_at: '2026-07-11T00:00:00.000Z',
};

const conversation = {
  id: 'conv-new',
  character_id: 'char-a',
  title: '新的对话',
  ignore_memory: 0,
  created_at: '2026-07-11T00:00:00.000Z',
  updated_at: '2026-07-11T00:00:00.000Z',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderNewChatHook(overrides = {}) {
  const conversations = [{ ...conversation, id: 'conv-old' }];
  const selected = [];
  const applied = [];
  const refreshed = [];
  const toasts = [];
  let clearMessagesCalls = 0;
  let clearStreamingCalls = 0;

  const { useNewChat } = require('../src/hooks/chat/useNewChat.ts');
  const { result } = renderHook(() => useNewChat({
    character,
    setConversations: updater => {
      const next = typeof updater === 'function' ? updater(conversations) : updater;
      conversations.splice(0, conversations.length, ...next);
    },
    selectActiveConvId: id => selected.push(id),
    applyMessagesResponse: (id, response) => {
      applied.push({ id, response });
      return true;
    },
    clearMessages: () => { clearMessagesCalls += 1; },
    clearStreamingText: () => { clearStreamingCalls += 1; },
    refreshConversationState: async id => { refreshed.push(id); },
    showToast: (message, type) => toasts.push({ message, type }),
    t: key => key,
    ...overrides,
  }));

  return {
    result,
    conversations,
    selected,
    applied,
    refreshed,
    toasts,
    get clearMessagesCalls() { return clearMessagesCalls; },
    get clearStreamingCalls() { return clearStreamingCalls; },
  };
}

test.afterEach(() => {
  cleanup();
  delete global.fetch;
  const { clearCachedMessages } = require('../src/lib/chat-message-cache.ts');
  clearCachedMessages();
});

test.after(() => {
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('useNewChat validates the conversation shape before mutating visible state', async () => {
  global.fetch = async url => {
    assert.equal(url, '/api/conversations');
    return jsonResponse({ title: 'missing required identity fields' }, 201);
  };
  const state = renderNewChatHook({ character: { ...character, greeting: '' } });

  await act(() => state.result.current.handleNewChat());

  assert.deepEqual(state.conversations.map(item => item.id), ['conv-old']);
  assert.deepEqual(state.selected, []);
  assert.deepEqual(state.refreshed, []);
  assert.deepEqual(state.toasts, [{ message: 'common.operationFailed: Invalid conversation response', type: 'error' }]);
});

test('useNewChat keeps a validated conversation and an empty cache when greeting creation fails', async () => {
  global.fetch = async url => {
    if (url === '/api/conversations') return jsonResponse(conversation, 201);
    if (url === '/api/messages') return jsonResponse({ error: 'greeting write failed' }, 500);
    throw new Error(`unexpected fetch ${url}`);
  };
  const state = renderNewChatHook();

  await act(() => state.result.current.handleNewChat());

  const { readCachedMessages } = require('../src/lib/chat-message-cache.ts');
  assert.deepEqual(state.conversations.map(item => item.id), ['conv-new', 'conv-old']);
  assert.deepEqual(state.selected, ['conv-new']);
  assert.deepEqual(state.applied, []);
  assert.equal(state.clearMessagesCalls, 1);
  assert.equal(state.clearStreamingCalls, 1);
  assert.deepEqual(readCachedMessages('conv-new'), {
    messages: [],
    hasMore: false,
    oldestSeq: null,
    unextractedCount: 0,
    totalTokens: 0,
  });
  assert.deepEqual(state.refreshed, ['conv-new']);
  assert.deepEqual(state.toasts, [{
    message: 'chat.greetingCreateFailed: greeting write failed',
    type: 'error',
  }]);
});

test('useNewChat applies a validated greeting after initializing the new conversation', async () => {
  const greetingMessage = {
    id: 'msg-greeting',
    conversation_id: 'conv-new',
    role: 'assistant',
    content: '欢迎回来',
    token_count: 4,
    created_at: '2026-07-11T00:00:01.000Z',
    seq: 1,
    metadata: {},
  };
  global.fetch = async url => {
    if (url === '/api/conversations') return jsonResponse(conversation, 201);
    if (url === '/api/messages') return jsonResponse(greetingMessage, 201);
    throw new Error(`unexpected fetch ${url}`);
  };
  const state = renderNewChatHook();

  await act(() => state.result.current.handleNewChat());

  assert.deepEqual(state.applied, [{
    id: 'conv-new',
    response: {
      messages: [greetingMessage],
      hasMore: false,
      oldestSeq: 1,
      unextractedCount: 0,
      totalTokens: 4,
    },
  }]);
  assert.deepEqual(state.toasts, []);
  assert.equal(state.clearMessagesCalls, 1);
  assert.equal(state.clearStreamingCalls, 1);
});
