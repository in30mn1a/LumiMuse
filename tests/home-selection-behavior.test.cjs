const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;
const previousSessionStorage = Object.getOwnPropertyDescriptor(global, 'sessionStorage');
Object.defineProperty(global, 'sessionStorage', {
  configurable: true,
  writable: true,
  value: window.sessionStorage,
});

const { act, cleanup, render } = require('@testing-library/react');

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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function character(id, suffix = '') {
  return {
    id,
    name: `Character ${id}${suffix}`,
    avatar_url: null,
    description: '',
    personality: '',
    system_prompt: `system ${id}${suffix}`,
    first_message: '',
    example_dialogues: [],
    tags: [],
    created_at: '2026-07-11T00:00:00.000Z',
    updated_at: '2026-07-11T00:00:00.000Z',
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createFetchHarness() {
  const requests = [];
  const fetch = input => {
    const deferred = createDeferred();
    requests.push({ url: String(input), deferred, settled: false });
    return deferred.promise;
  };

  function pending(characterId) {
    const request = requests.find(candidate => (
      !candidate.settled && candidate.url === `/api/characters/${characterId}`
    ));
    assert.ok(request, `missing pending character request for ${characterId}`);
    return request;
  }

  async function resolve(characterId, body = character(characterId, ' full')) {
    const request = pending(characterId);
    request.settled = true;
    await act(async () => {
      request.deferred.resolve(jsonResponse(body));
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    });
  }

  async function reject(characterId, error = new Error(`failed ${characterId}`)) {
    const request = pending(characterId);
    request.settled = true;
    await act(async () => {
      request.deferred.reject(error);
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    });
  }

  async function resolveHttpError(characterId) {
    const request = pending(characterId);
    request.settled = true;
    await act(async () => {
      request.deferred.resolve(jsonResponse({ error: `failed ${characterId}` }, { status: 500 }));
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    });
  }

  return { fetch, pending, reject, requests, resolve, resolveHttpError };
}

function loadHome() {
  let sidebarProps = null;

  function SidebarProbe(props) {
    sidebarProps = props;
    return React.createElement('div', {
      'data-testid': 'home-sidebar',
      'data-character-id': props.selectedCharacterId ?? '',
    });
  }

  function ChatViewProbe(props) {
    return React.createElement('div', {
      'data-testid': 'home-chat',
      'data-character-id': props.character?.id ?? '',
      'data-conversation-id': props.conversationId ?? '',
      'data-target-message-id': props.targetMessageId ?? '',
    });
  }

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/components/sidebar/Sidebar') {
      return { __esModule: true, default: SidebarProbe };
    }
    if (request === '@/components/chat/ChatView') {
      return { __esModule: true, default: ChatViewProbe };
    }
    if (request === '@/components/search/GlobalSearch') {
      return { __esModule: true, default: () => null };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve('../src/app/page.tsx');
    delete require.cache[resolved];
    const Home = require('../src/app/page.tsx').default;
    return {
      Home,
      getSidebarProps() {
        assert.ok(sidebarProps, 'Sidebar should have rendered');
        return sidebarProps;
      },
    };
  } finally {
    Module._load = originalLoad;
  }
}

function readSelection(view) {
  const sidebar = view.getByTestId('home-sidebar');
  const chat = view.getByTestId('home-chat');
  return {
    selectedCharacterId: sidebar.dataset.characterId || null,
    characterId: chat.dataset.characterId || null,
    conversationId: chat.dataset.conversationId || null,
    targetMessageId: chat.dataset.targetMessageId || null,
  };
}

function assertSelection(view, expected) {
  assert.deepEqual(readSelection(view), expected);
  assert.equal(
    expected.selectedCharacterId,
    expected.characterId,
    'the selected character id and rendered character must stay in the same generation',
  );
  if (expected.conversationId) {
    assert.equal(
      expected.conversationId,
      `conv-${expected.characterId}`,
      'the rendered conversation must belong to the rendered character',
    );
  }
}

async function renderInitializedHome(fetchHarness) {
  const { Home, getSidebarProps } = loadHome();
  const view = render(React.createElement(Home));

  act(() => {
    getSidebarProps().onCharacterSelect('A', character('A', ' snapshot'));
  });
  assertSelection(view, {
    selectedCharacterId: 'A',
    characterId: 'A',
    conversationId: null,
    targetMessageId: null,
  });
  await fetchHarness.resolve('A');

  let conversationSelection;
  act(() => {
    conversationSelection = getSidebarProps().onConversationSelect('A', 'conv-A', 'message-A');
  });
  await act(async () => {
    await conversationSelection;
  });
  assertSelection(view, {
    selectedCharacterId: 'A',
    characterId: 'A',
    conversationId: 'conv-A',
    targetMessageId: 'message-A',
  });

  return { getSidebarProps, view };
}

for (const responseOrder of ['older-first', 'newer-first']) {
  test(`home selection keeps character then conversation promises consistent (${responseOrder})`, async () => {
    const fetchHarness = createFetchHarness();
    const originalFetch = global.fetch;
    global.fetch = fetchHarness.fetch;

    try {
      const { getSidebarProps, view } = await renderInitializedHome(fetchHarness);

      act(() => {
        getSidebarProps().onCharacterSelect('B', character('B', ' snapshot'));
      });
      assertSelection(view, {
        selectedCharacterId: 'B',
        characterId: 'B',
        conversationId: null,
        targetMessageId: null,
      });

      let selectConversation;
      act(() => {
        selectConversation = getSidebarProps().onConversationSelect('C', 'conv-C', 'message-C');
      });
      assertSelection(view, {
        selectedCharacterId: 'B',
        characterId: 'B',
        conversationId: null,
        targetMessageId: null,
      });

      if (responseOrder === 'older-first') {
        await fetchHarness.resolve('B');
        assertSelection(view, {
          selectedCharacterId: 'B',
          characterId: 'B',
          conversationId: null,
          targetMessageId: null,
        });
        await fetchHarness.resolve('C');
        await selectConversation;
      } else {
        await fetchHarness.resolve('C');
        await selectConversation;
        assertSelection(view, {
          selectedCharacterId: 'C',
          characterId: 'C',
          conversationId: 'conv-C',
          targetMessageId: 'message-C',
        });
        await fetchHarness.resolve('B');
      }

      assertSelection(view, {
        selectedCharacterId: 'C',
        characterId: 'C',
        conversationId: 'conv-C',
        targetMessageId: 'message-C',
      });
    } finally {
      cleanup();
      global.fetch = originalFetch;
    }
  });

  test(`home selection keeps conversation then character promises consistent (${responseOrder})`, async () => {
    const fetchHarness = createFetchHarness();
    const originalFetch = global.fetch;
    global.fetch = fetchHarness.fetch;

    try {
      const { getSidebarProps, view } = await renderInitializedHome(fetchHarness);

      let selectConversation;
      act(() => {
        selectConversation = getSidebarProps().onConversationSelect('B', 'conv-B', 'message-B');
      });
      assertSelection(view, {
        selectedCharacterId: 'A',
        characterId: 'A',
        conversationId: 'conv-A',
        targetMessageId: 'message-A',
      });

      act(() => {
        getSidebarProps().onCharacterSelect('C', character('C', ' snapshot'));
      });
      assertSelection(view, {
        selectedCharacterId: 'C',
        characterId: 'C',
        conversationId: null,
        targetMessageId: null,
      });

      if (responseOrder === 'older-first') {
        await fetchHarness.resolve('B');
        await selectConversation;
        assertSelection(view, {
          selectedCharacterId: 'C',
          characterId: 'C',
          conversationId: null,
          targetMessageId: null,
        });
        await fetchHarness.resolve('C');
      } else {
        await fetchHarness.resolve('C');
        await fetchHarness.resolve('B');
        await selectConversation;
      }

      assertSelection(view, {
        selectedCharacterId: 'C',
        characterId: 'C',
        conversationId: null,
        targetMessageId: null,
      });
    } finally {
      cleanup();
      global.fetch = originalFetch;
    }
  });
}

test('home selection failures preserve the previous complete selection', async () => {
  const fetchHarness = createFetchHarness();
  const originalFetch = global.fetch;
  global.fetch = fetchHarness.fetch;

  try {
    const { getSidebarProps, view } = await renderInitializedHome(fetchHarness);
    const previousSelection = {
      selectedCharacterId: 'A',
      characterId: 'A',
      conversationId: 'conv-A',
      targetMessageId: 'message-A',
    };

    let conversationSelection;
    act(() => {
      conversationSelection = getSidebarProps().onConversationSelect('B', 'conv-B', 'message-B');
    });
    assertSelection(view, previousSelection);
    await fetchHarness.resolveHttpError('B');
    await conversationSelection;
    assertSelection(view, previousSelection);

    act(() => {
      getSidebarProps().onCharacterSelect('C');
    });
    assertSelection(view, previousSelection);
    await fetchHarness.reject('C');
    assertSelection(view, previousSelection);
  } finally {
    cleanup();
    global.fetch = originalFetch;
  }
});

test.after(() => {
  cleanup();
  restoreDom();
  if (previousSessionStorage) {
    Object.defineProperty(global, 'sessionStorage', previousSessionStorage);
  } else {
    delete global.sessionStorage;
  }
  Module._resolveFilename = originalResolveFilename;
});
