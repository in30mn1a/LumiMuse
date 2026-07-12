const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const modulePath = path.resolve(__dirname, '../src/lib/inline-image-prompt.ts');
const { extractInlinePrompt, stripInlinePrompt } = require(modulePath);

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
