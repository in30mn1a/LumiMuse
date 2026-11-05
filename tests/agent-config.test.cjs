const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { loadSettings, resolveAgentConfig } = require('../src/lib/settings.ts');
const { API_KEY_MASK } = require('../src/lib/constants.ts');

const MAIN_KEY = 'sk-main-fixture';
const AGENT_KEY = 'sk-agent-provider-fixture';

function setupDb(t, settings = {}) {
  const db = new Database(':memory:');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => {
    __setDbForTests(null);
    db.close();
  });
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries({
    api_base: 'https://main.test/v1',
    api_key: MAIN_KEY,
    model: 'main-model',
    active_provider_id: 'main-provider',
    ...settings,
  })) {
    upsert.run(key, JSON.stringify(value));
  }
  db.prepare(`
    INSERT INTO api_providers (id, name, api_base, api_key, model)
    VALUES ('agent-provider', 'Agent', 'https://agent.test/v1', ?, 'provider-default-model')
  `).run(AGENT_KEY);
  return db;
}

test('unconfigured agent falls back to the main provider and chat model', t => {
  setupDb(t);
  assert.deepEqual(resolveAgentConfig(loadSettings()), {
    provider_id: 'main-provider',
    api_base: 'https://main.test/v1',
    api_key: MAIN_KEY,
    model: 'main-model',
    reasoning_effort: 'default',
    context_window: 272000,
  });
});

test('a configured provider, model and effort are used together', t => {
  setupDb(t, {
    agent_provider_id: 'agent-provider',
    agent_model: 'judge-model',
    agent_reasoning_effort: 'high',
  });
  assert.deepEqual(resolveAgentConfig(loadSettings()), {
    provider_id: 'agent-provider',
    api_base: 'https://agent.test/v1',
    api_key: AGENT_KEY,
    model: 'judge-model',
    reasoning_effort: 'high',
    context_window: 272000,
  });
});

test('a deleted provider falls back to the main provider but keeps the agent model', t => {
  setupDb(t, { agent_provider_id: 'deleted-provider', agent_model: 'judge-model' });
  const config = resolveAgentConfig(loadSettings());
  assert.equal(config.provider_id, 'main-provider');
  assert.equal(config.api_base, 'https://main.test/v1');
  assert.equal(config.api_key, MAIN_KEY);
  assert.equal(config.model, 'judge-model');
});

test('a provider with an empty model setting still uses the main chat model', t => {
  setupDb(t, { agent_provider_id: 'agent-provider', agent_model: '   ' });
  const config = resolveAgentConfig(loadSettings());
  assert.equal(config.api_base, 'https://agent.test/v1');
  assert.equal(config.model, 'main-model');
});

test('GET /api/settings returns the agent keys and still masks the main key', async t => {
  setupDb(t, { agent_provider_id: 'agent-provider', agent_model: 'judge-model' });
  const previousPassword = process.env.ACCESS_PASSWORD;
  delete process.env.ACCESS_PASSWORD;
  t.after(() => {
    if (previousPassword !== undefined) process.env.ACCESS_PASSWORD = previousPassword;
  });
  const { GET } = require('../src/app/api/settings/route.ts');
  const response = await GET(new Request('http://localhost/api/settings'));
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.agent_provider_id, 'agent-provider');
  assert.equal(body.agent_model, 'judge-model');
  assert.equal(body.agent_reasoning_effort, 'default');
  assert.equal(body.api_key, API_KEY_MASK);
  assert.equal(text.includes(MAIN_KEY), false);
  assert.equal(text.includes(AGENT_KEY), false);
});

test('the agent context window is independent of the global context_window', t => {
  setupDb(t, { context_window: 32000, agent_context_window: 500000 });
  const settings = loadSettings();
  assert.equal(resolveAgentConfig(settings).context_window, 500000);
  assert.equal(settings.context_window, 32000);
});

test('an invalid stored agent context window falls back to the default', t => {
  setupDb(t, { agent_context_window: 0 });
  assert.equal(resolveAgentConfig(loadSettings()).context_window, 272000);
});

test('the settings schema accepts a positive integer agent context window and rejects others', () => {
  const { settingsUpdateSchema } = require('../src/lib/schemas.ts');
  assert.equal(settingsUpdateSchema.safeParse({ agent_context_window: 272000 }).success, true);
  for (const value of [0, -1, 1.5, '272000', 100_000_001]) {
    assert.equal(settingsUpdateSchema.safeParse({ agent_context_window: value }).success, false, String(value));
  }
});
