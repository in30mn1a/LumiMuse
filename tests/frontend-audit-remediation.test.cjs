const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');
const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act, cleanup, renderHook, render, fireEvent, waitFor } = require('@testing-library/react');
const root = path.resolve(__dirname, '..');
const resolveOriginal = Module._resolveFilename;
const loadOriginal = Module._load;
Module._resolveFilename = function(request, parent, ...args) {
  if (request.startsWith('@/')) {
    const base = path.join(root, 'src', request.slice(2));
    for (const file of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return resolveOriginal.call(this, request, parent, ...args);
};
function loadTs(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText, filename);
}
require.extensions['.ts'] = loadTs;
require.extensions['.tsx'] = loadTs;
const t = key => key;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test.afterEach(() => { cleanup(); delete global.fetch; });
test.after(() => { restoreDom(); delete global.IS_REACT_ACT_ENVIRONMENT; });
const conversation = { id: 'created-a', character_id: 'a', title: 'new', ignore_memory: 0, created_at: '', updated_at: '' };

test('new chat rejects a late A response after A → B → A and leaves a newer request loading', async () => {
  const requests = [];
  global.fetch = () => { const request = deferred(); requests.push(request); return request.promise; };
  const { useNewChat } = require('../src/hooks/chat/useNewChat.ts');
  const selected = [], refreshed = [];
  const { result, rerender } = renderHook(({ id }) => useNewChat({
    character: { id }, setConversations() {}, selectActiveConvId: id => selected.push(id),
    applyMessagesResponse() {}, clearMessages() {}, clearStreamingText() {},
    refreshConversationState: async id => refreshed.push(id), showToast() {}, t,
  }), { initialProps: { id: 'a' } });
  let old, next;
  act(() => { old = result.current.handleNewChat(); });
  rerender({ id: 'b' }); rerender({ id: 'a' });
  act(() => { next = result.current.handleNewChat(); });
  await act(async () => { requests[0].resolve(json(conversation)); await old; });
  assert.deepEqual(selected, []);
  assert.equal(result.current.creating, true);
  await act(async () => { requests[1].resolve(json({ ...conversation, id: 'latest' })); await next; });
  assert.deepEqual(selected, ['latest']); assert.deepEqual(refreshed, ['latest']);
});

test('a late profile mutation cannot invalidate the current character load or edit draft', async () => {
  const mutation = deferred(), loadB = deferred();
  const calls = [];
  global.fetch = (url, init) => { calls.push(url); return init ? mutation.promise : loadB.promise; };
  const { useMemoryProfilePanel } = require('../src/hooks/settings/useMemoryProfilePanel.ts');
  const characterRef = { current: 'a' };
  const { result, rerender } = renderHook(({ id }) => useMemoryProfilePanel({
    characterId: id, memoryManagementCharacterIdRef: characterRef, loadMemoryDiagnostics() {}, t, showToast() {},
  }), { initialProps: { id: 'a' } });
  let old, loading;
  act(() => { old = result.current.handleMemoryProfileRollback(1); });
  characterRef.current = 'b'; rerender({ id: 'b' });
  act(() => { loading = result.current.loadMemoryProfile('b'); result.current.setEditingProfileDraft({ profile_name: 'draft B' }); });
  await act(async () => { mutation.resolve(json({ ok: true })); await old; });
  assert.equal(calls.length, 2); assert.equal(result.current.memoryProfileLoading, true);
  assert.equal(result.current.editingProfileDraft.profile_name, 'draft B');
  await act(async () => { loadB.resolve(json({ profile: { character_id: 'b' }, versions: [], tasks: [] })); await loading; });
  assert.equal(result.current.memoryProfileLoading, false);
  assert.equal(result.current.memoryProfile.profile.character_id, 'b');
});

function renderManagedProfile() {
  const { useMemoryManagementCharacters } = require('../src/hooks/settings/useMemoryManagementCharacters.ts');
  const { useMemoryProfilePanel } = require('../src/hooks/settings/useMemoryProfilePanel.ts');
  return renderHook(() => {
    const manager = useMemoryManagementCharacters();
    const panel = useMemoryProfilePanel({
      characterId: manager.memoryManagementCharacterId,
      memoryManagementCharacterIdRef: manager.memoryManagementCharacterIdRef,
      loadMemoryDiagnostics() {}, t, showToast() {},
    });
    const callbacks = {
      resetProfile: panel.resetProfile, resetArchiveForCharacterChange() {},
      loadMemoryProfile: panel.loadMemoryProfile, loadMemoryDiagnostics() {},
      loadMemoryArchiveMemories() {}, loadMemoryArchiveBatches() {},
    };
    return {
      manager, panel,
      loadCharacters: () => manager.loadMemoryManagementCharacters(callbacks),
      selectCharacter: id => manager.handleMemoryManagementCharacterChange(id, callbacks),
    };
  });
}

test('initial memory management loading keeps the first profile request through the character commit', async () => {
  const profile = deferred();
  global.fetch = url => url === '/api/characters'
    ? Promise.resolve(json([{ id: 'a', name: 'A' }]))
    : profile.promise;
  const { result } = renderManagedProfile();
  let loading;
  act(() => { loading = result.current.loadCharacters(); });
  await waitFor(() => assert.equal(result.current.manager.memoryManagementCharacterId, 'a'));
  assert.equal(result.current.panel.memoryProfileLoading, true);
  await act(async () => {
    profile.resolve(json({ profile: { character_id: 'a' }, versions: [], tasks: [] }));
    await loading;
  });
  assert.equal(result.current.panel.memoryProfile.profile.character_id, 'a');
  assert.equal(result.current.panel.memoryProfileLoading, false);
});

test('real character selection accepts the newest A profile after A to B to A without stale loading updates', async () => {
  const requests = [];
  global.fetch = url => { const request = deferred(); requests.push({ url, ...request }); return request.promise; };
  const { result } = renderManagedProfile();
  act(() => result.current.selectCharacter('a'));
  act(() => result.current.selectCharacter('b'));
  act(() => result.current.selectCharacter('a'));
  assert.equal(requests.length, 3);
  assert.equal(result.current.panel.memoryProfileLoading, true);
  await act(async () => {
    requests[0].resolve(json({ profile: { character_id: 'a', profile_name: 'old A' }, versions: [], tasks: [] }));
    requests[1].resolve(json({ profile: { character_id: 'b' }, versions: [], tasks: [] }));
  });
  assert.equal(result.current.panel.memoryProfile, null);
  assert.equal(result.current.panel.memoryProfileLoading, true);
  await act(async () => {
    requests[2].resolve(json({ profile: { character_id: 'a', profile_name: 'new A' }, versions: [], tasks: [] }));
  });
  assert.equal(result.current.panel.memoryProfile.profile.profile_name, 'new A');
  assert.equal(result.current.panel.memoryProfileLoading, false);
});

test('image generation works with the getRandomValues-only crypto available over ordinary HTTP', async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const secureRandom = require('node:crypto').webcrypto;
  let randomCalls = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: bytes => { randomCalls += 1; return secureRandom.getRandomValues(bytes); },
  } });
  try {
    const generation = deferred();
    let persisted;
    global.fetch = async (url, init) => {
      if (url === '/api/image-gen') return generation.promise;
      persisted = JSON.parse(init.body).metadata;
      return json({ metadata: persisted });
    };
    const { useChatImageGeneration } = require('../src/hooks/chat/useChatImageGeneration.ts');
    const messagesRef = { current: [{ id: 'm', conversation_id: 'a', metadata: {} }] };
    const { result } = renderHook(() => useChatImageGeneration({
      activeConvId: 'a', activeConvIdRef: { current: 'a' }, characterRef: { current: { id: 'char' } }, messagesRef,
      updateMessagesForConversation: (_, updater) => { messagesRef.current = updater(messagesRef.current); },
      markSkipNextScroll() {}, showToast() {}, t,
    }));
    let generating, failure;
    act(() => {
      generating = result.current.handleGenerateImage('m', 'prompt');
      generating.catch(error => { failure = error; });
    });
    await waitFor(() => assert.ok(persisted || failure));
    assert.ifError(failure);
    assert.ok(persisted.generatedImages[0].requestToken);
    assert.equal(randomCalls, 1);
    assert.equal(result.current.generatingImageMessageIds.has('m'), true);
    await act(async () => { generation.resolve(json({ url: '/generated.png' })); await generating; });
    assert.equal(persisted.generatedImages[0].url, '/generated.png');
    assert.equal(result.current.generatingImageMessageIds.size, 0);
  } finally {
    Object.defineProperty(globalThis, 'crypto', originalCrypto);
  }
});

test('random token initialization failure shows an error and permits an image generation retry', async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const secureRandom = require('node:crypto').webcrypto;
  let randomFails = true;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: bytes => {
      if (randomFails) throw new Error('Random source unavailable');
      return secureRandom.getRandomValues(bytes);
    },
  } });
  try {
    const calls = [], toasts = [];
    global.fetch = async (url, init) => {
      calls.push(url);
      return url === '/api/image-gen' ? json({ url: '/generated.png' }) : json({ metadata: JSON.parse(init.body).metadata });
    };
    const { useChatImageGeneration } = require('../src/hooks/chat/useChatImageGeneration.ts');
    const { result } = renderHook(() => useChatImageGeneration({
      activeConvId: 'a', activeConvIdRef: { current: 'a' }, characterRef: { current: { id: 'char' } },
      messagesRef: { current: [{ id: 'm', conversation_id: 'a', metadata: {} }] },
      updateMessagesForConversation() {}, markSkipNextScroll() {}, showToast: (...args) => toasts.push(args), t,
    }));
    await act(async () => { assert.equal(await result.current.handleGenerateImage('m', 'prompt'), false); });
    assert.equal(result.current.generatingImageMessageIds.size, 0);
    assert.equal(calls.length, 0);
    assert.ok(toasts.some(([message, type]) => message.includes('Random source unavailable') && type === 'error'));
    randomFails = false;
    await act(async () => { assert.equal(await result.current.handleGenerateImage('m', 'prompt'), true); });
    assert.ok(calls.includes('/api/image-gen'));
    assert.equal(result.current.generatingImageMessageIds.size, 0);
  } finally {
    Object.defineProperty(globalThis, 'crypto', originalCrypto);
  }
});

test('cancel during a delayed placeholder write persists its terminal state without sending generation', async () => {
  const firstPut = deferred(); let persisted = {}; let writes = 0; const calls = [];
  global.fetch = async (url, init) => {
    calls.push(url); assert.equal(url, '/api/messages/m');
    const body = JSON.parse(init.body);
    if (++writes === 1) await firstPut.promise;
    if (body.metadata) persisted = body.metadata;
    else persisted.generatedImages[0].status = 'failed';
    return json({ metadata: persisted });
  };
  const { useChatImageGeneration } = require('../src/hooks/chat/useChatImageGeneration.ts');
  const activeConvIdRef = { current: 'a' }, characterRef = { current: { id: 'char' } };
  const messagesRef = { current: [{ id: 'm', conversation_id: 'a', metadata: {} }] };
  const { result, rerender } = renderHook(({ id }) => useChatImageGeneration({
    activeConvId: id, activeConvIdRef, characterRef, messagesRef, updateMessagesForConversation() {}, markSkipNextScroll() {}, showToast() {}, t,
  }), { initialProps: { id: 'a' } });
  let generating;
  act(() => { generating = result.current.handleGenerateImage('m', 'prompt'); });
  activeConvIdRef.current = 'b'; rerender({ id: 'b' });
  await act(async () => { firstPut.resolve(); await generating; });
  assert.equal(writes, 2);
  assert.equal(persisted.generatedImages[0].status, 'failed');
  assert.equal(persisted.generatedImages[0].prompt, 'prompt');
  assert.equal(result.current.generatingImageMessageIds.size, 0);
});

function loadMemoryList() {
  Module._load = function(request, ...args) {
    if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t }) };
    if (request === './MemoryCard') return { __esModule: true, default: props => React.createElement('button', { onClick: () => props.onDelete(props.memory.id), 'data-editing': String(props.initialEditing) }, props.memory.content) };
    return loadOriginal.call(this, request, ...args);
  };
  try { return require('../src/components/memories/MemoryList.tsx').default; } finally { Module._load = loadOriginal; }
}
test('memory list does not display an empty result before a slow load completes', async () => {
  const request = deferred();
  global.fetch = () => request.promise;
  const MemoryList = loadMemoryList();
  const view = render(React.createElement(MemoryList, { characterId: 'a' }));
  assert.ok(view.getByRole('status', { name: 'common.loading' }));
  assert.equal(view.queryByText('memory.emptyFiltered'), null);
  await act(async () => { request.resolve(json({ memories: [], total: 0, hasMore: false })); });
  await view.findByText('memory.emptyFiltered');
  assert.equal(view.queryByRole('status'), null);
});

test('memory list keeps a newer character load busy when an old request finishes', async () => {
  const oldRequest = deferred(), newRequest = deferred();
  global.fetch = url => new URL(url, 'http://test').searchParams.get('character_id') === 'a'
    ? oldRequest.promise : newRequest.promise;
  const MemoryList = loadMemoryList();
  const view = render(React.createElement(MemoryList, { characterId: 'a' }));
  view.rerender(React.createElement(MemoryList, { characterId: 'b' }));
  await act(async () => { oldRequest.resolve(json({ memories: [{ id: 'a', content: 'old memory', tags: [] }], total: 1, hasMore: false })); });
  assert.ok(view.getByRole('status', { name: 'common.loading' }));
  assert.equal(view.queryByText('old memory'), null);
  assert.equal(view.queryByText('memory.emptyFiltered'), null);
  await act(async () => { newRequest.resolve(json({ memories: [{ id: 'b', content: 'new memory', tags: [] }], total: 1, hasMore: false })); });
  await view.findByText('new memory');
  assert.equal(view.queryByRole('status'), null);
});

test('memory list renders a retryable load error instead of an empty result', async () => {
  let calls = 0;
  global.fetch = async () => ++calls === 1
    ? new Response('{}', { status: 503 })
    : json({ memories: [], total: 0, hasMore: false });
  const MemoryList = loadMemoryList();
  const view = render(React.createElement(MemoryList, { characterId: 'a' }));
  assert.match((await view.findByRole('alert')).textContent, /common.loadFailed/);
  assert.equal(view.queryByText('memory.emptyFiltered'), null);
  fireEvent.click(view.getByRole('button', { name: 'common.retry' }));
  await view.findByText('memory.emptyFiltered');
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(calls, 2);
});

test('memory list keeps existing cards mounted while refreshing the same query and on refresh failure', async () => {
  const request = deferred();
  let calls = 0;
  global.fetch = () => ++calls === 1
    ? Promise.resolve(json({ memories: [{ id: 'a', content: 'memory a', tags: [] }], total: 1, hasMore: false }))
    : request.promise;
  const MemoryList = loadMemoryList();
  const view = render(React.createElement(MemoryList, { characterId: 'a' }));
  const card = await view.findByText('memory a');
  view.rerender(React.createElement(MemoryList, { characterId: 'a', refreshNonce: 1 }));
  assert.equal(view.getByText('memory a'), card, 'background refresh must not unmount an editor');
  assert.ok(view.getByRole('status', { name: 'common.loading' }));
  await act(async () => { request.resolve(new Response('{}', { status: 503 })); });
  await view.findByRole('alert');
  assert.equal(view.getByText('memory a'), card, 'a refresh failure must preserve the editor and its draft');
  assert.equal(view.queryByRole('status'), null);
});
test('a late memory deletion cannot replace the newly selected character list or refresh A', async () => {
  const deletion = deferred(); const gets = [];
  global.fetch = (url, init) => {
    if (init?.method === 'DELETE') return deletion.promise;
    const id = new URL(url, 'http://test').searchParams.get('character_id'); gets.push(id);
    return Promise.resolve(json({ memories: [{ id, content: 'memory ' + id, tags: [], category: 'fact' }], total: 1, hasMore: false }));
  };
  const MemoryList = loadMemoryList();
  const view = render(React.createElement(MemoryList, { characterId: 'a' }));
  await waitFor(() => view.getByText('memory a'));
  fireEvent.click(view.getByText('memory a'));
  view.rerender(React.createElement(MemoryList, { characterId: 'b' }));
  await waitFor(() => view.getByText('memory b'));
  await act(async () => { deletion.resolve(json({ ok: true })); });
  assert.deepEqual(gets, ['a', 'b']); assert.ok(view.getByText('memory b'));
});

test('ChatView automatic creation does not start a stream or select a conversation after the role changes', async () => {
  const creation = deferred(); let chatRequests = 0;
  const showToast = () => {};
  const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
  global.fetch = async (url, init) => {
    if (url === '/api/conversations' && init?.method === 'POST') return creation.promise;
    if (String(url).startsWith('/api/conversations?')) return json([]);
    if (String(url).startsWith('/api/memories?')) return json([]);
    if (url === '/api/settings') return json(DEFAULT_SETTINGS);
    if (url === '/api/chat') { chatRequests += 1; throw new Error('must not start a stale stream'); }
    return json({ messages: [], totalTokens: 0, unextractedCount: 0, hasMore: false });
  };
  const empty = () => null;
  Module._load = function(request, parent, ...args) {
    if (request === 'next/dynamic') return { __esModule: true, default: () => empty };
    if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t }) };
    if (request === '@/components/ui/Toast') return { useToast: () => ({ showToast, ToastContainer: empty }) };
    if (parent?.filename.endsWith('ChatView.tsx')) {
      if (request === './ChatInput') return { __esModule: true, default: props => React.createElement('button', { onClick: () => props.onSend('hello') }, 'send') };
      if (request === './ConversationListPanels') return { ConversationDrawer: empty };
      if (request.startsWith('./')) return { __esModule: true, default: empty };
    }
    return loadOriginal.call(this, request, parent, ...args);
  };
  let ChatView;
  try { ChatView = require('../src/components/chat/ChatView.tsx').default; } finally { Module._load = loadOriginal; }
  const view = render(React.createElement(ChatView, { character: { id: 'automatic-a', name: 'A' }, conversationId: null }));
  await act(async () => {});
  fireEvent.click(view.getByText('send'));
  view.rerender(React.createElement(ChatView, { character: { id: 'automatic-b', name: 'B' }, conversationId: null }));
  await act(async () => { creation.resolve(json({ ...conversation, character_id: 'automatic-a' })); });
  assert.equal(chatRequests, 0);
  assert.ok(view.getByText('send'));
});

test('message image cancellation CAS preserves newer tasks and other metadata in real SQLite', async () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, metadata TEXT)');
  const state = { marker: 'keep', generatedImages: [
    { id: 'target', requestToken: 'new-task', prompt: 'new prompt', status: 'pending_image' },
    { id: 'other', prompt: 'other', status: 'ready', url: '/other.png' },
  ] };
  db.prepare('INSERT INTO messages VALUES (?, ?)').run('m', JSON.stringify(state));
  Module._load = function(request, ...args) {
    if (request === '@/lib/db') return { getDb: () => db };
    if (request === '@/lib/character-file-utils') return {};
    if (request === '@/lib/message-token-provenance') return {};
    return loadOriginal.call(this, request, ...args);
  };
  let PUT;
  try { PUT = require('../src/app/api/messages/[id]/route.ts').PUT; } finally { Module._load = loadOriginal; }
  const cancel = async (token, extra = {}) => {
    const response = await PUT(new Request('http://test/api/messages/m', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageCancellation: { imageId: 'target', requestToken: token, error: 'cancelled', ...extra } }),
    }), { params: Promise.resolve({ id: 'm' }) });
    assert.equal(response.status, 200); return (await response.json()).metadata;
  };
  try {
    assert.deepEqual(await cancel('old-task'), state);
    const ended = await cancel('new-task');
    assert.equal(ended.generatedImages[0].status, 'failed');
    assert.equal(ended.marker, 'keep'); assert.deepEqual(ended.generatedImages[1], state.generatedImages[1]);
    state.generatedImages[0] = { ...state.generatedImages[0], status: 'ready', url: '/new.png' };
    db.prepare('UPDATE messages SET metadata = ?').run(JSON.stringify(state));
    assert.deepEqual(await cancel('new-task'), state);
    state.generatedImages[0].status = 'failed';
    db.prepare('UPDATE messages SET metadata = ?').run(JSON.stringify(state));
    assert.equal((await cancel('old-task', { restoreFailed: true })).generatedImages[0].status, 'failed');
    assert.equal((await cancel('new-task', { restoreFailed: true })).generatedImages[0].status, 'ready');
  } finally { db.close(); }
});

test('a cancellation response delayed across remount cannot replace a new generation token in the cache', async () => {
  const oldImage = deferred(), newImage = deferred(), cancellation = deferred();
  let imageCalls = 0, cancelledSnapshot;
  const messagesRef = { current: [{ id: 'm', conversation_id: 'a', metadata: {} }] };
  global.fetch = async (url, init) => {
    if (url === '/api/image-gen') return (++imageCalls === 1 ? oldImage : newImage).promise;
    const body = JSON.parse(init.body);
    if (body.imageCancellation) {
      cancelledSnapshot = { ...messagesRef.current[0].metadata, generatedImages: messagesRef.current[0].metadata.generatedImages.map(image => ({ ...image, status: 'failed' })) };
      return cancellation.promise;
    }
    return json({ metadata: body.metadata });
  };
  const { useChatImageGeneration } = require('../src/hooks/chat/useChatImageGeneration.ts');
  const options = {
    activeConvId: 'a', activeConvIdRef: { current: 'a' }, characterRef: { current: { id: 'char' } }, messagesRef,
    updateMessagesForConversation: (_, updater) => { messagesRef.current = updater(messagesRef.current); },
    markSkipNextScroll() {}, showToast() {}, t,
  };
  const first = renderHook(() => useChatImageGeneration(options));
  let oldGeneration;
  act(() => { oldGeneration = first.result.current.handleGenerateImage('m', 'old'); });
  await waitFor(() => assert.equal(imageCalls, 1));
  const imageId = messagesRef.current[0].metadata.generatedImages[0].id;
  const oldToken = messagesRef.current[0].metadata.generatedImages[0].requestToken;
  first.unmount();
  await act(async () => { oldImage.resolve(json({ url: '/old.png' })); });
  await waitFor(() => assert.ok(cancelledSnapshot));
  const second = renderHook(() => useChatImageGeneration(options));
  let newGeneration;
  act(() => { newGeneration = second.result.current.handleGenerateImage('m', 'new', imageId); });
  await waitFor(() => assert.equal(imageCalls, 2));
  const newToken = messagesRef.current[0].metadata.generatedImages[0].requestToken;
  assert.notEqual(newToken, oldToken);
  await act(async () => { cancellation.resolve(json({ metadata: cancelledSnapshot })); await oldGeneration; });
  assert.equal(messagesRef.current[0].metadata.generatedImages[0].requestToken, newToken);
  assert.equal(messagesRef.current[0].metadata.generatedImages[0].status, 'pending_image');
  await act(async () => { newImage.resolve(json({ url: '/new.png' })); await newGeneration; });
  assert.equal(messagesRef.current[0].metadata.generatedImages[0].url, '/new.png');
});

test('a late memory add preserves B count, editing state and its newer add operation', async () => {
  const addA = deferred(), addB = deferred(); const gets = []; let addedB = false;
  global.fetch = (url, init) => {
    if (init?.method === 'POST') return JSON.parse(init.body).character_id === 'a' ? addA.promise : addB.promise;
    const id = new URL(url, 'http://test').searchParams.get('character_id'); gets.push(id);
    return Promise.resolve(json({ memories: [{ id: addedB && id === 'b' ? 'new-b' : id, content: 'memory ' + id, tags: [], category: 'fact' }], total: id === 'b' ? 3 : 1, hasMore: false }));
  };
  const MemoryList = loadMemoryList();
  const view = render(React.createElement(MemoryList, { characterId: 'a' }));
  await waitFor(() => view.getByText('memory a'));
  fireEvent.click(view.getByText('memory.add'));
  view.rerender(React.createElement(MemoryList, { characterId: 'b' }));
  await waitFor(() => view.getByText('memory b'));
  fireEvent.click(view.getByText('memory.add'));
  await act(async () => { addA.resolve(json({ id: 'new-a' })); });
  assert.equal(view.getByText('memory b').getAttribute('data-editing'), 'false');
  assert.ok(view.getByText('memory.adding'));
  assert.ok(view.getByText(/memory.summary 3/));
  assert.deepEqual(gets, ['a', 'b']);
  await act(async () => { addedB = true; addB.resolve(json({ id: 'new-b' })); });
  assert.equal(view.getByText('memory b').getAttribute('data-editing'), 'true');
});

test('a memory add started before a keyword filter change cannot refresh the old query', async () => {
  const addition = deferred(), queries = [];
  global.fetch = (url, init) => {
    if (init?.method === 'POST') return addition.promise;
    const keyword = new URL(url, 'http://test').searchParams.get('keyword') || ''; queries.push(keyword);
    return Promise.resolve(json({ memories: [{ id: keyword || 'old', content: keyword ? 'filtered' : 'unfiltered', tags: [], category: 'fact' }], total: 1, hasMore: false }));
  };
  const MemoryList = loadMemoryList();
  const view = render(React.createElement(MemoryList, { characterId: 'a' }));
  await waitFor(() => view.getByText('unfiltered'));
  fireEvent.click(view.getByText('memory.add'));
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'needle' } });
  await waitFor(() => view.getByText('filtered'));
  await act(async () => { addition.resolve(json({ id: 'old-addition' })); });
  assert.deepEqual(queries, ['', 'needle']);
  assert.equal(view.getByText('filtered').getAttribute('data-editing'), 'false');
});
