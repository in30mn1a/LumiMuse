const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, ...rest) {
  if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
  return resolveFilename.call(this, request, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const sandbox = require('../src/lib/spreset/sandbox.ts');

test.before(async () => {
  await sandbox.initializeSandbox?.();
});

function release(value) {
  sandbox.disposeSandboxValue?.(value);
}

test('console constructor cannot reach host process', () => {
  const fn = sandbox.evaluateFunction(`() => console.log.constructor('return typeof process')()`);
  try {
    assert.equal(fn({}), 'undefined');
  } finally {
    release(fn);
  }
});

test('argument constructor stays in the isolated interpreter', () => {
  const fn = sandbox.evaluateFunction(`arg => {
    arg.messages.length = 0;
    return arg.constructor.constructor('return typeof process')();
  }`);
  const input = { messages: [{ role: 'user', content: 'preserve' }] };
  try {
    assert.equal(fn(input), 'undefined');
    assert.equal(input.messages.length, 1);
  } finally {
    release(fn);
  }
});

test('factory evaluation cannot escape through console methods', () => {
  const value = sandbox.evaluateFactory(`return {
    name: console.warn.constructor('return [typeof process, typeof require, typeof fetch].join(",")')(),
  };`);
  try {
    assert.equal(value.name, 'undefined,undefined,undefined');
  } finally {
    release(value);
  }
});

test('actual synchronous function execution observes its timeout', () => {
  const fn = sandbox.evaluateFunction(`() => {
    const start = Date.now();
    while (Date.now() - start < 400) {}
    return 'late';
  }`, { timeoutMs: 100 });
  try {
    assert.throws(() => fn({}), /超时|interrupt/i);
  } finally {
    release(fn);
  }
});

test('result serialization is executed within the same timeout', () => {
  const fn = sandbox.evaluateFunction(`() => ({
    toJSON() {
      const start = Date.now();
      while (Date.now() - start < 400) {}
      return { ok: true };
    },
  })`, { timeoutMs: 100 });
  try {
    assert.throws(() => fn({}), /超时|interrupt/i);
  } finally {
    release(fn);
  }
});

test('async factory action jobs observe their timeout', async () => {
  const value = sandbox.evaluateFactory(`return {
    action: async () => {
      await Promise.resolve();
      const start = Date.now();
      while (Date.now() - start < 400) {}
      return 'late';
    },
  };`, { timeoutMs: 100 });
  try {
    await assert.rejects(async () => value.action({}), /超时|interrupt/i);
  } finally {
    release(value);
  }
});

test('factory action preserves its closure and modern JavaScript methods', async () => {
  const value = sandbox.evaluateFactory(`
    let count = 0;
    return {
      name: 'closure',
      action: async (arg) => {
        await Promise.resolve();
        count += 1;
        return { count, text: [...new Set(arg.values)].at(-1).replaceAll('x', 'y') };
      },
    };
  `);
  try {
    assert.deepEqual(await value.action({ values: ['x', 'x'] }), { count: 1, text: 'y' });
    assert.deepEqual(await value.action({ values: ['x'] }), { count: 2, text: 'y' });
  } finally {
    release(value);
  }
});

test('result getters and error coercion are also interruptible', () => {
  const scripts = [
    `() => ({ get data() { const t = Date.now(); while (Date.now() - t < 400) {} return 'late'; } })`,
    `() => { throw { toString() { const t = Date.now(); while (Date.now() - t < 400) {} return 'late'; } }; }`,
  ];
  for (const source of scripts) {
    const fn = sandbox.evaluateFunction(source, { timeoutMs: 100 });
    try {
      assert.throws(() => fn({}), /超时|interrupt/i);
    } finally {
      release(fn);
    }
  }
});

test('factory evaluation itself is interruptible', () => {
  const value = sandbox.evaluateFactory(`
    const t = Date.now();
    while (Date.now() - t < 400) {}
    return { name: 'late' };
  `, { timeoutMs: 100 });
  assert.equal(value, null);
});

test('self-replenishing async jobs cannot evade the action deadline', async () => {
  const value = sandbox.evaluateFactory(`return {
    action: async () => {
      const t = Date.now();
      while (Date.now() - t < 400) await Promise.resolve();
      return 'late';
    },
  };`, { timeoutMs: 100 });
  try {
    await assert.rejects(async () => value.action({}), /超时|interrupt/i);
  } finally {
    release(value);
  }
});

test('scope and value disposal are idempotent and release persistent closures', async () => {
  const scope = sandbox.createSandboxScope();
  const first = sandbox.evaluateFunction('arg => arg', { scope });
  const second = sandbox.evaluateFactory('return { action: arg => arg };', { scope });
  first.dispose();
  first.dispose();
  assert.deepEqual(await second.action({ ok: true }), { ok: true });
  scope.dispose();
  scope.dispose();
  release(second);
  assert.throws(() => first({}), /已释放/);
  assert.throws(() => second.action({}), /已释放/);
  assert.equal(sandbox.evaluateFunction('arg => arg', { scope }), null);
});

const RECURSE = '() => { const f = () => f() + 1; return f(); }';

function assertHealthy() {
  const healthy = sandbox.evaluateFunction('({ value }) => value + 1');
  assert.ok(healthy, '健康脚本应能求值');
  try {
    assert.equal(healthy({ value: 41 }), 42);
  } finally {
    release(healthy);
  }
}

test('runaway recursion is an ordinary script error and never poisons the interpreter', () => {
  for (let round = 0; round < 30; round += 1) {
    const fn = sandbox.evaluateFunction(RECURSE);
    assert.ok(fn);
    assert.throws(() => fn({}), error => !/Aborted|Assertion/.test(error.message));
    release(fn);
  }
  assertHealthy();
});

test('deeply nested JSON cannot overflow the host stack', () => {
  for (const depth of [5000, 20000, 200000]) {
    const fn = sandbox.evaluateFunction(`() => {
      const text = '['.repeat(${depth}) + ']'.repeat(${depth});
      try { JSON.parse(text); return 'parsed'; } catch (error) { return 'rejected'; }
    }`);
    assert.ok(fn);
    assert.ok(['parsed', 'rejected'].includes(fn({})));
    release(fn);
  }
  assertHealthy();
});

test('a call made near host stack exhaustion stays contained and the next init recovers', async () => {
  let limit = 0;
  const measure = () => { limit += 1; measure(); };
  try { measure(); } catch { /* 量出当前可用的宿主栈深度 */ }
  const descend = (remaining, action) => (remaining <= 0 ? action() : descend(remaining - 1, action));
  for (const ratio of [0.99, 0.97, 0.93, 0.85, 0.7, 0.5]) {
    const fn = sandbox.evaluateFunction(RECURSE);
    assert.ok(fn);
    try {
      descend(Math.floor(limit * ratio), () => fn({}));
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /Aborted|Assertion/);
    }
    release(fn);
    await sandbox.initializeSandbox();
    assertHealthy();
  }
});

test('a fault in one context leaves its scope disposable', () => {
  const scope = sandbox.createSandboxScope();
  const first = sandbox.evaluateFunction(RECURSE, { scope });
  const second = sandbox.evaluateFunction('arg => arg', { scope });
  assert.throws(() => first({}));
  scope.dispose();
  assert.throws(() => second({}), /已释放/);
});

test('runaway allocation fails as a script error instead of exhausting the process', () => {
  for (const source of [
    '() => { const all = []; while (true) all.push(new Array(1000000).fill(0)); }',
    '() => { let text = "x".repeat(1048576); const all = []; while (true) { text += "y"; all.push(text); } }',
  ]) {
    const fn = sandbox.evaluateFunction(source, { timeoutMs: 60000 });
    assert.ok(fn);
    const before = process.memoryUsage().rss;
    assert.throws(() => fn({}), error => !/超时|Aborted|Assertion|故障/.test(error.message));
    assert.ok(process.memoryUsage().rss - before < 1024 * 1024 * 1024, '内存不应涨到解释器的 2GB 极限');
    release(fn);
  }
  assertHealthy();
});

test('the memory limit grows with the input so long histories are never rejected', () => {
  const fn = sandbox.evaluateFunction(`({ text }) => {
    const copies = [];
    for (let i = 0; i < 20; i += 1) copies.push(text + i);
    return copies.length;
  }`, { timeoutMs: 60000 });
  assert.ok(fn);
  try {
    assert.equal(fn({ text: 'x'.repeat(16 * 1024 * 1024) }), 20);
  } finally {
    release(fn);
  }
});

test('a timed-out script is not executed again', async () => {
  const spin = `const t = Date.now(); while (Date.now() - t < 400) {}`;
  const fn = sandbox.evaluateFunction(`() => { ${spin} return 'late'; }`, { timeoutMs: 100 });
  const value = sandbox.evaluateFactory(`return { action: () => { ${spin} return 'late'; } };`, { timeoutMs: 100 });
  try {
    assert.throws(() => fn({}), /超时/);
    let start = Date.now();
    assert.throws(() => fn({}), /超时/);
    assert.ok(Date.now() - start < 50, '超时后的调用应立即失败');
    await assert.rejects(async () => value.action({}), /超时/);
    start = Date.now();
    await assert.rejects(async () => value.action({}), /超时/);
    assert.ok(Date.now() - start < 50, '工具动作同样不重复执行');
  } finally {
    release(fn);
    release(value);
  }
  assertHealthy();
});

test('one timed-out script does not prevent a separate request from executing', () => {
  const broken = sandbox.evaluateFunction(`() => {
    const t = Date.now();
    while (Date.now() - t < 400) {}
    return 'late';
  }`, { timeoutMs: 100 });
  try {
    assert.throws(() => broken({}), /超时|interrupt/i);
  } finally {
    release(broken);
  }
  const healthy = sandbox.evaluateFunction('({ value }) => value + 1');
  try {
    assert.equal(healthy({ value: 41 }), 42);
  } finally {
    release(healthy);
  }
});
