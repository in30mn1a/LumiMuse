const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const {
  normalizeCharacterTaskModels,
  serializeReasoningMap,
  loadCharacterTaskModels,
} = require(path.resolve(__dirname, '../src/lib/character-task-models.ts'));

test('normalizeCharacterTaskModels accepts stored JSON strings and drops invalid efforts', () => {
  const fields = normalizeCharacterTaskModels({
    background_model: 'extract-model',
    image_prompt_model: '  ',
    background_reasoning_by_model: JSON.stringify({
      'extract-model': 'high',
      bad: 'nope',
      __proto__: 'max',
    }),
    image_prompt_reasoning_by_model: { 'draw-model': 'low' },
  });

  assert.equal(fields.background_model, 'extract-model');
  assert.equal(fields.image_prompt_model, '  ');
  assert.deepEqual(fields.background_reasoning_by_model, { 'extract-model': 'high' });
  assert.deepEqual(fields.image_prompt_reasoning_by_model, { 'draw-model': 'low' });
  assert.equal(serializeReasoningMap(fields.background_reasoning_by_model), '{"extract-model":"high"}');
});

test('loadCharacterTaskModels falls back when the columns are not migrated yet', () => {
  const db = {
    prepare() {
      return {
        get() {
          const error = new Error('no such column: background_model');
          throw error;
        },
      };
    },
  };

  assert.deepEqual(loadCharacterTaskModels(db, 'char-a'), {
    background_model: '',
    image_prompt_model: '',
    background_reasoning_by_model: {},
    image_prompt_reasoning_by_model: {},
  });
});
