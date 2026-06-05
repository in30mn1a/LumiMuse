const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const ts = require('typescript');
const Database = require('better-sqlite3');

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
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

function requireFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

function requireFreshWithMocks(modulePath, mocks) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function deleteModuleCache(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module may not have been loaded in this test.
  }
}

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          body,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function jsonRequest(body, url = 'http://test.local/api/test') {
  return {
    nextUrl: new URL(url),
    async json() {
      return body;
    },
  };
}

function withTempWorkspace(fn) {
  const tmpRoot = path.join(root, '.tmp-tests');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'memory-profile-'));
  const previousCwd = process.cwd();

  const cleanup = () => {
    process.chdir(previousCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
    }
  };

  process.chdir(tmpDir);
  try {
    const result = fn(tmpDir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function createCharacterDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
  return db;
}

function createCharacterDbFile(tmpDir) {
  const dbPath = path.join(tmpDir, `profile-${crypto.randomUUID()}.db`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
  return { db, dbPath };
}

test('getDb 迁移会创建 character_memory_profiles 表与 11.1 字段', () => {
  withTempWorkspace(() => {
    const originalSetImmediate = global.setImmediate;
    global.setImmediate = () => 0;

    try {
      const { getDb } = requireFresh('../src/lib/db.ts');
      const db = getDb();
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_memory_profiles'")
        .get();
      const columns = db
        .prepare('PRAGMA table_info(character_memory_profiles)')
        .all()
        .map(column => column.name);

      assert.ok(table, 'expected character_memory_profiles table to exist after migration');
      assert.deepEqual(columns, [
        'character_id',
        'profile_name',
        'relationship_state',
        'recent_story_state',
        'emotional_baseline',
        'open_threads',
        'user_profile_summary',
        'pinned_summary',
        'updated_at',
      ]);

      const taskColumns = db
        .prepare('PRAGMA table_info(character_memory_profile_update_tasks)')
        .all()
        .map(column => column.name);
      const versionColumns = db
        .prepare('PRAGMA table_info(character_memory_profile_versions)')
        .all()
        .map(column => column.name);

      assert.deepEqual(taskColumns, [
        'id',
        'character_id',
        'reason',
        'patch_json',
        'status',
        'claim_token',
        'lease_expires_at',
        'retry_count',
        'error_message',
        'created_at',
        'updated_at',
      ]);
      assert.deepEqual(versionColumns, [
        'id',
        'character_id',
        'version_number',
        'snapshot_json',
        'reason',
        'task_id',
        'created_at',
      ]);
      db.close();
    } finally {
      global.setImmediate = originalSetImmediate;
      delete require.cache[require.resolve('../src/lib/db.ts')];
    }
  });
});

test('memory profile legacy table migration backfills profile_name without losing data', () => {
  const { ensureMemoryProfileTables } = requireFresh('../src/lib/db.ts');
  const { readMemoryProfile } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  db.exec(`
    CREATE TABLE character_memory_profiles (
      character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
      relationship_state TEXT NOT NULL DEFAULT '',
      recent_story_state TEXT NOT NULL DEFAULT '',
      emotional_baseline TEXT NOT NULL DEFAULT '',
      open_threads TEXT NOT NULL DEFAULT '[]',
      user_profile_summary TEXT NOT NULL DEFAULT '',
      pinned_summary TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`
    INSERT INTO character_memory_profiles (
      character_id, relationship_state, recent_story_state, user_profile_summary, updated_at
    )
    VALUES ('char-a', '旧库关系状态', '旧库故事状态', '旧库主人画像', datetime('now'))
  `).run();

  ensureMemoryProfileTables(db);
  const columns = db.prepare('PRAGMA table_info(character_memory_profiles)').all().map(column => column.name);
  const profile = readMemoryProfile('char-a', db);

  assert.ok(columns.includes('profile_name'));
  assert.equal(profile.profile_name, '');
  assert.equal(profile.relationship_state, '旧库关系状态');
  assert.equal(profile.recent_story_state, '旧库故事状态');
  assert.equal(profile.user_profile_summary, '旧库主人画像');

  db.close();
});

test('memory profile 可初始化并用结构化 patch 更新部分字段', () => {
  const {
    getOrCreateMemoryProfile,
    patchMemoryProfile,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  const initial = getOrCreateMemoryProfile('char-a', db);
  assert.equal(initial.character_id, 'char-a');
  assert.equal(initial.profile_name, '');
  assert.equal(initial.relationship_state, '');
  assert.deepEqual(initial.open_threads, []);

  const updated = patchMemoryProfile('char-a', {
    profile_name: '稳定陪伴线',
    relationship_state: '主人和艾莉丝已经建立稳定亲密的陪伴关系。',
    open_threads: ['毕业设计进度', '周末去看展'],
  }, db);

  assert.equal(updated.profile_name, '稳定陪伴线');
  assert.equal(updated.relationship_state, '主人和艾莉丝已经建立稳定亲密的陪伴关系。');
  assert.deepEqual(updated.open_threads, ['毕业设计进度', '周末去看展']);
  assert.equal(updated.recent_story_state, '');

  const row = db.prepare('SELECT profile_name, relationship_state, recent_story_state, open_threads FROM character_memory_profiles WHERE character_id = ?').get('char-a');
  assert.equal(row.profile_name, '稳定陪伴线');
  assert.equal(row.relationship_state, '主人和艾莉丝已经建立稳定亲密的陪伴关系。');
  assert.equal(row.recent_story_state, '');
  assert.equal(row.open_threads, JSON.stringify(['毕业设计进度', '周末去看展']));

  db.close();
});

test('parseMemoryProfilePatchResponse 保留合法空 patch 与额外文字 JSON fallback', () => {
  const { parseMemoryProfilePatchResponse } = requireFresh('../src/lib/memory-profile.ts');

  assert.deepEqual(parseMemoryProfilePatchResponse('{"patch":{}}'), {});
  assert.deepEqual(
    parseMemoryProfilePatchResponse('好的，结果如下：\n{"patch":{"relationship_state":"稳定陪伴"}}\n已完成。'),
    { relationship_state: '稳定陪伴' },
  );
});

test('parseMemoryProfilePatchResponse 解析失败时抛出明确错误', () => {
  const { parseMemoryProfilePatchResponse } = requireFresh('../src/lib/memory-profile.ts');

  assert.throws(
    () => parseMemoryProfilePatchResponse('not json'),
    /profile patch parsing|JSON|parse/i,
  );
  assert.throws(
    () => parseMemoryProfilePatchResponse('前缀 {patch:{}} 后缀'),
    /profile patch parsing|JSON|parse/i,
  );
});

test('memory profile patch prompt 输出格式覆盖所有画像字段', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/memory-profile.ts'), 'utf8');
  const outputFormatMatch = source.match(/输出格式：([^\n]+)/);
  assert.ok(outputFormatMatch, 'missing memory profile output format prompt');

  for (const field of [
    'relationship_state',
    'recent_story_state',
    'emotional_baseline',
    'open_threads',
    'user_profile_summary',
    'pinned_summary',
  ]) {
    assert.ok(outputFormatMatch[1].includes(field), `output format should mention ${field}`);
  }
});

test('memory profile API 返回 init 状态与空队列 process 结果', async () => {
  await withTempWorkspace(async () => {
    const originalSetImmediate = global.setImmediate;
    global.setImmediate = () => 0;

    try {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');

      const { getDb } = requireFresh('../src/lib/db.ts');
      const db = getDb();
      db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();

      const route = requireFreshWithMocks('../src/app/api/memory-profile/route.ts', {
        'next/server': jsonResponseMock(),
      });

      const firstInitPayload = await route
        .POST(jsonRequest({ action: 'init', character_id: 'char-a' }, 'http://test.local/api/memory-profile'))
        .then(response => response.json());
      const secondInitPayload = await route
        .POST(jsonRequest({ action: 'init', character_id: 'char-a' }, 'http://test.local/api/memory-profile'))
        .then(response => response.json());
      const processPayload = await route
        .POST(jsonRequest({ action: 'process', limit: 10 }, 'http://test.local/api/memory-profile'))
        .then(response => response.json());

      assert.equal(firstInitPayload.ok, true);
      assert.equal(firstInitPayload.status, 'created');
      assert.equal(firstInitPayload.created, true);
      assert.equal(firstInitPayload.already_exists, false);
      assert.equal(firstInitPayload.profile.character_id, 'char-a');

      assert.equal(secondInitPayload.ok, true);
      assert.equal(secondInitPayload.status, 'already_exists');
      assert.equal(secondInitPayload.created, false);
      assert.equal(secondInitPayload.already_exists, true);
      assert.equal(secondInitPayload.profile.character_id, 'char-a');

      assert.equal(processPayload.ok, true);
      assert.equal(processPayload.processed, 0);
      assert.equal(processPayload.failed, 0);
      assert.equal(processPayload.remaining, 0);
      assert.equal(processPayload.has_pending_tasks, false);
      assert.equal(processPayload.no_pending_tasks, true);
      assert.equal(processPayload.message, 'no pending tasks');

      db.close();
    } finally {
      global.setImmediate = originalSetImmediate;
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');
    }
  });
});

test('memory profile API 从记忆初始化会同步处理画像并返回更新结果', async () => {
  await withTempWorkspace(async () => {
    try {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');

      const { getDb } = requireFresh('../src/lib/db.ts');
      const db = getDb();
      db.prepare("INSERT INTO characters (id, name, basic_info, personality, scenario) VALUES ('char-a', '艾莉丝', '本地陪伴助手', '温柔直接', '长期陪伴主人')").run();
      db.prepare(`
        INSERT INTO memories (
          id, character_id, category, content, confidence, tags, source_msg_ids,
          memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count,
          metadata, created_at, updated_at
        )
        VALUES (
          'mem-a', 'char-a', '话题历史', '主人最近在推进记忆画像流程，希望初始化后直接显示近期故事状态。', 0.9, '[]', '[]',
          'open_thread', 0.8, 0.2, 'active', 0, NULL, 0, '{}', '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z'
        )
      `).run();

      let capturedPrompt = '';
      const route = requireFreshWithMocks('../src/app/api/memory-profile/route.ts', {
        'next/server': jsonResponseMock(),
        '@/lib/api-client': {
          REASONING_SAFE_MAX_TOKENS: 4096,
          chatCompletion: async (_settings, messages) => {
            capturedPrompt = messages[0].content;
            return JSON.stringify({
              patch: {
                relationship_state: '长期陪伴关系稳定',
                recent_story_state: '主人正在修正记忆画像初始化流程',
                open_threads: ['记忆画像自动入库'],
              },
            });
          },
        },
        '@/lib/settings': {
          loadSettings: () => ({
            api_base: 'https://llm.example/v1',
            api_key: 'secret',
            model: 'profile-model',
            max_tokens: 1024,
            memory_background_provider_id: '',
            memory_background_model: '',
            disable_deepseek_thinking_for_background: false,
          }),
          resolveBackgroundConfig: settings => ({
            api_base: settings.api_base,
            api_key: settings.api_key,
            model: settings.model,
          }),
          buildBackgroundChatExtraBody: () => ({}),
        },
      });

      const payload = await route
        .POST(jsonRequest({ action: 'init_from_memories', character_id: 'char-a' }, 'http://test.local/api/memory-profile'))
        .then(response => response.json());
      const task = db.prepare('SELECT status FROM character_memory_profile_update_tasks').get();

      assert.equal(payload.ok, true);
      assert.equal(payload.status, 'processed');
      assert.equal(payload.profile.recent_story_state, '主人正在修正记忆画像初始化流程');
      assert.deepEqual(payload.profile.open_threads, ['记忆画像自动入库']);
      assert.equal(task.status, 'done');
      assert.match(capturedPrompt, /recent_story_state/);

      db.close();
    } finally {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');
    }
  });
});

test('memory profile API 从记忆初始化未产生画像变更时返回 no_changes', async () => {
  await withTempWorkspace(async () => {
    try {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');

      const { getDb } = requireFresh('../src/lib/db.ts');
      const db = getDb();
      db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
      db.prepare(`
        INSERT INTO memories (
          id, character_id, category, content, confidence, tags, source_msg_ids,
          memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count,
          metadata, created_at, updated_at
        )
        VALUES (
          'mem-a', 'char-a', '话题历史', '这是一条不足以形成长期画像的普通闲聊。', 0.9, '[]', '[]',
          'conversation_summary', 0.4, 0.1, 'active', 0, NULL, 0, '{}', '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z'
        )
      `).run();

      const route = requireFreshWithMocks('../src/app/api/memory-profile/route.ts', {
        'next/server': jsonResponseMock(),
        '@/lib/api-client': {
          REASONING_SAFE_MAX_TOKENS: 4096,
          chatCompletion: async () => JSON.stringify({ patch: {} }),
        },
        '@/lib/settings': {
          loadSettings: () => ({
            api_base: 'https://llm.example/v1',
            api_key: 'secret',
            model: 'profile-model',
            max_tokens: 1024,
            memory_background_provider_id: '',
            memory_background_model: '',
            disable_deepseek_thinking_for_background: false,
          }),
          resolveBackgroundConfig: settings => ({
            api_base: settings.api_base,
            api_key: settings.api_key,
            model: settings.model,
          }),
          buildBackgroundChatExtraBody: () => ({}),
        },
      });

      const response = await route.POST(jsonRequest(
        { action: 'init_from_memories', character_id: 'char-a' },
        'http://test.local/api/memory-profile',
      ));
      const payload = await response.json();
      const task = db.prepare('SELECT status, error_message FROM character_memory_profile_update_tasks').get();

      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.status, 'no_changes');
      assert.equal(payload.task_result.processed, 0);
      assert.equal(payload.task_result.skipped, 1);
      assert.equal(task.status, 'done');
      assert.equal(task.error_message, 'empty profile patch skipped');

      db.close();
    } finally {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');
    }
  });
});

test('memory profile API 从记忆初始化失败时返回错误而不是成功', async () => {
  await withTempWorkspace(async () => {
    try {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');

      const { getDb } = requireFresh('../src/lib/db.ts');
      const db = getDb();
      db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
      db.prepare(`
        INSERT INTO memories (
          id, character_id, category, content, confidence, tags, source_msg_ids,
          memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count,
          metadata, created_at, updated_at
        )
        VALUES (
          'mem-a', 'char-a', '话题历史', '主人希望画像初始化失败时不要显示成功。', 0.9, '[]', '[]',
          'open_thread', 0.8, 0.2, 'active', 0, NULL, 0, '{}', '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z'
        )
      `).run();

      const route = requireFreshWithMocks('../src/app/api/memory-profile/route.ts', {
        'next/server': jsonResponseMock(),
        '@/lib/api-client': {
          REASONING_SAFE_MAX_TOKENS: 4096,
          chatCompletion: async () => {
            throw new Error('profile model failed');
          },
        },
        '@/lib/settings': {
          loadSettings: () => ({
            api_base: 'https://llm.example/v1',
            api_key: 'secret',
            model: 'profile-model',
            max_tokens: 1024,
            memory_background_provider_id: '',
            memory_background_model: '',
            disable_deepseek_thinking_for_background: false,
          }),
          resolveBackgroundConfig: settings => ({
            api_base: settings.api_base,
            api_key: settings.api_key,
            model: settings.model,
          }),
          buildBackgroundChatExtraBody: () => ({}),
        },
      });

      const response = await route.POST(jsonRequest(
        { action: 'init_from_memories', character_id: 'char-a' },
        'http://test.local/api/memory-profile',
      ));
      const payload = await response.json();
      const task = db.prepare('SELECT status, error_message FROM character_memory_profile_update_tasks').get();

      assert.equal(response.status, 500);
      assert.equal(payload.ok, false);
      assert.equal(payload.error, 'profile_update_failed');
      assert.match(payload.detail, /profile model failed/);
      assert.equal(task.status, 'failed');
      assert.match(task.error_message, /profile model failed/);

      db.close();
    } finally {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');
    }
  });
});

test('memory profile API 手动 enqueue 只同步处理当前任务', async () => {
  await withTempWorkspace(async () => {
    try {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');

      const { getDb } = requireFresh('../src/lib/db.ts');
      const db = getDb();
      db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
      const memoryProfile = requireFresh('../src/lib/memory-profile.ts');
      for (let i = 0; i < 10; i += 1) {
        memoryProfile.enqueueMemoryProfileUpdate('char-a', { relationship_state: `旧队列任务 ${i}` }, 'old_pending', db);
      }

      const route = requireFreshWithMocks('../src/app/api/memory-profile/route.ts', {
        'next/server': jsonResponseMock(),
        '@/lib/memory-profile': {
          ...memoryProfile,
          triggerMemoryProfileQueue: () => {},
        },
      });

      const payload = await route
        .POST(jsonRequest({
          action: 'enqueue',
          character_id: 'char-a',
          patch: { relationship_state: '手动保存后的关系状态' },
          reason: 'manual_edit',
        }, 'http://test.local/api/memory-profile'))
        .then(response => response.json());
      const tasks = db.prepare('SELECT status FROM character_memory_profile_update_tasks ORDER BY id ASC').all();

      assert.equal(payload.ok, true);
      assert.equal(payload.profile.relationship_state, '手动保存后的关系状态');
      assert.deepEqual(tasks.map(task => task.status), [
        ...Array(10).fill('pending'),
        'done',
      ]);
      assert.equal(payload.task.status, 'done');
      assert.equal(payload.task_result.processed, 1);

      db.close();
    } finally {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');
    }
  });
});

test('memory profile API 手动 enqueue 不同步处理其它待处理队列', async () => {
  await withTempWorkspace(async () => {
    try {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');

      const { getDb } = requireFresh('../src/lib/db.ts');
      const db = getDb();
      db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝'), ('char-b', '莉莉')").run();
      const memoryProfile = requireFresh('../src/lib/memory-profile.ts');
      memoryProfile.enqueueMemoryProfileUpdate('char-b', { relationship_state: '其它角色旧队列' }, 'old_pending', db);
      memoryProfile.enqueueMemoryProfileUpdate('char-a', { relationship_state: '当前角色旧队列' }, 'old_pending', db);

      const route = requireFreshWithMocks('../src/app/api/memory-profile/route.ts', {
        'next/server': jsonResponseMock(),
        '@/lib/memory-profile': {
          ...memoryProfile,
          triggerMemoryProfileQueue: () => {},
        },
      });

      const payload = await route
        .POST(jsonRequest({
          action: 'enqueue',
          character_id: 'char-a',
          patch: { relationship_state: '当前角色手动保存' },
          reason: 'manual_edit',
        }, 'http://test.local/api/memory-profile'))
        .then(response => response.json());
      const rows = db.prepare(`
        SELECT character_id, status
        FROM character_memory_profile_update_tasks
        ORDER BY id ASC
      `).all();
      const charBProfile = db.prepare('SELECT relationship_state FROM character_memory_profiles WHERE character_id = ?').get('char-b');

      assert.equal(payload.ok, true);
      assert.equal(payload.profile.relationship_state, '当前角色手动保存');
      assert.deepEqual(rows, [
        { character_id: 'char-b', status: 'pending' },
        { character_id: 'char-a', status: 'pending' },
        { character_id: 'char-a', status: 'done' },
      ]);
      assert.equal(payload.task_result.processed, 1);
      assert.equal(charBProfile, undefined);

      db.close();
    } finally {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');
    }
  });
});

test('memory profile GET 返回轻量任务摘要而不是完整 source_text payload', async () => {
  await withTempWorkspace(async () => {
    try {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');

      const { getDb } = requireFresh('../src/lib/db.ts');
      const db = getDb();
      db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
      const memoryProfile = requireFresh('../src/lib/memory-profile.ts');
      memoryProfile.patchMemoryProfile('char-a', { relationship_state: '稳定陪伴' }, db);
      for (let i = 0; i < 3; i += 1) {
        memoryProfile.enqueueMemoryProfilePatchExtraction(
          'char-a',
          `历史对话采样 ${i}\n${'x'.repeat(20_000)}`,
          'memory_extraction',
          db,
        );
      }

      const route = requireFreshWithMocks('../src/app/api/memory-profile/route.ts', {
        'next/server': jsonResponseMock(),
      });
      const payload = await route
        .GET({ nextUrl: new URL('http://test.local/api/memory-profile?character_id=char-a') })
        .then(response => response.json());
      const encoded = JSON.stringify(payload);

      assert.equal(payload.profile.relationship_state, '稳定陪伴');
      assert.equal(payload.tasks.length, 3);
      assert.ok(encoded.length < 5000, `profile response should stay small, got ${encoded.length} chars`);
      assert.ok(!('source_text' in payload.tasks[0]), 'task summary must not expose source_text');
      assert.ok(!('patch' in payload.tasks[0]), 'task summary must not expose patch payload');
      assert.ok(!('claim_token' in payload.tasks[0]), 'task summary must not expose claim token');
      assert.ok(!('lease_expires_at' in payload.tasks[0]), 'task summary must not expose lease state');

      db.close();
    } finally {
      deleteModuleCache('../src/lib/db.ts');
      deleteModuleCache('../src/lib/memory-profile.ts');
      deleteModuleCache('../src/app/api/memory-profile/route.ts');
    }
  });
});

test('memory profile API 可删除指定历史版本', async () => {
  let deletedArgs = null;
  const route = requireFreshWithMocks('../src/app/api/memory-profile/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/memory-profile': {
      enqueueMemoryProfileUpdate: () => {
        throw new Error('enqueue should not be called');
      },
      enqueueMemoryProfilePatchExtraction: () => {
        throw new Error('extract should not be called');
      },
      getMemoryProfileUpdateTasks: () => [],
      getMemoryProfileVersions: () => [],
      getOrCreateMemoryProfile: () => ({ character_id: 'char-a' }),
      processMemoryProfileUpdateTasks: async () => ({ processed: 0, failed: 0, remaining: 0 }),
      readMemoryProfile: () => ({ character_id: 'char-a' }),
      rollbackMemoryProfile: () => {
        throw new Error('rollback should not be called');
      },
      triggerMemoryProfileQueue: () => {},
      deleteMemoryProfileVersion: (characterId, versionId) => {
        deletedArgs = { characterId, versionId };
        return true;
      },
    },
  });

  const response = await route.POST(jsonRequest(
    { action: 'delete_version', character_id: 'char-a', version_id: 7 },
    'http://test.local/api/memory-profile',
  ));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, deleted: true });
  assert.deepEqual(deletedArgs, { characterId: 'char-a', versionId: 7 });
});

test('renderMemoryProfile 将非空结构化 profile 渲染为自然语言并省略空字段', () => {
  const { renderMemoryProfile } = requireFresh('../src/lib/memory-profile.ts');

  const rendered = renderMemoryProfile({
    character_id: 'char-a',
    relationship_state: '主人和艾莉丝已经建立稳定亲密的陪伴关系。',
    recent_story_state: '',
    emotional_baseline: '主人最近压力偏高，需要更柔和的回应。',
    open_threads: ['毕业设计进度', '周末去看展'],
    user_profile_summary: '主人偏好直接但温柔的中文解释。',
    pinned_summary: '',
    updated_at: '2026-06-02T00:00:00.000Z',
  });

  assert.match(rendered, /记忆画像/);
  assert.match(rendered, /关系状态：主人和艾莉丝已经建立稳定亲密的陪伴关系。/);
  assert.match(rendered, /情绪基线：主人最近压力偏高，需要更柔和的回应。/);
  assert.match(rendered, /进行中的话题：毕业设计进度；周末去看展/);
  assert.match(rendered, /主人画像：主人偏好直接但温柔的中文解释。/);
  assert.doesNotMatch(rendered, /近期故事状态/);
  assert.doesNotMatch(rendered, /置顶摘要/);
});

test('memory profile update task 可入队、处理并记录更新后版本', async () => {
  const {
    enqueueMemoryProfileUpdate,
    getMemoryProfileUpdateTasks,
    getMemoryProfileVersions,
    patchMemoryProfile,
    processMemoryProfileUpdateTasks,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  patchMemoryProfile('char-a', {
    profile_name: '旧画像',
    relationship_state: '旧关系状态',
    open_threads: ['旧话题'],
  }, db);

  const task = enqueueMemoryProfileUpdate('char-a', {
    profile_name: '新画像',
    relationship_state: '新关系状态',
    open_threads: ['新话题'],
  }, 'memory_extraction', db);

  assert.equal(task.status, 'pending');
  assert.deepEqual(getMemoryProfileUpdateTasks('char-a', db).map(item => item.id), [task.id]);

  const result = await processMemoryProfileUpdateTasks({ db, limit: 1 });
  const doneTask = getMemoryProfileUpdateTasks('char-a', db)[0];
  const versions = getMemoryProfileVersions('char-a', db);

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(doneTask.status, 'done');
  assert.equal(result.profiles[0].profile_name, '新画像');
  assert.equal(result.profiles[0].relationship_state, '新关系状态');
  assert.deepEqual(result.profiles[0].open_threads, ['新话题']);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version_number, 1);
  assert.equal(versions[0].snapshot.profile_name, '新画像');
  assert.equal(versions[0].snapshot.relationship_state, '新关系状态');
  assert.deepEqual(versions[0].snapshot.open_threads, ['新话题']);

  db.close();
});

test('manual memory profile patch can clear existing fields', async () => {
  const {
    enqueueMemoryProfileUpdate,
    patchMemoryProfile,
    processMemoryProfileUpdateTasks,
    readMemoryProfile,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  patchMemoryProfile('char-a', {
    profile_name: '旧画像名称',
    relationship_state: '旧关系状态',
    open_threads: ['旧话题'],
    pinned_summary: '旧钉选摘要',
  }, db);

  enqueueMemoryProfileUpdate('char-a', {
    profile_name: '',
    relationship_state: '',
    open_threads: [],
    pinned_summary: '',
  }, 'manual_edit', db);

  const result = await processMemoryProfileUpdateTasks({ db, limit: 1 });
  const profile = readMemoryProfile('char-a', db);

  assert.equal(result.processed, 1);
  assert.equal(result.skipped, 0);
  assert.equal(profile.profile_name, '');
  assert.equal(profile.relationship_state, '');
  assert.deepEqual(profile.open_threads, []);
  assert.equal(profile.pinned_summary, '');

  db.close();
});

test('LLM 生成画像 patch 时忽略 UI-only profile_name', async () => {
  const {
    enqueueMemoryProfilePatchExtraction,
    getMemoryProfileVersions,
    patchMemoryProfile,
    processMemoryProfileUpdateTasks,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  patchMemoryProfile('char-a', {
    profile_name: '手动画像名称',
    relationship_state: '旧关系状态',
  }, db);
  enqueueMemoryProfilePatchExtraction('char-a', '主人和艾莉丝建立了新的关系状态。', 'memory_extraction', db);

  const result = await processMemoryProfileUpdateTasks({
    db,
    limit: 1,
    generatePatch: async () => ({
      profile_name: '模型误写画像名称',
      relationship_state: '新的稳定关系状态',
    }),
  });
  const versions = getMemoryProfileVersions('char-a', db);
  const profile = result.profiles[0];

  assert.equal(result.processed, 1);
  assert.equal(profile.profile_name, '手动画像名称');
  assert.equal(profile.relationship_state, '新的稳定关系状态');
  assert.equal(versions[0].snapshot.profile_name, '手动画像名称');
  assert.equal(versions[0].snapshot.relationship_state, '新的稳定关系状态');

  db.close();
});

test('memory profile 自动版本可切换回非空 v1 内容', async () => {
  const {
    enqueueMemoryProfileUpdate,
    getMemoryProfileVersions,
    patchMemoryProfile,
    processMemoryProfileUpdateTasks,
    rollbackMemoryProfile,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  enqueueMemoryProfileUpdate('char-a', {
    profile_name: '第一阶段画像',
    relationship_state: 'v1 关系状态',
    user_profile_summary: 'v1 主人画像',
  }, 'memory_extraction', db);

  await processMemoryProfileUpdateTasks({ db, limit: 1 });
  const version = getMemoryProfileVersions('char-a', db)[0];

  patchMemoryProfile('char-a', {
    profile_name: '误命名画像',
    relationship_state: '误清空状态',
    user_profile_summary: '',
  }, db);

  const switched = rollbackMemoryProfile('char-a', version.id, db);

  assert.equal(version.version_number, 1);
  assert.equal(version.snapshot.profile_name, '第一阶段画像');
  assert.equal(version.snapshot.relationship_state, 'v1 关系状态');
  assert.equal(version.snapshot.user_profile_summary, 'v1 主人画像');
  assert.equal(switched.profile_name, '第一阶段画像');
  assert.equal(switched.relationship_state, 'v1 关系状态');
  assert.equal(switched.user_profile_summary, 'v1 主人画像');

  db.close();
});

test('memory profile versions 支持分页并裁剪旧版本', () => {
  const {
    createMemoryProfileVersion,
    getMemoryProfileVersions,
    patchMemoryProfile,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  for (let i = 1; i <= 125; i += 1) {
    patchMemoryProfile('char-a', { relationship_state: `版本 ${i}` }, db);
    createMemoryProfileVersion('char-a', 'test_retention', undefined, db);
  }

  const firstPage = getMemoryProfileVersions('char-a', db, { limit: 10, offset: 0 });
  const secondPage = getMemoryProfileVersions('char-a', db, { limit: 10, offset: 10 });
  const retainedCount = db.prepare('SELECT COUNT(*) as count FROM character_memory_profile_versions WHERE character_id = ?').get('char-a').count;

  assert.equal(firstPage.length, 10);
  assert.equal(secondPage.length, 10);
  assert.equal(firstPage[0].version_number, 125);
  assert.equal(firstPage[9].version_number, 116);
  assert.equal(secondPage[0].version_number, 115);
  assert.equal(retainedCount, 100);

  db.close();
});

test('并发处理 profile update task 时同一任务只会被一个 worker claim', async () => {
  await withTempWorkspace(async (tmpDir) => {
    const {
      enqueueMemoryProfilePatchExtraction,
      getMemoryProfileUpdateTasks,
      processMemoryProfileUpdateTasks,
    } = requireFresh('../src/lib/memory-profile.ts');
    const { db, dbPath } = createCharacterDbFile(tmpDir);
    const otherDb = new Database(dbPath);
    otherDb.pragma('foreign_keys = ON');

    enqueueMemoryProfilePatchExtraction('char-a', '主人说以后希望艾莉丝先安抚再讲道理。', 'memory_extraction', db);

    let generatorCalls = 0;
    const generatePatch = async () => {
      generatorCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 40));
      return {
        relationship_state: '主人和艾莉丝建立了更稳定的安抚约定。',
      };
    };

    const [first, second] = await Promise.all([
      processMemoryProfileUpdateTasks({ db, limit: 1, generatePatch, leaseSeconds: 30 }),
      processMemoryProfileUpdateTasks({ db: otherDb, limit: 1, generatePatch, leaseSeconds: 30 }),
    ]);

    assert.equal(first.processed + second.processed, 1);
    assert.equal(first.failed + second.failed, 0);
    assert.equal(generatorCalls, 1);

    const tasks = getMemoryProfileUpdateTasks('char-a', db);
    assert.equal(tasks[0].status, 'done');
    assert.equal(tasks[0].claim_token, null);
    assert.equal(tasks[0].lease_expires_at, null);

    otherDb.close();
    db.close();
  });
});

test('过期 processing profile task 可被后续 worker 重新 claim', async () => {
  const {
    enqueueMemoryProfileUpdate,
    getMemoryProfileUpdateTasks,
    processMemoryProfileUpdateTasks,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  const task = enqueueMemoryProfileUpdate('char-a', {
    emotional_baseline: '主人最近压力偏高，需要更柔和的回应。',
  }, 'memory_extraction', db);

  db.prepare(`
    UPDATE character_memory_profile_update_tasks
    SET status = 'processing',
        claim_token = 'stale-worker',
        lease_expires_at = datetime('now', '-1 minute')
    WHERE id = ?
  `).run(task.id);

  const result = await processMemoryProfileUpdateTasks({ db, limit: 1, leaseSeconds: 30 });
  const doneTask = getMemoryProfileUpdateTasks('char-a', db)[0];

  assert.equal(result.processed, 1);
  assert.equal(doneTask.status, 'done');
  assert.equal(doneTask.claim_token, null);
  assert.equal(doneTask.lease_expires_at, null);
  assert.equal(result.profiles[0].emotional_baseline, '主人最近压力偏高，需要更柔和的回应。');

  db.close();
});

test('profile worker 丢失 claim 后不会继续写入画像', async () => {
  const {
    enqueueMemoryProfilePatchExtraction,
    getMemoryProfileUpdateTasks,
    patchMemoryProfile,
    processMemoryProfileUpdateTasks,
    readMemoryProfile,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  patchMemoryProfile('char-a', { relationship_state: '原始关系状态' }, db);
  const task = enqueueMemoryProfilePatchExtraction('char-a', '主人和艾莉丝建立了新的关系状态。', 'memory_extraction', db);

  const result = await processMemoryProfileUpdateTasks({
    db,
    limit: 1,
    generatePatch: async () => {
      db.prepare(`
        UPDATE character_memory_profile_update_tasks
        SET claim_token = 'other-worker'
        WHERE id = ?
      `).run(task.id);
      return { relationship_state: '不应写入的过期结果' };
    },
  });
  const profile = readMemoryProfile('char-a', db);
  const updatedTask = getMemoryProfileUpdateTasks('char-a', db)[0];

  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(profile.relationship_state, '原始关系状态');
  assert.equal(updatedTask.claim_token, 'other-worker');

  db.close();
});

test('LLM 生成空 profile patch 时跳过任务且不写入版本或污染 profile', async () => {
  const {
    enqueueMemoryProfilePatchExtraction,
    getMemoryProfileUpdateTasks,
    getMemoryProfileVersions,
    patchMemoryProfile,
    processMemoryProfileUpdateTasks,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  patchMemoryProfile('char-a', { relationship_state: '原始关系状态' }, db);
  enqueueMemoryProfilePatchExtraction('char-a', '这只是一段没有长期价值的闲聊。', 'memory_extraction', db);

  const result = await processMemoryProfileUpdateTasks({
    db,
    limit: 1,
    generatePatch: async () => ({}),
  });
  const doneTask = getMemoryProfileUpdateTasks('char-a', db)[0];
  const versions = getMemoryProfileVersions('char-a', db);
  const profile = result.profiles[0];

  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.equal(doneTask.status, 'done');
  assert.equal(doneTask.error_message, 'empty profile patch skipped');
  assert.equal(versions.length, 0);
  assert.equal(profile.relationship_state, '原始关系状态');

  db.close();
});

test('LLM 画像 patch 响应解析失败时标记任务失败而不是空 patch 跳过', async () => {
  const {
    enqueueMemoryProfilePatchExtraction,
    getMemoryProfileUpdateTasks,
    getMemoryProfileVersions,
    parseMemoryProfilePatchResponse,
    patchMemoryProfile,
    processMemoryProfileUpdateTasks,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  patchMemoryProfile('char-a', { relationship_state: '原始关系状态' }, db);
  enqueueMemoryProfilePatchExtraction('char-a', '主人表达了新的长期画像信息。', 'memory_extraction', db);

  const result = await processMemoryProfileUpdateTasks({
    db,
    limit: 1,
    generatePatch: async () => parseMemoryProfilePatchResponse('not json'),
  });
  const failedTask = getMemoryProfileUpdateTasks('char-a', db)[0];
  const versions = getMemoryProfileVersions('char-a', db);

  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 1);
  assert.equal(failedTask.status, 'failed');
  assert.match(failedTask.error_message, /profile patch parsing|JSON|parse/i);
  assert.equal(versions.length, 0);

  db.close();
});

test('memory profile rollback 可恢复版本快照且不额外创建新版本', () => {
  const {
    createMemoryProfileVersion,
    getMemoryProfileVersions,
    patchMemoryProfile,
    rollbackMemoryProfile,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  patchMemoryProfile('char-a', {
    relationship_state: '稳定陪伴',
    user_profile_summary: '主人喜欢简洁解释。',
  }, db);
  const version = createMemoryProfileVersion('char-a', 'manual_checkpoint', undefined, db);

  patchMemoryProfile('char-a', {
    relationship_state: '误写状态',
    user_profile_summary: '误写画像',
  }, db);

  const rolledBack = rollbackMemoryProfile('char-a', version.id, db);
  const versions = getMemoryProfileVersions('char-a', db);

  assert.equal(rolledBack.relationship_state, '稳定陪伴');
  assert.equal(rolledBack.user_profile_summary, '主人喜欢简洁解释。');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].id, version.id);
  assert.equal(versions[0].reason, 'manual_checkpoint');

  db.close();
});

test('memory profile rollback 遇到空历史快照时不会清空当前非空画像', () => {
  const {
    readMemoryProfile,
    patchMemoryProfile,
    rollbackMemoryProfile,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  const current = patchMemoryProfile('char-a', {
    profile_name: '当前画像名称',
    relationship_state: '当前稳定陪伴',
    recent_story_state: '主人正在修复记忆画像回滚',
    user_profile_summary: '主人偏好直接明确的处理流程。',
  }, db);
  const emptySnapshot = {
    ...current,
    profile_name: '历史空快照名称',
    relationship_state: '',
    recent_story_state: '',
    emotional_baseline: '',
    open_threads: [],
    user_profile_summary: '',
    pinned_summary: '',
  };
  const version = db.prepare(`
    INSERT INTO character_memory_profile_versions (
      character_id, version_number, snapshot_json, reason, task_id, created_at
    )
    VALUES ('char-a', 1, ?, 'before_init_from_memories', NULL, datetime('now'))
  `).run(JSON.stringify(emptySnapshot));

  const rolledBack = rollbackMemoryProfile('char-a', Number(version.lastInsertRowid), db);
  const after = readMemoryProfile('char-a', db);

  assert.equal(rolledBack.profile_name, '当前画像名称');
  assert.equal(rolledBack.relationship_state, '当前稳定陪伴');
  assert.equal(rolledBack.recent_story_state, '主人正在修复记忆画像回滚');
  assert.equal(rolledBack.user_profile_summary, '主人偏好直接明确的处理流程。');
  assert.equal(after.profile_name, '当前画像名称');
  assert.equal(after.relationship_state, '当前稳定陪伴');
  assert.equal(after.recent_story_state, '主人正在修复记忆画像回滚');
  assert.equal(after.user_profile_summary, '主人偏好直接明确的处理流程。');

  db.close();
});

test('memory profile versions 可删除指定历史版本', () => {
  const {
    createMemoryProfileVersion,
    deleteMemoryProfileVersion,
    getMemoryProfileVersions,
    patchMemoryProfile,
  } = requireFresh('../src/lib/memory-profile.ts');
  const db = createCharacterDb();

  patchMemoryProfile('char-a', { relationship_state: '版本一' }, db);
  const first = createMemoryProfileVersion('char-a', 'manual_checkpoint', undefined, db);
  patchMemoryProfile('char-a', { relationship_state: '版本二' }, db);
  const second = createMemoryProfileVersion('char-a', 'manual_checkpoint', undefined, db);

  const deleted = deleteMemoryProfileVersion('char-a', first.id, db);
  const versions = getMemoryProfileVersions('char-a', db);

  assert.equal(deleted, true);
  assert.deepEqual(versions.map(version => version.id), [second.id]);
  assert.equal(deleteMemoryProfileVersion('char-a', first.id, db), false);

  db.close();
});
