const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { splitByHighlightRanges } = require(path.resolve(__dirname, '../src/lib/text-highlight.ts'));

const joined = segments => segments.map(segment => segment.text).join('');
const matched = segments => segments.filter(segment => segment.isMatch).map(segment => segment.text);

test('splits text around every exact backend highlight range', () => {
  const text = '猫娘在窗边，猫娘在打盹';
  const segments = splitByHighlightRanges(text, [
    { start: 0, end: 2, text: '猫娘' },
    { start: 6, end: 8, text: '猫娘' },
  ]);

  assert.deepEqual(segments, [
    { text: '猫娘', isMatch: true },
    { text: '在窗边，', isMatch: false },
    { text: '猫娘', isMatch: true },
    { text: '在打盹', isMatch: false },
  ]);
});

test('uses exact unicode61 diacritic ranges reported by FTS5', () => {
  const text = 'We met at café Lumi.';
  const segments = splitByHighlightRanges(text, [{ start: 10, end: 14, text: 'café' }]);
  assert.deepEqual(matched(segments), ['café']);
  assert.equal(joined(segments), text);
});

test('uses the exact FTS phrase range without highlighting unrelated equal tokens', () => {
  const text = 'hello there; hello, world today';
  const segments = splitByHighlightRanges(text, [{ start: 13, end: 25, text: 'hello, world' }]);
  assert.deepEqual(matched(segments), ['hello, world']);
  assert.equal(joined(segments), text);
});

test('uses complete source-token ranges reported for an FTS prefix query', () => {
  const text = 'help helper shell';
  const segments = splitByHighlightRanges(text, [
    { start: 0, end: 4, text: 'help' },
    { start: 5, end: 11, text: 'helper' },
  ]);
  assert.deepEqual(matched(segments), ['help', 'helper']);
  assert.equal(joined(segments), text);
});

test('ignores stale ranges whose text no longer matches an edited message', () => {
  const text = 'edited body';
  const segments = splitByHighlightRanges(text, [{ start: 0, end: 4, text: 'old!' }]);
  assert.deepEqual(segments, [{ text, isMatch: false }]);
});

test('ignores invalid, overlapping, and out-of-bounds ranges without changing content', () => {
  const text = '0123456789';
  const segments = splitByHighlightRanges(text, [
    { start: -1, end: 2, text: '01' },
    { start: 2, end: 5, text: '234' },
    { start: 4, end: 6, text: '45' },
    { start: 9, end: 11, text: '9' },
  ]);

  assert.deepEqual(matched(segments), ['234']);
  assert.equal(joined(segments), text);
});

test('returns one unmatched segment when ranges are empty', () => {
  assert.deepEqual(splitByHighlightRanges('正文', []), [{ text: '正文', isMatch: false }]);
});

test('never drops or duplicates content', () => {
  const text = 'abc keyword def keyword';
  const segments = splitByHighlightRanges(text, [
    { start: 4, end: 11, text: 'keyword' },
    { start: 16, end: 23, text: 'keyword' },
  ]);
  assert.equal(joined(segments), text);
});
