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
