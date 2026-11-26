const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();

const { __migrateForTests } = require('../src/lib/db.ts');
const {
  normalizeWorkTitle, cleanWorkTitle, findMatchingWork, createWork, updateWork, deleteWork,
  getWork, listWorks, renderWorksCatalog, loadWorksCatalogText, WorkValidationError,
} = require('../src/lib/works-catalog.ts');

const T0 = '2026-05-01T00:00:00.000Z';
const T1 = '2026-06-01T00:00:00.000Z';
const T2 = '2026-07-01T00:00:00.000Z';

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  t.after(() => db.close());
  db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '甲'), ('char-b', '乙')").run();
  return db;
}

function add(db, input, now = T0) {
  return createWork(db, { character_id: 'char-a', status: 'watched', ...input }, now);
}

test('migrate creates both works tables and character delete cascades', (t) => {
  const db = setup(t);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'character_works%' ORDER BY name").all();
  assert.deepEqual(tables.map(r => r.name), ['character_works', 'character_works_update_tasks']);

  add(db, { work_type: 'movie', title: '她' });
  db.prepare("INSERT INTO character_works_update_tasks (character_id, source_text) VALUES ('char-a', 'x')").run();
  db.prepare("INSERT INTO character_works_update_tasks (character_id, source_text) VALUES ('char-b', 'y')").run();
  db.prepare("DELETE FROM characters WHERE id = 'char-a'").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_works').get().n, 0);
  assert.deepEqual(db.prepare('SELECT character_id FROM character_works_update_tasks').all().map(r => r.character_id), ['char-b']);
});

test('migrate is idempotent', (t) => {
  const db = setup(t);
  add(db, { work_type: 'movie', title: '她' });
  __migrateForTests(db);
  assert.equal(listWorks(db, 'char-a').length, 1);
});

test('normalizeWorkTitle ignores width, case, brackets, spaces and punctuation', () => {
  assert.equal(normalizeWorkTitle('《Better Call Saul》'), normalizeWorkTitle('better call saul'));
  assert.equal(normalizeWorkTitle('彗星来的那一夜'), normalizeWorkTitle('「彗星来的那一夜」'));
  assert.equal(normalizeWorkTitle('Ｈｅｒ'), 'her');
  assert.equal(normalizeWorkTitle('爱在：黎明破晓前'), normalizeWorkTitle('爱在 黎明破晓前'));
  assert.notEqual(normalizeWorkTitle('复联4'), normalizeWorkTitle('复联3'));
  assert.equal(cleanWorkTitle('  《她》 '), '她');
});

test('findMatchingWork matches title or alias within the same character and type', (t) => {
  const db = setup(t);
  const saul = add(db, { work_type: 'series', title: '风骚律师', aliases: ['Better Call Saul'] });
  add(db, { work_type: 'book', title: '三体' });

  assert.equal(findMatchingWork(db, 'char-a', 'series', ['better call saul']).id, saul.id);
  assert.equal(findMatchingWork(db, 'char-a', 'series', ['《风骚律师》']).id, saul.id);
  assert.equal(findMatchingWork(db, 'char-a', 'series', ['三体']), null, 'type must match');
  assert.equal(findMatchingWork(db, 'char-b', 'series', ['风骚律师']), null, 'character must match');
  assert.equal(findMatchingWork(db, 'char-a', 'series', ['', '  ']), null);
});

test('findMatchingWork returns dismissed entries but prefers an active match', (t) => {
  const db = setup(t);
  const dismissed = add(db, { work_type: 'book', title: '朝圣' });
  updateWork(db, dismissed.id, { dismissed: true }, T1);
  assert.equal(findMatchingWork(db, 'char-a', 'book', ['朝圣']).id, dismissed.id);
  assert.notEqual(findMatchingWork(db, 'char-a', 'book', ['朝圣']).dismissed_at, null);

  const active = add(db, { work_type: 'book', title: '朝圣之路', aliases: ['朝圣'] }, T2);
  assert.equal(findMatchingWork(db, 'char-a', 'book', ['朝圣']).id, active.id);
});

test('createWork validates input and cleans title and aliases', (t) => {
  const db = setup(t);
  assert.throws(() => add(db, { work_type: 'music', title: 'Lost Stars' }), WorkValidationError);
  assert.throws(() => add(db, { work_type: 'movie', title: '她', status: 'mentioned' }), WorkValidationError);
  assert.throws(() => add(db, { work_type: 'movie', title: ' 《》 ' }), WorkValidationError);

  const her = add(db, { work_type: 'movie', title: '《她》', aliases: ['Her', 'her', '她', ' '] , rating: ' 9.0–9.5 ' });
  assert.equal(her.title, '她');
  assert.deepEqual(her.aliases, ['Her']);
  assert.equal(her.rating, '9.0–9.5');
  assert.equal(her.first_seen_at, T0);
  assert.equal(her.dismissed_at, null);
});

test('updateWork writes given fields, allows clearing, and bumps updated_at', (t) => {
  const db = setup(t);
  const entry = add(db, { work_type: 'series', title: '黑镜', status: 'watching', progress: '第一季第 3 集', note: '喜欢' });
  const updated = updateWork(db, entry.id, { progress: '第二季第 2 集', note: '' }, T1);
  assert.equal(updated.progress, '第二季第 2 集');
  assert.equal(updated.note, '');
  assert.equal(updated.status, 'watching');
  assert.equal(updated.updated_at, T1);

  const removed = updateWork(db, entry.id, { dismissed: true }, T2);
  assert.equal(removed.dismissed_at, T2);
  const restored = updateWork(db, entry.id, { dismissed: false }, T2);
  assert.equal(restored.dismissed_at, null);
  assert.equal(restored.progress, '第二季第 2 集', 'restore keeps the fields from before removal');

  assert.throws(() => updateWork(db, 'missing', { note: 'x' }, T2), WorkValidationError);
  assert.equal(deleteWork(db, entry.id), true);
  assert.equal(getWork(db, entry.id), null);
});

test('listWorks hides dismissed entries unless asked and isolates characters', (t) => {
  const db = setup(t);
  add(db, { work_type: 'movie', title: '她' });
  const gone = add(db, { work_type: 'movie', title: '朝圣' });
  updateWork(db, gone.id, { dismissed: true }, T1);
  createWork(db, { character_id: 'char-b', work_type: 'movie', title: '月球', status: 'watched' }, T0);

  assert.deepEqual(listWorks(db, 'char-a').map(w => w.title), ['她']);
  assert.deepEqual(listWorks(db, 'char-a', { includeDismissed: true }).map(w => w.title).sort(), ['她', '朝圣']);
  assert.deepEqual(listWorks(db, 'char-b').map(w => w.title), ['月球']);
});

test('renderWorksCatalog is empty without visible entries', () => {
  assert.equal(renderWorksCatalog([]), '');
  const dismissed = {
    id: 'w1', character_id: 'char-a', work_type: 'movie', title: '她', aliases: [], status: 'watched',
    rating: '', progress: '', note: '', source_memory_ids: [], source_msg_ids: [],
    first_seen_at: T0, dismissed_at: T1, created_at: T0, updated_at: T1,
  };
  assert.equal(renderWorksCatalog([dismissed]), '');
});

test('renderWorksCatalog groups by type, orders deterministically and labels status per type', (t) => {
  const db = setup(t);
  add(db, { work_type: 'game', title: '艾尔登法环', status: 'watching' }, T0);
  add(db, { work_type: 'movie', title: '银翼杀手2049', rating: '8.5' }, T2);
  add(db, { work_type: 'movie', title: '她', aliases: ['Her'], rating: '9.0–9.5', note: '最爱之一' }, T1);
  add(db, { work_type: 'movie', title: '花束般的恋爱', status: 'want' }, T0);
  add(db, { work_type: 'series', title: '黑镜', status: 'watching', progress: '第二季第 2 集' }, T0);
  add(db, { work_type: 'book', title: '且听风吟' }, T0);

  const text = renderWorksCatalog(listWorks(db, 'char-a'));
  assert.equal(text, [
    '## 用户的作品清单',
    '这是用户看过、在看和想看的作品（书是读过、在读、想读，游戏是玩过、在玩、想玩），由系统根据你们的对话整理。推荐新作品时，不要把已经看过、读过、玩过的作品当成新推荐；可以优先从想看、想读、想玩的作品里挑。',
    '### 电影',
    '- 看过：《她》（又名 Her）｜评分 9.0–9.5｜最爱之一',
    '- 看过：《银翼杀手2049》｜评分 8.5',
    '- 想看：《花束般的恋爱》',
    '### 剧集/动画',
    '- 在看：《黑镜》｜进度 第二季第 2 集',
    '### 书',
    '- 读过：《且听风吟》',
    '### 游戏',
    '- 在玩：《艾尔登法环》',
  ].join('\n'));

  // 输入顺序不同，输出逐字节相同
  const shuffled = listWorks(db, 'char-a').reverse();
  assert.equal(renderWorksCatalog(shuffled), text);
});

test('renderWorksCatalog and loadWorksCatalogText honor the history cutoff', (t) => {
  const db = setup(t);
  add(db, { work_type: 'movie', title: '她' }, T0);
  add(db, { work_type: 'series', title: '黑镜', status: 'watching' }, T2);

  const full = loadWorksCatalogText(db, 'char-a');
  assert.equal(full.count, 2);
  assert.match(full.text, /黑镜/);

  const past = loadWorksCatalogText(db, 'char-a', { cutoff: T1 });
  assert.equal(past.count, 1);
  assert.match(past.text, /《她》/);
  assert.doesNotMatch(past.text, /黑镜/);

  const beforeAll = loadWorksCatalogText(db, 'char-a', { cutoff: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(beforeAll, { text: '', count: 0 });

  // 解析不了的时间不藏条目
  assert.equal(loadWorksCatalogText(db, 'char-a', { cutoff: 'not-a-date' }).count, 2);
});

test('cutoff inclusive: equal timestamps count as before by default, strictly before when inclusive is false', (t) => {
  const db = setup(t);
  add(db, { work_type: 'movie', title: '她' }, T0);
  add(db, { work_type: 'series', title: '黑镜', status: 'watching' }, T1);

  // 默认 inclusive，保持老调用方的语义（插入回复以锚点 user 消息为界）
  assert.equal(loadWorksCatalogText(db, 'char-a', { cutoff: T1 }).count, 2);
  assert.equal(loadWorksCatalogText(db, 'char-a', { cutoff: T1, inclusive: true }).count, 2);
  // 重新生成：严格早于目标消息
  const strict = loadWorksCatalogText(db, 'char-a', { cutoff: T1, inclusive: false });
  assert.equal(strict.count, 1);
  assert.doesNotMatch(strict.text, /黑镜/);

  const entries = listWorks(db, 'char-a');
  assert.match(renderWorksCatalog(entries, { cutoff: T1 }), /黑镜/);
  assert.doesNotMatch(renderWorksCatalog(entries, { cutoff: T1, inclusive: false }), /黑镜/);
  assert.equal(loadWorksCatalogText(db, 'char-a', { cutoff: 'not-a-date', inclusive: false }).count, 2);
});

test('SQLite-format timestamps are read as UTC regardless of the process time zone', () => {
  // 截止时刻是 SQLite datetime('now') 格式（UTC），条目是 ISO。裸 Date.parse 会按本地时区读截止时刻：
  // UTC+8 下截止提前 8 小时（她 被藏掉），纽约夏令时 UTC-4 下推后 4 小时（黑镜 落在截止时刻上漏出来）。
  const entry = (id, title, firstSeenAt) => ({
    id, character_id: 'char-a', work_type: 'movie', title, aliases: [], status: 'watched',
    rating: '', progress: '', note: '', source_memory_ids: [], source_msg_ids: [],
    first_seen_at: firstSeenAt, dismissed_at: null, created_at: firstSeenAt, updated_at: firstSeenAt,
  });
  const entries = [
    entry('w1', '她', '2026-05-31T20:00:00.000Z'),
    entry('w2', '黑镜', '2026-06-01T04:00:00.000Z'),
  ];
  const cutoff = '2026-06-01 00:00:00';
  const expected = renderWorksCatalog([entries[0]]);
  assert.equal(renderWorksCatalog(entries, { cutoff }), expected);

  const script = `
    require(${JSON.stringify(path.join(__dirname, 'helpers', 'register-ts-loader.cjs'))}).registerTsLoader();
    const { renderWorksCatalog } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'works-catalog.ts'))});
    process.stdout.write(JSON.stringify(renderWorksCatalog(${JSON.stringify(entries)}, { cutoff: ${JSON.stringify(cutoff)} })));
  `;
  for (const tz of ['Asia/Shanghai', 'UTC', 'America/New_York']) {
    const output = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(JSON.parse(output), expected, `TZ=${tz}`);
  }
});

test('createWork and updateWork store parseable first_seen_at as ISO and keep unparseable values', (t) => {
  const db = setup(t);
  const sqliteFormat = add(db, { work_type: 'movie', title: '她', first_seen_at: '2026-06-01 08:00:00' });
  assert.equal(sqliteFormat.first_seen_at, '2026-06-01T08:00:00.000Z');
  const offset = add(db, { work_type: 'movie', title: '月球', first_seen_at: '2026-06-01T16:00:00+08:00' });
  assert.equal(offset.first_seen_at, '2026-06-01T08:00:00.000Z');
  const raw = add(db, { work_type: 'movie', title: '花样年华', first_seen_at: '去年夏天' });
  assert.equal(raw.first_seen_at, '去年夏天');

  assert.equal(updateWork(db, raw.id, { first_seen_at: '2026-07-01 12:30:00' }, T2).first_seen_at, '2026-07-01T12:30:00.000Z');
  assert.equal(updateWork(db, raw.id, { first_seen_at: '某天' }, T2).first_seen_at, '某天');
  assert.equal(updateWork(db, raw.id, { first_seen_at: '' }, T2).first_seen_at, '某天', '空串视为没给');
});
