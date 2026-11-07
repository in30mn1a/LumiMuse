const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');
registerTsLoader();
const {
  SHRINK_WARNING_RATIO,
  SOURCE_NOTE_PHRASES,
  contentFidelityIssues,
  contentShrink,
  extractQuotes,
  findMissingQuotes,
  findSourceNotePhrases,
  findUnfamiliarChars,
} = require('../src/lib/agent/content-fidelity.ts');

test('source-note phrases are caught unless the source text already had them', () => {
  assert.deepEqual([...SOURCE_NOTE_PHRASES], ['无原文依据', '批量导入', '早期记录', '无具体日期']);
  const sources = ['用户早上醒来会先抱抱我再起床。'];
  assert.deepEqual(
    findSourceNotePhrases('用户与我的日常习惯（早期记录，无具体日期）：早上醒来会先抱抱我再起床。', sources),
    ['早期记录', '无具体日期'],
  );
  assert.deepEqual(findSourceNotePhrases('用户的偏好（2026-05-11 批量导入条目，无原文来源可核）：喜欢甜点。', []), ['批量导入']);
  assert.deepEqual(findSourceNotePhrases('用户翻看早期记录时笑了。', ['用户翻看早期记录时笑了，说想重温。']), []);
  assert.deepEqual(findSourceNotePhrases('用户早上醒来会先抱抱我再起床。', sources), []);
});

test('quotes are compared without edge punctuation and only flagged when the words are gone', () => {
  assert.deepEqual(
    extractQuotes('用户睡前说“おやすみ、ルナちゃん。今日もありがとう。”，又叫我「小太阳」和『阿暖』，还说"ok"与「嗯」。'),
    ['おやすみ、ルナちゃん。今日もありがとう', '小太阳', '阿暖', 'ok'],
  );
  const sources = ['用户睡前说“おやすみ、ルナちゃん。今日もありがとう。”', '用户称我为「小太阳」。', '用户又说“おやすみ、ルナちゃん。今日もありがとう。”'];
  assert.deepEqual(findMissingQuotes('睡前会说「おやすみ、ルナちゃん。今日もありがとう」，称我为小太阳。', sources), []);
  assert.deepEqual(
    findMissingQuotes('睡前以「おやすみ、ルナちゃん」开头表达谢意，称我为「小太阳」。', sources),
    ['おやすみ、ルナちゃん。今日もありがとう'],
  );
  assert.deepEqual(findMissingQuotes('睡前用中文说晚安，谢谢我陪着他。', ['用户睡前说「晚安，谢谢你一直陪着我。」']), ['晚安，谢谢你一直陪着我']);
});

test('unfamiliar characters are new rare hanzi only, so a common wrong character slips through', () => {
  const sources = ['用户睡前向我撒娇，问我是否满足。'];
  assert.deepEqual(findUnfamiliarChars('睡前会撒嬻，问我是吾满足。', sources), ['嬻'], 'the decoder-built table must be available');
  assert.deepEqual(findUnfamiliarChars('睡前会撒嬻，问我是否满足。', ['用户撒嬻。']), [], 'characters already in the source are kept as they are');
  assert.deepEqual(findUnfamiliarChars('睡前会撒娇，偶尔嘟嘴，嘟嘟囔囔。', sources), ['嘟', '囔']);
  assert.deepEqual(findUnfamiliarChars('おやすみ、ルナちゃん。Good night.', []), []);
});

test('shrink is measured against the longest source and only past the threshold', () => {
  assert.equal(SHRINK_WARNING_RATIO, 0.3);
  const long = '甲'.repeat(100);
  assert.equal(contentShrink('乙'.repeat(71), [long]), null);
  assert.equal(contentShrink('乙'.repeat(70), [long]), null, 'exactly 30% shorter is still fine');
  assert.deepEqual(contentShrink('乙'.repeat(30), [long, '丙'.repeat(40)]), { before: 100, after: 30, percent: 70 });
  const astral = String.fromCodePoint(0x20000);
  assert.deepEqual(contentShrink(astral.repeat(10), [astral.repeat(20)]), { before: 20, after: 10, percent: 50 }, 'counts characters, not UTF-16 units');
  assert.equal(contentShrink('乙', []), null);
});

test('contentFidelityIssues bundles the card warnings and only checks length for update and merge', () => {
  assert.deepEqual(
    contentFidelityIssues('archive', '睡前会撒嬻，说「晚安」。', ['用户睡前向我撒娇，说“晚安，宝贝。”']),
    { missingQuotes: ['晚安，宝贝'], unfamiliarChars: ['嬻'], shrink: null },
  );
  const same = '用户睡前向我撒娇，说“晚安，宝贝。”';
  assert.deepEqual(contentFidelityIssues('update', same, [same]), { missingQuotes: [], unfamiliarChars: [], shrink: null });
  const source = `【学业】答辩在四月。${'【兴趣】喜欢读小说和看电影。'.repeat(6)}`;
  assert.deepEqual(contentFidelityIssues('update', '【学业】答辩在四月二十七日。', [source]).shrink, { before: [...source].length, after: 14, percent: 85 });
  assert.equal(contentFidelityIssues('archive', '【学业】答辩在四月二十七日。', [source]).shrink, null, 'summaries are expected to condense');
});
