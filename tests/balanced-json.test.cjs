const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const {
  extractBalancedJsonAt,
  findFirstBalancedJson,
} = require(path.resolve(__dirname, '../src/lib/balanced-json.ts'));

test('balanced JSON extraction ignores braces, brackets, escaped quotes, and backslashes inside strings', () => {
  const expected = {
    message: 'literal } ] and " quote',
    nested: { items: [1, { path: 'C:\\tmp\\file' }] },
  };
  const fixture = `prefix ${JSON.stringify(expected)} suffix`;
  const start = fixture.indexOf('{');
  const snippet = extractBalancedJsonAt(fixture, start);

  assert.ok(snippet);
  assert.deepEqual(JSON.parse(snippet), expected);
});

test('balanced JSON extraction selects the requested root and stops at the first complete value', () => {
  const text = 'explanation [1,{"value":"[still text]"}] between {"second":true} trailing';

  assert.equal(findFirstBalancedJson(text, 'array'), '[1,{"value":"[still text]"}]');
  assert.equal(findFirstBalancedJson(text, 'object'), '{"value":"[still text]"}');
  assert.equal(findFirstBalancedJson(text, 'object', text.indexOf('between')), '{"second":true}');
});

test('balanced JSON extraction rejects mismatched or unterminated structures', () => {
  assert.equal(extractBalancedJsonAt('{"items":[1,2}', 0), null);
  assert.equal(extractBalancedJsonAt('{"text":"unterminated}', 0), null);
  assert.equal(findFirstBalancedJson('plain prose only'), null);
});
