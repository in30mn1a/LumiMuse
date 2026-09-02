// 上游前缀缓存按顺序匹配请求体：稳定前缀里任何一个字节变了，它之后的内容全部作废。
// 这里锁住 assemblePrompt 的分层不变量——
//   system（角色详情 + full 记忆包 + 时间说明 + 生图指令）逐字节不变
//   → 历史只增不改
//   → 检索模式等逐轮会变的内容才压在最后一条 user。
// 2026-08-30 真实 Gemini：记忆挂 last user 时重新生成 ~95%，续聊 ~36%
// （约等于不含记忆的 system）。续聊会改写上一轮 last user，记忆块进不了前缀。

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

const { assemblePrompt } = require('../src/lib/chat-engine.ts');

function baseCharacter(overrides = {}) {
  return {
    id: 'char-a',
    name: 'Alice',
    avatar_url: null,
    basic_info: 'a long-lived companion',
    personality: 'warm',
    scenario: '',
    greeting: '',
    example_dialogue: '',
    system_prompt: '',
    other_info: '',
    image_tags: '',
    user_image_tags: '',
    created_at: '2026-06-07T00:00:00.000Z',
    updated_at: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

function baseSettings(overrides = {}) {
  return {
    context_window: 1000000,
    max_tokens: 12800,
    example_dialogue: false,
    memory_inject: true,
    show_timestamps: false,
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    id: 'msg-a',
    conversation_id: 'conv-a',
    role: 'user',
    content: 'hello',
    token_count: 1,
    created_at: '2026-06-07T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

const MEMORY_TEXT = '## 记忆上下文\n\n### 本轮相关回忆\n- 用户不爱吃甜的\n- 用户住在东京';
const MEMORY_TEXT_AFTER_EXTRACT = `${MEMORY_TEXT}\n- 用户开始学做甜点`;

function timeAt(minute) {
  return { clientNowIso: `2026-08-30T01:${String(minute).padStart(2, '0')}:00.000Z`, timeZone: 'Asia/Tokyo' };
}

function lastUserContent(prompt) {
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    if (prompt[i].role === 'user') return prompt[i].content;
  }
  return undefined;
}

test('[show_timestamps=false 回退] ## Current Time 前置到最后一条 user 且排在用户原话之前', async () => {
  const prompt = await assemblePrompt(
    baseCharacter(),
    [message({ id: 'u1', content: '宝宝，中午想吃什么' })],
    baseSettings(),
    MEMORY_TEXT,
    timeAt(57),
  );

  assert.equal(prompt[0].role, 'system');
  assert.doesNotMatch(prompt[0].content, /Current Time/, 'system 里不得再出现 Current Time');

  const tail = lastUserContent(prompt);
  assert.match(tail, /## Current Time/);
  assert.match(tail, /10:57/, '应使用 Asia/Tokyo 的墙上时间');
  assert.ok(
    tail.indexOf('## Current Time') < tail.indexOf('宝宝，中午想吃什么'),
    '尾部块必须排在用户原话之前',
  );
  assert.ok(tail.endsWith('宝宝，中午想吃什么'), '用户原话必须是最后一段');
});

test('[show_timestamps=false 回退] 时间变化不改动 system——两轮 system 逐字节相同', async () => {
  const character = baseCharacter();
  const settings = baseSettings();
  const settled = [
    message({ id: 'u1', content: '第一轮提问', created_at: '2026-08-30T01:40:00.000Z' }),
    message({ id: 'a1', role: 'assistant', content: '第一轮回答', created_at: '2026-08-30T01:41:00.000Z' }),
  ];
  const u2 = message({ id: 'u2', content: '第二轮提问', created_at: '2026-08-30T01:50:00.000Z' });

  // turnA：用户发出 u2；turnB：a2 落库后用户又发 u3
  const turnA = await assemblePrompt(character, [...settled, u2], settings, MEMORY_TEXT, timeAt(57));
  const turnB = await assemblePrompt(
    character,
    [
      ...settled,
      u2,
      message({ id: 'a2', role: 'assistant', content: '第二轮回答', created_at: '2026-08-30T01:51:00.000Z' }),
      message({ id: 'u3', content: '第三轮提问', created_at: '2026-08-30T01:58:00.000Z' }),
    ],
    settings,
    MEMORY_TEXT,
    timeAt(58),
  );

  assert.equal(turnA[0].content, turnB[0].content, 'system 必须逐字节相同（含记忆包）');
  assert.match(turnA[0].content, /用户不爱吃甜的/, 'full 记忆包应留在 system');

  // 上一轮的最后一条 user 之前的历史必须逐字节不变
  for (let i = 1; i < turnA.length - 1; i += 1) {
    assert.deepEqual(turnA[i], turnB[i], `历史第 ${i} 条被改写了`);
  }

  // 已知且可接受的唯一分歧：上一轮的最后一条 user 在下一轮不再带尾部块。
  // 它离请求体末端只有 3 条消息，代价很小；但若哪天变成整段重写，这里会立刻红。
  const prevLastUser = turnA.length - 1;
  assert.equal(turnB[prevLastUser].content, '第二轮提问');
  assert.ok(
    turnA[prevLastUser].content.endsWith('\n\n第二轮提问'),
    '上一轮最后一条 user 与下一轮的差异必须仅限于前置的尾部块',
  );
});

test('[show_timestamps=false 回退] 检索记忆包移出 system，排在 Current Time 之前', async () => {
  const prompt = await assemblePrompt(
    baseCharacter(),
    [message({ id: 'u1', content: '今天过得怎么样' })],
    baseSettings(),
    MEMORY_TEXT,
    timeAt(57),
    false,
  );

  assert.doesNotMatch(prompt[0].content, /用户不爱吃甜的/, '检索模式的记忆包不得留在 system');
  assert.doesNotMatch(prompt[0].content, /Current Time/);

  const tail = lastUserContent(prompt);
  assert.match(tail, /用户不爱吃甜的/);
  assert.ok(
    tail.indexOf('用户不爱吃甜的') < tail.indexOf('## Current Time'),
    '记忆包应排在 Current Time 之前',
  );
  assert.ok(tail.endsWith('今天过得怎么样'));
});

test('尾部块计入历史预算——记忆包换位置不改变保留的历史条数', async () => {
  const character = baseCharacter();
  const bigMemory = `## 记忆上下文\n\n### 本轮相关回忆\n- ${'记忆细节 '.repeat(300)}`;
  const messages = [
    message({ id: 'u1', content: `旧消息 ${'内容 '.repeat(200)}`, token_count: null, created_at: '2026-08-30T01:40:00.000Z' }),
    message({ id: 'a1', role: 'assistant', content: `旧回答 ${'内容 '.repeat(200)}`, token_count: null, created_at: '2026-08-30T01:41:00.000Z' }),
    message({ id: 'u2', content: '最新提问', token_count: null, created_at: '2026-08-30T01:50:00.000Z' }),
  ];
  // 窗口收紧到只够放下一部分历史，让预算基数的差异能体现出来
  const settings = baseSettings({ context_window: 2200, max_tokens: 100 });

  const stable = await assemblePrompt(character, messages, settings, bigMemory, timeAt(57), true);
  const volatile = await assemblePrompt(character, messages, settings, bigMemory, timeAt(57), false);

  const ids = prompt => prompt.slice(1).map(m => m.role).join(',');
  assert.equal(
    ids(volatile),
    ids(stable),
    '尾部块若没计入 baseTokens，volatile 侧会因为基数偏小而多留历史',
  );
});

test('尾部块前置到多模态 user 的 text part，图片顺序不变', async () => {
  const prompt = await assemblePrompt(
    baseCharacter(),
    [message({
      id: 'u1',
      content: '看看这张图',
      metadata: {
        attachments: [{ type: 'image', name: 'tiny.png', url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
      },
    })],
    baseSettings(),
    MEMORY_TEXT,
    timeAt(57),
  );

  const tail = lastUserContent(prompt);
  assert.ok(Array.isArray(tail), '带图片时 content 必须仍是多模态数组');
  assert.equal(tail[0].type, 'text');
  assert.match(tail[0].text, /## Current Time/);
  assert.ok(tail[0].text.indexOf('## Current Time') < tail[0].text.indexOf('看看这张图'));
  assert.ok(tail.some(part => part.type === 'image_url'), '图片 part 不得被丢掉');
});

test('[show_timestamps=false 回退] 没有 user 消息时尾部块追加成独立 user，不被静默丢弃', async () => {
  const prompt = await assemblePrompt(
    baseCharacter(),
    [message({ id: 'a1', role: 'assistant', content: '只有一条开场白' })],
    baseSettings(),
    '',
    timeAt(57),
  );

  const last = prompt[prompt.length - 1];
  assert.equal(last.role, 'user');
  assert.match(last.content, /## Current Time/);
});

test('没有 timeContext 且记忆包稳定时不产生尾部块', async () => {
  const prompt = await assemblePrompt(
    baseCharacter(),
    [message({ id: 'u1', content: '只有用户原话' })],
    baseSettings(),
    MEMORY_TEXT,
  );

  assert.equal(lastUserContent(prompt), '只有用户原话');
  assert.match(prompt[0].content, /用户不爱吃甜的/);
});

// ── 主路径（show_timestamps=true）：历史之后不得有任何逐轮变化的内容 ──────────────
// 网关只有 4 个 cache_control 名额，全被「计费块 / agent 块 / 搬家后的调用方 system /
// 最后一条消息」占满，历史末尾拿不到断点。所以命中的唯一条件是：
//   第 N 轮的完整消息数组，必须是第 N+1 轮的严格前缀。
// 实测：留任何一样在最后一条 user 上（时间 60 tok 或生图指令 324 tok），命中率都从 ~99% 掉到 62%。

function stampedSettings(overrides = {}) {
  return baseSettings({ show_timestamps: true, ...overrides });
}

const IMAGE_ON = { enabled: true, inline_prompt: true };

test('show_timestamps 打开时，时间说明进 system 且不含具体时刻', async () => {
  const prompt = await assemblePrompt(
    baseCharacter(),
    [message({ id: 'u1', content: '现在几点了', created_at: '2026-08-30T01:50:00.000Z' })],
    stampedSettings(),
    MEMORY_TEXT,
    timeAt(57),
  );

  assert.match(prompt[0].content, /## Current Time/, '时间说明必须在 system 里');
  assert.match(prompt[0].content, /Asia\/Tokyo/);
  assert.doesNotMatch(prompt[0].content, /10:57/, 'system 里不得写入具体时刻，否则每轮都变');
  // 具体时间由消息自带的时间戳前缀承载
  assert.match(lastUserContent(prompt), /\[2026-08-30 Sun \d\d:\d\d\]/);
});

test('完整生图指令挂最后一条 user，system 只留短提醒', async () => {
  const character = baseCharacter({ image_tags: 'shinosawa hiro, silver hair' });
  const prompt = await assemblePrompt(
    character,
    [message({ id: 'u1', content: '陪我聊聊天' })],
    stampedSettings({ image_gen: IMAGE_ON }),
    MEMORY_TEXT,
    timeAt(57),
  );

  assert.match(prompt[0].content, /\[IMG\]\.\.\.\[\/IMG\]/, 'system 只留短提醒，字节稳定');
  assert.doesNotMatch(prompt[0].content, /（系统附加要求，务必执行/, '完整写法不得进 system，否则被角色长人设压掉');
  assert.match(lastUserContent(prompt), /系统附加要求/, '完整生图指令必须挂在最后一条 user 上');
  assert.match(lastUserContent(prompt), /shinosawa hiro/, '固定外貌标签应随完整指令一起挂在 user 上');
  assert.match(lastUserContent(prompt), /陪我聊聊天/);
});

test('inline_prompt_position=system 时完整指令进 system，user 不再被追加', async () => {
  const character = baseCharacter({ image_tags: 'shinosawa hiro, silver hair' });
  const prompt = await assemblePrompt(
    character,
    [message({ id: 'u1', content: '陪我聊聊天' })],
    stampedSettings({ image_gen: { enabled: true, inline_prompt: true, inline_prompt_position: 'system' } }),
    MEMORY_TEXT,
    timeAt(57),
  );

  assert.match(prompt[0].content, /系统附加要求，务必执行/, '完整写法应进 system');
  assert.match(prompt[0].content, /shinosawa hiro/, '固定外貌标签随完整指令一起进 system');
  assert.doesNotMatch(lastUserContent(prompt), /系统附加要求/, 'system 模式下 last user 不再被追加指令');
  assert.match(lastUserContent(prompt), /陪我聊聊天/, '用户原话保持干净');
});

test('核心：相同 full 记忆时第 N 轮是第 N+1 轮的严格前缀（续聊命中的条件）', async () => {
  const character = baseCharacter({ image_tags: 'shinosawa hiro' });
  const settings = stampedSettings();
  const settled = [
    message({ id: 'u1', content: '第一轮提问', created_at: '2026-08-30T01:40:00.000Z' }),
    message({ id: 'a1', role: 'assistant', content: '第一轮回答', created_at: '2026-08-30T01:41:00.000Z' }),
    message({ id: 'u2', content: '第二轮提问', created_at: '2026-08-30T01:50:00.000Z' }),
  ];

  const turnA = await assemblePrompt(character, settled, settings, MEMORY_TEXT, timeAt(57));
  const turnB = await assemblePrompt(
    character,
    [
      ...settled,
      message({ id: 'a2', role: 'assistant', content: '第二轮回答', created_at: '2026-08-30T01:51:00.000Z' }),
      message({ id: 'u3', content: '第三轮提问', created_at: '2026-08-30T01:58:00.000Z' }),
    ],
    settings,
    MEMORY_TEXT,
    timeAt(58),
  );

  assert.ok(turnB.length > turnA.length, '续聊应当只是追加消息');
  for (let i = 0; i < turnA.length; i += 1) {
    assert.deepEqual(
      turnA[i], turnB[i],
      `messages[${i}] 在下一轮被改写了——续聊前缀被打断`,
    );
  }
  assert.match(turnA[0].content, /用户不爱吃甜的/, 'full 记忆必须在 system 前缀里');
});

test('开启内联生图时，续聊会改写上一轮最后一条 user（完整指令挂在那里）', async () => {
  const character = baseCharacter({ image_tags: 'shinosawa hiro' });
  const settings = stampedSettings({ image_gen: IMAGE_ON });
  const settled = [
    message({ id: 'u1', content: '第一轮提问', created_at: '2026-08-30T01:40:00.000Z' }),
    message({ id: 'a1', role: 'assistant', content: '第一轮回答', created_at: '2026-08-30T01:41:00.000Z' }),
    message({ id: 'u2', content: '第二轮提问', created_at: '2026-08-30T01:50:00.000Z' }),
  ];

  const turnA = await assemblePrompt(character, settled, settings, MEMORY_TEXT, timeAt(57));
  const turnB = await assemblePrompt(
    character,
    [
      ...settled,
      message({ id: 'a2', role: 'assistant', content: '第二轮回答', created_at: '2026-08-30T01:51:00.000Z' }),
      message({ id: 'u3', content: '第三轮提问', created_at: '2026-08-30T01:58:00.000Z' }),
    ],
    settings,
    MEMORY_TEXT,
    timeAt(58),
  );

  assert.equal(turnA[0].content, turnB[0].content, 'system 短提醒必须逐字节稳定');
  assert.match(turnA[0].content, /\[IMG\]\.\.\.\[\/IMG\]/);
  assert.notEqual(
    turnA[turnA.length - 1].content,
    turnB[turnA.length - 1].content,
    '上一轮 last user 卸下完整指令，这是内联生图压过角色人设的已知缓存代价',
  );
  assert.match(turnB[turnB.length - 1].content, /系统附加要求/);
});

test('full 记忆包变化时首差落在 system（把记忆放进前缀的固有代价）', async () => {
  const character = baseCharacter();
  const settings = stampedSettings();
  const settled = [
    message({ id: 'u1', content: '第一轮提问', created_at: '2026-08-30T01:40:00.000Z' }),
    message({ id: 'a1', role: 'assistant', content: '第一轮回答', created_at: '2026-08-30T01:41:00.000Z' }),
    message({ id: 'u2', content: '第二轮提问', created_at: '2026-08-30T01:50:00.000Z' }),
  ];

  const turnA = await assemblePrompt(character, settled, settings, MEMORY_TEXT, timeAt(57));
  const turnB = await assemblePrompt(
    character,
    [
      ...settled,
      message({ id: 'a2', role: 'assistant', content: '第二轮回答', created_at: '2026-08-30T01:51:00.000Z' }),
      message({ id: 'u3', content: '第三轮提问', created_at: '2026-08-30T01:58:00.000Z' }),
    ],
    settings,
    MEMORY_TEXT_AFTER_EXTRACT,
    timeAt(58),
  );

  assert.notEqual(turnA[0].content, turnB[0].content);
  assert.match(turnA[0].content, /用户不爱吃甜的/);
  assert.doesNotMatch(turnA[0].content, /用户开始学做甜点/);
  assert.match(turnB[0].content, /用户开始学做甜点/);
});

test('检索模式的记忆包仍会打破前缀（该配置的已知上限）', async () => {
  const character = baseCharacter();
  const settings = stampedSettings();
  const settled = [
    message({ id: 'u1', content: '第一轮提问', created_at: '2026-08-30T01:40:00.000Z' }),
    message({ id: 'a1', role: 'assistant', content: '第一轮回答', created_at: '2026-08-30T01:41:00.000Z' }),
    message({ id: 'u2', content: '第二轮提问', created_at: '2026-08-30T01:50:00.000Z' }),
  ];

  const turnA = await assemblePrompt(character, settled, settings, MEMORY_TEXT, timeAt(57), false);
  const turnB = await assemblePrompt(
    character,
    [
      ...settled,
      message({ id: 'a2', role: 'assistant', content: '第二轮回答', created_at: '2026-08-30T01:51:00.000Z' }),
      message({ id: 'u3', content: '第三轮提问', created_at: '2026-08-30T01:58:00.000Z' }),
    ],
    settings,
    MEMORY_TEXT,
    timeAt(58),
    false,
  );

  assert.notDeepEqual(turnA.at(-1), turnB[turnA.length - 1]);
  assert.equal(turnA[0].content, turnB[0].content, 'system 仍必须逐字节稳定');
});
