const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { createWork, updateWork, getWork, listWorks, WORK_FIELD_LIMITS } = require('../src/lib/works-catalog.ts');
const { setStructuredLogSink } = require('../src/lib/structured-log.ts');
const { recoverAndWakeAtLeaseExpiry } = require('../src/lib/background-task-recovery.ts');
const { WORKS_CATALOG_UPDATE_PROMPT } = require('../src/lib/prompt-templates.ts');
const {
  parseWorksUpdateResponse,
  applyWorksUpdate,
  buildWorksCatalogUpdatePrompt,
  enqueueWorksCatalogUpdate,
  processWorksCatalogUpdateTasks,
  recoverStaleWorksCatalogTasks,
} = require('../src/lib/works-catalog-update.ts');

const T0 = '2026-05-01T00:00:00.000Z';
const T1 = '2026-06-01T00:00:00.000Z';
const T2 = '2026-07-01T00:00:00.000Z';
const NOW = '2026-11-25T00:00:00.000Z';

const originalLoad = Module._load;

function requireFreshWithMocks(modulePath, mocks, alsoFresh = []) {
  for (const extra of alsoFresh) delete require.cache[require.resolve(extra)];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => { __setDbForTests(null); db.close(); });
  db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '甲'), ('char-b', '乙')").run();
  return db;
}

function add(db, input, now = T0) {
  return createWork(db, { character_id: 'char-a', status: 'watched', ...input }, now);
}

function item(fields) {
  return { ref: null, type: 'movie', title: '', aliases: [], status: 'watched', rating: '', progress: '', note: '', ...fields };
}

function apply(db, items, refMap = {}, overrides = {}) {
  return applyWorksUpdate(db, 'char-a', items, refMap, {
    sourceMsgIds: ['msg-9'], sourceTime: T2, now: NOW, ...overrides,
  });
}

function captureLogs(t) {
  const records = [];
  setStructuredLogSink(record => records.push(record));
  t.after(() => setStructuredLogSink(null));
  return records;
}

function taskRows(db) {
  return db.prepare('SELECT * FROM character_works_update_tasks ORDER BY id').all();
}

// ── 解析 ──

test('parse accepts plain JSON, code fences and surrounding text, and normalizes field shapes', () => {
  const plain = parseWorksUpdateResponse('{"works":[{"ref":"W3","type":"series","title":"黑镜","aliases":[],"status":"watching","rating":"","progress":"第二季第 2 集","note":""}]}');
  assert.deepEqual(plain, [{
    ref: 'W3', type: 'series', title: '黑镜', aliases: [], status: 'watching', rating: '', progress: '第二季第 2 集', note: '',
  }]);

  const fenced = parseWorksUpdateResponse('```json\n{"works":[{"ref":"w2","type":"Movie","title":"她","aliases":"Her","status":"WATCHED","rating":9.5}]}\n```');
  assert.deepEqual(fenced[0], {
    ref: 'W2', type: 'movie', title: '她', aliases: ['Her'], status: 'watched', rating: '9.5', progress: '', note: '',
  });

  const chatty = parseWorksUpdateResponse('好的，{这不是 JSON} 结果如下：{"works":[{"ref":3,"type":"book","title":"三体"},"坏项",null]} 以上。');
  assert.equal(chatty.length, 1, '形状不对的项直接略过');
  assert.equal(chatty[0].ref, 'W3');
  assert.equal(parseWorksUpdateResponse('{"works":[{"ref":"新作品","type":"game","title":"塞尔达"}]}')[0].ref, null);
  assert.deepEqual(parseWorksUpdateResponse('{"works":[]}'), []);
});

test('parse accepts single-line and multi-line code fences', () => {
  // 单行代码块：去围栏会把整行丢掉，兜底扫描必须看原始响应
  assert.deepEqual(parseWorksUpdateResponse('```json {"works":[]} ```'), []);
  const single = parseWorksUpdateResponse('```json {"works":[{"type":"movie","title":"她","status":"watched"}]} ```');
  assert.deepEqual(single.map(w => [w.type, w.title, w.status]), [['movie', '她', 'watched']]);

  assert.deepEqual(parseWorksUpdateResponse('```\n{"works":[]}\n```'), []);
  const multi = parseWorksUpdateResponse('```json\n{\n  "works": [\n    {"type":"book","title":"三体","status":"want"}\n  ]\n}\n```');
  assert.deepEqual(multi.map(w => w.title), ['三体']);
  const trailing = parseWorksUpdateResponse('```json\n{"works":[{"type":"game","title":"塞尔达","status":"watching"}]}\n```\n以上。');
  assert.deepEqual(trailing.map(w => w.title), ['塞尔达']);
});

test('parse throws on responses without a works array', () => {
  assert.throws(() => parseWorksUpdateResponse('没有任何变化'), /works catalog update parsing failed/);
  assert.throws(() => parseWorksUpdateResponse('{"memories":[]}'), /works catalog update parsing failed/);
  assert.throws(() => parseWorksUpdateResponse('{"works":{"title":"她"}}'), /works catalog update parsing failed/);
  assert.throws(() => parseWorksUpdateResponse('{"works":[{"title":"她"'), /works catalog update parsing failed/);
});

// ── 合并规则 ──

test('new work is created with source time, message ids and clipped optional fields', (t) => {
  const db = setup(t);
  const long = n => '长'.repeat(n);
  const aliases = Array.from({ length: 10 }, (_, i) => `别名${i}`);
  aliases[0] = '别'.repeat(WORK_FIELD_LIMITS.alias + 5);
  const result = apply(db, [item({
    type: 'series', title: long(WORK_FIELD_LIMITS.title + 20), aliases, status: 'want',
    rating: '9'.repeat(30), progress: long(80), note: long(100),
  })]);
  assert.equal(result.created.length, 1);
  const entry = getWork(db, result.created[0]);
  assert.equal(Array.from(entry.title).length, WORK_FIELD_LIMITS.title);
  assert.equal(entry.aliases.length, WORK_FIELD_LIMITS.aliases);
  assert.equal(Array.from(entry.aliases[0]).length, WORK_FIELD_LIMITS.alias);
  assert.equal(entry.rating.length, WORK_FIELD_LIMITS.rating);
  assert.equal(Array.from(entry.progress).length, WORK_FIELD_LIMITS.progress);
  assert.equal(Array.from(entry.note).length, WORK_FIELD_LIMITS.note);
  assert.equal(entry.status, 'want');
  assert.equal(entry.work_type, 'series');
  assert.equal(entry.first_seen_at, T2, 'first_seen_at 取本批最后一条消息的时间');
  assert.deepEqual(entry.source_msg_ids, ['msg-9']);
  assert.equal(entry.created_at, NOW);

  const noTime = apply(db, [item({ title: '她' })], {}, { sourceTime: null });
  assert.equal(getWork(db, noTime.created[0]).first_seen_at, NOW);
});

test('update via ref overwrites status, keeps fields on empty values, unions aliases and never renames', (t) => {
  const db = setup(t);
  const saul = add(db, {
    work_type: 'series', title: '风骚律师', aliases: ['BCS'], status: 'watching',
    rating: '9.5', progress: '第三季', note: '节奏很稳', source_msg_ids: ['msg-1'],
  });

  const result = apply(db, [item({
    ref: 'W1', type: 'series', title: 'Better Call Saul', aliases: ['绝命律师', 'bcs'], status: 'watched',
    rating: '', progress: '', note: '',
  })], { W1: saul.id });
  assert.deepEqual(result, { created: [], updated: [saul.id], skippedDismissed: 0, dropped: 0 });

  const after = getWork(db, saul.id);
  assert.equal(after.title, '风骚律师', '规范名不变');
  assert.deepEqual(after.aliases, ['BCS', 'Better Call Saul', '绝命律师'], '新叫法进别名，按归一化去重');
  assert.equal(after.status, 'watched');
  assert.equal(after.rating, '9.5', '空值不清空');
  assert.equal(after.progress, '第三季');
  assert.equal(after.note, '节奏很稳');
  assert.deepEqual(after.source_msg_ids, ['msg-1', 'msg-9']);
  assert.equal(after.first_seen_at, T0, '更新不改 first_seen_at');
  assert.equal(after.updated_at, NOW);

  apply(db, [item({ ref: 'W1', type: 'series', title: '风骚律师', status: 'watched', rating: '10', progress: '全剧终', note: '神作' })], { W1: saul.id });
  const latest = getWork(db, saul.id);
  assert.deepEqual([latest.rating, latest.progress, latest.note], ['10', '全剧终', '神作'], '非空值覆盖');
});

test('existing aliases are never dropped when the union exceeds the alias limit', (t) => {
  const db = setup(t);
  const existing = Array.from({ length: WORK_FIELD_LIMITS.aliases }, (_, i) => `旧名${i}`);
  const entry = add(db, { work_type: 'movie', title: '她', aliases: existing });
  apply(db, [item({ ref: 'W1', title: '她', aliases: ['Her', '新名'] })], { W1: entry.id });
  assert.deepEqual(getWork(db, entry.id).aliases, existing);
});

test('missing ref, out-of-range ref and foreign ref fall back to name matching', (t) => {
  const db = setup(t);
  const her = add(db, { work_type: 'movie', title: '她', aliases: ['Her'] });
  const other = createWork(db, { character_id: 'char-b', work_type: 'movie', title: '她', status: 'want' }, T0);

  const outOfRange = apply(db, [item({ ref: 'W9', title: 'Her', status: 'watched', rating: '9' })], { W1: her.id });
  assert.deepEqual(outOfRange.updated, [her.id]);
  assert.equal(getWork(db, her.id).rating, '9');

  const foreign = apply(db, [item({ ref: 'W1', title: '她', note: '配色好看' })], { W1: other.id });
  assert.deepEqual(foreign.updated, [her.id], '指向别的角色的条目不能用');
  assert.equal(getWork(db, other.id).note, '');

  const noRef = apply(db, [item({ title: '《她》', progress: '' , note: '配乐也好' })]);
  assert.deepEqual(noRef.updated, [her.id]);
  assert.equal(listWorks(db, 'char-a').length, 1);
});

test('a ref whose type and names both disagree is treated as wrong; a type slip with a shared name still counts', (t) => {
  const db = setup(t);
  const her = add(db, { work_type: 'movie', title: '她' });
  const spirited = add(db, { work_type: 'movie', title: '千与千寻' });

  const wrong = apply(db, [item({ ref: 'W1', type: 'series', title: '黑镜', status: 'watching' })], { W1: her.id });
  assert.equal(wrong.created.length, 1, '指错的 ref 退回名称匹配，没有命中就新增');
  assert.deepEqual(getWork(db, her.id).aliases, [], '不能把别的作品的名字写进它');
  assert.equal(getWork(db, her.id).status, 'watched');

  const slip = apply(db, [item({ ref: 'W2', type: 'series', title: '千与千寻', status: 'watched', rating: '10' })], { W2: spirited.id });
  assert.deepEqual(slip.updated, [spirited.id]);
  assert.equal(getWork(db, spirited.id).work_type, 'movie', '自动路径不改类型');
  assert.equal(getWork(db, spirited.id).rating, '10');
});

test('a same-type ref whose names do not match is treated as wrong and cannot bypass a tombstone', (t) => {
  const db = setup(t);
  const originalInfo = console.info;
  console.info = () => {};
  t.after(() => { console.info = originalInfo; });
  const mirror = add(db, { work_type: 'series', title: '黑镜', status: 'watching', progress: '第二季第 2 集' });
  const mirrorBefore = getWork(db, mirror.id);

  const wrong = apply(db, [item({ ref: 'W1', type: 'series', title: '西部世界', status: 'want' })], { W1: mirror.id });
  assert.equal(wrong.created.length, 1, '名称对不上的 ref 退回名称匹配，没有命中就新增');
  assert.deepEqual(wrong.updated, []);
  assert.deepEqual(getWork(db, mirror.id), mirrorBefore, '黑镜的状态、进度、别名都不能被改写');
  const westworld = getWork(db, wrong.created[0]);
  assert.deepEqual([westworld.title, westworld.status], ['西部世界', 'want']);

  // 西部世界被主人移除后，指错的 ref 不能借黑镜绕过墓碑
  updateWork(db, westworld.id, { dismissed: true }, T1);
  const westworldBefore = getWork(db, westworld.id);
  const tomb = apply(db, [item({
    ref: 'W1', type: 'series', title: '西部世界', aliases: ['Westworld'], status: 'watched', rating: '9',
  })], { W1: mirror.id });
  assert.deepEqual(tomb, { created: [], updated: [], skippedDismissed: 1, dropped: 0 });
  assert.deepEqual(getWork(db, mirror.id), mirrorBefore);
  assert.deepEqual(getWork(db, westworld.id), westworldBefore);
});

test('the auto path never moves a watched entry back; watching -> want is still allowed', (t) => {
  const db = setup(t);
  const her = add(db, { work_type: 'movie', title: '她', status: 'watched', rating: '9' });
  const mirror = add(db, { work_type: 'series', title: '黑镜', status: 'watching' });
  const refMap = { W1: her.id, W2: mirror.id };

  // 晚到的旧批次带着「想看」
  apply(db, [item({ ref: 'W1', title: '她', status: 'want' })], refMap);
  assert.equal(getWork(db, her.id).status, 'watched');

  // 重看：状态保持看过，其它字段照常更新
  const rewatch = apply(db, [item({ ref: 'W1', title: '她', status: 'watching', progress: '重看到一半', note: '二刷' })], refMap);
  assert.deepEqual(rewatch.updated, [her.id]);
  const afterRewatch = getWork(db, her.id);
  assert.deepEqual([afterRewatch.status, afterRewatch.progress, afterRewatch.note], ['watched', '重看到一半', '二刷']);

  // 没给 ref、按名称命中时同样不降级
  apply(db, [item({ title: '《她》', status: 'want' })]);
  assert.equal(getWork(db, her.id).status, 'watched');

  apply(db, [item({ ref: 'W2', type: 'series', title: '黑镜', status: 'want' })], refMap);
  assert.equal(getWork(db, mirror.id).status, 'want', '在看 → 想看允许');
});

test('dismissed entries are never re-added nor modified', (t) => {
  const db = setup(t);
  const records = captureLogs(t);
  const infos = [];
  const originalInfo = console.info;
  console.info = line => infos.push(line);
  t.after(() => { console.info = originalInfo; });

  const dismissed = add(db, { work_type: 'book', title: '朝圣', aliases: ['The Pilgrimage'] });
  updateWork(db, dismissed.id, { dismissed: true }, T1);
  const before = getWork(db, dismissed.id);
  const active = add(db, { work_type: 'movie', title: '她' });
  // W1 快照时还是正常条目，处理前被用户移除
  updateWork(db, active.id, { dismissed: true }, T1);
  const activeBefore = getWork(db, active.id);

  const result = apply(db, [
    item({ type: 'book', title: 'the pilgrimage', status: 'want', rating: '8' }),
    item({ ref: 'W1', type: 'movie', title: '她', status: 'watching', note: '又想看' }),
  ], { W1: active.id });

  assert.deepEqual(result, { created: [], updated: [], skippedDismissed: 2, dropped: 0 });
  assert.deepEqual(getWork(db, dismissed.id), before);
  assert.deepEqual(getWork(db, active.id), activeBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_works').get().n, 2);
  assert.equal(infos.filter(line => line.includes('memory.works_catalog.dismissed_skipped')).length, 2);
  assert.deepEqual(records, [], '跳过已移除条目是预期行为，不报警告');
});

test('invalid items are dropped; a missing status only works for updates', (t) => {
  const db = setup(t);
  const her = add(db, { work_type: 'movie', title: '她', status: 'watching' });
  const result = apply(db, [
    item({ type: 'song', title: '晴天' }),
    item({ type: 'movie', title: '花样年华', status: 'loved' }),
    item({ type: 'movie', title: '《》' }),
    item({ type: 'movie', title: '   ' }),
    item({ type: 'movie', title: '花样年华', status: '' }),
    item({ ref: 'W1', type: 'movie', title: '她', status: '', rating: '9' }),
  ], { W1: her.id });
  assert.equal(result.dropped, 5);
  assert.deepEqual(result.updated, [her.id]);
  assert.equal(getWork(db, her.id).status, 'watching', '没给状态就保留原状态');
  assert.equal(getWork(db, her.id).rating, '9');
  assert.equal(listWorks(db, 'char-a').length, 1);
});

test('several items hitting the same entry apply in order within one batch', (t) => {
  const db = setup(t);
  const result = apply(db, [
    item({ type: 'series', title: '黑镜', status: 'want' }),
    item({ type: 'series', title: 'Black Mirror', aliases: ['黑镜'], status: 'watching', progress: '第一季第 1 集' }),
    item({ type: 'series', title: '黑镜', status: 'watching', progress: '第二季第 2 集' }),
  ]);
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.updated, [], '本批新建的条目不重复算作更新');
  const [entry] = listWorks(db, 'char-a');
  assert.equal(entry.id, result.created[0]);
  assert.equal(entry.status, 'watching');
  assert.equal(entry.progress, '第二季第 2 集');
  assert.deepEqual(entry.aliases, ['Black Mirror']);
});

test('the whole batch rolls back when any write fails', (t) => {
  const db = setup(t);
  const her = add(db, { work_type: 'movie', title: '她', status: 'want' });
  const before = getWork(db, her.id);
  db.exec(`
    CREATE TRIGGER fail_on_bomb BEFORE INSERT ON character_works
    WHEN NEW.title = '炸弹' BEGIN SELECT RAISE(ABORT, 'boom'); END;
  `);
  assert.throws(() => apply(db, [
    item({ ref: 'W1', title: '她', status: 'watched', rating: '9' }),
    item({ title: '新片' }),
    item({ title: '炸弹' }),
  ], { W1: her.id }), /boom/);
  assert.deepEqual(getWork(db, her.id), before);
  assert.deepEqual(listWorks(db, 'char-a', { includeDismissed: true }).map(e => e.id), [her.id]);
});

// ── 提示词 ──

test('prompt numbers only non-dismissed entries, lists dismissed by name, and does not re-expand placeholders', (t) => {
  const db = setup(t);
  const saul = add(db, { work_type: 'series', title: '风骚律师', status: 'watching', progress: '第三季' });
  const her = add(db, { work_type: 'movie', title: '她', aliases: ['Her'], rating: '9.0–9.5' });
  const gone = add(db, { work_type: 'book', title: '朝圣' });
  updateWork(db, gone.id, { dismissed: true }, T1);

  const conversation = '[M1] 用户 (时间): 我把 {current_works} 和 $& 都写进来了';
  const { prompt, refMap } = buildWorksCatalogUpdatePrompt(listWorks(db, 'char-a', { includeDismissed: true }), conversation);
  assert.deepEqual(refMap, { W1: her.id, W2: saul.id }, '编号按 listWorks 的确定性顺序，只给未移除条目');
  assert.ok(prompt.includes('W1 {"type":"movie","title":"她","aliases":["Her"],"status":"watched","rating":"9.0–9.5","progress":"","note":""}'));
  assert.ok(prompt.includes('W2 {"type":"series","title":"风骚律师"'));
  const dismissedSection = prompt.split('## 用户已排除，不要加回')[1].split('## 本轮对话')[0];
  assert.equal(dismissedSection.trim(), '- 《朝圣》');
  assert.ok(!/W\d+ \{[^\n]*朝圣/.test(prompt), '已移除条目不给编号');
  assert.ok(prompt.endsWith(`${conversation}\n\n请输出 JSON：`), '对话里的占位符与 $& 原样保留');

  const empty = buildWorksCatalogUpdatePrompt([], '对话');
  assert.deepEqual(empty.refMap, {});
  assert.ok(empty.prompt.includes('## 当前片单（编号 W1 起）\n（空）'));
  assert.ok(empty.prompt.includes('## 用户已排除，不要加回\n（无）'));
});

test('prompt contract: scope rule and "mention is not watched" rule are present', () => {
  const p = WORKS_CATALOG_UPDATE_PROMPT;
  assert.match(p, /只收录四类作品：电影（movie）、剧集或动画（series[^)]*）、书（book[^)]*）、游戏（game）/);
  assert.match(p, /不收录：用户自己创作的作品、教材和考试用书、歌曲/);
  assert.match(p, /只是提到作品名、引用台词、讨论剧情.*不算看过，不要记录/);
  assert.match(p, /已在当前片单里的作品必须用 ref 指认/);
  assert.match(p, /看过的作品再次提到（重看、想再看）时保持 watched/);
  assert.match(p, /\{"works":\[\]\}/);
  assert.match(p, /用户已排除，不要加回/);
  assert.ok(!p.includes('主人'), '提示词用「用户」');
  for (const placeholder of ['{current_works}', '{dismissed_works}', '{conversation_text}']) {
    assert.ok(p.includes(placeholder), placeholder);
  }
});

// ── 队列 ──

test('enqueue skips ignore_memory conversations and empty text', (t) => {
  const db = setup(t);
  db.prepare("INSERT INTO conversations (id, character_id, title, ignore_memory) VALUES ('conv-on', 'char-a', '', 0), ('conv-off', 'char-a', '', 1)").run();
  const input = { sourceText: '用户: 我看完了《她》', sourceMsgIds: ['m1', 'm2', 'm1'], sourceTime: T1 };

  assert.equal(enqueueWorksCatalogUpdate('char-a', { ...input, conversationId: 'conv-off' }, db), null);
  assert.equal(enqueueWorksCatalogUpdate('char-a', { ...input, sourceText: '  \n', conversationId: 'conv-on' }, db), null);
  assert.equal(taskRows(db).length, 0);

  const id = enqueueWorksCatalogUpdate('char-a', { ...input, conversationId: 'conv-on' }, db);
  const [row] = taskRows(db);
  assert.equal(row.id, id);
  assert.equal(row.status, 'pending');
  assert.equal(row.conversation_id, 'conv-on');
  assert.equal(row.source_text, input.sourceText);
  assert.deepEqual(JSON.parse(row.source_msg_ids), ['m1', 'm2']);
  assert.equal(row.source_time, T1);
});

test('process: enqueue -> fake LLM -> catalog updated and task done', async (t) => {
  const db = setup(t);
  const her = add(db, { work_type: 'movie', title: '她', status: 'want' });
  enqueueWorksCatalogUpdate('char-a', {
    sourceText: '[M1] 用户: 昨晚看完了《Her》，给 9 分。还想看《黑镜》。',
    sourceMsgIds: ['m1', 'm2'], sourceTime: T1, conversationId: null,
  }, db);

  const prompts = [];
  const result = await processWorksCatalogUpdateTasks({
    db,
    callLlm: async ({ characterId, prompt }) => {
      prompts.push({ characterId, prompt });
      return '```json\n' + JSON.stringify({ works: [
        { ref: 'W1', type: 'movie', title: '她', aliases: ['Her'], status: 'watched', rating: '9 分', progress: '', note: '' },
        { ref: null, type: 'series', title: '黑镜', aliases: ['Black Mirror'], status: 'want', rating: '', progress: '', note: '' },
      ] }) + '\n```';
    },
  });

  assert.deepEqual(result, { processed: 1, skipped: 0, failed: 0, retried: 0, retryDelayMs: 0, claimed: 1, remaining: 0 });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].characterId, 'char-a');
  assert.ok(prompts[0].prompt.includes('W1 {"type":"movie","title":"她"'));
  assert.ok(prompts[0].prompt.includes('昨晚看完了《Her》'));

  const updated = getWork(db, her.id);
  assert.deepEqual([updated.status, updated.rating, updated.aliases], ['watched', '9 分', ['Her']]);
  assert.deepEqual(updated.source_msg_ids, ['m1', 'm2']);
  const mirror = listWorks(db, 'char-a').find(e => e.title === '黑镜');
  assert.equal(mirror.first_seen_at, T1);
  const [task] = taskRows(db);
  assert.equal(task.status, 'done');
  assert.equal(task.claim_token, null);
  assert.equal(task.error_message, null);
});

test('process: empty works output completes the task without touching the catalog', async (t) => {
  const db = setup(t);
  const her = add(db, { work_type: 'movie', title: '她' });
  enqueueWorksCatalogUpdate('char-a', { sourceText: '今天天气不错', sourceMsgIds: ['m1'], sourceTime: T1, conversationId: null }, db);
  const result = await processWorksCatalogUpdateTasks({ db, callLlm: async () => '{"works":[]}' });
  assert.equal(result.skipped, 1);
  assert.deepEqual(getWork(db, her.id), her);
  assert.equal(taskRows(db)[0].status, 'done');
});

test('process: unparseable response or LLM error fails the task with a log and leaves the catalog unchanged', async (t) => {
  const db = setup(t);
  const records = captureLogs(t);
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  t.after(() => { console.error = originalError; console.warn = originalWarn; });

  const her = add(db, { work_type: 'movie', title: '她' });
  const snapshot = listWorks(db, 'char-a', { includeDismissed: true });
  enqueueWorksCatalogUpdate('char-a', { sourceText: '我看完了《她》', sourceMsgIds: ['m1'], sourceTime: T1, conversationId: null }, db);
  enqueueWorksCatalogUpdate('char-a', { sourceText: '我想看《黑镜》', sourceMsgIds: ['m2'], sourceTime: T1, conversationId: null }, db);

  // 任务 1 一直返回不可解析的文本，任务 2 一直报错；每轮都要先把任务 1 的次数用完才轮到任务 2
  const order = [];
  const callLlm = async ({ prompt }) => {
    const isFirst = prompt.includes('我看完了《她》');
    order.push(isFirst ? 1 : 2);
    if (isFirst) return '片单没有变化。';
    throw new Error('upstream 503');
  };
  const rounds = [];
  for (let i = 0; i < 10; i += 1) {
    const result = await processWorksCatalogUpdateTasks({ db, callLlm });
    if (result.claimed === 0) break;
    rounds.push(result);
  }

  assert.deepEqual(order, [1, 1, 1, 2, 2, 2], '失败的任务按 id 顺序先重试，后面的任务不插队');
  assert.equal(rounds.reduce((n, r) => n + r.retried, 0), 4);
  assert.equal(rounds.reduce((n, r) => n + r.failed, 0), 2);
  assert.equal(rounds[0].claimed, 2, '第一轮认领两个，任务 1 失败后任务 2 被一并放回');
  // 直接调用不等待，只报告退避时间（默认表）；用完次数的那一轮没有重试，报 0
  assert.deepEqual(rounds.map(r => r.retryDelayMs), [5000, 30000, 5000, 30000, 0]);
  assert.deepEqual(listWorks(db, 'char-a', { includeDismissed: true }), snapshot);
  assert.deepEqual(getWork(db, her.id), her);
  const rows = taskRows(db);
  assert.deepEqual(rows.map(r => [r.status, r.retry_count, r.claim_token]), [['failed', 3, null], ['failed', 3, null]]);
  assert.match(rows[0].error_message, /parsing failed/);
  assert.match(rows[1].error_message, /upstream 503/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_candidates').get().n, 0, '不写提取候选表');

  const failures = records.filter(r => r.event === 'memory.works_catalog.update_failed');
  assert.equal(failures.length, 2, '只有用完次数才记 update_failed');
  assert.equal(records.filter(r => r.event === 'memory.works_catalog.update_retrying').length, 4);
  assert.equal(failures[0].fields.characterId, 'char-a');
  assert.equal(failures[0].fields.status, 'failed');

  // 与画像队列同一规则：failed 是终态，不会被下一轮自动认领
  const again = await processWorksCatalogUpdateTasks({ db, callLlm: async () => { throw new Error('should not run'); } });
  assert.equal(again.claimed, 0);
});

test('process: a write failure inside the batch fails the task and rolls the batch back', async (t) => {
  const db = setup(t);
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  t.after(() => { console.error = originalError; console.warn = originalWarn; });
  const her = add(db, { work_type: 'movie', title: '她', status: 'want' });
  db.exec(`
    CREATE TRIGGER fail_on_bomb BEFORE INSERT ON character_works
    WHEN NEW.title = '炸弹' BEGIN SELECT RAISE(ABORT, 'boom'); END;
  `);
  enqueueWorksCatalogUpdate('char-a', { sourceText: '对话', sourceMsgIds: ['m1'], sourceTime: T1, conversationId: null }, db);
  const callLlm = async () => JSON.stringify({ works: [
    { ref: 'W1', type: 'movie', title: '她', status: 'watched' },
    { ref: null, type: 'movie', title: '炸弹', status: 'watched' },
  ] });
  let failed = 0;
  for (let i = 0; i < 10; i += 1) {
    const result = await processWorksCatalogUpdateTasks({ db, callLlm });
    if (result.claimed === 0) break;
    failed += result.failed;
  }
  assert.equal(failed, 1);
  assert.equal(taskRows(db)[0].retry_count, 3);
  assert.deepEqual(getWork(db, her.id), her);
  assert.equal(taskRows(db)[0].status, 'failed');
});

test('process: a task whose lease was taken over does not write', async (t) => {
  const db = setup(t);
  const her = add(db, { work_type: 'movie', title: '她', status: 'want' });
  enqueueWorksCatalogUpdate('char-a', { sourceText: '对话', sourceMsgIds: ['m1'], sourceTime: T1, conversationId: null }, db);
  await processWorksCatalogUpdateTasks({
    db,
    callLlm: async () => {
      // 模型调用期间租约被回收并被另一处理者认领
      db.prepare("UPDATE character_works_update_tasks SET claim_token = 'other-worker'").run();
      return JSON.stringify({ works: [{ ref: 'W1', type: 'movie', title: '她', status: 'watched' }] });
    },
  });
  assert.equal(getWork(db, her.id).status, 'want');
  assert.equal(taskRows(db)[0].claim_token, 'other-worker');
});

test('stale processing tasks are recovered at boot; unexpired leases are left alone', (t) => {
  const db = setup(t);
  const insert = db.prepare(`
    INSERT INTO character_works_update_tasks (character_id, source_text, status, claim_token, lease_expires_at)
    VALUES ('char-a', ?, 'processing', ?, ?)
  `);
  insert.run('过期', 'old-token', '2000-01-01 00:00:00');
  insert.run('无租约', 'no-lease', null);
  // 未过期租约设在一小时后：recoverAndWakeAtLeaseExpiry 的补跑定时器是 unref 的，不会在用例结束后触发
  insert.run('进行中', 'live-token', db.prepare("SELECT datetime('now', '+1 hour') AS t").get().t);

  let triggers = 0;
  recoverAndWakeAtLeaseExpiry(db, 'character_works_update_tasks', {
    recover: () => recoverStaleWorksCatalogTasks(db),
    trigger: () => { triggers += 1; },
  }, error => { throw error; });

  const rows = taskRows(db);
  assert.deepEqual(rows.map(r => [r.source_text, r.status, r.claim_token]), [
    ['过期', 'pending', null],
    ['无租约', 'pending', null],
    ['进行中', 'processing', 'live-token'],
  ]);
  assert.equal(triggers, 1);
});

test('db boot registry recovers and wakes the works catalog queue', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'db.ts'), 'utf8');
  const boot = source.slice(source.indexOf('const BACKGROUND_QUEUE_BOOT'), source.indexOf('export function ensureMemoryProfileTables'));
  assert.match(boot, /await import\('@\/lib\/works-catalog-update'\)[\s\S]*?recoverAndWakeAtLeaseExpiry\(getDb\(\), 'character_works_update_tasks', \{\s*recover: recoverStaleWorksCatalogTasks,\s*trigger: triggerWorksCatalogQueue,/);
});

test('background drain backs off between attempts and keeps later tasks behind the failing one', async (t) => {
  const db = setup(t);
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  t.after(() => { console.error = originalError; console.warn = originalWarn; });
  for (const [key, value] of [['api_base', 'https://llm.example/v1'], ['api_key', 'test-key'], ['model', 'fake-model']]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }
  const her = add(db, { work_type: 'movie', title: '她', status: 'want' });

  // 任务一前两次 429、第三次成功；任务二一次成功
  const calls = [];
  const worksUpdate = requireFreshWithMocks('../src/lib/works-catalog-update.ts', {
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async (_settings, messages) => {
        const task = messages.at(-1).content.includes('任务一') ? 1 : 2;
        calls.push({ task, at: performance.now() });
        if (task === 1 && calls.filter(c => c.task === 1).length < 3) throw new Error('upstream 429');
        return JSON.stringify({ works: task === 1
          ? [{ ref: 'W1', type: 'movie', title: '她', status: 'watched' }]
          : [{ ref: null, type: 'series', title: '黑镜', status: 'want' }] });
      },
    },
  });
  const DELAYS = [40, 80];
  worksUpdate.__setWorksCatalogRetryDelaysForTests(DELAYS);
  t.after(() => worksUpdate.__setWorksCatalogRetryDelaysForTests(null));

  enqueueWorksCatalogUpdate('char-a', { sourceText: '任务一：我看完了《她》', sourceMsgIds: ['m1'], sourceTime: T1, conversationId: null }, db);
  enqueueWorksCatalogUpdate('char-a', { sourceText: '任务二：我想看《黑镜》', sourceMsgIds: ['m2'], sourceTime: T1, conversationId: null }, db);
  worksUpdate.triggerWorksCatalogQueue();
  const rows = await waitForTaskSettled(db);

  assert.deepEqual(calls.map(c => c.task), [1, 1, 1, 2], '退避期间后面的任务不插队');
  const gaps = [calls[1].at - calls[0].at, calls[2].at - calls[1].at];
  // 计时器精度按 5ms 放宽；立刻重试时间隔只有几毫秒
  assert.ok(gaps[0] >= DELAYS[0] - 5, `第一次重试前应等待约 ${DELAYS[0]}ms，实际 ${gaps[0].toFixed(1)}ms`);
  assert.ok(gaps[1] >= DELAYS[1] - 5, `第二次重试前应等待约 ${DELAYS[1]}ms，实际 ${gaps[1].toFixed(1)}ms`);
  assert.deepEqual(rows.map(r => [r.status, r.retry_count]), [['done', 2], ['done', 0]]);
  assert.equal(getWork(db, her.id).status, 'watched');
  assert.deepEqual(listWorks(db, 'char-a').map(e => e.title).sort(), ['她', '黑镜'].sort());
});

// ── 与提取队列的衔接 ──

function seedConversation(db, { ignoreMemory = 0 } = {}) {
  db.prepare("INSERT INTO conversations (id, character_id, title, ignore_memory) VALUES ('conv-a', 'char-a', '', ?)").run(ignoreMemory);
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at, metadata, seq)
    VALUES (?, 'conv-a', ?, ?, ?, '{}', ?)
  `);
  insertMessage.run('msg-u1', 'user', '昨晚终于看完了《Her》，我给 9 分。', '2026-11-20T12:00:00.000Z', 1);
  insertMessage.run('msg-empty', 'user', '', '2026-11-20T12:00:30.000Z', 2);
  insertMessage.run('msg-a1', 'assistant', '真好，那部电影的配色很美。', '2026-11-20T12:01:00.000Z', 3);
  db.prepare(`
    INSERT INTO memory_tasks (character_id, conversation_id, message_ids, created_at, updated_at)
    VALUES ('char-a', 'conv-a', ?, ?, ?)
  `).run(JSON.stringify(['msg-u1', 'msg-empty', 'msg-a1']), NOW, NOW);
  for (const [key, value] of [['api_base', 'https://llm.example/v1'], ['api_key', 'test-key'], ['model', 'fake-model']]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }
}

/** 加载真实 memory-queue 与 works-catalog-update，只替换提取结果、画像入队和上游 LLM。 */
function loadQueue({ extraction, chatCompletion }) {
  const calls = { profile: 0, llm: [] };
  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/memory-engine': {
      extractMemories: async () => extraction,
      getCommittedExtractionResult: () => null,
      retrieveRelevantMemories: () => [],
    },
    '@/lib/memory-extraction-reference': {
      buildExtractionOverview: () => ({ profileText: '', priorityText: '' }),
      buildLifecycleReference: async () => ({ text: '', memories: [], mode: 'none', diagnostics: {} }),
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => { calls.profile += 1; },
      triggerMemoryProfileQueue: () => {},
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async (settings, messages) => {
        calls.llm.push({ settings, messages });
        return chatCompletion(settings, messages);
      },
    },
  }, ['../src/lib/works-catalog-update.ts']);
  // 上面由 memory-queue 重新载入的片单模块实例：去掉退避，重试用例不用等几十秒
  require('../src/lib/works-catalog-update.ts').__setWorksCatalogRetryDelaysForTests([]);
  return { queue, calls };
}

async function waitForTaskSettled(db) {
  for (let i = 0; i < 200; i += 1) {
    const rows = taskRows(db);
    if (rows.length > 0 && rows.every(r => r.status === 'done' || r.status === 'failed')) return rows;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('works catalog task did not settle');
}

function extractionTask(db) {
  return db.prepare('SELECT status, error_message FROM memory_tasks WHERE id = 1').get();
}

function userMessageExtracted(db) {
  return JSON.parse(db.prepare("SELECT metadata FROM messages WHERE id = 'msg-u1'").get().metadata).memory_extracted === true;
}

test('end to end: successful extraction enqueues the catalog update and the real LLM path updates the catalog', async (t) => {
  const db = setup(t);
  seedConversation(db);
  const { queue, calls } = loadQueue({
    extraction: { insertCount: 1, mergeCount: 0 },
    chatCompletion: async () => JSON.stringify({ works: [
      { ref: null, type: 'movie', title: '她', aliases: ['Her'], status: 'watched', rating: '9 分', progress: '', note: '' },
    ] }),
  });

  await queue.__processQueueForTest();
  assert.equal(extractionTask(db).status, 'done');
  assert.equal(calls.profile, 1);

  const [task] = await waitForTaskSettled(db);
  assert.equal(task.status, 'done');
  assert.equal(task.conversation_id, 'conv-a');
  assert.deepEqual(JSON.parse(task.source_msg_ids), ['msg-u1', 'msg-a1'], '只记实际进入对话文本的消息');
  assert.equal(task.source_time, '2026-11-20T12:01:00.000Z');
  assert.match(task.source_text, /^\[M1\] 用户 \(.*昨晚终于看完了《Her》/);

  assert.equal(calls.llm.length, 1);
  assert.equal(calls.llm[0].settings.model, 'fake-model');
  assert.equal(calls.llm[0].settings.json_mode, true);
  assert.equal(calls.llm[0].settings.max_tokens >= 16384, true);
  assert.ok(calls.llm[0].messages.at(-1).content.includes('昨晚终于看完了《Her》'));

  const [entry] = listWorks(db, 'char-a');
  assert.deepEqual(
    [entry.title, entry.aliases, entry.status, entry.rating, entry.first_seen_at, entry.source_msg_ids],
    ['她', ['Her'], 'watched', '9 分', '2026-11-20T12:01:00.000Z', ['msg-u1', 'msg-a1']],
  );
});

test('zero extraction results do not enqueue a catalog update', async (t) => {
  const db = setup(t);
  seedConversation(db);
  const { queue, calls } = loadQueue({
    extraction: { insertCount: 0, mergeCount: 0 },
    chatCompletion: async () => { throw new Error('should not run'); },
  });
  await queue.__processQueueForTest();
  assert.equal(extractionTask(db).status, 'done');
  assert.equal(taskRows(db).length, 0);
  assert.equal(calls.llm.length, 0);
});

test('ignore_memory conversations do not enqueue a catalog update even when extraction runs', async (t) => {
  // 聊天自动触发对 ignore_memory 对话直接不提取；手动提取接口不检查该开关，提取仍可能成功，
  // 这里锁定片单这一侧的拦截。
  const db = setup(t);
  seedConversation(db, { ignoreMemory: 1 });
  const { queue, calls } = loadQueue({
    extraction: { insertCount: 2, mergeCount: 1 },
    chatCompletion: async () => { throw new Error('should not run'); },
  });
  await queue.__processQueueForTest();
  assert.equal(extractionTask(db).status, 'done');
  assert.equal(calls.profile, 1, '画像入队维持原样');
  assert.equal(taskRows(db).length, 0);
  assert.equal(calls.llm.length, 0);
});

test('catalog enqueue failure does not affect extraction or the profile enqueue', async (t) => {
  const db = setup(t);
  const records = captureLogs(t);
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  t.after(() => { console.error = originalError; console.warn = originalWarn; });
  seedConversation(db);
  db.exec('DROP TABLE character_works_update_tasks');
  const { queue, calls } = loadQueue({
    extraction: { insertCount: 1, mergeCount: 0 },
    chatCompletion: async () => { throw new Error('should not run'); },
  });
  await queue.__processQueueForTest();
  assert.deepEqual(extractionTask(db), { status: 'done', error_message: null });
  assert.equal(userMessageExtracted(db), true);
  assert.equal(calls.profile, 1);
  assert.equal(records.filter(r => r.event === 'memory.works_catalog.enqueue_failed').length, 1);
});

test('catalog LLM failure leaves the extraction result intact and the catalog task failed', async (t) => {
  const db = setup(t);
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  t.after(() => { console.error = originalError; console.warn = originalWarn; });
  seedConversation(db);
  const { queue } = loadQueue({
    extraction: { insertCount: 1, mergeCount: 0 },
    chatCompletion: async () => { throw new Error('upstream 500'); },
  });
  await queue.__processQueueForTest();
  assert.deepEqual(extractionTask(db), { status: 'done', error_message: null });
  assert.equal(userMessageExtracted(db), true);
  const [task] = await waitForTaskSettled(db);
  assert.deepEqual([task.status, task.retry_count], ['failed', 3], '后台排空会按顺序重试，用完次数才失败');
  assert.match(task.error_message, /upstream 500/);
  assert.equal(listWorks(db, 'char-a').length, 0);
});
