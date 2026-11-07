// 示例对话必须作为 system 里一段带标注的文本发送，不能拆成 user/assistant 轮次。
// 拆成轮次时模型会把示例当成本次对话已经发生的内容；示例最后一条 {{char}} 还会和开场白
// （第一条 assistant 消息）被 mergeConsecutiveRoles 合成同一条，示例和正式对话失去边界。

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { assemblePrompt, renderExampleDialogue } = require('../src/lib/chat-engine.ts');

const EXAMPLES = [
  '{{user}}: 都结婚一年了，你还这么看我？',
  '{{char}}: *他没移开目光。* 今晚还想多看一会儿。',
  '',
  '{{user}}：先放开，坐旁边陪我就行，别碰我。',
  '{{char}}：*他松开手。* 好，陪你。',
].join('\n');

const GREETING = '*裴峥在你对面坐下。* 裴太太，今晚的时间能分我一点？';

function character(overrides = {}) {
  return {
    id: 'char-example',
    name: '裴峥',
    avatar_url: null,
    basic_info: '沉湾艺术空间负责人。',
    personality: '沉稳、自信。',
    scenario: '雨夜的咖啡馆。',
    greeting: GREETING,
    example_dialogue: EXAMPLES,
    system_prompt: '',
    other_info: '下面每组示例均为独立风格示范。',
    image_tags: '',
    user_image_tags: '',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function settings(overrides = {}) {
  return {
    context_window: 1000000,
    max_tokens: 12800,
    example_dialogue: true,
    memory_inject: true,
    show_timestamps: false,
    ...overrides,
  };
}

function message(overrides) {
  return {
    conversation_id: 'conv-example',
    token_count: 1,
    created_at: '2026-11-01T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

const HISTORY = [
  message({ id: 'greeting', role: 'assistant', content: GREETING }),
  message({ id: 'u1', role: 'user', content: '分' }),
];

test('示例对话进入 system 的标注段落，请求里没有示例轮次', async () => {
  const prompt = await assemblePrompt(character(), HISTORY, settings(), '');

  assert.deepEqual(prompt.map(m => m.role), ['system', 'assistant', 'user']);

  const system = prompt[0].content;
  assert.match(system, /## 示例对话/);
  assert.match(system, /不是本次对话中已经发生的内容/);
  assert.match(system, /<example_dialogue>\n用户: 都结婚一年了/);
  assert.match(system, /裴峥：\*他松开手。\* 好，陪你。\n<\/example_dialogue>/);
  assert.doesNotMatch(system, /\{\{(user|char)\}\}/);

  assert.ok(system.indexOf('## 其他补充信息') < system.indexOf('## 示例对话'), '示例应排在 other_info 之后');
  assert.ok(system.indexOf('## 示例对话') < system.indexOf('## 行为要求'), '示例应排在行为要求之前');
});

test('开场白保持为独立的 assistant 消息，不与示例合并', async () => {
  const prompt = await assemblePrompt(character(), HISTORY, settings(), '');

  assert.equal(prompt[1].content, GREETING);
  for (const m of prompt.slice(1)) {
    assert.doesNotMatch(String(m.content), /好，陪你|多看一会儿/);
  }
});

test('关闭示例对话开关时 system 不含示例段落', async () => {
  const prompt = await assemblePrompt(character(), HISTORY, settings({ example_dialogue: false }), '');

  assert.doesNotMatch(prompt[0].content, /示例对话|example_dialogue/);
  assert.deepEqual(prompt.map(m => m.role), ['system', 'assistant', 'user']);
});

test('renderExampleDialogue 保留多行内容，<START> 转为分组空行，宏不区分大小写', () => {
  const rendered = renderExampleDialogue(
    '<START>\r\n{{User}}: 你想喝什么？\r\n{{CHAR}}: 热拿铁。\r\n还没点。\r\n<START>\r\n\r\n{{user}}: 行\r\n{{char}}: 那换我问你。',
    '裴峥',
  );

  assert.match(
    rendered,
    /<example_dialogue>\n用户: 你想喝什么？\n裴峥: 热拿铁。\n还没点。\n\n用户: 行\n裴峥: 那换我问你。\n<\/example_dialogue>$/,
  );
  assert.doesNotMatch(rendered, /<START>/i);
});

test('renderExampleDialogue 对空白内容返回空串，角色名为空时用通用称呼', () => {
  assert.equal(renderExampleDialogue('  \n<START>\n ', '裴峥'), '');
  assert.match(renderExampleDialogue('{{char}}: 你好', ''), /角色: 你好/);
});
