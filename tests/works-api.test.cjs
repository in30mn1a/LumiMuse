const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();

const { __migrateForTests } = require('../src/lib/db.ts');
const { createWork, getWork } = require('../src/lib/works-catalog.ts');

const originalLoad = Module._load;

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return { status: init.status ?? 200, body, async json() { return body; } };
      },
    },
  };
}

let currentDb = null;
const mocks = {
  'next/server': jsonResponseMock(),
  '@/lib/db': { getDb: () => currentDb },
};

function requireFreshWithMocks(modulePath) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const listRoute = requireFreshWithMocks('../src/app/api/works/route.ts');
const itemRoute = requireFreshWithMocks('../src/app/api/works/[id]/route.ts');

const T0 = '2026-05-01T00:00:00.000Z';

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '甲'), ('char-b', '乙')").run();
  currentDb = db;
  t.after(() => {
    currentDb = null;
    db.close();
  });
  return db;
}

function request(url, body) {
  return {
    nextUrl: new URL(url, 'http://test.local'),
    async json() {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

const ctx = id => ({ params: Promise.resolve({ id }) });

async function list(characterId, { includeDismissed = false } = {}) {
  const query = `character_id=${encodeURIComponent(characterId)}${includeDismissed ? '&include_dismissed=1' : ''}`;
  const response = await listRoute.GET(request(`/api/works?${query}`));
  assert.equal(response.status, 200);
  return response.body;
}

async function post(body) {
  return listRoute.POST(request('/api/works', body));
}

async function put(id, body, characterId = 'char-a') {
  const query = characterId ? `?character_id=${encodeURIComponent(characterId)}` : '';
  return itemRoute.PUT(request(`/api/works/${id}${query}`, body), ctx(id));
}

async function getItem(id, { characterId = 'char-a', sources = false } = {}) {
  const params = new URLSearchParams();
  if (characterId) params.set('character_id', characterId);
  if (sources) params.set('include_sources', '1');
  return itemRoute.GET(request(`/api/works/${id}?${params}`), ctx(id));
}

async function createOk(body) {
  const response = await post({ character_id: 'char-a', status: 'watched', ...body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

test('GET requires character_id and lists only that character, dismissed on request', async t => {
  setup(t);
  const missing = await listRoute.GET(request('/api/works'));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'character_id is required');

  const her = await createOk({ work_type: 'movie', title: '她' });
  const kept = await createOk({ work_type: 'book', title: '三体' });
  await post({ character_id: 'char-b', work_type: 'movie', title: '乙的电影', status: 'want' });
  assert.equal((await put(her.id, { dismissed: true })).status, 200);

  assert.deepEqual((await list('char-a')).map(w => w.id), [kept.id]);
  assert.deepEqual((await list('char-a', { includeDismissed: true })).map(w => w.id).sort(), [her.id, kept.id].sort());
  assert.deepEqual((await list('char-b')).map(w => w.title), ['乙的电影']);
  assert.deepEqual(await list('char-missing'), []);
});

test('POST creates an entry with all optional fields and no evidence', async t => {
  setup(t);
  const work = await createOk({
    work_type: 'series', title: '  《风骚律师》 ', aliases: ['Better Call Saul', ''], status: 'watching',
    rating: ' 9.5 ', progress: '第二季第 2 集', note: '慢热但好看',
  });
  assert.equal(work.character_id, 'char-a');
  assert.equal(work.title, '风骚律师');
  assert.deepEqual(work.aliases, ['Better Call Saul']);
  assert.equal(work.status, 'watching');
  assert.equal(work.rating, '9.5');
  assert.equal(work.progress, '第二季第 2 集');
  assert.equal(work.note, '慢热但好看');
  assert.deepEqual(work.source_memory_ids, []);
  assert.deepEqual(work.source_msg_ids, []);
  assert.equal(work.dismissed_at, null);
});

test('POST rejects invalid bodies without writing anything', async t => {
  const db = setup(t);
  const cases = [
    [request('/api/works', new SyntaxError('bad json')), 'Invalid JSON body', null],
    [request('/api/works', []), 'Invalid request body', null],
    [request('/api/works', { character_id: 'char-a', work_type: 'movie', status: 'watched' }), 'Invalid request body', 'title'],
    [request('/api/works', { character_id: 'char-a', work_type: 'music', title: 'x', status: 'watched' }), 'Invalid request body', 'work_type'],
    [request('/api/works', { character_id: 'char-a', work_type: 'movie', title: 'x', status: 'seen' }), 'Invalid request body', 'status'],
    [request('/api/works', { character_id: 'char-a', work_type: 'movie', title: '《》', status: 'watched' }), 'Invalid request body', 'title'],
    [request('/api/works', { character_id: 'char-a', work_type: 'movie', title: '她'.repeat(101), status: 'watched' }), 'Invalid request body', 'title'],
    [request('/api/works', { character_id: 'char-a', work_type: 'movie', title: 'x', status: 'watched', note: '好'.repeat(61) }), 'Invalid request body', 'note'],
    [request('/api/works', { character_id: 'char-a', work_type: 'movie', title: 'x', status: 'watched', rating: '1'.repeat(17) }), 'Invalid request body', 'rating'],
    [request('/api/works', { character_id: 'char-a', work_type: 'movie', title: 'x', status: 'watched', progress: '集'.repeat(41) }), 'Invalid request body', 'progress'],
    [request('/api/works', { character_id: 'char-a', work_type: 'movie', title: 'x', status: 'watched', aliases: Array.from({ length: 9 }, (_, i) => `a${i}`) }), 'Invalid request body', 'aliases'],
    [request('/api/works', { character_id: 'char-a', work_type: 'movie', title: 'x', status: 'watched', aliases: ['名'.repeat(101)] }), 'Invalid request body', 'aliases'],
  ];
  for (const [req, error, field] of cases) {
    const response = await listRoute.POST(req);
    assert.equal(response.status, 400, `${error} ${field}`);
    assert.equal(response.body.error, error);
    if (field) assert.ok(Array.isArray(response.body.fieldErrors[field]), `fieldErrors.${field} missing: ${JSON.stringify(response.body.fieldErrors)}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_works').get().n, 0, 'nothing truncated and written');

  // 上限按字符数算：60 个字（含 emoji）的印象正好放得下
  const atLimit = await createOk({ work_type: 'movie', title: '她', note: '😀'.repeat(60) });
  assert.equal(Array.from(atLimit.note).length, 60);

  const unknown = await post({ character_id: 'char-missing', work_type: 'movie', title: '她', status: 'watched' });
  assert.equal(unknown.status, 404);
});

test('POST returns 409 for a matching title or alias, telling the client to edit or restore', async t => {
  setup(t);
  const saul = await createOk({ work_type: 'series', title: '风骚律师', aliases: ['Better Call Saul'] });

  const byTitle = await post({ character_id: 'char-a', work_type: 'series', title: '《风骚律师》', status: 'want' });
  assert.equal(byTitle.status, 409);
  assert.equal(byTitle.body.code, 'work_exists');
  assert.match(byTitle.body.error, /edit/);
  assert.equal(byTitle.body.work.id, saul.id);

  const byAlias = await post({ character_id: 'char-a', work_type: 'series', title: 'better call saul', status: 'want' });
  assert.equal(byAlias.status, 409);
  assert.equal(byAlias.body.work.id, saul.id);

  const newAliasHitsTitle = await post({ character_id: 'char-a', work_type: 'series', title: '绝命律师', aliases: ['风骚律师'], status: 'want' });
  assert.equal(newAliasHitsTitle.status, 409);

  const her = await createOk({ work_type: 'movie', title: '她', aliases: ['Her'] });
  assert.equal((await put(her.id, { dismissed: true })).status, 200);
  const dismissed = await post({ character_id: 'char-a', work_type: 'movie', title: 'Her', status: 'want' });
  assert.equal(dismissed.status, 409);
  assert.equal(dismissed.body.code, 'work_dismissed');
  assert.match(dismissed.body.error, /restore/);
  assert.equal(dismissed.body.work.id, her.id);

  // 不同类型、不同角色不算重复
  assert.equal((await post({ character_id: 'char-a', work_type: 'book', title: '风骚律师', status: 'want' })).status, 201);
  assert.equal((await post({ character_id: 'char-b', work_type: 'series', title: '风骚律师', status: 'want' })).status, 201);
});

test('PUT updates fields and lets a manual edit clear rating, progress, note and aliases', async t => {
  setup(t);
  const work = await createOk({
    work_type: 'series', title: '黑镜', aliases: ['Black Mirror'], status: 'watching',
    rating: '9', progress: '第二季第 2 集', note: '很压抑',
  });
  const updated = await put(work.id, { status: 'watched', rating: '', progress: '', note: '', aliases: [] });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.status, 'watched');
  assert.equal(updated.body.rating, '');
  assert.equal(updated.body.progress, '');
  assert.equal(updated.body.note, '');
  assert.deepEqual(updated.body.aliases, []);
  assert.equal(updated.body.title, '黑镜');

  const renamed = await put(work.id, { title: '黑镜（英剧）', work_type: 'series', aliases: ['Black Mirror'] });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, '黑镜（英剧）');
  assert.deepEqual(renamed.body.aliases, ['Black Mirror']);
});

test('PUT validates the body and the claimed character before touching the entry', async t => {
  const db = setup(t);
  const work = await createOk({ work_type: 'movie', title: '她', note: '原样' });
  const before = getWork(db, work.id);

  const invalidJson = await itemRoute.PUT(request(`/api/works/${work.id}?character_id=char-a`, new SyntaxError('bad')), ctx(work.id));
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.error, 'Invalid JSON body');

  const noFields = await put(work.id, {});
  assert.equal(noFields.status, 400);
  assert.equal(noFields.body.error, 'No fields to update');

  const unknownOnly = await put(work.id, { source_memory_ids: ['m1'] });
  assert.equal(unknownOnly.status, 400, 'evidence is not writable through the manual API');

  const tooLong = await put(work.id, { note: '好'.repeat(61) });
  assert.equal(tooLong.status, 400);
  assert.ok(Array.isArray(tooLong.body.fieldErrors.note));

  const emptyTitle = await put(work.id, { title: '  ' });
  assert.equal(emptyTitle.status, 400);
  assert.ok(Array.isArray(emptyTitle.body.fieldErrors.title));

  const badDismissed = await put(work.id, { dismissed: 'yes' });
  assert.equal(badDismissed.status, 400);

  const noClaim = await put(work.id, { note: '改了' }, null);
  assert.equal(noClaim.status, 400);
  assert.equal(noClaim.body.error, 'character_id is required');

  const missing = await put('no-such-work', { note: '改了' });
  assert.equal(missing.status, 404);

  assert.deepEqual(getWork(db, work.id), before, 'rejected requests leave the entry untouched');
});

test('dismiss hides the entry and restore brings back every field unchanged', async t => {
  const db = setup(t);
  const work = await createOk({
    work_type: 'game', title: '塞尔达传说：旷野之息', aliases: ['旷野之息'], status: 'watching',
    rating: '10', progress: '四神兽打完', note: '最爱',
  });
  // 依据只来自自动更新和提案；这里直接写库模拟已有依据，验证恢复后依据也在
  db.prepare('UPDATE character_works SET source_memory_ids = ? WHERE id = ?').run(JSON.stringify(['mem-1']), work.id);
  const before = getWork(db, work.id);

  const dismissed = await put(work.id, { dismissed: true });
  assert.equal(dismissed.status, 200);
  assert.notEqual(dismissed.body.dismissed_at, null);
  assert.deepEqual((await list('char-a')).map(w => w.id), []);
  assert.deepEqual((await list('char-a', { includeDismissed: true })).map(w => w.id), [work.id]);

  const restored = await put(work.id, { dismissed: false });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.dismissed_at, null);
  for (const field of ['work_type', 'title', 'status', 'rating', 'progress', 'note', 'first_seen_at', 'created_at']) {
    assert.equal(restored.body[field], before[field], field);
  }
  assert.deepEqual(restored.body.aliases, before.aliases);
  assert.deepEqual(restored.body.source_memory_ids, ['mem-1']);
  assert.deepEqual((await list('char-a')).map(w => w.id), [work.id]);
});

test('PUT returns 409 when a rename, retype, alias edit or restore would duplicate another active entry', async t => {
  setup(t);
  const her = await createOk({ work_type: 'movie', title: '她', aliases: ['Her'] });
  const other = await createOk({ work_type: 'movie', title: '爱在黎明破晓前' });
  const book = await createOk({ work_type: 'book', title: 'Her' });

  const rename = await put(other.id, { title: 'her' });
  assert.equal(rename.status, 409);
  assert.equal(rename.body.code, 'work_exists');
  assert.equal(rename.body.work.id, her.id);

  const alias = await put(other.id, { aliases: ['《她》'] });
  assert.equal(alias.status, 409);

  const retype = await put(book.id, { work_type: 'movie' });
  assert.equal(retype.status, 409);
  assert.equal(retype.body.work.id, her.id);

  // 改自己的字段、保留自己的名字不算重复
  assert.equal((await put(her.id, { title: '她', aliases: ['Her', 'HER（2013）'], note: '配乐好' })).status, 200);

  // 撞上已移除的条目不拦（恢复时才拦）
  const ghost = await createOk({ work_type: 'movie', title: '花样年华' });
  assert.equal((await put(ghost.id, { dismissed: true })).status, 200);
  const intoDismissed = await put(other.id, { title: '花样年华' });
  assert.equal(intoDismissed.status, 200);
  const restore = await put(ghost.id, { dismissed: false });
  assert.equal(restore.status, 409);
  assert.equal(restore.body.work.id, other.id);
});

test('PUT checks only newly introduced names, so a pre-existing overlap does not lock either entry', async t => {
  const db = setup(t);
  const her = await createOk({ work_type: 'movie', title: '她', aliases: ['Her'] });
  const other = await createOk({ work_type: 'movie', title: '爱在黎明破晓前' });
  // 模拟自动更新、批准的提案或旧数据留下的重名：直接写库给 other 也加上别名 Her
  db.prepare('UPDATE character_works SET aliases = ? WHERE id = ?').run(JSON.stringify(['Her']), other.id);

  const edits = [
    [her.id, { status: 'want' }],
    [other.id, { rating: '8' }],
    // 连同没改的名称一起发回来也不算新名称
    [her.id, { title: '她', aliases: ['Her'], status: 'watching' }],
    [other.id, { title: '爱在黎明破晓前（1995）' }],
    [other.id, { aliases: ['HER', 'Before Sunrise'] }],
    [other.id, { work_type: 'movie', note: '类型没变' }],
  ];
  for (const [id, body] of edits) {
    const response = await put(id, body);
    assert.equal(response.status, 200, JSON.stringify({ body, response: response.body }));
  }

  // 新加进来的名称撞上另一条仍然 409，且不写库
  const before = getWork(db, other.id);
  const clash = await put(other.id, { aliases: ['HER', 'Before Sunrise', '《她》'] });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'work_exists');
  assert.equal(clash.body.work.id, her.id);
  const renameClash = await put(other.id, { title: '她' });
  assert.equal(renameClash.status, 409);
  assert.equal(renameClash.body.work.id, her.id);
  assert.deepEqual(getWork(db, other.id), before);

  // 改类型：整条重新进入该类型，全部名称都要查（换走不撞，换回来撞上别名 Her）
  assert.equal((await put(other.id, { work_type: 'series' })).status, 200);
  const backToMovie = await put(other.id, { work_type: 'movie' });
  assert.equal(backToMovie.status, 409);
  assert.equal(backToMovie.body.work.id, her.id);

  // 恢复：同样查全部名称
  assert.equal((await put(other.id, { work_type: 'movie', dismissed: true })).status, 200);
  const restore = await put(other.id, { dismissed: false });
  assert.equal(restore.status, 409);
  assert.equal(restore.body.work.id, her.id);
  assert.notEqual(getWork(db, other.id).dismissed_at, null, 'a refused restore stays removed');
});

test('an entry of character B can neither be read nor edited through character A', async t => {
  const db = setup(t);
  const bWork = createWork(db, {
    character_id: 'char-b', work_type: 'movie', title: '乙的秘密片单', status: 'watched', note: '乙的印象',
  }, T0);
  const before = getWork(db, bWork.id);

  const read = await getItem(bWork.id, { characterId: 'char-a', sources: true });
  assert.equal(read.status, 403);
  assert.equal(read.body.error, 'Forbidden');
  assert.equal(read.body.title, undefined);
  assert.equal(read.body.sources, undefined);

  const noClaim = await getItem(bWork.id, { characterId: null });
  assert.equal(noClaim.status, 400);

  for (const body of [{ note: '甲改的' }, { dismissed: true }, { title: '改名' }]) {
    const edit = await put(bWork.id, body, 'char-a');
    assert.equal(edit.status, 403);
  }
  assert.deepEqual(getWork(db, bWork.id), before);

  const own = await getItem(bWork.id, { characterId: 'char-b' });
  assert.equal(own.status, 200);
  assert.equal(own.body.title, '乙的秘密片单');
});

test('GET include_sources returns this character\'s memories and message excerpts in evidence order', async t => {
  const db = setup(t);
  db.prepare("INSERT INTO conversations (id, character_id) VALUES ('conv-a', 'char-a'), ('conv-b', 'char-b')").run();
  const insertMemory = db.prepare('INSERT INTO memories (id, character_id, category, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertMemory.run('mem-a1', 'char-a', '偏好习惯', '用户看完了《她》，打了 9.5 分', 'active', T0, T0);
  insertMemory.run('mem-a2', 'char-a', '话题历史', '用户说《她》是最爱之一', 'archived', T0, T0);
  insertMemory.run('mem-b1', 'char-b', '偏好习惯', '乙角色的私密记忆', 'active', T0, T0);
  const insertMessage = db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)');
  const longText = `我昨晚看完了《她》。\n\n${'配乐和配色都特别好，'.repeat(20)}`;
  insertMessage.run('msg-a1', 'conv-a', 'user', longText, T0);
  insertMessage.run('msg-a2', 'conv-a', 'assistant', '那你最喜欢哪一段？', T0);
  insertMessage.run('msg-b1', 'conv-b', 'user', '乙对话里的私密消息', T0);

  const work = createWork(db, {
    character_id: 'char-a', work_type: 'movie', title: '她', status: 'watched',
    source_memory_ids: ['mem-a2', 'mem-b1', 'mem-gone', 'mem-a1'],
    source_msg_ids: ['msg-b1', 'msg-a2', 'msg-gone', 'msg-a1'],
  }, T0);

  const plain = await getItem(work.id);
  assert.equal(plain.status, 200);
  assert.equal(plain.body.sources, undefined, 'sources only on request');

  const response = await getItem(work.id, { sources: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.id, work.id);
  assert.equal(response.body.title, '她');
  const { memories, messages } = response.body.sources;
  assert.deepEqual(memories, [
    { id: 'mem-a2', content: '用户说《她》是最爱之一', status: 'archived', created_at: T0 },
    { id: 'mem-a1', content: '用户看完了《她》，打了 9.5 分', status: 'active', created_at: T0 },
  ]);
  assert.deepEqual(messages.map(m => [m.id, m.conversation_id, m.role]), [
    ['msg-a2', 'conv-a', 'assistant'],
    ['msg-a1', 'conv-a', 'user'],
  ]);
  assert.equal(messages[0].excerpt, '那你最喜欢哪一段？');
  assert.equal(messages[0].created_at, T0);
  const excerpt = messages[1].excerpt;
  assert.ok(excerpt.startsWith('我昨晚看完了《她》。 配乐'), 'whitespace is collapsed');
  assert.ok(excerpt.endsWith('…'));
  assert.equal(Array.from(excerpt).length, 121);
  assert.equal(messages[1].content, undefined, 'full message text is not sent');

  const serialized = JSON.stringify(response.body);
  // 别的角色的 id 仍留在条目自己的依据列表里，这里只校验它们的正文和对话不外泄
  for (const leaked of ['乙角色的私密记忆', '乙对话里的私密消息', 'conv-b']) {
    assert.ok(!serialized.includes(leaked), `leaked ${leaked}`);
  }
});

test('GET include_sources on an entry without evidence returns empty lists', async t => {
  setup(t);
  const work = await createOk({ work_type: 'book', title: '三体' });
  const response = await getItem(work.id, { sources: true });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.sources, { memories: [], messages: [] });

  const missing = await getItem('no-such-work', { sources: true });
  assert.equal(missing.status, 404);
});
