const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const modulePath = path.resolve(__dirname, '../src/lib/inline-image-prompt.ts');
const { buildInlinePromptInstruction, extractInlinePrompt, stripInlinePrompt } = require(modulePath);
const { IMAGE_PROMPT_POV_POLICY } = require('../src/lib/image-prompt-instructions.ts');

test('all inline image styles use the same POV policy', () => {
  for (const style of ['danbooru', 'nai-v5']) {
    const instruction = buildInlinePromptInstruction('silver hair', 'black hair', style);
    assert.equal(instruction.split(IMAGE_PROMPT_POV_POLICY).length - 1, 1);
    assert.doesNotMatch(instruction, /可以在亲密互动时适当使用\s*POV/);
  }
});

test('inline image prompt makes full user tags conditional on third-person presence', () => {
  const instruction = buildInlinePromptInstruction(
    '1girl, silver hair, blue eyes',
    '1boy, black hair, glasses',
  );

  assert.match(instruction, /\[IMG\]/);
  assert.match(instruction, /不算跳出角色/);
  assert.match(instruction, /仅当用户以第三人称完整出场时，需包含用户外貌标签：1boy, black hair, glasses/);
  assert.match(instruction, /POV 时用户是镜头.*只能从用户外貌标签中选取画面内可见部位的特征（如 the viewer's hands）/);
  assert.match(instruction, /用户未出场时不得包含任何用户外貌标签/);
  assert.match(instruction, /固定外貌标签：1girl, silver hair, blue eyes/);
});

test('both inline image styles exclude the full user slot in POV', () => {
  for (const style of ['danbooru', 'nai-v5']) {
    const instruction = buildInlinePromptInstruction(
      '1girl, silver hair',
      '1boy, black hair, glasses',
      style,
    );
    assert.match(instruction, /仅当用户以第三人称完整出场.*用户外貌标签：1boy, black hair, glasses/);
    assert.match(instruction, /POV 时用户是镜头.*the viewer's hands/);
  }
});

test('inline image requirements preserve multiline content and empty values keep the old instruction', () => {
  const requirements = '  保留窗边的构图。\n使用柔和侧光。  ';
  for (const style of ['danbooru', 'nai-v5']) {
    const original = buildInlinePromptInstruction('silver hair', 'black hair', style);
    for (const empty of ['', ' \n\t ']) {
      assert.equal(buildInlinePromptInstruction('silver hair', 'black hair', style, empty), original);
    }
    const instruction = buildInlinePromptInstruction('silver hair', 'black hair', style, requirements);
    assert.ok(instruction.startsWith(original));
    assert.ok(instruction.endsWith(requirements));
    assert.match(instruction, /仅用于 \[IMG\] 内的提示词，不写入角色对话正文/);
  }
});

test('inline image prompt extracts a case-insensitive multiline block and strips it from the reply', () => {
  const text = '今晚一起看雨吧。\n[img]\n1girl, blue hair, rainy window\n[/IMG]   ';

  assert.equal(extractInlinePrompt(text), '1girl, blue hair, rainy window');
  assert.equal(stripInlinePrompt(text), '今晚一起看雨吧。');
});

test('inline image prompt leaves a reply without a block intact except existing trailing trim behavior', () => {
  assert.equal(extractInlinePrompt('只是普通回复。   '), '');
  assert.equal(stripInlinePrompt('只是普通回复。   '), '只是普通回复。');
});

test('inline image prompt hides an unclosed streaming tail without inventing a prompt', () => {
  const text = '正文已经完成。\n[IMG]1girl, blue hair';

  assert.equal(extractInlinePrompt(text), '');
  assert.equal(stripInlinePrompt(text), '正文已经完成。');
  assert.equal(stripInlinePrompt('正文[/IMG]'), '正文[/IMG]');
});

test('multiple inline image blocks use the last one and are all stripped', () => {
  const text = '正文\n[IMG]first, prompt[/IMG]\n补充\n[IMG]second, prompt[/IMG]';

  assert.equal(extractInlinePrompt(text), 'second, prompt');
  assert.equal(stripInlinePrompt(text), '正文\n\n补充');
});

test('a placeholder block echoed while thinking does not displace the real prompt', () => {
  const real = '[IMG]\nPrompt: 1girl, 1boy, indoor\nCharacter 1: girl, long hair\n[/IMG]';
  for (const echo of ['[IMG]...[/IMG]', '[IMG]…[/IMG]', '[img] ... [/img]', '[IMG]……[/IMG]']) {
    const text = `末尾要输出一次 ${echo} 生图提示词。\n正文。\n${real}`;

    assert.equal(extractInlinePrompt(text), 'Prompt: 1girl, 1boy, indoor\nCharacter 1: girl, long hair');
    assert.equal(stripInlinePrompt(text), '末尾要输出一次  生图提示词。\n正文。');
  }
});

test('a placeholder block is never a prompt, wherever it appears', () => {
  assert.equal(extractInlinePrompt('正文。\n[IMG]...[/IMG]'), '');
  assert.equal(stripInlinePrompt('正文。\n[IMG]...[/IMG]'), '正文。');
  assert.equal(extractInlinePrompt('[IMG]1girl, rain[/IMG]\n别忘了 [IMG]...[/IMG]'), '1girl, rain');
});

test('a bare [IMG] mention neither pairs with the real close marker nor swallows the body', () => {
  const text = '最后要补上 [IMG] 提示词。\n正文。\n[IMG]1girl, rain[/IMG]';

  assert.equal(extractInlinePrompt(text), '1girl, rain');
  assert.equal(stripInlinePrompt(text), '最后要补上 [IMG] 提示词。\n正文。');
});

test('an unclosed tail after a closed block is still hidden while streaming', () => {
  assert.equal(stripInlinePrompt('正文。\n[IMG]...[/IMG]\n后文\n[IMG]1girl, ra'), '正文。\n\n后文');
});

test('chat-engine wires sensitive tag strip/rejoin for inline prompts on all models', () => {
  const fs = require('node:fs');
  const chatEngine = fs.readFileSync(
    path.resolve(__dirname, '../src/lib/chat-engine.ts'),
    'utf8',
  );
  assert.match(chatEngine, /prepareImageTagsForLlm\(character\.image_tags\)/);
  // 角色与用户的敏感 tag 必须分开传，V5 结构化提示词才不会把用户外貌塞进 Character 1
  assert.match(
    chatEngine,
    /restoreSensitiveImageTagsToPrompt\(\s*rawInlinePrompt,\s*options\.characterImageTags,\s*options\.userImageTags,\s*\)/,
  );
  assert.match(
    chatEngine,
    /characterImageTags:\s*character\.image_tags/,
  );
});
