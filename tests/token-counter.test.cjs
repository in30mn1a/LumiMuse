const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const tokenCounterPath = path.join(root, 'src/lib/token-counter.ts');
const originalLoad = Module._load;
const originalDateNow = Date.now;
const originalWarn = console.warn;

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

function requireFreshTokenCounter() {
  delete require.cache[require.resolve(tokenCounterPath)];
  return require(tokenCounterPath);
}

function withMocks(mocks, fn) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      const mock = mocks[request];
      if (mock instanceof Error) throw mock;
      return mock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

function captureWarnings(fn) {
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };

  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test.afterEach(() => {
  Module._load = originalLoad;
  Date.now = originalDateNow;
  console.warn = originalWarn;
  delete require.cache[require.resolve(tokenCounterPath)];
});

test('fallback estimate covers empty string, Chinese, English, numbers, and emoji', () => {
  const { estimateTokens } = requireFreshTokenCounter();
  const mocks = {
    'js-tiktoken/lite': new Error('missing tiktoken'),
    'js-tiktoken/ranks/cl100k_base': {},
  };

  const { result } = captureWarnings(() =>
    withMocks(mocks, () => ({
      empty: estimateTokens(''),
      chinese: estimateTokens('你好世界'),
      english: estimateTokens('hello world'),
      numbers: estimateTokens('12345678'),
      emoji: estimateTokens('😀'),
    })),
  );

  assert.deepEqual(result, {
    empty: 0,
    chinese: 6,
    english: 4,
    numbers: 2,
    emoji: 1,
  });
});

test('warns when encoder initialization fails and fallback is used', () => {
  Date.now = () => 1_000;
  const { estimateTokens } = requireFreshTokenCounter();
  const mocks = {
    'js-tiktoken/lite': new Error('transient tiktoken load failure'),
    'js-tiktoken/ranks/cl100k_base': {},
  };

  const { result, warnings } = captureWarnings(() =>
    withMocks(mocks, () => estimateTokens('hello world')),
  );

  assert.equal(result, 4);
  assert.ok(warnings.length >= 1);
  assert.match(warnings.join('\n'), /token counter/i);
  assert.match(warnings.join('\n'), /fallback/i);
});

test('retries encoder initialization after cooldown and returns to encoder counts', () => {
  let now = 1_000;
  Date.now = () => now;

  let loadAttempts = 0;
  class FakeTiktoken {
    encode(text) {
      return new Array(text.length + 10).fill(0);
    }
  }

  const { estimateTokens } = requireFreshTokenCounter();
  const liteMock = {};
  Object.defineProperty(liteMock, 'Tiktoken', {
    get() {
      loadAttempts += 1;
      if (loadAttempts === 1) {
        throw new Error('transient tiktoken load failure');
      }
      return FakeTiktoken;
    },
  });

  const mocks = {
    'js-tiktoken/lite': liteMock,
    'js-tiktoken/ranks/cl100k_base': { default: { ranks: [] } },
  };

  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };

  const first = withMocks(mocks, () => estimateTokens('hello'));
  const beforeCooldown = withMocks(mocks, () => estimateTokens('hello'));
  now += 61_000;
  const afterCooldown = withMocks(mocks, () => estimateTokens('hello'));

  assert.equal(first, 2);
  assert.equal(beforeCooldown, 2);
  assert.equal(afterCooldown, 15);
  assert.equal(loadAttempts, 2);
  assert.ok(warnings.length >= 1);
});
