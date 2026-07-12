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

const { parseSseStream } = require(path.resolve(__dirname, '../src/lib/sse-parser.ts'));

function readerFromTextChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }).getReader();
}

function readerFromByteChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  }).getReader();
}

function createCancelableControlledReader() {
  const queued = [];
  let pendingRead = null;
  let cancelled = false;
  let cancelCalls = 0;

  const settlePendingRead = (result) => {
    const resolve = pendingRead;
    pendingRead = null;
    resolve?.(result);
  };

  return {
    reader: {
      read() {
        if (cancelled) return Promise.resolve({ done: true, value: undefined });
        if (queued.length > 0) return Promise.resolve({ done: false, value: queued.shift() });
        return new Promise(resolve => {
          pendingRead = resolve;
        });
      },
      cancel() {
        cancelCalls += 1;
        cancelled = true;
        settlePendingRead({ done: true, value: undefined });
        return Promise.resolve();
      },
    },
    enqueue(value) {
      if (cancelled) return;
      if (pendingRead) {
        settlePendingRead({ done: false, value });
      } else {
        queued.push(value);
      }
    },
    release() {
      cancelled = true;
      settlePendingRead({ done: true, value: undefined });
    },
    get cancelCalls() {
      return cancelCalls;
    },
  };
}

function createControlledReader() {
  const encoder = new TextEncoder();
  let streamController;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  });

  return {
    reader: stream.getReader(),
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

test('parseSseStream warns when a complete data event has malformed JSON', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  const deltas = [];

  try {
    console.warn = (...args) => {
      warnings.push(args);
    };

    await parseSseStream(
      readerFromTextChunks(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: {"choices":\n\n']),
      chunk => deltas.push(chunk),
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /Failed to parse complete SSE data event/);
  assert.deepEqual(deltas.map(chunk => chunk.text), ['ok']);
});

test('parseSseStream parses complete JSON split across multiple chunks', async () => {
  const deltas = [];

  await parseSseStream(
    readerFromTextChunks([
      'data: {"choices":[{"delta":',
      '{"content":"he',
      'llo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    chunk => deltas.push(chunk),
  );

  assert.deepEqual(deltas.map(chunk => chunk.text), ['hello']);
});

test('parseSseStream emits CRLF-delimited OpenAI events before stream closes', async () => {
  const deltas = [];
  const controlled = createControlledReader();
  const parsing = parseSseStream(controlled.reader, chunk => deltas.push(chunk));

  try {
    controlled.enqueue('data: {"choices":[{"delta":{"content":"hello"}}]}\r\n\r\n');
    await waitForStreamRead();

    assert.deepEqual(deltas.map(chunk => chunk.text), ['hello']);
  } finally {
    controlled.close();
    await parsing;
  }
});

test('parseSseStream preserves Chinese and emoji split inside UTF-8 code points', async () => {
  const encoder = new TextEncoder();
  const content = '你🙂好';
  const prefix = 'data: {"choices":[{"delta":{"content":"';
  const eventBytes = encoder.encode(`${prefix}${content}"}}]}\n\n`);
  const contentStart = encoder.encode(prefix).length;
  const chunks = [
    eventBytes.slice(0, contentStart + 1),
    eventBytes.slice(contentStart + 1, contentStart + 5),
    eventBytes.slice(contentStart + 5, contentStart + 8),
    eventBytes.slice(contentStart + 8),
  ];
  const deltas = [];

  await parseSseStream(
    readerFromByteChunks(chunks),
    chunk => deltas.push(chunk),
  );

  assert.deepEqual(deltas.map(chunk => chunk.text), [content]);
  assert.ok(!deltas[0].text.includes('\uFFFD'));
});

test('parseSseStream flushes the final data event without a trailing blank line', async () => {
  const deltas = [];

  await parseSseStream(
    readerFromTextChunks(['data: {"choices":[{"delta":{"content":"final"}}]}']),
    chunk => deltas.push(chunk),
  );

  assert.deepEqual(deltas.map(chunk => chunk.text), ['final']);
});

test('parseSseStream cancels a pending reader on mid-stream abort and emits no later delta', async () => {
  const encoder = new TextEncoder();
  const controlled = createCancelableControlledReader();
  const abortController = new AbortController();
  const deltas = [];
  const parsing = parseSseStream(
    controlled.reader,
    chunk => deltas.push(chunk),
    { signal: abortController.signal },
  );

  try {
    controlled.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"before"}}]}\n\n'));
    await waitForStreamRead();
    assert.deepEqual(deltas.map(chunk => chunk.text), ['before']);

    abortController.abort();
    await waitForStreamRead();

    assert.equal(controlled.cancelCalls, 1);
    controlled.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"after"}}]}\n\n'));
    await parsing;
    assert.deepEqual(deltas.map(chunk => chunk.text), ['before']);
  } finally {
    controlled.release();
    await parsing;
  }
});
