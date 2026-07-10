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
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

function loadDeadlineModule() {
  try {
    const resolved = require.resolve('../src/lib/background-llm-deadline.ts');
    delete require.cache[resolved];
    return require(resolved);
  } catch {
    return {};
  }
}

test('background LLM timeout defaults to thirty minutes', () => {
  const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
  assert.equal(DEFAULT_SETTINGS.memory_background_timeout_ms, 1_800_000);
});

test('settings schema accepts zero and large explicit deadlines while rejecting negatives', () => {
  const { settingsUpdateSchema } = require('../src/lib/schemas.ts');
  const disabled = settingsUpdateSchema.safeParse({ memory_background_timeout_ms: 0 });
  const longRunning = settingsUpdateSchema.safeParse({ memory_background_timeout_ms: 172_800_000 });
  const negative = settingsUpdateSchema.safeParse({ memory_background_timeout_ms: -1 });
  const longImageDeadline = settingsUpdateSchema.safeParse({ image_gen: { generate_timeout_ms: 3_000_000_000 } });

  assert.equal(disabled.success, true);
  assert.equal(disabled.success && disabled.data.memory_background_timeout_ms, 0);
  assert.equal(longRunning.success, true);
  assert.equal(longRunning.success && longRunning.data.memory_background_timeout_ms, 172_800_000);
  assert.equal(negative.success, false);
  assert.equal(longImageDeadline.success, true);
});

test('zero timeout disables the watchdog and passes no synthetic signal', async () => {
  const { runWithBackgroundLlmDeadline } = loadDeadlineModule();
  assert.equal(typeof runWithBackgroundLlmDeadline, 'function');

  let receivedSignal = 'not-called';
  const result = await runWithBackgroundLlmDeadline(0, async signal => {
    receivedSignal = signal;
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(receivedSignal, undefined);
});

test('positive timeout aborts a stuck background operation with a typed error', async () => {
  const { BackgroundLlmTimeoutError, runWithBackgroundLlmDeadline } = loadDeadlineModule();
  assert.equal(typeof runWithBackgroundLlmDeadline, 'function');

  let receivedSignal;
  const promise = runWithBackgroundLlmDeadline(10, signal => {
    receivedSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });

  await assert.rejects(promise, error => {
    assert.equal(error instanceof BackgroundLlmTimeoutError, true);
    assert.equal(error.timeoutMs, 10);
    return true;
  });
  assert.equal(receivedSignal.aborted, true);
});

test('long deadlines are chunked below the native setTimeout overflow boundary', () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const delays = [];
  let cleared;
  global.setTimeout = (_callback, delay) => {
    delays.push(delay);
    return 77;
  };
  global.clearTimeout = handle => { cleared = handle; };
  try {
    const { MAX_TIMER_DELAY_MS, scheduleLongTimeout } = require('../src/lib/long-timeout.ts');
    const clear = scheduleLongTimeout(() => {}, 3_000_000_000);
    assert.deepEqual(delays, [MAX_TIMER_DELAY_MS]);
    clear();
    assert.equal(cleared, 77);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});
