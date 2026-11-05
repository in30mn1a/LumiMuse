const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

async function capturePromptRequest(style, requirements) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY, name TEXT, personality TEXT, scenario TEXT,
      image_tags TEXT, user_image_tags TEXT, image_prompt_other_requirements TEXT
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, character_id TEXT, parent_id TEXT, parent_seq_end INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, seq INTEGER
    );
  `);
  db.prepare('INSERT INTO characters VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'char-1', 'Mira', 'a calm adult illustrator', 'rainy cafe', 'silver hair, blue eyes', '', requirements ?? '',
  );
  db.prepare('INSERT INTO conversations VALUES (?, ?, NULL, NULL)').run('conv-1', 'char-1');
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run('message-1', 'conv-1', 'assistant', '看着窗外的雨。', 1);

  let captured;
  const settings = {
    api_base: 'https://llm.example/v1',
    api_key: 'fictional-key',
    model: 'fictional-model',
    memory_background_timeout_ms: 0,
    image_gen: {
      enabled: true,
      engine: style === 'nai-v5' ? 'nai' : 'sd',
      nai_model: 'nai-diffusion-5-full',
    },
  };
  const mocks = {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => settings,
      resolveBackgroundConfig: value => value,
      mergeSettingsForBackgroundLlm: (base, config, patch) => ({ ...base, ...config, ...patch }),
      buildBackgroundChatExtraBody: () => undefined,
    },
    '@/lib/api-client': {
      chatCompletion: async (_settings, messages) => {
        captured = structuredClone(messages);
        return style === 'nai-v5'
          ? 'Prompt:\n1girl, rainy window\n\nCharacter 1:\ngirl, silver hair, blue eyes'
          : 'POSITIVE: 1girl, silver hair, blue eyes, rainy window';
      },
    },
  };
  const originalLoad = Module._load;
  let route;
  try {
    Module._load = function loadWithMocks(request, ...args) {
      return Object.hasOwn(mocks, request) ? mocks[request] : originalLoad.call(this, request, ...args);
    };
    const routePath = require.resolve('../src/app/api/image-gen/prompt/route.ts');
    delete require.cache[routePath];
    route = require(routePath);
  } finally {
    Module._load = originalLoad;
  }

  try {
    const response = await route.POST(new Request('http://localhost/api/image-gen/prompt', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: 'conv-1', message_id: 'message-1', user_hint: '镜头从侧面拍摄。' }),
    }));
    assert.equal(response.status, 200);
    assert.ok((await response.json()).prompt);
    return captured;
  } finally {
    db.close();
  }
}

test('standalone generation sends complete character requirements with context and the one-time hint in both styles', async () => {
  const requirements = '  保留窗边的构图。\n使用柔和侧光。  ';
  for (const style of ['danbooru', 'nai-v5']) {
    const messages = await capturePromptRequest(style, requirements);
    const context = messages.find(message => message.role === 'user').content;
    assert.ok(context.includes(requirements), `${style} 未传递完整要求`);
    assert.match(context, /Mira/);
    assert.match(context, /silver hair, blue eyes/);
    assert.match(context, /看着窗外的雨。/);
    assert.match(context, /镜头从侧面拍摄。/);
    assert.ok(context.indexOf('【生图其他要求】') < context.indexOf('【用户额外指定（最高优先级）】'));
    if (style === 'nai-v5') {
      assert.match(messages[0].content, /英文为主。/);
      assert.doesNotMatch(messages[0].content, /句子可以直接写中文/);
    }
  }
});

test('standalone generation keeps the existing request identical when character requirements are empty', async () => {
  for (const style of ['danbooru', 'nai-v5']) {
    const original = await capturePromptRequest(style);
    for (const empty of ['', ' \n\t ']) {
      assert.deepEqual(await capturePromptRequest(style, empty), original);
    }
  }
});
