const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests, __resetDbForTests } = require('../src/lib/db.ts');
const createRoute = require('../src/app/api/characters/route.ts');
const characterRoute = require('../src/app/api/characters/[id]/route.ts');

function request(body, method = 'POST') {
  return new Request('http://localhost/api/characters', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('image prompt requirements migrate old characters once without replacing existing content', () => {
  const db = new Database(':memory:');
  try {
    __migrateForTests(db);
    db.exec('ALTER TABLE characters DROP COLUMN image_prompt_other_requirements');
    db.prepare('INSERT INTO characters (id, name, image_tags) VALUES (?, ?, ?)')
      .run('legacy', '旧角色', 'silver hair');

    __migrateForTests(db);
    const migrated = db.prepare('SELECT * FROM characters WHERE id = ?').get('legacy');
    assert.equal(migrated.image_prompt_other_requirements, '');
    assert.equal(migrated.image_tags, 'silver hair');
    const column = db.prepare('PRAGMA table_info(characters)').all()
      .find(item => item.name === 'image_prompt_other_requirements');
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, "''");

    db.prepare('UPDATE characters SET image_prompt_other_requirements = ? WHERE id = ?')
      .run('使用柔和逆光。\n保留窗外雨景。', 'legacy');
    __migrateForTests(db);
    assert.equal(db.prepare('SELECT image_prompt_other_requirements FROM characters WHERE id = ?')
      .get('legacy').image_prompt_other_requirements, '使用柔和逆光。\n保留窗外雨景。');
  } finally {
    db.close();
  }
});

test('character routes persist, preserve omitted, and explicitly clear image prompt requirements', async () => {
  const db = new Database(':memory:');
  try {
    __migrateForTests(db);
    __setDbForTests(db);
    const requirements = '使用柔和逆光。\n保留窗外雨景。' + '完整要求'.repeat(5000);
    const response = await createRoute.POST(request({
      name: '生图角色', image_prompt_other_requirements: requirements,
    }));
    assert.equal(response.status, 201);
    const character = await response.json();
    assert.equal(character.image_prompt_other_requirements, requirements);
    const context = { params: Promise.resolve({ id: character.id }) };

    const preservedResponse = await characterRoute.PUT(request({ name: '改名' }, 'PUT'), context);
    assert.equal(preservedResponse.status, 200);
    assert.equal((await preservedResponse.json()).image_prompt_other_requirements, requirements);

    const invalidResponse = await characterRoute.PUT(request({ image_prompt_other_requirements: 7 }, 'PUT'), context);
    assert.equal(invalidResponse.status, 400);
    assert.equal(db.prepare('SELECT image_prompt_other_requirements FROM characters WHERE id = ?')
      .get(character.id).image_prompt_other_requirements, requirements);

    const clearedResponse = await characterRoute.PUT(request({ image_prompt_other_requirements: '' }, 'PUT'), context);
    assert.equal(clearedResponse.status, 200);
    assert.equal((await clearedResponse.json()).image_prompt_other_requirements, '');
    assert.equal((await (await characterRoute.GET(request({}, 'POST'), context)).json())
      .image_prompt_other_requirements, '');

    const legacyResponse = await createRoute.POST(request({ name: '无额外要求' }));
    assert.equal((await legacyResponse.json()).image_prompt_other_requirements, '');
  } finally {
    __resetDbForTests();
    if (db.open) db.close();
  }
});

test('conditional cleanup preserves a fresh character with only image prompt requirements', async () => {
  const db = new Database(':memory:');
  try {
    __migrateForTests(db);
    __setDbForTests(db);
    const character = await (await createRoute.POST(request({
      name: '生图草稿', image_prompt_other_requirements: '使用柔和逆光。',
    }))).json();
    const response = await characterRoute.DELETE(new Request('http://localhost/api/characters', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Character-Cleanup': character.created_at },
    }), { params: Promise.resolve({ id: character.id }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).deleted, false);
    assert.equal(db.prepare('SELECT image_prompt_other_requirements FROM characters WHERE id = ?')
      .get(character.id).image_prompt_other_requirements, '使用柔和逆光。');
  } finally {
    __resetDbForTests();
    if (db.open) db.close();
  }
});
