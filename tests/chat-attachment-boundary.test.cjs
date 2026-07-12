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

function jsonRequest(body) {
  return {
    signal: new AbortController().signal,
    async json() {
      return body;
    },
  };
}

function controlledJsonRequest(body) {
  const controller = new AbortController();
  return {
    controller,
    request: {
      signal: controller.signal,
      async json() {
        return body;
      },
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function chatBody(overrides = {}) {
  return {
    conversation_id: 'conv-a',
    content: 'hello',
    ...overrides,
  };
}

function textAttachment(name, data) {
  return {
    type: 'text',
    name,
    data,
    mimeType: 'text/plain',
  };
}

function imageAttachment(name, data) {
  return {
    type: 'image',
    name,
    data,
    mimeType: 'image/png',
  };
}

function baseCharacter(overrides = {}) {
  return {
    id: 'char-a',
    name: 'Alice',
    avatar_url: null,
    basic_info: '',
    personality: '',
    scenario: '',
    greeting: '',
    example_dialogue: '',
    system_prompt: '',
    other_info: '',
    image_tags: '',
    user_image_tags: '',
    created_at: '2026-06-07T00:00:00.000Z',
    updated_at: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

function baseSettings(overrides = {}) {
  return {
    context_window: 1000,
    max_tokens: 100,
    example_dialogue: false,
    memory_inject: false,
    show_timestamps: false,
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    id: 'msg-a',
    conversation_id: 'conv-a',
    role: 'user',
    content: 'hello',
    token_count: 1,
    created_at: '2026-06-07T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

function routeMocks(runChatImpl, dbRows = []) {
  return {
    '@/lib/chat-engine': { runChat: runChatImpl },
    '@/lib/db': {
      getDb() {
        return {
          prepare(sql) {
            if (sql.includes('FROM conversations')) {
              return { get: () => ({ character_id: 'char-a', ignore_memory: 1 }) };
            }
            if (sql.includes('FROM messages')) {
              return { all: () => dbRows };
            }
            return { get: () => undefined, all: () => [] };
          },
        };
      },
    },
    '@/lib/settings': {
      loadSettings() {
        return { streaming: true };
      },
    },
    '@/lib/memory-queue': {
      enqueueExtraction() {
        throw new Error('enqueueExtraction should not run in this test');
      },
    },
  };
}

async function readStreamText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

test('/api/chat rejects aggregate attachment bytes before runChat', async () => {
  let runChatCalls = 0;
  const route = requireFreshWithMocks('../src/app/api/chat/route.ts', routeMocks(() => {
    runChatCalls += 1;
  }));
  const { MAX_TOTAL_ATTACHMENT_BYTES } = require('../src/lib/schemas.ts');

  const response = await route.POST(jsonRequest(chatBody({
    attachments: [
      imageAttachment('a.png', 'data:image/png;base64,' + 'A'.repeat(Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES * 2 / 3) + 8)),
      imageAttachment('b.png', 'data:image/png;base64,' + 'B'.repeat(Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES * 2 / 3) + 8)),
    ],
  })));

  assert.equal(response.status, 413);
  assert.equal((await responseJson(response)).error, 'Attachments too large');
  assert.equal(runChatCalls, 0);
});

test('/api/chat rejects aggregate text attachment characters before runChat', async () => {
  let runChatCalls = 0;
  const route = requireFreshWithMocks('../src/app/api/chat/route.ts', routeMocks(() => {
    runChatCalls += 1;
  }));
  const { MAX_TOTAL_TEXT_ATTACHMENT_CHARS } = require('../src/lib/schemas.ts');

  const response = await route.POST(jsonRequest(chatBody({
    attachments: [
      textAttachment('a.txt', 'a'.repeat(Math.ceil(MAX_TOTAL_TEXT_ATTACHMENT_CHARS / 2))),
      textAttachment('b.txt', 'b'.repeat(Math.ceil(MAX_TOTAL_TEXT_ATTACHMENT_CHARS / 2) + 1)),
    ],
  })));

  assert.equal(response.status, 413);
  assert.equal((await responseJson(response)).error, 'Text attachments too large');
  assert.equal(runChatCalls, 0);
});

test('/api/chat accepts small attachments and keeps streaming response shape', async () => {
  let seenAttachments = null;
  const route = requireFreshWithMocks('../src/app/api/chat/route.ts', routeMocks(async (_conversationId, _content, _settings, callbacks, options) => {
    seenAttachments = options.attachments;
    callbacks.onChunk('hi');
  }));

  const response = await route.POST(jsonRequest(chatBody({
    attachments: [
      textAttachment('note.txt', 'small note'),
      imageAttachment('tiny.png', 'data:image/png;base64,AAAA'),
    ],
  })));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  assert.equal(seenAttachments.length, 2);
  assert.match(await readStreamText(response), /event: chunk\ndata: {"text":"hi"}/);
});

test('/api/chat emits an SSE error event and closes when runChat calls onError', async () => {
  const route = requireFreshWithMocks('../src/app/api/chat/route.ts', routeMocks(async (_conversationId, _content, _settings, callbacks) => {
    callbacks.onError(new Error('upstream failed'));
  }));

  const response = await route.POST(jsonRequest(chatBody()));
  const streamText = await readStreamText(response);

  assert.match(streamText, /event: error\ndata: {"message":"upstream failed"}\n\n/);
  assert.doesNotMatch(streamText, /event: chunk/);
});

test('/api/chat emits an SSE error event and closes when runChat throws', async () => {
  const route = requireFreshWithMocks('../src/app/api/chat/route.ts', routeMocks(async () => {
    throw new Error('runChat exploded');
  }));

  const response = await route.POST(jsonRequest(chatBody()));
  const streamText = await readStreamText(response);

  assert.match(streamText, /event: error\ndata: {"message":"runChat exploded"}\n\n/);
  assert.doesNotMatch(streamText, /event: chunk/);
});

test('/api/chat ignores late runChat callbacks after request abort', async () => {
  const runChatGate = deferred();
  let capturedCallbacks;
  const route = requireFreshWithMocks('../src/app/api/chat/route.ts', routeMocks(async (_conversationId, _content, _settings, callbacks) => {
    capturedCallbacks = callbacks;
    await runChatGate.promise;
  }));
  const { controller, request } = controlledJsonRequest(chatBody());

  const response = await route.POST(request);
  assert.ok(capturedCallbacks);
  controller.abort();

  assert.doesNotThrow(() => capturedCallbacks.onChunk('late chunk'));
  assert.doesNotThrow(() => capturedCallbacks.onUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
  await assert.doesNotReject(() => capturedCallbacks.onDone('late completion', 2));
  assert.doesNotThrow(() => capturedCallbacks.onError(new Error('late error')));

  runChatGate.resolve();
  const reader = response.body.getReader();
  const readResult = await Promise.race([
    reader.read().then(() => 'event'),
    new Promise(resolve => setImmediate(() => resolve('pending'))),
  ]);
  assert.equal(readResult, 'pending');
  await reader.cancel();
});

test('chat input payload strips uploaded image data URLs while preserving text attachment data', () => {
  const { prepareAttachmentPayload } = require('../src/lib/attachment-payload.ts');
  const imageDataUrl = 'data:image/png;base64,AAAA';
  const localAttachments = [
    {
      id: 'image-1',
      type: 'image',
      name: 'avatar.png',
      data: imageDataUrl,
      url: '/api/files/attachments/avatar.png',
      mimeType: 'image/png',
    },
    {
      id: 'text-1',
      type: 'text',
      name: 'note.txt',
      data: 'remember this',
      mimeType: 'text/plain',
    },
  ];

  const payload = prepareAttachmentPayload(localAttachments);

  assert.deepEqual(payload, [
    {
      type: 'image',
      name: 'avatar.png',
      url: '/api/files/attachments/avatar.png',
      mimeType: 'image/png',
    },
    {
      type: 'text',
      name: 'note.txt',
      data: 'remember this',
      mimeType: 'text/plain',
    },
  ]);
  assert.equal(localAttachments[0].data, imageDataUrl);
});

test('assemblePrompt counts text attachment content when trimming history budget', async () => {
  const { assemblePrompt } = require('../src/lib/chat-engine.ts');
  const { estimateTokens } = require('../src/lib/token-counter.ts');

  const character = baseCharacter();
  const oldAttachmentText = 'old attachment '.repeat(400);
  const currentContent = 'current message';
  const messages = [
    message({
      id: 'old-user',
      content: 'old message',
      metadata: { attachments: [textAttachment('old.txt', oldAttachmentText)] },
    }),
    message({
      id: 'current-user',
      content: currentContent,
      token_count: estimateTokens(currentContent),
      created_at: '2026-06-07T00:01:00.000Z',
    }),
  ];
  const probe = await assemblePrompt(character, [messages[1]], baseSettings({
    context_window: 100000,
  }), []);
  const systemTokens = estimateTokens(probe[0].content);
  const currentTokens = estimateTokens(currentContent);
  const settings = baseSettings({
    context_window: systemTokens + currentTokens + 104,
  });

  const prompt = await assemblePrompt(character, messages, settings, []);
  const rendered = JSON.stringify(prompt);

  assert.match(rendered, /current message/);
  assert.doesNotMatch(rendered, /old attachment/);
});

test('assemblePrompt applies the legacy memory package budget before injecting memories', async () => {
  const { assemblePrompt } = require('../src/lib/chat-engine.ts');
  const character = baseCharacter();
  const prompt = await assemblePrompt(
    character,
    [message({ id: 'current-user', content: 'current question' })],
    baseSettings({
      memory_inject: true,
      memory_engine: { memory_package_token_budget: 200 },
    }),
    [
      'short memory: Alice likes the blue scarf',
      `oversized memory: ${'too much detail '.repeat(400)}`,
    ],
  );
  const systemPrompt = prompt[0].content;

  assert.match(systemPrompt, /short memory: Alice likes the blue scarf/);
  assert.doesNotMatch(systemPrompt, /oversized memory/);
});

test('assemblePrompt preserves the current user message even when memory consumes the prompt budget', async () => {
  const { assemblePrompt } = require('../src/lib/chat-engine.ts');
  const prompt = await assemblePrompt(
    baseCharacter(),
    [message({ id: 'current-user', content: 'current message must stay' })],
    baseSettings({
      context_window: 40,
      max_tokens: 100,
      memory_inject: true,
    }),
    `large memory package ${'memory detail '.repeat(500)}`,
  );
  const rendered = JSON.stringify(prompt);

  assert.match(rendered, /current message must stay/);
});

test('assemblePrompt trims older history when the newest message already uses the remaining budget', async () => {
  const { assemblePrompt } = require('../src/lib/chat-engine.ts');
  const prompt = await assemblePrompt(
    baseCharacter(),
    [
      message({
        id: 'old-user',
        content: 'old history should be trimmed',
        token_count: 5000,
      }),
      message({
        id: 'current-user',
        content: 'latest user message',
        token_count: 1,
        created_at: '2026-06-07T00:01:00.000Z',
      }),
    ],
    baseSettings({
      context_window: 60,
      max_tokens: 100,
    }),
    [],
  );
  const rendered = JSON.stringify(prompt);

  assert.match(rendered, /latest user message/);
  assert.doesNotMatch(rendered, /old history should be trimmed/);
});

test('prompt token provenance is reusable only while content, attachments, and algorithm still match', () => {
  const {
    createMessageTokenCount,
    resolveMessageTokenCount,
  } = require('../src/lib/message-token-provenance.ts');
  const attachments = [textAttachment('note.txt', 'remember this')];
  const calculated = createMessageTokenCount('hello', 'user', attachments);
  const trustedMessage = message({
    content: 'hello',
    token_count: calculated.tokenCount,
    metadata: {
      attachments,
      token_count_provenance: calculated.provenance,
    },
  });

  assert.equal(resolveMessageTokenCount(trustedMessage).reused, true);
  assert.equal(resolveMessageTokenCount({ ...trustedMessage, content: 'edited' }).reused, false);
  assert.equal(resolveMessageTokenCount({
    ...trustedMessage,
    metadata: {
      ...trustedMessage.metadata,
      attachments: [textAttachment('note.txt', 'changed attachment')],
    },
  }).reused, false);
  assert.equal(resolveMessageTokenCount({
    ...trustedMessage,
    metadata: {
      ...trustedMessage.metadata,
      token_count_provenance: {
        ...calculated.provenance,
        algorithm: 'legacy-tokenizer-v0',
      },
    },
  }).reused, false);
});

test('assemblePrompt does not trust an unversioned external token_count for budget trimming', async () => {
  const { assemblePrompt } = require('../src/lib/chat-engine.ts');
  const { estimateTokens } = require('../src/lib/token-counter.ts');
  const prompt = await assemblePrompt(
    baseCharacter(),
    [
      message({
        id: 'external-count',
        content: 'short imported message',
        token_count: 5000,
      }),
      message({
        id: 'current',
        content: 'current question',
        token_count: estimateTokens('current question'),
        created_at: '2026-06-07T00:01:00.000Z',
      }),
    ],
    baseSettings({ context_window: 1200, max_tokens: 100 }),
    [],
  );

  assert.match(prompt.map(message => message.content).join('\n'), /short imported message/);
});
