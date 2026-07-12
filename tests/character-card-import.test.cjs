const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { normalizeCharacterCard } = require(path.resolve(__dirname, '../src/lib/character-card-import.ts'));

test('normalizeCharacterCard maps a real v2 card and normalizes optional fields', () => {
  const draft = normalizeCharacterCard({
    spec: 'chara_card_v2',
    data: {
      name: '露米',
      description: '月光图书馆记录员',
      creator: 'fixture-author',
      character_version: '1.2',
      personality: '安静、敏锐',
      scenario: '深夜图书馆',
      first_mes: '你终于来了。',
      mes_example: '用户：你好\n露米：晚上好',
      post_history_instructions: '保持沉浸。',
      creator_notes: '边界 fixture',
      tags: [' librarian ', 7, '', 'moonlight'],
      avatar_url: '/cards/lumi.png',
    },
  });

  assert.ok(draft);
  assert.equal(draft.name, '露米');
  assert.equal(draft.avatar_url, '/cards/lumi.png');
  assert.equal(draft.greeting, '你终于来了。');
  assert.equal(draft.image_tags, ' librarian , moonlight');
  assert.equal(draft.user_image_tags, '');
  assert.match(draft.basic_info, /【版本】\n1.2/);
  assert.match(draft.other_info, /【作者备注】\n边界 fixture/);
});

test('normalizeCharacterCard rejects arrays and nameless cards', () => {
  assert.equal(normalizeCharacterCard([]), null);
  assert.equal(normalizeCharacterCard({ data: { description: 'missing name' } }), null);
});
