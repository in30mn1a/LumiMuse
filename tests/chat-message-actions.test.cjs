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
    refreshMessages: () => Promise.resolve(),
    refreshConversationState: () => Promise.resolve(),
    updateMessagesForConversation: () => {},
    markSkipNextScroll: () => {},
    showToast: () => {},
    t: key => key,
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
