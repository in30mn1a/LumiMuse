const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const {
  isReasoningEffort,
  sanitizeReasoningEffortByModel,
  resolveReasoningEffortForModel,
  rememberReasoningEffortForModel,
  planModelReasoningSwitch,
} = require('../src/lib/reasoning-effort.ts');

test('isReasoningEffort accepts only known effort values', () => {
  assert.equal(isReasoningEffort('default'), true);
  assert.equal(isReasoningEffort('high'), true);
  assert.equal(isReasoningEffort('max'), true);
  assert.equal(isReasoningEffort('extreme'), false);
  assert.equal(isReasoningEffort(''), false);
  assert.equal(isReasoningEffort(null), false);
});

test('sanitizeReasoningEffortByModel drops invalid keys and values', () => {
  assert.deepEqual(sanitizeReasoningEffortByModel(null), {});
  assert.deepEqual(sanitizeReasoningEffortByModel(['high']), {});
  assert.deepEqual(sanitizeReasoningEffortByModel({
    'gpt-5': 'high',
    '  ': 'low',
    bad: 'extreme',
    'ok-model': 'default',
  }), {
    'gpt-5': 'high',
    'ok-model': 'default',
  });
});

test('resolveReasoningEffortForModel falls back when a model has no memory', () => {
  assert.equal(resolveReasoningEffortForModel('a', { a: 'high' }), 'high');
  assert.equal(resolveReasoningEffortForModel('b', { a: 'high' }), 'default');
  assert.equal(resolveReasoningEffortForModel('b', { a: 'high' }, 'medium'), 'medium');
  assert.equal(resolveReasoningEffortForModel('', { a: 'high' }, 'low'), 'low');
});

test('rememberReasoningEffortForModel writes only when the model name is present', () => {
  const current = { a: 'high' };
  assert.equal(rememberReasoningEffortForModel(current, '', 'low'), current);
  assert.equal(rememberReasoningEffortForModel(current, 'a', 'high'), current);
  assert.deepEqual(rememberReasoningEffortForModel(current, 'a', 'low'), { a: 'low' });
  assert.deepEqual(rememberReasoningEffortForModel(current, 'b', 'medium'), { a: 'high', b: 'medium' });
});

test('planModelReasoningSwitch remembers the previous model and restores the next', () => {
  const planned = planModelReasoningSwitch({
    previousModel: 'alpha',
    previousEffort: 'high',
    nextModel: 'beta',
    byModel: { beta: 'low' },
  });

  assert.equal(planned.effort, 'low');
  assert.deepEqual(planned.byModel, { beta: 'low', alpha: 'high' });
});

test('planModelReasoningSwitch uses default when the next model has no memory', () => {
  const planned = planModelReasoningSwitch({
    previousModel: 'alpha',
    previousEffort: 'high',
    nextModel: 'gamma',
    byModel: {},
  });

  assert.equal(planned.effort, 'default');
  assert.deepEqual(planned.byModel, { alpha: 'high', gamma: 'default' });
});
