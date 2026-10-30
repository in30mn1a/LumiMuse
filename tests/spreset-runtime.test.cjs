/**
 * SPreset 运行时移植（`src/lib/spreset/*`）单测。
 *
 * 覆盖：沙箱求值、配置解析、ChatSquash、FinalRequestProcessing、toolCallFormatter、
 * 工具绑定加载、工具循环（回复工具 / 合成工具），以及导入期的插件配置持久化。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');

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
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const dbModulePath = require.resolve(path.join(root, 'src', 'lib', 'db.ts'));
const presetModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-presets.ts'));
const importModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-preset-import.ts'));
const sandboxPath = require.resolve(path.join(root, 'src', 'lib', 'spreset', 'sandbox.ts'));
const configPath = require.resolve(path.join(root, 'src', 'lib', 'spreset', 'config.ts'));
const toolsPath = require.resolve(path.join(root, 'src', 'lib', 'spreset', 'tools.ts'));
const requestPath = require.resolve(path.join(root, 'src', 'lib', 'spreset', 'request.ts'));
const outputPath = require.resolve(path.join(root, 'src', 'lib', 'spreset', 'output.ts'));
const runtimePath = require.resolve(path.join(root, 'src', 'lib', 'spreset', 'runtime.ts'));

let db;
let lib;
let importLib;
let sandbox;
let config;
let tools;
let requestLib;
let outputLib;
let runtimeLib;
let DEFAULT_SETTINGS;
let resources;

test.beforeEach(async () => {
  resources = [];
  const keysBefore = Object.keys(require.cache).filter(k => k.startsWith(root + path.sep + 'src' + path.sep + 'lib'));
  for (const k of keysBefore) delete require.cache[k];

  const dbMod = require(dbModulePath);
  dbMod.__resetDbForTests();

  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  dbMod.__migrateForTests(db);
  dbMod.__setDbForTests(db);

  lib = require(presetModulePath);
  importLib = require(importModulePath);
  sandbox = require(sandboxPath);
  await sandbox.initializeSandbox();
  config = require(configPath);
  tools = require(toolsPath);
  requestLib = require(requestPath);
  outputLib = require(outputPath);
  runtimeLib = require(runtimePath);
  for (const [module, key] of [
    [sandbox, 'evaluateFunction'], [sandbox, 'evaluateFactory'],
    [outputLib, 'createToolCallFormatter'], [outputLib, 'createOutputPreprocessor'],
    [runtimeLib, 'createPresetRuntime'],
  ]) {
    const create = module[key];
    module[key] = (...args) => {
      const value = create(...args);
      if (value) resources.push(value);
      return value;
    };
  }
  const loadTools = tools.loadTools;
  tools.loadTools = (...args) => {
    const loaded = loadTools(...args);
    resources.push(...loaded);
    return loaded;
  };
  DEFAULT_SETTINGS = require(path.join(root, 'src', 'types', 'index.ts')).DEFAULT_SETTINGS;
});

test.afterEach(() => {
  for (const resource of resources) {
    if (typeof resource.dispose === 'function') resource.dispose();
    else sandbox.disposeSandboxValue(resource);
  }
  try { db && db.close(); } catch {}
});

// ---------- 沙箱 ----------

test('表达式脚本：结尾分号不影响求值，拿不到 require/process', () => {
  const fn = sandbox.evaluateFunction('(x) => x.value + 1;');
  assert.equal(typeof fn, 'function');
  assert.equal(fn({ value: 41 }), 42);

  const probe = sandbox.evaluateFunction('() => [typeof require, typeof process, typeof fetch].join(",")');
  assert.equal(probe({}), 'undefined,undefined,undefined');
});

test('工厂脚本：return 出的工具定义可执行 action', async () => {
  const tool = sandbox.evaluateFactory(`
    return {
      name: 'demo_tool',
      description: 'demo',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      action: async (args) => JSON.stringify({ echoed: args.q }),
    };
  `);
  assert.equal(tool.name, 'demo_tool');
  assert.equal(await tool.action({ q: 'hi' }), '{"echoed":"hi"}');
});

test('语法错误的脚本返回 null，不抛给调用方', () => {
  assert.equal(sandbox.evaluateFunction('({ request }) => { this is not js'), null);
  assert.equal(sandbox.evaluateFactory('return {{{'), null);
});

// ---------- 配置解析 ----------

test('解析 SPreset 配置：只取启用项，绑定键保持原样', () => {
  const parsed = config.parseSpresetConfig({
    SPreset: {
      ChatSquash: { enabled: true, user_prefix: '|{{user}}|\\n', char_prefix: '|剧情|\\n', squashed_separator_string: '<|sep|>' },
      FinalRequestProcessing: { enabled: true, script: '({ request }) => request' },
      OutputPreprocessing: {
        enabled: true,
        script: '({ buffer }) => ({ output: buffer, hold: "", state: {} })',
        toolCallFormatter: { enabled: true, script: '({ calls }) => calls.length ? "x" : ""' },
      },
      ToolBindings: {
        'entry-1': { enabled: true, valid: true, resolvedName: 'reply_tool', code: 'return { name: "reply_tool" }' },
        'entry-2': { enabled: false, valid: true, resolvedName: 'off_tool', code: 'return { name: "off_tool" }' },
        'entry-3': { enabled: true, valid: false, resolvedName: 'broken_tool', code: 'return {}' },
      },
    },
  });

  assert.ok(parsed);
  assert.deepEqual(parsed.tools.map(tool => tool.name), ['reply_tool']);
  assert.equal(parsed.chatSquash.role, 'system');
  assert.equal(parsed.output.formatter.enabled, true);
  assert.equal(config.hasSpresetRuntime(parsed), true);
});

test('没有插件配置或全部关闭时返回 null', () => {
  assert.equal(config.parseSpresetConfig({}), null);
  assert.equal(config.parseSpresetConfig({ SPreset: { ChatSquash: { enabled: false } } }), null);
  // ChatSquash 单独存在不算「运行时」（它不接管请求形态）
  const squashOnly = config.parseSpresetConfig({ SPreset: { ChatSquash: { enabled: true } } });
  assert.ok(squashOnly);
  assert.equal(config.hasSpresetRuntime(squashOnly), false);
});

// ---------- ChatSquash ----------

test('ChatSquash：套角色前缀/分隔符，system 原位保留，后置脚本可改写', () => {
  const squash = {
    enabled: true,
    conditionalEnabled: false,
    conditionalTag: '<|merge|>',
    role: 'system',
    userPrefix: '|{{user}}|',
    userSuffix: '',
    charPrefix: '|剧情|',
    charSuffix: '',
    prefixSystem: '',
    suffixSystem: '',
    enableSeparator: true,
    separator: '<|sep|>',
    postScriptEnabled: true,
    postScript: 'content => content.replace(/\\|剧情\\|/g, "|角色|")',
  };
  const messages = [
    { role: 'system', content: 'SYS' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U1' },
  ];
  const squashed = requestLib.applyChatSquash(messages, squash, '主人');
  assert.equal(squashed.length, 2);
  assert.equal(squashed[0].role, 'system');
  assert.equal(squashed[0].content, 'SYS');
  assert.equal(squashed[1].content, '|角色|A1<|sep|>|主人|U1');
});

test('ChatSquash 条件模式：正文没有条件标记时原样返回', () => {
  const squash = {
    enabled: true,
    conditionalEnabled: true,
    conditionalTag: '<|merge|>',
    role: 'system',
    userPrefix: '', userSuffix: '', charPrefix: '', charSuffix: '',
    prefixSystem: '', suffixSystem: '', enableSeparator: false, separator: '',
    postScriptEnabled: false, postScript: '',
  };
  const messages = [{ role: 'user', content: 'no marker' }];
  assert.equal(requestLib.applyChatSquash(messages, squash, '用户'), messages);
});

// ---------- FinalRequestProcessing ----------

test('FinalRequestProcessing：脚本返回的请求体生效，内部字段不外发', () => {
  const script = `({ request }) => {
    request.messages = [{ role: 'user', content: 'rewritten' }];
    request.tools = [{ type: 'function', function: { name: 't' } }];
    request.tool_choice = 'required';
    request.custom_include_body = 'reasoning_effort: high';
    return request;
  };`;
  const result = requestLib.runFinalRequestProcessor(script, { model: 'm', messages: [] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.request.messages, [{ role: 'user', content: 'rewritten' }]);
  assert.equal(result.request.tool_choice, 'required');
  assert.equal(Object.hasOwn(result.request, 'custom_include_body'), false, '内部字段不应外发');
});

test('FinalRequestProcessing 报错时退回原请求体（不阻塞聊天）', () => {
  const original = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
  const result = requestLib.runFinalRequestProcessor(`({ request }) => { throw new Error('boom'); }`, original);
  assert.match(result.error, /boom/);
  assert.equal(result.request, original);
});

test('FinalRequestProcessing 原地修改嵌套字段后报错，不污染回退请求', () => {
  const original = {
    model: 'm',
    messages: [{ role: 'user', content: 'original' }],
    tools: [{ type: 'function', function: { name: 'original_tool' } }],
  };
  const snapshot = JSON.parse(JSON.stringify(original));
  const result = requestLib.runFinalRequestProcessor(`({ request }) => {
    request.messages[0].content = 'mutated';
    request.tools[0].function.name = 'mutated_tool';
    request.tool_choice = 'required';
    throw new Error('boom');
  }`, original);
  assert.match(result.error, /boom/);
  assert.equal(result.request, original);
  assert.deepEqual(original, snapshot);
});

// ---------- toolCallFormatter ----------

test('toolCallFormatter：按预设脚本把参数还原成标签分区', () => {
  const script = `({ calls }) => calls.map(call => {
    const args = JSON.parse(call.arguments);
    return '<game>\\n' + args.game + '\\n</game>';
  }).join('');`;
  const formatter = outputLib.createToolCallFormatter(script);
  const text = formatter([{ id: '1', name: 'reply', arguments: JSON.stringify({ game: '正文' }) }], '');
  assert.equal(text, '<game>\n正文\n</game>');
});

test('toolCallFormatter 抛错时退回默认拼接', () => {
  const formatter = outputLib.createToolCallFormatter(`({ calls }) => { throw new Error('x'); }`);
  const fallback = outputLib.defaultToolCallText([{ id: '1', name: 'r', arguments: '{"content":"hi"}' }]);
  assert.equal(formatter([], fallback), fallback);
  assert.equal(fallback, 'hi');
});

// ---------- 工具绑定 ----------

test('工具绑定：条目禁用 / 绑定无效 / 代码报错都被跳过，其余照常可用', () => {
  const bindings = [
    { entryId: 'a', name: 'good', code: 'return { name: "good", description: "d", parameters: { type: "object", properties: {} }, action: async () => "ok" }', enabled: true, valid: true },
    { entryId: 'b', name: 'disabled_entry', code: 'return { name: "disabled_entry" }', enabled: true, valid: true },
    { entryId: 'c', name: 'bad_code', code: 'return {{{', enabled: true, valid: true },
    { entryId: 'd', name: 'invalid', code: 'return { name: "invalid" }', enabled: true, valid: false },
  ];
  const loaded = tools.loadTools(bindings, id => id !== 'b');
  assert.deepEqual(loaded.map(tool => tool.name), ['good']);
  assert.deepEqual(loaded[0].definition.function.name, 'good');
});

// ---------- 工具循环 ----------

function makeRuntime(overrides = {}) {
  const extensions = {
    SPreset: {
      FinalRequestProcessing: {
        enabled: true,
        script: `({ request }) => {
          request.messages = [{ role: 'user', content: 'go' }];
          request.tools = [{ type: 'function', function: { name: 'reply' } }];
          request.tool_choice = 'required';
          return request;
        };`,
      },
      OutputPreprocessing: {
        enabled: true,
        consumeToolCalls: true,
        script: '({ buffer, final }) => ({ output: buffer, hold: "", state: { final } })',
        toolCallFormatter: {
          enabled: true,
          script: '({ calls }) => calls.map(c => "<game>" + JSON.parse(c.arguments).game + "</game>").join("")',
        },
      },
      ToolBindings: {
        'entry-1': {
          enabled: true,
          valid: true,
          resolvedName: 'reply',
          code: 'return { name: "reply", description: "d", parameters: { type: "object", properties: {} }, action: async () => "ok" }',
        },
      },
      ...overrides,
    },
  };
  const entries = [{ id: 'entry-1', enabled: true }];
  return runtimeLib.createPresetRuntime({ extensions }, entries);
}

test('运行时：回复工具的参数即正文，直接结束且不再请求第二轮', async () => {
  const runtime = makeRuntime();
  assert.ok(runtime);

  const settings = { ...DEFAULT_SETTINGS, streaming: true, model: 'm', max_tokens: 100 };
  const chunks = [];
  let done = null;
  let rounds = 0;

  await runtimeLib.runPresetChat({
    runtime,
    messages: [{ role: 'user', content: '原始输入' }],
    settings,
    callbacks: { onChunk: t => chunks.push(t), onDone: t => { done = t; }, onError: e => { throw e; } },
    complete: async () => {
      rounds += 1;
      return { text: '', toolCalls: [{ id: 'c1', name: 'reply', arguments: '{"game":"正文内容"}' }] };
    },
  });

  assert.equal(rounds, 1);
  assert.equal(done, '<game>正文内容</game>');
  assert.equal(chunks.join(''), done);
});

test('运行时：合成工具先执行回灌，下一轮才拿到正文', async () => {
  const runtime = makeRuntime();
  const settings = { ...DEFAULT_SETTINGS, streaming: true, model: 'm', max_tokens: 100 };
  let done = null;
  let rounds = 0;
  let secondRequest = null;

  await runtimeLib.runPresetChat({
    runtime,
    messages: [{ role: 'user', content: '原始输入' }],
    settings,
    callbacks: { onChunk: () => {}, onDone: t => { done = t; }, onError: e => { throw e; } },
    complete: async (settingsArg, body) => {
      rounds += 1;
      if (rounds === 1) {
        return { text: '', toolCalls: [{ id: 'ctx', name: 'context', arguments: '{"query":"sync"}' }] };
      }
      secondRequest = body;
      return { text: '', toolCalls: [{ id: 'c2', name: 'reply', arguments: '{"game":"第二轮正文"}' }] };
    },
  });

  assert.equal(rounds, 2);
  assert.equal(done, '<game>第二轮正文</game>');
  // 回灌：原 messages + assistant(tool_calls) + tool 结果
  assert.equal(secondRequest.messages.length, 3);
  assert.equal(secondRequest.messages[1].role, 'assistant');
  assert.equal(secondRequest.messages[1].tool_calls[0].function.name, 'context');
  assert.equal(secondRequest.messages[2].role, 'tool');
});

test('运行时：模型只吐空内容时报错而不是写入空回复', async () => {
  const runtime = makeRuntime();
  const settings = { ...DEFAULT_SETTINGS, streaming: true, model: 'm', max_tokens: 100 };
  let error = null;

  await runtimeLib.runPresetChat({
    runtime,
    messages: [{ role: 'user', content: 'x' }],
    settings,
    callbacks: { onChunk: () => {}, onDone: () => {}, onError: e => { error = e; } },
    complete: async () => ({ text: '', toolCalls: [] }),
  });

  assert.ok(error instanceof Error);
  assert.match(error.message, /未返回有效正文/);
});

for (const mode of ['consume_disabled', 'formatter_absent']) {
  test(`运行时：普通绑定工具执行动作并回灌（${mode}）`, async () => {
    const output = {
      enabled: true,
      consumeToolCalls: mode !== 'consume_disabled',
      script: '({ buffer }) => ({ output: buffer, hold: "", state: {} })',
      toolCallFormatter: {
        enabled: mode !== 'formatter_absent',
        script: '({ defaultText }) => "SHOULD_NOT_CONSUME:" + defaultText',
      },
    };
    const runtime = makeRuntime({
      FinalRequestProcessing: { enabled: false },
      OutputPreprocessing: output,
      ToolBindings: {
        'entry-1': {
          enabled: true,
          valid: true,
          resolvedName: 'lookup',
          code: 'return { name: "lookup", action: async (args) => "FOUND:" + args.query }',
        },
      },
    });
    let rounds = 0;
    let done = null;
    let secondRequest;
    await runtimeLib.runPresetChat({
      runtime,
      messages: [{ role: 'user', content: 'find' }],
      settings: DEFAULT_SETTINGS,
      callbacks: { onChunk: () => {}, onDone: t => { done = t; }, onError: e => { throw e; } },
      complete: async (settings, body, options) => {
        rounds += 1;
        if (rounds === 1) {
          return { text: '', toolCalls: [{ id: 'lookup-1', name: 'lookup', arguments: '{"query":"needle"}' }] };
        }
        secondRequest = body;
        options.onText('ANSWER');
        return { text: 'ANSWER', toolCalls: [] };
      },
    });
    assert.equal(rounds, 2);
    assert.equal(secondRequest.messages.at(-1).content, 'FOUND:needle');
    assert.equal(secondRequest.messages.at(-1).tool_call_id, 'lookup-1');
    assert.equal(done, 'ANSWER');
  });
}

test('运行时：输出过滤为空时不回退原文落库', async () => {
  const runtime = makeRuntime({
    OutputPreprocessing: {
      enabled: true,
      script: '() => ({ output: "", hold: "", state: {} })',
    },
  });
  const chunks = [];
  let done = null;
  let error;
  await runtimeLib.runPresetChat({
    runtime, messages: [], settings: DEFAULT_SETTINGS,
    callbacks: { onChunk: t => chunks.push(t), onDone: t => { done = t; }, onError: e => { error = e; } },
    complete: async (settings, body, options) => {
      options.onText('SECRET');
      return { text: 'SECRET', toolCalls: [] };
    },
  });
  assert.deepEqual(chunks, []);
  assert.equal(done, null);
  assert.match(error.message, /未返回有效正文/);
});

test('运行时：连接异常只保存已过滤的可见正文', async () => {
  const runtime = makeRuntime({
    OutputPreprocessing: {
      enabled: true,
      script: '({ buffer }) => ({ output: buffer.replace("SECRET", ""), hold: "", state: {} })',
    },
  });
  const chunks = [];
  let partial = null;
  let error;
  await runtimeLib.runPresetChat({
    runtime, messages: [], settings: DEFAULT_SETTINGS,
    callbacks: {
      onChunk: t => chunks.push(t), onDone: () => { assert.fail('异常不应触发成功保存'); },
      onPartial: t => { partial = t; }, onError: e => { error = e; },
    },
    complete: async (settings, body, options) => {
      options.onText('SECRETvisible');
      throw new Error('connection lost');
    },
  });
  assert.equal(chunks.join(''), 'visible');
  assert.equal(partial, 'visible');
  assert.match(error.message, /connection lost/);
});

async function runWith(runtime, complete, callbacks = {}) {
  const seen = { chunks: [], done: [], partial: [], errors: [] };
  await runtimeLib.runPresetChat({
    runtime, messages: [{ role: 'user', content: 'x' }], settings: DEFAULT_SETTINGS,
    callbacks: {
      onChunk: t => seen.chunks.push(t),
      onDone: t => { seen.done.push(t); },
      onPartial: t => { seen.partial.push(t); },
      onError: e => { seen.errors.push(e); },
      ...callbacks,
    },
    complete,
  });
  return seen;
}

const NO_REQUEST_REWRITE = { FinalRequestProcessing: { enabled: false } };

function streamText(...pieces) {
  return async (settings, body, options) => {
    for (const piece of pieces) options.onText(piece);
    return { text: pieces.join(''), toolCalls: [] };
  };
}

test('运行时：最终调用改写已放行文本时，保存最终结果而不是停在旧前缀', async () => {
  const runtime = makeRuntime({
    ...NO_REQUEST_REWRITE,
    OutputPreprocessing: {
      enabled: true,
      script: '({ buffer, final }) => ({ output: final ? buffer.replace("draft", "final") : buffer, hold: "", state: {} })',
    },
  });
  const seen = await runWith(runtime, streamText('draft ', 'tail'));
  assert.deepEqual(seen.done, ['final tail']);
  assert.deepEqual(seen.errors, []);
});

test('运行时：过滤结果接不上已放行前缀时，后续正文不会丢', async () => {
  const runtime = makeRuntime({
    ...NO_REQUEST_REWRITE,
    OutputPreprocessing: {
      enabled: true,
      script: '({ buffer }) => ({ output: buffer.length > 3 ? buffer.slice(1) : buffer, hold: "", state: {} })',
    },
  });
  const seen = await runWith(runtime, streamText('abc', 'def', 'ghi'));
  assert.deepEqual(seen.done, ['bcdefghi']);
  assert.equal(seen.chunks.join(''), 'abc', '接不上的结果不发 chunk，由 done 后刷新对齐');
});

test('运行时：异常时保存最新一次过滤结果', async () => {
  const runtime = makeRuntime({
    ...NO_REQUEST_REWRITE,
    OutputPreprocessing: {
      enabled: true,
      script: '({ buffer }) => ({ output: buffer.length > 3 ? buffer.slice(1) : buffer, hold: "", state: {} })',
    },
  });
  const seen = await runWith(runtime, async (settings, body, options) => {
    options.onText('abc');
    options.onText('def');
    throw new Error('connection lost');
  });
  assert.deepEqual(seen.partial, ['bcdef']);
  assert.match(seen.errors[0].message, /connection lost/);
});

test('运行时：最终结果比已放行文本短时如实保存', async () => {
  const runtime = makeRuntime({
    ...NO_REQUEST_REWRITE,
    OutputPreprocessing: {
      enabled: true,
      script: '({ buffer, final }) => ({ output: final ? buffer.slice(0, 2) : buffer, hold: "", state: {} })',
    },
  });
  const seen = await runWith(runtime, streamText('abcdef'));
  assert.deepEqual(seen.done, ['ab']);
});

test('运行时：formatter 无法求值时回复工具仍是回复通道，不重复请求上游', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const runtime = makeRuntime({
      ...NO_REQUEST_REWRITE,
      OutputPreprocessing: {
        enabled: true,
        consumeToolCalls: true,
        toolCallFormatter: { enabled: true, script: 'this is not ((( valid' },
      },
    });
    let rounds = 0;
    const seen = await runWith(runtime, async () => {
      rounds += 1;
      return { text: '', toolCalls: [{ id: 'c1', name: 'reply', arguments: '{"content":"REAL_REPLY"}' }] };
    });
    assert.equal(rounds, 1);
    assert.deepEqual(seen.done, ['REAL_REPLY']);
    assert.ok(warnings.some(line => line.includes('toolCallFormatter')), '应记录 formatter 编译失败');
  } finally {
    console.warn = warn;
  }
});

test('运行时：工具回灌保留思考字段与工具调用的 extra_content', async () => {
  const runtime = makeRuntime(NO_REQUEST_REWRITE);
  let second;
  let rounds = 0;
  await runWith(runtime, async (settings, body, options) => {
    rounds += 1;
    if (rounds === 1) {
      return {
        text: '',
        toolCalls: [{ id: 'ctx', name: 'context', arguments: '{}', extra_content: { google: { thought_signature: 'SIG' } } }],
        assistantFields: { reasoning_content: 'THINK', reasoning_details: [{ type: 'reasoning.encrypted', data: 'D' }] },
      };
    }
    second = body;
    options.onText('done');
    return { text: 'done', toolCalls: [] };
  });
  const assistant = second.messages.find(message => message.role === 'assistant');
  assert.equal(assistant.reasoning_content, 'THINK');
  assert.deepEqual(assistant.reasoning_details, [{ type: 'reasoning.encrypted', data: 'D' }]);
  assert.deepEqual(assistant.tool_calls[0].extra_content, { google: { thought_signature: 'SIG' } });
});

test('运行时：没有思考字段时回灌形态不变', async () => {
  const runtime = makeRuntime(NO_REQUEST_REWRITE);
  let second;
  let rounds = 0;
  await runWith(runtime, async (settings, body, options) => {
    rounds += 1;
    if (rounds === 1) return { text: '', toolCalls: [{ id: 'ctx', name: 'context', arguments: '{}' }] };
    second = body;
    options.onText('done');
    return { text: 'done', toolCalls: [] };
  });
  const assistant = second.messages.find(message => message.role === 'assistant');
  assert.deepEqual(Object.keys(assistant).sort(), ['content', 'role', 'tool_calls']);
  assert.deepEqual(Object.keys(assistant.tool_calls[0]).sort(), ['function', 'id', 'type']);
});

test('运行时：保存失败只报告一次，不会再触发第二次保存', async () => {
  const runtime = makeRuntime(NO_REQUEST_REWRITE);
  let saves = 0;
  const errors = [];
  await assert.rejects(runWith(runtime, streamText('reply'), {
    onDone: () => { saves += 1; throw new Error('db failed'); },
    onPartial: () => { saves += 1; },
    onError: e => errors.push(e),
  }), /db failed/);
  assert.equal(saves, 1);
  assert.deepEqual(errors, []);
});

test('运行时：请求脚本失败时使用重新组装的消息，且不再压缩', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const runtime = runtimeLib.createPresetRuntime({
      extensions: { SPreset: {
        ChatSquash: { enabled: true },
        FinalRequestProcessing: { enabled: true, script: '() => { throw new Error("boom"); }' },
      } },
    }, [], { fallbackMessages: async () => [{ role: 'system', content: 'CLEAN' }, { role: 'user', content: 'REAL_USER' }] });
    const request = await runtime.buildRequest([{ role: 'system', content: '<<<|catgodml|raw>>>' }], DEFAULT_SETTINGS);
    assert.deepEqual(request.messages, [{ role: 'system', content: 'CLEAN' }, { role: 'user', content: 'REAL_USER' }]);
    assert.equal(request.stream, DEFAULT_SETTINGS.streaming !== false);
    runtime.dispose();
  } finally {
    console.warn = warn;
  }
});

const IMAGE_URL = 'data:image/png;base64,QUJD';
const IMAGE_MESSAGES = [
  { role: 'system', content: 'S' },
  { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: IMAGE_URL } }] },
];

function countImage(request) {
  return JSON.stringify(request.messages).split(IMAGE_URL).length - 1;
}

test('运行时：ChatSquash 压扁后图片补回 user 消息', async () => {
  const runtime = makeRuntime({ ...NO_REQUEST_REWRITE, ChatSquash: { enabled: true } });
  const request = await runtime.buildRequest(IMAGE_MESSAGES, DEFAULT_SETTINGS);
  assert.equal(countImage(request), 1);
  const carrier = request.messages.find(message => Array.isArray(message.content));
  assert.equal(carrier.role, 'user');
  assert.ok(JSON.stringify(request.messages).includes('look'));
  runtime.dispose();
});

test('运行时：请求脚本换掉 messages 时图片补到最后一条 user', async () => {
  const runtime = makeRuntime();
  const request = await runtime.buildRequest(IMAGE_MESSAGES, DEFAULT_SETTINGS);
  assert.deepEqual(request.messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'go' }, { type: 'image_url', image_url: { url: IMAGE_URL } }],
  }]);
  runtime.dispose();
});

test('运行时：脚本结果没有 user 时为图片新增一条 user', async () => {
  const runtime = makeRuntime({
    FinalRequestProcessing: {
      enabled: true,
      script: '({ request }) => ({ ...request, messages: [{ role: "system", content: "ONLY" }] })',
    },
  });
  const request = await runtime.buildRequest(IMAGE_MESSAGES, DEFAULT_SETTINGS);
  assert.equal(request.messages[0].content, 'ONLY');
  assert.equal(request.messages.at(-1).role, 'user');
  assert.equal(countImage(request), 1);
  runtime.dispose();
});

test('运行时：图片仍在请求里时不重复追加', async () => {
  const runtime = makeRuntime(NO_REQUEST_REWRITE);
  const request = await runtime.buildRequest(IMAGE_MESSAGES, DEFAULT_SETTINGS);
  assert.deepEqual(request.messages, IMAGE_MESSAGES);
  runtime.dispose();
});

test('运行时：超时的过滤器每轮只阻塞一次', async () => {
  const runtime = makeRuntime({
    ...NO_REQUEST_REWRITE,
    OutputPreprocessing: {
      enabled: true,
      script: '({ buffer }) => { const t = Date.now(); while (Date.now() - t < 5000) {} return { output: "", hold: "", state: {} }; }',
    },
  });
  const start = Date.now();
  const seen = await runWith(runtime, streamText('a', 'b', 'c', 'd'));
  assert.ok(Date.now() - start < 3500, '第一次超时后不应逐 chunk 再阻塞');
  assert.deepEqual(seen.done, ['abcd'], '过滤器失败退化为直通');
});

test('导入运行时预设时不再提示「不执行脚本」，普通预设仍提示', () => {
  const runtimeReport = importLib.importSillyTavernPreset(buildSpresetPresetJson());
  assert.equal(runtimeReport.warnings.some(w => w.code === 'extensions_ignored'), false);
  const plainReport = importLib.importSillyTavernPreset(JSON.stringify({
    extensions: { some: 'thing' },
    prompts: [{ identifier: 'x', name: 'x', role: 'system', content: 'plain' }],
  }));
  assert.equal(plainReport.warnings.some(w => w.code === 'extensions_ignored'), true);
});

test('运行时：取消后不消费截断工具参数，只保存已过滤正文', async () => {
  const runtime = makeRuntime({
    OutputPreprocessing: {
      enabled: true, consumeToolCalls: true,
      script: '({ buffer }) => ({ output: buffer.replace("SECRET", ""), hold: "", state: {} })',
      toolCallFormatter: { enabled: true, script: '() => "TRUNCATED_TOOL_TEXT"' },
    },
  });
  const controller = new AbortController();
  let formatted = 0;
  let executed = 0;
  let rounds = 0;
  let done = null;
  const originalFormatter = runtime.formatReply;
  runtime.formatReply = calls => { formatted += 1; return originalFormatter(calls); };
  runtime.executeTool = async () => { executed += 1; return 'unexpected'; };
  const chunks = [];
  await runtimeLib.runPresetChat({
    runtime, messages: [], settings: DEFAULT_SETTINGS,
    callbacks: {
      signal: controller.signal, onChunk: t => chunks.push(t), onDone: t => { done = t; },
      onError: e => { throw e; },
    },
    complete: async (settings, body, options) => {
      rounds += 1;
      options.onText('SECRETvisible');
      controller.abort();
      return { text: 'SECRETvisible', toolCalls: [{ id: 'reply-1', name: 'reply', arguments: '{"game":"partial' }] };
    },
  });
  assert.equal(rounds, 1);
  assert.equal(formatted, 0);
  assert.equal(executed, 0);
  assert.equal(done, 'visible');
  assert.equal(chunks.join(''), done);
});

test('运行时：工具动作期间取消，不执行剩余工具也不发下一轮', async () => {
  const runtime = makeRuntime({ OutputPreprocessing: { enabled: false } });
  const controller = new AbortController();
  let executed = 0;
  let rounds = 0;
  runtime.executeTool = async () => { executed += 1; controller.abort(); return 'result'; };
  await runtimeLib.runPresetChat({
    runtime, messages: [], settings: DEFAULT_SETTINGS,
    callbacks: {
      signal: controller.signal, onChunk: () => {}, onDone: () => { assert.fail('不应保存空回复'); },
      onError: e => { throw e; },
    },
    complete: async () => {
      rounds += 1;
      return { text: '', toolCalls: [
        { id: 'a', name: 'context', arguments: '{}' },
        { id: 'b', name: 'context', arguments: '{}' },
      ] };
    },
  });
  assert.equal(executed, 1);
  assert.equal(rounds, 1);
});

test('运行时：请求构建失败仍报告错误并释放脚本资源', async () => {
  const runtime = makeRuntime();
  let disposed = 0;
  const dispose = runtime.dispose;
  runtime.dispose = () => { disposed += 1; dispose(); };
  runtime.buildRequest = async () => { throw new Error('build failed'); };
  let error;
  await runtimeLib.runPresetChat({
    runtime, messages: [], settings: DEFAULT_SETTINGS,
    callbacks: { onChunk: () => {}, onDone: () => {}, onError: e => { error = e; } },
    complete: async () => { assert.fail('构建失败不应请求模型'); },
  });
  assert.match(error.message, /build failed/);
  assert.equal(disposed, 1);
});

test('运行时：预先取消不构建请求且释放脚本资源', async () => {
  const runtime = makeRuntime();
  const controller = new AbortController();
  controller.abort();
  let disposed = 0;
  const dispose = runtime.dispose;
  runtime.dispose = () => { disposed += 1; dispose(); };
  runtime.buildRequest = async () => { assert.fail('预先取消不应构建请求'); };
  await runtimeLib.runPresetChat({
    runtime, messages: [], settings: DEFAULT_SETTINGS,
    callbacks: { signal: controller.signal, onChunk: () => {}, onDone: () => {}, onError: e => { throw e; } },
    complete: async () => { assert.fail('预先取消不应请求模型'); },
  });
  assert.equal(disposed, 1);
});

test('没有插件配置的预设不创建运行时', () => {
  assert.equal(runtimeLib.createPresetRuntime({ extensions: {} }, []), null);
});

// ---------- 导入期持久化 ----------

function buildSpresetPresetJson() {
  return JSON.stringify({
    prompts: [
      { identifier: 'aaa-1', name: '主提示', role: 'system', content: '你是故事主持人。' },
      { identifier: 'bbb-2', name: '回复工具', role: 'system', content: '用 reply 工具回复' },
    ],
    prompt_order: [{
      character_id: 100001,
      order: [{ identifier: 'aaa-1', enabled: true }, { identifier: 'bbb-2', enabled: true }],
    }],
    extensions: {
      SPreset: {
        LogUpload: { enabled: true, url: 'https://example.com/upload' },
        FinalRequestProcessing: { enabled: true, script: '({ request }) => request' },
        ToolBindings: {
          'bbb-2': { enabled: true, valid: true, resolvedName: 'reply_tool', code: 'return { name: "reply_tool" }' },
        },
      },
      expressions: { keep: true },
    },
  });
}

test('导入 SPreset 运行时预设：extensions 落库、绑定键改写为条目 id、剔除 LogUpload', () => {
  const report = importLib.importSillyTavernPreset(buildSpresetPresetJson());
  const preset = lib.getPreset(report.preset_id);
  const entries = lib.listEntries(report.preset_id);

  assert.ok(preset.extensions.SPreset, '应持久化 SPreset 配置');
  assert.equal(Object.hasOwn(preset.extensions.SPreset, 'LogUpload'), false, 'LogUpload 不应入库');
  assert.deepEqual(preset.extensions.expressions, { keep: true }, '其他插件配置原样保留');

  const bindingKeys = Object.keys(preset.extensions.SPreset.ToolBindings);
  assert.equal(bindingKeys.length, 1);
  assert.ok(entries.some(entry => entry.id === bindingKeys[0]), '绑定键应指向本地条目 id');
  assert.equal(entries.find(entry => entry.id === bindingKeys[0]).name, '回复工具');

  const codes = report.warnings.map(w => w.code);
  assert.ok(codes.includes('spreset_runtime'), '应报告运行时接管');
  assert.equal(codes.includes('spreset_protocol'), false, '运行时模式不再走语法翻译兜底');
  assert.equal(entries.some(entry => entry.name === '（兼容）工具协议转换'), false, '运行时模式不追加翻译条目');
});

test('只有指令没有运行时配置的预设，仍走语法翻译兜底', () => {
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [{ identifier: 'x', name: '指令', role: 'system', content: '<<<|catgodml|registerPart:game:<game></game>正文>>>' }],
  }));
  const entries = lib.listEntries(report.preset_id);
  assert.ok(entries.some(entry => entry.name === '（兼容）工具协议转换'));
  assert.ok(report.warnings.some(w => w.code === 'spreset_protocol'));
  assert.equal(report.warnings.some(w => w.code === 'spreset_runtime'), false);
});

test('LumiMuse 原生格式可往返携带 extensions', () => {
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    version: 1,
    format: 'lumimuse-prompt-preset',
    preset: {
      name: '往返',
      description: '',
      story_plot_strip: false,
      import_warnings: [],
      extensions: { SPreset: { ChatSquash: { enabled: true } } },
    },
    entries: [],
  }));
  const preset = lib.getPreset(report.preset_id);
  assert.deepEqual(preset.extensions, { SPreset: { ChatSquash: { enabled: true } } });
});
