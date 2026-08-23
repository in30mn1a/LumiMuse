const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');
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

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function createDbProbe() {
  const database = new Database(':memory:');
  const queries = [];

  database.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      parent_id TEXT,
      parent_seq_end INTEGER
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar_url TEXT,
      basic_info TEXT NOT NULL,
      personality TEXT NOT NULL,
      scenario TEXT NOT NULL,
      greeting TEXT NOT NULL,
      example_dialogue TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      other_info TEXT NOT NULL,
      image_tags TEXT NOT NULL,
      user_image_tags TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL,
      metadata TEXT
    );
  `);

  database.prepare(`
    INSERT INTO conversations (id, character_id, updated_at)
    VALUES ('conv-a', 'char-a', '2026-07-10T00:00:00.000Z')
  `).run();
  database.prepare(`
    INSERT INTO characters (
      id, name, avatar_url, basic_info, personality, scenario, greeting,
      example_dialogue, system_prompt, other_info, image_tags, user_image_tags,
      created_at, updated_at
    ) VALUES (
      'char-a', 'Alice', NULL, '', '', '', '', '', '', '', '', '',
      '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
    )
  `).run();

  const db = {
    prepare(sql) {
      const query = { sql: normalizeSql(sql), calls: [] };
      queries.push(query);
      const statement = database.prepare(sql);
      return {
        get(...args) {
          query.calls.push(args);
          return statement.get(...args);
        },
        all(...args) {
          query.calls.push(args);
          return statement.all(...args);
        },
        run(...args) {
          query.calls.push(args);
          return statement.run(...args);
        },
      };
    },
    transaction(fn) {
      return database.transaction(fn);
    },
  };

  return { database, db, queries };
}

function insertMessage(database, {
  id,
  conversationId = 'conv-a',
  role,
  content,
  seq,
  tokenCount = 1,
  createdAt = `2026-07-10T00:00:${String(seq).padStart(2, '0')}.000Z`,
  metadata = '{}',
}) {
  database.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, role, content, tokenCount, createdAt, seq, metadata);
}

function settings() {
  return {
    streaming: false,
    context_window: 100000,
    max_tokens: 100,
    example_dialogue: false,
    memory_inject: false,
    show_timestamps: false,
    image_gen: { enabled: false, inline_prompt: false },
    memory_engine: { memory_package_token_budget: 12000 },
  };
}

function loadChatEngine(db, capture) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/lib/db') return { getDb: () => db };
    if (request === '@/lib/api-client') {
      return {
        async chatCompletion(_settings, messages) {
          capture.messages = messages;
          return 'generated response';
        },
        async chatCompletionStream() {
          throw new Error('streaming path should not run');
        },
      };
    }
    if (request === '@/lib/memory-engine') return { retrieveRelevantMemories: () => [] };
    if (request === '@/lib/memory-retrieval') {
      return { retrieveWorkingMemoryPackage: async () => ({ text: '', selectedMemories: [], tokenCount: 0, mode: 'test' }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve('../src/lib/chat-engine.ts');
    delete require.cache[resolved];
    return require('../src/lib/chat-engine.ts');
  } finally {
    Module._load = originalLoad;
  }
}

async function runStreamingStripProbe(rawText, chunkSizes, options = {}) {
  const probe = createDbProbe();
  const capture = { emitted: '', doneText: '', errors: [] };
  const abortController = new AbortController();
  const preset = {
    id: 'preset-stream-strip',
    name: 'stream strip',
    description: '',
    is_built_in: false,
    story_plot_strip: true,
    strip_tags: options.stripTags ?? ['content', 'scene', '#think'],
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z',
  };

  Module._load = function loadStreamingMocks(request, parent, isMain) {
    if (request === '@/lib/db') return { getDb: () => probe.db };
    if (request === '@/lib/api-client') {
      return {
        async chatCompletion() {
          throw new Error('non-streaming path should not run');
        },
        async chatCompletionStream(_settings, _messages, callbacks) {
          let offset = 0;
          let chunkIndex = 0;
          while (offset < rawText.length) {
            const size = chunkSizes[chunkIndex % chunkSizes.length];
            callbacks.onChunk(rawText.slice(offset, offset + size));
            offset += size;
            chunkIndex += 1;
          }
          if (options.abort) abortController.abort();
          await callbacks.onDone(rawText);
        },
      };
    }
    if (request === '@/lib/memory-engine') return { retrieveRelevantMemories: () => [] };
    if (request === '@/lib/memory-retrieval') {
      return { retrieveWorkingMemoryPackage: async () => ({ text: '', selectedMemories: [], tokenCount: 0, mode: 'test' }) };
    }
    if (request === '@/lib/prompt-presets') {
      return {
        resolveActivePreset: () => preset,
        loadEnabledEntries: () => [],
      };
    }
    if (request === '@/lib/prompt-preset-assembler') {
      return {
        assemblePresetPrompt: async () => [{ role: 'system', content: 'test prompt' }],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve('../src/lib/chat-engine.ts');
    delete require.cache[resolved];
    const { runChat } = require('../src/lib/chat-engine.ts');
    await runChat('conv-a', '', { ...settings(), streaming: true }, {
      onChunk(text) { capture.emitted += text; },
      onDone(text) { capture.doneText = text; },
      onError(error) { capture.errors.push(error); },
    }, { skipUserInsert: true, signal: abortController.signal });
  } finally {
    Module._load = originalLoad;
  }

  const stored = probe.database.prepare(
    "SELECT content, metadata FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
  ).get('conv-a');
  return {
    ...capture,
    storedText: stored?.content ?? '',
    storedMetadata: stored?.metadata ? JSON.parse(stored.metadata) : {},
    database: probe.database,
  };
}

async function runWithProbe(rows, options, setupDatabase) {
  const probe = createDbProbe();
  setupDatabase?.(probe.database);
  for (const row of rows) insertMessage(probe.database, row);
  const capture = {};
  const { runChat } = loadChatEngine(probe.db, capture);
  const errors = [];

  // runChat 会在执行期惰性导入预设模块；这里也必须覆盖执行窗口，
  // 否则测试会读取开发机真实 settings/default preset，破坏 :memory: 隔离。
  const loadBeforeRun = Module._load;
  Module._load = function loadRunMocks(request, parent, isMain) {
    if (request === '@/lib/prompt-presets') {
      return {
        resolveActivePreset: () => null,
        loadEnabledEntries: () => [],
      };
    }
    return loadBeforeRun.call(this, request, parent, isMain);
  };
  try {
    await runChat('conv-a', '', settings(), {
      onChunk() {},
      onDone() {},
      onError(error) { errors.push(error); },
    }, { skipUserInsert: true, ...options });
  } finally {
    Module._load = loadBeforeRun;
  }

  assert.deepEqual(errors, []);
  return { ...probe, capture };
}

function conversationContents(messages) {
  return messages.slice(1).map(message => message.content);
}

test('runChat loads only the last summary and later messages with a seq lower bound', async (t) => {
  const probe = await runWithProbe([
    { id: 'old-user', role: 'user', content: 'old history', seq: 1 },
    { id: 'old-summary', role: 'system', content: 'old summary', seq: 2, metadata: '{"isSummary":true}' },
    { id: 'between-user', role: 'user', content: 'between summaries', seq: 3 },
    { id: 'last-summary', role: 'system', content: 'latest summary', seq: 4, metadata: '{"isSummary":true}' },
    { id: 'new-user', role: 'user', content: 'new question', seq: 5 },
  ]);
  t.after(() => probe.database.close());

  assert.deepEqual(conversationContents(probe.capture.messages), [
    '[对话总结]\nlatest summary',
    'new question',
  ]);
  const boundedQuery = probe.queries.find(query => /FROM messages WHERE conversation_id = \? AND seq >= \?/.test(query.sql));
  assert.ok(boundedQuery, 'chat history query should include seq >= ? after locating the last summary');
  assert.deepEqual(boundedQuery.calls, [['conv-a', 4]]);
});

test('runChat keeps full ordered history when no summary exists', async (t) => {
  const sharedTimestamp = '2026-07-10T01:00:00.000Z';
  const probe = await runWithProbe([
    { id: 'assistant-2', role: 'assistant', content: 'second by seq', seq: 2, createdAt: sharedTimestamp },
    { id: 'user-1', role: 'user', content: 'first by seq', seq: 1, createdAt: sharedTimestamp },
    { id: 'user-3', role: 'user', content: 'third by seq', seq: 3, createdAt: sharedTimestamp },
  ]);
  t.after(() => probe.database.close());

  assert.deepEqual(conversationContents(probe.capture.messages), [
    'first by seq',
    'second by seq',
    'third by seq',
  ]);
  assert.ok(probe.queries.some(query => query.sql === 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'));
});

test('runChat preserves created_at-first ordering when imported seq order differs', async (t) => {
  const probe = await runWithProbe([
    {
      id: 'later-time-low-seq',
      role: 'assistant',
      content: 'later timestamp despite lower seq',
      seq: 1,
      createdAt: '2026-07-10T02:00:00.000Z',
    },
    {
      id: 'earlier-time-high-seq',
      role: 'user',
      content: 'earlier timestamp despite higher seq',
      seq: 9,
      createdAt: '2026-07-10T01:00:00.000Z',
    },
  ]);
  t.after(() => probe.database.close());

  assert.deepEqual(conversationContents(probe.capture.messages), [
    'earlier timestamp despite higher seq',
    'later timestamp despite lower seq',
  ]);
});

test('runChat uses seq-first ordering for a linked view with a late inserted reply', async (t) => {
  const probe = await runWithProbe([
    {
      id: 'root-1',
      conversationId: 'conv-root',
      role: 'user',
      content: 'root first',
      seq: 1,
      createdAt: '2026-07-10T01:00:00.000Z',
    },
    {
      id: 'child-inserted',
      role: 'assistant',
      content: 'inserted second by seq',
      seq: 2,
      createdAt: '2026-07-10T03:00:00.000Z',
    },
    {
      id: 'root-3',
      conversationId: 'conv-root',
      role: 'user',
      content: 'root third by seq',
      seq: 3,
      createdAt: '2026-07-10T02:00:00.000Z',
    },
    {
      id: 'child-4',
      role: 'assistant',
      content: 'child fourth',
      seq: 4,
      createdAt: '2026-07-10T04:00:00.000Z',
    },
  ], {}, database => {
    database.prepare(`
      INSERT INTO conversations (id, character_id, updated_at)
      VALUES ('conv-root', 'char-a', '2026-07-10T00:00:00.000Z')
    `).run();
    database.prepare(`
      UPDATE conversations
      SET parent_id = 'conv-root', parent_seq_end = 3
      WHERE id = 'conv-a'
    `).run();
  });
  t.after(() => probe.database.close());

  assert.deepEqual(conversationContents(probe.capture.messages), [
    'root first',
    'inserted second by seq',
    'root third by seq',
    'child fourth',
  ]);
  assert.ok(probe.queries.some(query => (
    query.sql.includes('ORDER BY seq ASC, created_at ASC, id ASC')
  )));
});

test('runChat lazily replaces an untrusted persisted token_count with current server provenance', async (t) => {
  const { estimateTokens } = require('../src/lib/token-counter.ts');
  const probe = await runWithProbe([
    {
      id: 'legacy-import',
      role: 'user',
      content: 'short imported message',
      tokenCount: 5000,
      seq: 1,
    },
  ]);
  t.after(() => probe.database.close());

  const repaired = probe.database.prepare(
    'SELECT token_count, metadata FROM messages WHERE id = ?',
  ).get('legacy-import');
  const metadata = JSON.parse(repaired.metadata);

  assert.equal(repaired.token_count, estimateTokens('short imported message'));
  assert.equal(metadata.token_count_provenance.source, 'server');
  assert.equal(typeof metadata.token_count_provenance.algorithm, 'string');
  assert.equal(typeof metadata.token_count_provenance.fingerprint, 'string');
  assert.match(probe.capture.messages.map(message => message.content).join('\n'), /short imported message/);
});

test('runChat tolerates malformed legacy metadata while locating a summary', async (t) => {
  const probe = await runWithProbe([
    { id: 'broken', role: 'user', content: 'legacy message', seq: 1, metadata: '{not-json' },
    { id: 'summary', role: 'system', content: 'safe summary', seq: 2, metadata: '{"isSummary":true}' },
    { id: 'new-user', role: 'user', content: 'after summary', seq: 3 },
  ]);
  t.after(() => probe.database.close());

  assert.deepEqual(conversationContents(probe.capture.messages), [
    '[对话总结]\nsafe summary',
    'after summary',
  ]);
});

test('runChat preserves regenerate target time even when the target is before the last summary', async (t) => {
  const targetCreatedAt = '2025-12-24T03:04:00.000Z';
  const probe = await runWithProbe([
    { id: 'old-user', role: 'user', content: 'question to regenerate', seq: 1 },
    { id: 'target-assistant', role: 'assistant', content: 'old answer', seq: 2, createdAt: targetCreatedAt },
    { id: 'summary', role: 'system', content: 'later summary', seq: 3, metadata: '{"isSummary":true}' },
    { id: 'new-user', role: 'user', content: 'later question', seq: 4 },
  ], {
    regenerateAssistantId: 'target-assistant',
    timeContext: { timeZone: 'UTC' },
  });
  t.after(() => probe.database.close());

  assert.match(probe.capture.messages[0].content, /2025-12-24 03:04/);
  assert.deepEqual(conversationContents(probe.capture.messages), ['question to regenerate']);
  const targetQuery = probe.queries.find(query => query.sql === 'SELECT created_at, seq FROM messages WHERE id = ? AND conversation_id = ?');
  assert.ok(targetQuery, 'regenerate should fetch the target timestamp independently of bounded history');
  assert.deepEqual(targetQuery.calls, [['target-assistant', 'conv-a']]);
  assert.doesNotMatch(JSON.stringify(probe.capture.messages), /later summary|later question|old answer/);
});

test('finalizeAssistantResponse 清理带星期的残留时间戳前缀（含不带星期的旧格式）', (t) => {
  const probe = createDbProbe();
  t.after(() => probe.database.close());
  const { finalizeAssistantResponse } = loadChatEngine(probe.db, {});

  const strip = (rawText) => finalizeAssistantResponse(
    rawText,
    { storyPlotStrip: false, stripTags: [], characterImageTags: '' },
  ).fullText;

  // 新格式（带英文星期缩写）——消息时间戳已含星期，模型可能照历史消息的样子误输出
  assert.equal(strip('[2026-08-02 Sun 14:30] 我记住了'), '我记住了');
  assert.equal(strip('[2026/08/02 Sun 14:30] 我记住了'), '我记住了');
  // 旧格式（不带星期）仍应清理
  assert.equal(strip('[2026-05-13 14:30] 我记住了'), '我记住了');
  // 时间戳不在开头、或格式不对（星期超 3 字母）→ 不误伤正文
  assert.equal(strip('前缀 [2026-08-02 Sun 14:30] 我记住了'), '前缀 [2026-08-02 Sun 14:30] 我记住了');
  assert.equal(strip('[2026-08-02 Sunday 14:30] 我记住了'), '[2026-08-02 Sunday 14:30] 我记住了');
});

test('finalizeAssistantResponse 先提取 IMG 再剥 story XML，保留正文和生图提示词', (t) => {
  const probe = createDbProbe();
  t.after(() => probe.database.close());
  const { finalizeAssistantResponse } = loadChatEngine(probe.db, {});

  const result = finalizeAssistantResponse(
    '<story_plot><story_body>干净正文</story_body></story_plot>\n[IMG]1girl, blue eyes[/IMG]',
    { storyPlotStrip: true, stripTags: ['story_plot'], characterImageTags: '' },
  );

  assert.equal(result.fullText, '干净正文');
  assert.equal(result.inlinePrompt, '1girl, blue eyes');
});

test('runChat 参数化流式逐字符/任意 chunk 的可见文本与最终落库严格一致', async (t) => {
  const raw = '<think>草稿</think>\n\n<scene>客厅</scene>\n\n<content>正文</content>';
  for (const chunkSizes of [[1], [2, 7, 1, 9, 3]]) {
    const result = await runStreamingStripProbe(raw, chunkSizes);
    t.after(() => result.database.close());
    assert.deepEqual(result.errors, []);
    assert.equal(result.emitted, '客厅\n\n正文');
    assert.equal(result.doneText, result.emitted);
    assert.equal(result.storedText, result.emitted);
  }
});

test('runChat 参数化流式在 EOF 补发安全前缀暂存的普通尾部空白', async (t) => {
  const raw = '  缩进 Markdown\n    ';
  const result = await runStreamingStripProbe(raw, [1]);
  t.after(() => result.database.close());

  assert.deepEqual(result.errors, []);
  assert.equal(result.doneText, raw);
  assert.equal(result.storedText, raw);
  assert.equal(result.emitted, raw);
});

test('runChat 参数化流式真实 abort 不显示或落库未闭合 drop 与协议碎片', async (t) => {
  const cases = [
    ['<scene>客厅</scene><think>未完成草稿', '客厅'],
    ['<scene>客厅</scene><content>正文</con', '客厅正文'],
  ];
  for (const [raw, expected] of cases) {
    const result = await runStreamingStripProbe(raw, [1], { abort: true });
    t.after(() => result.database.close());
    assert.deepEqual(result.errors, []);
    assert.equal(result.emitted, expected);
    assert.equal(result.doneText, expected);
    assert.equal(result.storedText, expected);
    assert.equal(result.storedMetadata.generation_stopped, true);
    assert.equal(result.storedMetadata.generation_stop_reason, 'abort');
  }
});

test('runChat 参数化流式在 EOF 保留正文中的非头部未闭合 block 字面量', async (t) => {
  const raw = '她说 <content> 是标签符号';
  const result = await runStreamingStripProbe(raw, [1]);
  t.after(() => result.database.close());

  assert.deepEqual(result.errors, []);
  assert.equal(result.emitted, raw);
  assert.equal(result.doneText, raw);
  assert.equal(result.storedText, raw);
});

test('runChat abort 不补发或落库首个未完成协议前缀', async (t) => {
  const cases = [
    ['<con', ['content', '#think']],
    ['<think', ['content', '#think']],
    ['<sto', ['story_plot']],
  ];
  for (const [raw, stripTags] of cases) {
    const result = await runStreamingStripProbe(raw, [1], { abort: true, stripTags });
    t.after(() => result.database.close());
    assert.deepEqual(result.errors, []);
    assert.equal(result.emitted, '');
    assert.equal(result.doneText, '');
    assert.equal(result.storedText, '');
    assert.equal(result.storedMetadata.generation_stopped, true);
    assert.equal(result.storedMetadata.generation_stop_reason, 'abort');
  }
});
