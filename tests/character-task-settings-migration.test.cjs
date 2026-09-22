const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests } = require('../src/lib/db.ts');
const { CHARACTER_TASK_SETTINGS_MIGRATED_KEY } = require('../src/lib/character-task-settings-migration.ts');

function putSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

test('global background settings are copied onto characters once', () => {
  const db = new Database(':memory:');
  try {
    __migrateForTests(db);
    db.prepare('DELETE FROM settings WHERE key = ?').run(CHARACTER_TASK_SETTINGS_MIGRATED_KEY);
    db.prepare(`
      INSERT INTO api_providers (id, name, api_base, api_key, model)
      VALUES ('provider-1', 'nag', 'https://bg.example/v1', 'secret', 'provider-default')
    `).run();
    putSetting(db, 'model', 'main-chat');
    putSetting(db, 'memory_background_provider_id', 'provider-1');
    putSetting(db, 'memory_background_model', 'grok-4.6');
    putSetting(db, 'memory_background_reasoning_effort_enabled', true);
    putSetting(db, 'memory_background_reasoning_effort', 'medium');
    putSetting(db, 'memory_background_system_prompt', 'be precise');
    putSetting(db, 'memory_background_system_prompt_by_model', {
      'grok-4.6': 'old prompt',
      'other-model': 'keep me',
    });
    putSetting(db, 'disable_deepseek_thinking_for_background', true);
    putSetting(db, 'memory_background_timeout_ms', 1_800_000);
    db.prepare(`
      INSERT INTO characters (id, name, created_at, updated_at)
      VALUES ('inherit', 'Inherit', datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO characters (
        id, name, background_model, image_prompt_model,
        background_system_prompt_by_model, created_at, updated_at
      ) VALUES ('own', 'Own', 'own-model', 'draw-model', ?, datetime('now'), datetime('now'))
    `).run(JSON.stringify({ 'own-model': 'already mine' }));
    db.prepare(`
      INSERT INTO characters (id, name, background_provider_id, created_at, updated_at)
      VALUES ('blank-model', 'Blank', 'provider-1', datetime('now'), datetime('now'))
    `).run();

    __migrateForTests(db);

    const inherit = db.prepare('SELECT * FROM characters WHERE id = ?').get('inherit');
    assert.equal(inherit.background_provider_id, 'provider-1');
    assert.equal(inherit.background_model, 'grok-4.6');
    assert.equal(JSON.parse(inherit.background_reasoning_by_model)['grok-4.6'], 'medium');
    const inheritPrompts = JSON.parse(inherit.background_system_prompt_by_model);
    assert.equal(inheritPrompts['grok-4.6'], 'be precise');
    assert.equal(inheritPrompts['other-model'], 'keep me');
    assert.equal(JSON.parse(inherit.image_prompt_system_prompt_by_model)['other-model'], 'keep me');

    const own = db.prepare('SELECT * FROM characters WHERE id = ?').get('own');
    assert.equal(own.background_model, 'own-model');
    assert.equal(own.background_provider_id, 'provider-1');
    assert.equal(JSON.parse(own.background_system_prompt_by_model)['own-model'], 'already mine');
    assert.equal(JSON.parse(own.image_prompt_system_prompt_by_model)['draw-model'], 'be precise');
    assert.deepEqual(JSON.parse(own.background_reasoning_by_model), {});

    assert.equal(db.prepare(`SELECT value FROM settings WHERE key = 'memory_background_model'`).get(), undefined);
    assert.equal(db.prepare(`SELECT value FROM settings WHERE key = 'memory_background_provider_id'`).get(), undefined);
    assert.equal(
      db.prepare(`SELECT value FROM settings WHERE key = 'disable_deepseek_thinking_for_background'`).get(),
      undefined,
    );
    assert.equal(JSON.parse(db.prepare(`SELECT value FROM settings WHERE key = 'memory_background_timeout_ms'`).get().value), 1_800_000);

    db.prepare(`UPDATE characters SET background_model = '' WHERE id = 'blank-model'`).run();
    putSetting(db, 'memory_background_model', 'should-not-return');
    __migrateForTests(db);
    assert.equal(
      db.prepare(`SELECT background_model FROM characters WHERE id = 'blank-model'`).get().background_model,
      '',
    );
  } finally {
    db.close();
  }
});

test('blank global background model inherits the provider model', () => {
  const db = new Database(':memory:');
  try {
    __migrateForTests(db);
    db.prepare('DELETE FROM settings WHERE key = ?').run(CHARACTER_TASK_SETTINGS_MIGRATED_KEY);
    db.prepare(`
      INSERT INTO api_providers (id, name, api_base, api_key, model)
      VALUES ('provider-2', 'other', 'https://other.example/v1', 'secret', 'provider-default')
    `).run();
    putSetting(db, 'memory_background_provider_id', 'provider-2');
    putSetting(db, 'memory_background_model', '   ');
    db.prepare(`
      INSERT INTO characters (id, name, created_at, updated_at)
      VALUES ('c', 'C', datetime('now'), datetime('now'))
    `).run();

    __migrateForTests(db);

    assert.equal(
      db.prepare(`SELECT background_model FROM characters WHERE id = 'c'`).get().background_model,
      'provider-default',
    );
  } finally {
    db.close();
  }
});
