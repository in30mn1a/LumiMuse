const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();
const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { resolveMemoryIndexTarget } = require('../src/lib/memory-index-trigger.ts');

const RUNNABLE = {
  index_enabled: true,
  embedding_api_base: 'https://embedding.invalid/v1',
  embedding_model: ' embed-model ',
  embedding_dimension: 768,
};

function useSettings(t, memoryEngine) {
  const db = new Database(':memory:');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => { __setDbForTests(null); db.close(); });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('memory_engine', JSON.stringify(memoryEngine));
}

test('resolveMemoryIndexTarget reports the model and dimension the index queue embeds with', t => {
  useSettings(t, RUNNABLE);
  assert.deepEqual(resolveMemoryIndexTarget(), { provider: 'openai-compatible', model: 'embed-model', dimension: 768 });
});

test('resolveMemoryIndexTarget is null whenever the queue would not produce vectors', async t => {
  const cases = {
    'index disabled': { ...RUNNABLE, index_enabled: false },
    'no embedding model': { ...RUNNABLE, embedding_model: '  ' },
    'no embedding endpoint': { ...RUNNABLE, embedding_api_base: '' },
    'external payloads disallowed': { ...RUNNABLE, allow_external_memory_payloads: false },
  };
  for (const [name, memoryEngine] of Object.entries(cases)) {
    await t.test(name, subtest => {
      useSettings(subtest, memoryEngine);
      assert.equal(resolveMemoryIndexTarget(), null);
    });
  }
});
