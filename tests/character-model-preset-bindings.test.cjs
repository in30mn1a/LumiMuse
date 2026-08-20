const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
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
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const dbModulePath = require.resolve(path.join(root, 'src', 'lib', 'db.ts'));

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          async json() {
            return body;
          },
        };
      },
    },
  };
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
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

function jsonRequest(body) {
  return {
    async json() {
      return body;
    },
  };
}

function seedCharacter(db) {
  db.prepare(`
    INSERT INTO characters (
      id, name, basic_info, personality, scenario, greeting, example_dialogue,
      system_prompt, other_info, image_tags, user_image_tags, active_preset_id,
      created_at, updated_at
    ) VALUES (
      'char-1', '艾莉丝', '', '', '', '', '', '', '', '', '', '__none__',
      datetime('now'), datetime('now')
    )
  `).run();
}

function loadRoute(db) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}lib${path.sep}prompt-presets`)) {
      delete require.cache[key];
    }
  }
  return requireFreshWithMocks('../src/app/api/characters/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });
}

test('GET/PUT character model preset bindings replace-all and keep-on-omit', async () => {
  const dbMod = require(dbModulePath);
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  dbMod.__migrateForTests(db);
  seedCharacter(db);
  db.prepare(`
    INSERT INTO prompt_presets (
      id, name, description, is_built_in, story_plot_strip, strip_tags, created_at, updated_at
    ) VALUES ('preset-1', 'Claude RP', '', 0, 0, '[]', datetime('now'), datetime('now'))
  `).run();

  const route = loadRoute(db);
  const params = { params: Promise.resolve({ id: 'char-1' }) };

  const emptyGet = await route.GET({}, params);
  const emptyBody = await emptyGet.json();
  assert.equal(emptyGet.status, 200);
  assert.deepEqual(emptyBody.model_preset_bindings, []);

  const put = await route.PUT(jsonRequest({
    name: '艾莉丝',
    model_preset_bindings: [
      { model: 'claude-sonnet-4', preset_id: 'preset-1' },
      { model: 'gpt-4o', preset_id: '__none__' },
    ],
  }), params);
  const putBody = await put.json();
  assert.equal(put.status, 200, putBody.error);
  assert.deepEqual(putBody.model_preset_bindings, [
    { model: 'claude-sonnet-4', preset_id: 'preset-1' },
    { model: 'gpt-4o', preset_id: '__none__' },
  ]);

  const keep = await route.PUT(jsonRequest({ name: '艾莉丝-改名' }), params);
  const keepBody = await keep.json();
  assert.equal(keep.status, 200);
  assert.equal(keepBody.name, '艾莉丝-改名');
  assert.equal(keepBody.model_preset_bindings.length, 2);

  const duplicate = await route.PUT(jsonRequest({
    model_preset_bindings: [
      { model: 'same', preset_id: 'preset-1' },
      { model: 'same', preset_id: '__none__' },
    ],
  }), params);
  assert.equal(duplicate.status, 400);

  const missing = await route.PUT(jsonRequest({
    model_preset_bindings: [{ model: 'claude-sonnet-4', preset_id: 'no-such-preset' }],
  }), params);
  assert.equal(missing.status, 400);

  const cleared = await route.PUT(jsonRequest({ model_preset_bindings: [] }), params);
  const clearedBody = await cleared.json();
  assert.equal(cleared.status, 200);
  assert.deepEqual(clearedBody.model_preset_bindings, []);

  db.close();
});

test('character editor and i18n expose model preset bindings', () => {
  const page = fs.readFileSync(path.join(root, 'src/app/characters/[id]/page.tsx'), 'utf8');
  const field = fs.readFileSync(path.join(root, 'src/components/ui/ModelPresetBindingsField.tsx'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'src/lib/i18n.ts'), 'utf8');
  assert.match(page, /ModelPresetBindingsField/);
  assert.match(page, /preset\.modelBindDuplicate/);
  assert.match(field, /select-rich/);
  assert.doesNotMatch(field, /datalist/);
  assert.doesNotMatch(field, /list=/);
  assert.match(i18n, /'preset\.modelBindTitle': '模型绑定预设'/);
  assert.match(i18n, /'preset\.modelBindTitle': 'Model preset bindings'/);
  assert.match(i18n, /'preset\.modelBindModelPlaceholder': '请选择模型'/);
  assert.match(i18n, /'preset\.modelBindModelPlaceholder': 'Select a model'/);
});
