const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const {
  collectLocalAssetUrlsFromContent,
  copyLocalAssetUrl,
  deleteLocalAssetUrls,
  filterUnreferencedLocalAssetUrls,
  resolveLocalAssetUrl,
} = require(path.resolve(__dirname, '../src/lib/character-file-utils.ts'));

test('deleting local assets reports both canonical aliases only for files confirmed absent', async () => {
  const tempRoot = path.resolve(__dirname, '../.tmp-tests');
  fs.mkdirSync(tempRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'character-delete-files-'));
  const previousCwd = process.cwd();

  try {
    const existingPath = path.join(workspace, 'public', 'generated', 'char-a', 'existing.png');
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, 'image');
    process.chdir(workspace);

    const deletedUrls = await deleteLocalAssetUrls([
      '/api/files/generated/char-a/existing.png?cache=1',
      '/generated/char-a/existing.png#duplicate-alias',
      '/api/files/generated/char-a/missing.png',
      'https://example.com/not-local.png',
    ]);

    assert.deepEqual(deletedUrls, [
      '/generated/char-a/existing.png',
      '/api/files/generated/char-a/existing.png',
      '/generated/char-a/missing.png',
      '/api/files/generated/char-a/missing.png',
    ]);
    assert.equal(fs.existsSync(existingPath), false);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('deleting local assets excludes files whose unlink failed', async () => {
  const tempRoot = path.resolve(__dirname, '../.tmp-tests');
  fs.mkdirSync(tempRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'character-delete-error-'));
  const previousCwd = process.cwd();
  const originalWarn = console.warn;

  try {
    fs.mkdirSync(path.join(workspace, 'public', 'generated', 'char-a', 'directory.png'), { recursive: true });
    process.chdir(workspace);
    console.warn = () => {};

    const deletedUrls = await deleteLocalAssetUrls([
      '/api/files/generated/char-a/directory.png',
      '/api/files/generated/char-a/missing.png',
    ]);

    assert.deepEqual(deletedUrls, [
      '/generated/char-a/missing.png',
      '/api/files/generated/char-a/missing.png',
    ]);
  } finally {
    console.warn = originalWarn;
    process.chdir(previousCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('generated asset URLs accept one safe character directory and preserve the relative path', () => {
  const asset = resolveLocalAssetUrl('/api/files/generated/char_A-12/image-1.png?cache=1');

  assert.ok(asset);
  assert.equal(asset.dir, 'generated');
  assert.equal(asset.filename, 'char_A-12/image-1.png');
  assert.equal(
    asset.filePath,
    path.resolve(process.cwd(), 'public', 'generated', 'char_A-12', 'image-1.png'),
  );
});

test('local asset URL parsing rejects traversal, backslashes, and nested non-generated assets', () => {
  for (const url of [
    '/api/files/generated/../secret.png',
    '/api/files/generated/char-a\\secret.png',
    '/api/files/generated/char-a//secret.png',
    '/api/files/generated/char-a%2Fsecret.png',
    '/api/files/generated/char-a%5Csecret.png',
    '/api/files/avatars/char-a/avatar.png',
    '/api/files/attachments/char-a/file.png',
  ]) {
    assert.equal(resolveLocalAssetUrl(url), null, url);
  }
});

test('message content URL collection includes nested generated images and legacy flat assets', () => {
  const urls = collectLocalAssetUrlsFromContent([
    '![new](/api/files/generated/char-a/11111111-1111-4111-8111-111111111111.png)',
    '![old](/api/files/generated/22222222-2222-4222-8222-222222222222.webp)',
  ].join('\n'));

  assert.deepEqual([...urls], [
    '/api/files/generated/char-a/11111111-1111-4111-8111-111111111111.png',
    '/api/files/generated/22222222-2222-4222-8222-222222222222.webp',
  ]);
});

test('message content URL collection ignores local-looking paths inside external URLs', () => {
  const urls = collectLocalAssetUrlsFromContent([
    'https://cdn.example/generated/external-path.png',
    'https://example.test/view?asset=/api/files/generated/char-a/external-query.png',
    'https://example.test/view#/attachments/external-hash.txt',
    '//cdn.example/avatars/external-protocol-relative.png',
    '![nested](/api/files/generated/char-a/local-nested.png)',
    'legacy: /generated/local-flat.webp',
    'attachment: /api/files/attachments/local-file.txt',
  ].join('\n'));

  assert.deepEqual([...urls], [
    '/api/files/generated/char-a/local-nested.png',
    '/generated/local-flat.webp',
    '/api/files/attachments/local-file.txt',
  ]);
});

test('unreferenced asset filtering scans each real table at most once for many candidates', () => {
  const executedSql = [];
  const db = new Database(':memory:', {
    verbose(sql) {
      executedSql.push(sql.replace(/\s+/g, ' ').trim());
    },
  });

  try {
    db.exec(`
      CREATE TABLE characters (avatar_url TEXT);
      CREATE TABLE messages (metadata TEXT NOT NULL, content TEXT);
      INSERT INTO characters VALUES (NULL);
      INSERT INTO messages VALUES ('{}', 'no local assets here');
    `);
    executedSql.length = 0;

    const candidates = Array.from(
      { length: 40 },
      (_, index) => `/api/files/generated/char-a/orphan-${index}.png`,
    );
    const orphans = filterUnreferencedLocalAssetUrls(db, candidates);

    assert.deepEqual(orphans, candidates);
    assert.equal(
      executedSql.filter(sql => /^SELECT .* FROM messages\b/i.test(sql)).length,
      1,
      executedSql.join('\n'),
    );
    assert.equal(
      executedSql.filter(sql => /^SELECT .* FROM characters\b/i.test(sql)).length,
      1,
      executedSql.join('\n'),
    );
    assert.equal(executedSql.length, 2, executedSql.join('\n'));
  } finally {
    db.close();
  }
});

test('unreferenced asset filtering compares aliases and query variants by asset identity', () => {
  const executedSql = [];
  const db = new Database(':memory:', {
    verbose(sql) {
      executedSql.push(sql.replace(/\s+/g, ' ').trim());
    },
  });

  try {
    db.exec(`
      CREATE TABLE characters (avatar_url TEXT);
      CREATE TABLE messages (metadata TEXT NOT NULL, content TEXT);
    `);
    db.prepare('INSERT INTO characters VALUES (?)').run('/avatars/shared.png?size=large');
    db.prepare('INSERT INTO messages VALUES (?, ?)').run(
      JSON.stringify({
        generatedImages: [{ url: '/generated/char-a/shared.png?version=2' }],
      }),
      '/api/files/attachments/shared.txt#preview',
    );
    executedSql.length = 0;

    const orphans = filterUnreferencedLocalAssetUrls(db, [
      '/api/files/avatars/shared.png#candidate',
      '/api/files/generated/char-a/shared.png?candidate=1',
      '/attachments/shared.txt?download=1',
      '/generated/char-a/orphan.png?first=1',
      '/api/files/generated/char-a/orphan.png#duplicate-alias',
    ]);

    assert.deepEqual(orphans, ['/generated/char-a/orphan.png?first=1']);
    assert.equal(
      executedSql.filter(sql => /^SELECT .* FROM messages\b/i.test(sql)).length,
      1,
      executedSql.join('\n'),
    );
    assert.equal(
      executedSql.filter(sql => /^SELECT .* FROM characters\b/i.test(sql)).length,
      1,
      executedSql.join('\n'),
    );
  } finally {
    db.close();
  }
});

test('unreferenced asset filtering stops before scanning messages when avatars satisfy all candidates', () => {
  const executedSql = [];
  const db = new Database(':memory:', {
    verbose(sql) {
      executedSql.push(sql.replace(/\s+/g, ' ').trim());
    },
  });

  try {
    db.exec(`
      CREATE TABLE characters (avatar_url TEXT);
      CREATE TABLE messages (metadata TEXT NOT NULL, content TEXT);
      INSERT INTO characters VALUES ('/avatars/shared.png');
      INSERT INTO messages VALUES ('{}', 'unused');
    `);
    executedSql.length = 0;

    assert.deepEqual(
      filterUnreferencedLocalAssetUrls(db, ['/api/files/avatars/shared.png?cache=1']),
      [],
    );
    assert.equal(
      executedSql.filter(sql => /\bFROM messages\b/i.test(sql)).length,
      0,
      executedSql.join('\n'),
    );
  } finally {
    db.close();
  }
});

test('copying a generated asset can target the duplicated character directory', async () => {
  const tempRoot = path.resolve(__dirname, '../.tmp-tests');
  fs.mkdirSync(tempRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'character-files-'));
  const previousCwd = process.cwd();

  try {
    const source = path.join(workspace, 'public', 'generated', 'source.png');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'image');
    process.chdir(workspace);

    const copiedUrl = await copyLocalAssetUrl(
      '/api/files/generated/source.png',
      new Map(),
      { generatedCharacterId: 'char-copy' },
    );

    assert.match(copiedUrl, /^\/api\/files\/generated\/char-copy\/[a-f0-9-]{12}\.png$/);
    const copied = resolveLocalAssetUrl(copiedUrl);
    assert.ok(copied);
    assert.equal(fs.readFileSync(copied.filePath, 'utf8'), 'image');
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
