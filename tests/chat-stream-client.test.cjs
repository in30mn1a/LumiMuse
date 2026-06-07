const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

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

const {
  buildClientTimePayload,
  fetchMessagesPage,
  handleChatSseEvent,
  messagesUrl,
  parseChatSsePart,
  readChatSseStream,
} = require(path.resolve(__dirname, '../src/lib/chat-stream-client.ts'));

function message(id, seq) {
  return {
    id,
    conversation_id: 'conv-a',
    role: 'user',
    content: `message ${id}`,
    token_count: 1,
    created_at: `2026-06-06T12:00:${String(seq).padStart(2, '0')}.000Z`,
    seq,
    metadata: {},
  };
}

function streamFromTextChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function createControlledTextStream() {
  const encoder = new TextEncoder();
  let streamController;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  });

  return {
    stream,
    enqueue(text) {
      streamController.enqueue(encoder.encode(text));
    },
    close() {
      streamController.close();
    },
  };
}

function waitForStreamRead() {
  return new Promise(resolve => setImmediate(resolve));
}

test('messagesUrl builds optional query parameters without empty values', () => {
  assert.equal(messagesUrl('conv a'), '/api/messages?conversation_id=conv+a');
  assert.equal(
    messagesUrl('conv-a', { limit: 60, beforeSeq: 12, all: true }),
    '/api/messages?conversation_id=conv-a&all=1&limit=60&before_seq=12',
  );
  assert.equal(
    messagesUrl('conv-a', { limit: 0, beforeSeq: null, all: false }),
    '/api/messages?conversation_id=conv-a',
  );
});

test('fetchMessagesPage keeps legacy array responses compatible', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  let requestedSignal = null;

  try {
    const signal = new AbortController().signal;
    global.fetch = async (url, options) => {
      requestedUrl = String(url);
      requestedSignal = options.signal;
      return new Response(JSON.stringify([message('a-1', 4), message('a-2', 5)]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const response = await fetchMessagesPage('conv-a', { limit: 2, signal });

    assert.equal(requestedUrl, '/api/messages?conversation_id=conv-a&limit=2');
    assert.equal(requestedSignal, signal);
    assert.deepEqual(response.messages.map(item => item.id), ['a-1', 'a-2']);
    assert.equal(response.hasMore, false);
    assert.equal(response.oldestSeq, 4);
  } finally {
    global.fetch = originalFetch;
  }
});

test('parseChatSsePart reads event names and multiline data', () => {
  assert.deepEqual(parseChatSsePart('event: chunk\ndata: {"text":"hello"}'), {
    eventType: 'chunk',
    eventData: '{"text":"hello"}',
  });
  assert.deepEqual(parseChatSsePart('event: chunk\ndata: first\ndata: second'), {
    eventType: 'chunk',
    eventData: 'first\nsecond',
  });
  assert.deepEqual(parseChatSsePart('event: chunk\r\ndata: {"text":"hello"}\r\n'), {
    eventType: 'chunk',
    eventData: '{"text":"hello"}',
  });
});

test('handleChatSseEvent dispatches chunks, memory status, and server errors', () => {
  const chunks = [];
  let memoryExtracting = 0;
  const handlers = {
    onChunk: text => chunks.push(text),
    onMemoryExtracting: () => { memoryExtracting += 1; },
    getErrorMessage: () => 'fallback error',
  };

  handleChatSseEvent('', '{"text":"a"}', handlers);
  handleChatSseEvent('chunk', '{"text":"b"}', handlers);
  handleChatSseEvent('memory', '{"status":"extracting"}', handlers);
  handleChatSseEvent('chunk', '{"text":', handlers);

  assert.deepEqual(chunks, ['a', 'b']);
  assert.equal(memoryExtracting, 1);
  assert.throws(
    () => handleChatSseEvent('error', '{"message":"server failed"}', handlers),
    /server failed/,
  );
  assert.throws(
    () => handleChatSseEvent('error', '{}', handlers),
    /fallback error/,
  );
});

test('readChatSseStream parses split SSE chunks in order', async () => {
  const chunks = [];
  let memoryExtracting = 0;

  await readChatSseStream(streamFromTextChunks([
    'event: chunk\ndata: {"text":"he',
    'llo"}\n\n',
    'event: memory\ndata: {"status":"extracting"}\n\n',
    'data: {"text":"!"}',
  ]), {
    onChunk: text => chunks.push(text),
    onMemoryExtracting: () => { memoryExtracting += 1; },
    getErrorMessage: () => 'stream failed',
  });

  assert.deepEqual(chunks, ['hello', '!']);
  assert.equal(memoryExtracting, 1);
});

test('readChatSseStream emits CRLF-delimited chunks before stream closes', async () => {
  const chunks = [];
  const controlled = createControlledTextStream();
  const reading = readChatSseStream(controlled.stream, {
    onChunk: text => chunks.push(text),
    onMemoryExtracting: () => {},
    getErrorMessage: () => 'stream failed',
  });

  try {
    controlled.enqueue('event: chunk\r\ndata: {"text":"hello"}\r\n\r\n');
    await waitForStreamRead();

    assert.deepEqual(chunks, ['hello']);
  } finally {
    controlled.close();
    await reading;
  }
});

test('buildClientTimePayload returns chat request time fields', () => {
  const payload = buildClientTimePayload();

  assert.match(payload.client_now_iso, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof payload.client_timezone, 'string');
  assert.equal(typeof payload.client_utc_offset_minutes, 'number');
});
