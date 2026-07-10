const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

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
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

function loadLogger() {
  try {
    const resolved = require.resolve('../src/lib/structured-log.ts');
    delete require.cache[resolved];
    return require(resolved);
  } catch {
    return {};
  }
}

test('structured logger emits one JSON object with safe correlation fields and serialized Error', () => {
  const { structuredLog } = loadLogger();
  assert.equal(typeof structuredLog, 'function');

  const lines = [];
  const original = console.error;
  console.error = line => lines.push(line);
  try {
    structuredLog('error', 'memory.profile.failed', {
      requestId: 'req-1',
      taskId: 'task-2',
      characterId: 'char-3',
      status: 'failed',
      durationMs: 42,
    }, new TypeError('upstream failed'));
  } finally {
    console.error = original;
  }

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, 'error');
  assert.equal(entry.event, 'memory.profile.failed');
  assert.equal(entry.requestId, 'req-1');
  assert.equal(entry.taskId, 'task-2');
  assert.equal(entry.characterId, 'char-3');
  assert.equal(entry.error.name, 'TypeError');
  assert.deepEqual(entry.error, { name: 'TypeError' });
  assert.equal(typeof entry.timestamp, 'string');
});

test('structured logger drops non-whitelisted and sensitive fields', () => {
  const { structuredLog } = loadLogger();
  assert.equal(typeof structuredLog, 'function');

  const lines = [];
  const original = console.warn;
  console.warn = line => lines.push(line);
  try {
    structuredLog('warn', 'image.failed', {
      requestId: 'req-safe',
      engine: 'nai',
      apiKey: 'secret-key',
      prompt: 'private prompt',
      headers: { authorization: 'Bearer secret' },
      claimToken: 'claim-secret',
      arbitrary: 'not allowed',
    });
  } finally {
    console.warn = original;
  }

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.requestId, 'req-safe');
  assert.equal(entry.engine, 'nai');
  for (const forbidden of ['apiKey', 'prompt', 'headers', 'claimToken', 'arbitrary']) {
    assert.equal(Object.hasOwn(entry, forbidden), false, `${forbidden} must not be logged`);
  }
  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /secret-key|private prompt|Bearer secret|claim-secret/);
});

test('structured logger never exposes sensitive Error messages', () => {
  const { structuredLog } = loadLogger();
  const lines = [];
  const original = console.error;
  console.error = line => lines.push(line);
  try {
    structuredLog('error', 'upstream.failed', { requestId: 'req-safe' }, new Error(
      'prompt=private conversation Authorization: Bearer sk-secret http://10.0.0.8/internal',
    ));
  } finally {
    console.error = original;
  }
  const serialized = lines[0];
  assert.doesNotMatch(serialized, /private conversation|Authorization|Bearer|sk-secret|10\.0\.0\.8|internal/);
  assert.deepEqual(JSON.parse(serialized).error, { name: 'Error' });
});

test('request and background failure paths use structured correlation logging', () => {
  const proxy = fs.readFileSync(path.join(root, 'src/proxy.ts'), 'utf8');
  const imageRoute = fs.readFileSync(path.join(root, 'src/app/api/image-gen/route.ts'), 'utf8');
  const promptRoute = fs.readFileSync(path.join(root, 'src/app/api/image-gen/prompt/route.ts'), 'utf8');
  const memoryQueue = fs.readFileSync(path.join(root, 'src/lib/memory-queue.ts'), 'utf8');
  const memoryProfile = fs.readFileSync(path.join(root, 'src/lib/memory-profile.ts'), 'utf8');

  assert.match(proxy, /forwardedHeaders\.set\(REQUEST_ID_HEADER, requestId\)/);
  assert.match(proxy, /response\.headers\.set\(REQUEST_ID_HEADER, requestId\)/);
  assert.match(imageRoute, /structuredLog\('error', 'image\.generation\.failed'/);
  assert.match(promptRoute, /structuredLog\('error', 'image\.prompt\.failed'/);
  assert.match(memoryQueue, /structuredLog\('error', 'memory\.extraction\.failed'/);
  assert.match(memoryQueue, /taskId: task\.id/);
  assert.match(memoryQueue, /characterId: task\.character_id/);
  assert.match(memoryProfile, /structuredLog\('error', 'memory\.profile\.task_failed'/);
});
