const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests } = require('../src/lib/db.ts');
const { registerAppEventSink, APP_EVENT_RETENTION_MS } = require('../src/lib/app-events.ts');
const { setStructuredLogSink, structuredLog } = require('../src/lib/structured-log.ts');
const { UpstreamApiError } = require('../src/lib/upstream-error.ts');

const SECRET_MARKER = 'SECRET-MARKER-91bd';

function createDb() {
  const db = new Database(':memory:');
  __migrateForTests(db);
  return db;
}

function silenceConsole(t) {
  for (const method of ['info', 'warn', 'error']) {
    t.mock.method(console, method, () => {});
  }
}

function events(db) {
  return db.prepare('SELECT * FROM app_events ORDER BY id').all();
}

function setupSink(t) {
  silenceConsole(t);
  const db = createDb();
  registerAppEventSink(db);
  t.after(() => {
    setStructuredLogSink(null);
    db.close();
  });
  return db;
}

test('warn and error are stored while info is not', t => {
  const db = setupSink(t);
  structuredLog('info', 'test.info', { taskId: 'i' });
  structuredLog('warn', 'test.warn', { taskId: 'w' });
  structuredLog('error', 'test.error', { taskId: 'e' });
  assert.deepEqual(
    events(db).map(row => [row.level, row.event, row.task_id]),
    [['warn', 'test.warn', 'w'], ['error', 'test.error', 'e']],
  );
});

test('correlation fields, category and status are stored', t => {
  const db = setupSink(t);
  structuredLog('error', 'test.error', {
    characterId: 'char-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    taskId: 'task-1',
    providerId: 'provider-1',
    model: 'model-1',
  }, new UpstreamApiError(429, 'API error 429: slow down'));
  const [row] = events(db);
  assert.equal(row.character_id, 'char-1');
  assert.equal(row.conversation_id, 'conv-1');
  assert.equal(row.message_id, 'msg-1');
  assert.equal(row.task_id, 'task-1');
  assert.equal(row.provider_id, 'provider-1');
  assert.equal(row.model, 'model-1');
  assert.equal(row.http_status, 429);
  assert.equal(row.error_category, 'rate_limit');
  assert.equal(row.error_name, 'UpstreamApiError');
  assert.equal(row.error_message, 'Error details redacted');
});

test('non-whitelisted fields and error bodies never reach the table', t => {
  const db = setupSink(t);
  structuredLog('error', 'test.error', {
    conversationId: 'conv-1',
    prompt: `prompt ${SECRET_MARKER}`,
    content: `content ${SECRET_MARKER}`,
    apiKey: `sk-${SECRET_MARKER}`,
  }, new UpstreamApiError(500, `API error 500: ${SECRET_MARKER}`));
  assert.equal(events(db).length, 1);
  assert.doesNotMatch(JSON.stringify(events(db)), new RegExp(SECRET_MARKER));
});

test('values of an unexpected type are stored as null instead of losing the event', t => {
  const db = setupSink(t);
  structuredLog('warn', 'test.warn', { conversationId: { nested: true }, httpStatus: 'nope' });
  const [row] = events(db);
  assert.equal(row.event, 'test.warn');
  assert.equal(row.conversation_id, null);
  assert.equal(row.http_status, null);
});

test('a failing database does not reach the caller', t => {
  silenceConsole(t);
  const db = createDb();
  registerAppEventSink(db);
  t.after(() => setStructuredLogSink(null));
  db.close();
  assert.doesNotThrow(() => structuredLog('error', 'test.error', {}, new Error('boom')));
});

test('registering on an unmigrated database does not throw', t => {
  silenceConsole(t);
  const db = new Database(':memory:');
  t.after(() => db.close());
  assert.doesNotThrow(() => registerAppEventSink(db));
});

test('a throwing sink is isolated and a sink that logs does not recurse', t => {
  silenceConsole(t);
  t.after(() => setStructuredLogSink(null));

  setStructuredLogSink(() => {
    throw new Error('sink failed');
  });
  assert.doesNotThrow(() => structuredLog('error', 'test.error'));

  let calls = 0;
  setStructuredLogSink(() => {
    calls += 1;
    structuredLog('error', 'test.from_sink');
  });
  structuredLog('error', 'test.error');
  assert.equal(calls, 1);

  structuredLog('warn', 'test.next');
  assert.equal(calls, 2);
});

test('events older than the retention window are pruned on start and hourly', t => {
  silenceConsole(t);
  const start = Date.UTC(2026, 10, 3);
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const db = createDb();
  t.after(() => {
    setStructuredLogSink(null);
    db.close();
  });
  const insertAged = db.prepare(`INSERT INTO app_events (ts, level, event) VALUES (?, 'warn', ?)`);
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  insertAged.run(new Date(start - APP_EVENT_RETENTION_MS - 1).toISOString(), 'expired');
  insertAged.run(new Date(start - 29 * day).toISOString(), 'kept');

  registerAppEventSink(db);
  assert.deepEqual(events(db).map(row => row.event), ['kept']);

  // 29 天前的记录 2 天后超出窗口；距上次清理超过 1 小时，这次写入会清掉它
  t.mock.timers.setTime(start + 2 * day);
  structuredLog('warn', 'first');
  assert.deepEqual(events(db).map(row => row.event), ['first']);

  // 不足 1 小时不重复清理，满 1 小时才清理
  insertAged.run(new Date(start + 2 * day - APP_EVENT_RETENTION_MS - 1).toISOString(), 'expired-later');
  t.mock.timers.setTime(start + 2 * day + hour - 1);
  structuredLog('warn', 'second');
  assert.equal(events(db).some(row => row.event === 'expired-later'), true);

  t.mock.timers.setTime(start + 2 * day + hour);
  structuredLog('warn', 'third');
  assert.deepEqual(events(db).map(row => row.event), ['first', 'second', 'third']);
});

test('getDb registers the sink after a real migration', t => {
  silenceConsole(t);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumimuse-app-events-'));
  const originalCwd = process.cwd();
  const originalSetImmediate = global.setImmediate;
  const dbPath = require.resolve('../src/lib/db.ts');
  t.after(() => {
    setStructuredLogSink(null);
    require(dbPath).__resetDbForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  let db;
  // 只在 getDb 期间屏蔽后台队列启动；test runner 自身也依赖 setImmediate
  global.setImmediate = () => 0;
  try {
    process.chdir(tempDir);
    delete require.cache[dbPath];
    db = require(dbPath).getDb();
  } finally {
    process.chdir(originalCwd);
    global.setImmediate = originalSetImmediate;
  }
  structuredLog('error', 'test.real_db', {}, new UpstreamApiError(401, 'API error 401: nope'));
  assert.deepEqual(
    db.prepare('SELECT event, error_category, http_status FROM app_events').all().map(row => ({ ...row })),
    [{ event: 'test.real_db', error_category: 'auth', http_status: 401 }],
  );
});

function loadChatRoute(db, runChat) {
  const routePath = require.resolve('../src/app/api/chat/route.ts');
  const originalLoad = Module._load;
  delete require.cache[routePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/lib/db') return { getDb: () => db };
    if (request === '@/lib/chat-engine') return { runChat };
    if (request === '@/lib/memory-queue') return { enqueueExtraction: () => {} };
    if (request === '@/lib/settings') {
      return {
        loadSettings: () => ({ model: 'model-under-test', active_provider_id: 'provider-under-test' }),
        recordClientTimezone: () => {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(routePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[routePath];
  }
}

function loadApiClientWithUpstream(responder) {
  const clientPath = require.resolve('../src/lib/api-client.ts');
  const originalLoad = Module._load;
  delete require.cache[clientPath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === './ssrf-guard') return { safeFetch: responder };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(clientPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[clientPath];
  }
}

function chatRequest(signal) {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    body: JSON.stringify({ conversation_id: 'conv-1', content: 'hello' }),
    ...(signal ? { signal } : {}),
  });
}

function setupChat(t) {
  const db = setupSink(t);
  db.prepare(`INSERT INTO characters (id, name) VALUES ('char-1', 'Fixture')`).run();
  db.prepare(`INSERT INTO conversations (id, character_id) VALUES ('conv-1', 'char-1')`).run();
  return db;
}

const FAKE_API_SETTINGS = { api_base: 'http://upstream.test/v1', api_key: 'test-key', model: 'model-under-test' };

for (const [status, category] of [[401, 'auth'], [429, 'rate_limit'], [500, 'upstream_server']]) {
  test(`chat route records a real upstream ${status} and keeps the SSE error text`, async t => {
    const db = setupChat(t);
    const { chatCompletionStream } = loadApiClientWithUpstream(
      async () => new Response(`upstream said ${SECRET_MARKER}`, { status }),
    );
    const { POST } = loadChatRoute(db, async (_conversationId, _content, _settings, callbacks) => {
      await chatCompletionStream(FAKE_API_SETTINGS, [{ role: 'user', content: 'hello' }], callbacks);
    });

    const body = await (await POST(chatRequest())).text();
    assert.equal(body, `event: error\ndata: ${JSON.stringify({
      message: `API error ${status}: upstream said ${SECRET_MARKER}`,
    })}\n\n`);

    const rows = events(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'chat.reply_failed');
    assert.equal(rows[0].level, 'error');
    assert.equal(rows[0].error_category, category);
    assert.equal(rows[0].http_status, status);
    assert.equal(rows[0].conversation_id, 'conv-1');
    assert.equal(rows[0].character_id, 'char-1');
    assert.equal(rows[0].model, 'model-under-test');
    assert.equal(rows[0].provider_id, 'provider-under-test');
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(SECRET_MARKER));
  });
}

test('chat route catch branch records the failure with the same SSE text', async t => {
  const db = setupChat(t);
  const { POST } = loadChatRoute(db, async () => {
    throw new TypeError('fetch failed');
  });
  const body = await (await POST(chatRequest())).text();
  assert.equal(body, `event: error\ndata: ${JSON.stringify({ message: 'fetch failed' })}\n\n`);
  const [row] = events(db);
  assert.equal(row.event, 'chat.reply_failed');
  assert.equal(row.error_category, 'network');
  assert.equal(row.http_status, null);
});

test('a client stop is not recorded as a reply failure', async t => {
  const db = setupChat(t);
  const controller = new AbortController();
  let finished;
  const engineFinished = new Promise(resolve => {
    finished = resolve;
  });
  const { POST } = loadChatRoute(db, async () => {
    controller.abort();
    queueMicrotask(finished);
    throw new DOMException('The operation was aborted', 'AbortError');
  });
  // 客户端断开后路由不再关闭流，所以这里不读响应体，只等引擎结束
  await POST(chatRequest(controller.signal));
  await engineFinished;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events(db), []);
});

test('chat route still reports the error when the character lookup fails', async t => {
  silenceConsole(t);
  const db = createDb();
  registerAppEventSink(db);
  t.after(() => {
    setStructuredLogSink(null);
    db.close();
  });
  const brokenLookup = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return () => {
          throw new Error('database is locked');
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { POST } = loadChatRoute(brokenLookup, async (_conversationId, _content, _settings, callbacks) => {
    callbacks.onError(new UpstreamApiError(401, 'API error 401: nope'));
  });
  const body = await (await POST(chatRequest())).text();
  assert.equal(body, `event: error\ndata: ${JSON.stringify({ message: 'API error 401: nope' })}\n\n`);
  const [row] = events(db);
  assert.equal(row.character_id, null);
  assert.equal(row.error_category, 'auth');
});

for (const [label, rewritten, networkFailure] of [
  ['rewritten model with HTTP failure', true, false],
  ['rewritten model with network failure', true, true],
  ['unchanged model with HTTP failure', false, false],
]) {
  test(`the real chat path records the requested ${label}`, async t => {
    silenceConsole(t);
    const db = createDb();
    const dbModule = require('../src/lib/db.ts');
    dbModule.__setDbForTests(db);
    registerAppEventSink(db);
    db.prepare("INSERT INTO characters(id,name) VALUES('diag-char','Fixture')").run();
    db.prepare("INSERT INTO conversations(id,character_id) VALUES('diag-conv','diag-char')").run();
    const insertSetting = db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
    for (const [key, value] of Object.entries({
      api_base: 'http://upstream.test/v1', api_key: 'fixture-key', model: 'global-model',
      streaming: false, show_timestamps: false, memory_inject: false,
    })) insertSetting.run(key, JSON.stringify(value));

    if (rewritten) {
      const { importSillyTavernPreset } = require('../src/lib/prompt-preset-import.ts');
      const report = importSillyTavernPreset(JSON.stringify({
        prompts: [{ identifier: 'chatHistory', name: 'History', role: 'system', marker: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
        extensions: { SPreset: { FinalRequestProcessing: {
          enabled: true, script: '({request}) => ({...request, model:"actual-model"})',
        } } },
      }), { presetName: 'Diagnostic model fixture' });
      db.prepare("UPDATE characters SET active_preset_id=? WHERE id='diag-char'").run(report.preset_id);
    }
    const requests = [];
    const safeFetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (networkFailure) throw new TypeError('fetch failed');
      return new Response('fixture limited', { status: 429 });
    };
    const originalLoad = Module._load;
    Module._load = function loadWithFakeUpstream(request, parent, isMain) {
      if (request === '@/lib/ssrf-guard' || request === './ssrf-guard') return { safeFetch };
      if (request === '@/lib/memory-queue') return { enqueueExtraction() {} };
      if (request === '@/lib/memory-index-trigger') return { triggerMemoryIndexProcessing() {} };
      return originalLoad.call(this, request, parent, isMain);
    };
    const loadedPaths = ['../src/lib/api-client.ts', '../src/lib/chat-engine.ts', '../src/lib/spreset/runtime.ts', '../src/app/api/chat/route.ts'];
    for (const file of loadedPaths) delete require.cache[require.resolve(file)];
    t.after(() => {
      Module._load = originalLoad;
      for (const file of loadedPaths) delete require.cache[require.resolve(file)];
      setStructuredLogSink(null);
      dbModule.__setDbForTests(null);
      db.close();
    });
    const { POST } = require('../src/app/api/chat/route.ts');
    const response = await POST(new Request('http://fixture.test/api/chat', {
      method: 'POST', body: JSON.stringify({ conversation_id: 'diag-conv', content: 'fixture question' }),
    }));
    const sse = await response.text();
    const rows = events(db).filter(row => row.event === 'chat.reply_failed');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, rewritten ? 'actual-model' : 'global-model');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, requests[0].model);
    assert.equal(rows[0].http_status, networkFailure ? null : 429);
    assert.equal(rows[0].error_category, networkFailure ? 'network' : 'rate_limit');
    assert.match(sse, networkFailure ? /fetch failed/ : /API error 429/);
    assert.doesNotMatch(JSON.stringify(rows), /fixture-key|fixture question/);
  });
}
