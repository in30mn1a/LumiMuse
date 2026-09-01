const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const modulePath = path.resolve(__dirname, '../src/lib/inline-image-prompt.ts');
const { buildInlinePromptInstruction, extractInlinePrompt, stripInlinePrompt } = require(modulePath);

test('inline image prompt keeps non-intimate scenes user-free without forcing a solo scene', () => {
  const instruction = buildInlinePromptInstruction(
    '1girl, silver hair, blue eyes',
    '1boy, black hair, glasses',
  );

  assert.match(instruction, /\[IMG\]/);
  assert.match(instruction, /不算跳出角色/);
  assert.match(instruction, /不是角色与用户的亲密互动/);
  assert.match(instruction, /不得包含任何用户外貌标签/);
  assert.match(instruction, /只包含角色的单人\/多人场景/);
  assert.doesNotMatch(instruction, /只包含角色的单人场景/);
  assert.match(instruction, /亲密互动.*用户外貌标签：1boy, black hair, glasses/);
  assert.match(instruction, /固定外貌标签：1girl, silver hair, blue eyes/);
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

test('multiple inline image blocks keep the current first-block-only behavior', () => {
  const text = '正文\n[IMG]first, prompt[/IMG]\n补充\n[IMG]second, prompt[/IMG]';

  assert.equal(extractInlinePrompt(text), 'first, prompt');
  assert.equal(stripInlinePrompt(text), '正文\n\n补充\n[IMG]second, prompt[/IMG]');
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
