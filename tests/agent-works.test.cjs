const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { AGENT_TOOLS, AGENT_READ_TOOLS, AGENT_WRITE_TOOLS } = require('../src/lib/agent/tools/index.ts');
const { parseToolArguments } = require('../src/lib/agent/tools/registry.ts');
const { loadSkillTool } = require('../src/lib/agent/tools/review-tools.ts');
const { WORKS_CATALOG_SKILL } = require('../src/lib/agent/skills/works-catalog.ts');
const { getProposalView, listProposalViews } = require('../src/lib/agent/proposals.ts');
const { applyProposalDecision, undoProposalItem } = require('../src/lib/agent/proposal-apply.ts');
const { isCheckedByDefault, proposalItemFlags } = require('../src/lib/agent/proposal-flags.ts');
const { createAgentSession, appendAgentMessage } = require('../src/lib/agent/store.ts');
const { createWork, getWork, listWorks, updateWork } = require('../src/lib/works-catalog.ts');

// 全部是虚构数据
const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-02T00:00:00.000Z';
const T2 = '2026-11-03T00:00:00.000Z';
const T3 = '2026-11-04T00:00:00.000Z';
const MSG_EARLY = '2026-05-03T12:00:00.000Z';

function insert(db, table, row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map(key => row[key]));
}

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => { __setDbForTests(null); db.close(); });
  insert(db, 'characters', { id: 'char-a', name: '星野' });
  insert(db, 'characters', { id: 'char-b', name: '白砂' });
  insert(db, 'conversations', { id: 'conv-a', character_id: 'char-a' });
  insert(db, 'conversations', { id: 'conv-b', character_id: 'char-b' });
  insert(db, 'messages', { id: 'msg-dune-abcdefgh', conversation_id: 'conv-a', role: 'user', content: '昨晚看完了《沙丘》，给 8.5 分', created_at: MSG_EARLY });
  insert(db, 'messages', { id: 'msg-her-abcdefgh', conversation_id: 'conv-a', role: 'user', content: '《她》我重看了一遍，还是 9 分', created_at: '2026-06-01T08:00:00.000Z' });
  insert(db, 'messages', { id: 'msg-other-abcdefgh', conversation_id: 'conv-b', role: 'user', content: '其他角色的消息', created_at: T0 });
  const memory = (id, content, extra = {}) => insert(db, 'memories', { id, character_id: 'char-a', category: '偏好习惯', content, created_at: '2026-10-01 00:00:00', ...extra });
  memory('mem-dune-abcdefgh', '用户看完了电影《沙丘》，打了 8.5 分', { source_msg_ids: '["msg-dune-abcdefgh"]' });
  memory('mem-archived-abcd', '用户读完了小说《三体》', { status: 'archived', created_at: '2026-04-01 00:00:00' });
  memory('mem-merged-abcdef', '用户看过《沙丘》', {
    status: 'superseded',
    metadata: JSON.stringify({ mergedInto: 'mem-dune-abcdefgh', supersededBy: { action: 'memory_merge', memoryId: 'mem-dune-abcdefgh' } }),
  });
  memory('mem-replaced-abcd', '用户还没看过《沙丘》', {
    status: 'superseded',
    metadata: JSON.stringify({ supersededBy: { action: 'memory_extraction_supersede', memoryId: 'mem-dune-abcdefgh' } }),
  });
  memory('mem-retired-abcde', '用户想看《沙丘》', { status: 'superseded', metadata: JSON.stringify({ previousStatus: 'active', retiredByProposalItem: 1 }) });
  insert(db, 'memories', { id: 'mem-other-abcdefg', character_id: 'char-b', category: '偏好习惯', content: '其他角色的记忆' });

  const her = createWork(db, {
    character_id: 'char-a', work_type: 'movie', title: '她', aliases: ['Her'], status: 'watched', rating: '9',
    source_memory_ids: ['mem-dune-abcdefgh'], source_msg_ids: ['msg-her-abcdefgh'], first_seen_at: '2026-06-01T08:00:00.000Z',
  }, T0);
  const mirror = createWork(db, { character_id: 'char-a', work_type: 'series', title: '黑镜', status: 'watching', progress: '第二季第 2 集' }, T0);
  const removed = updateWork(db, createWork(db, { character_id: 'char-a', work_type: 'book', title: '高等数学', status: 'watched' }, T0).id, { dismissed: true }, T0);
  const other = createWork(db, { character_id: 'char-b', work_type: 'movie', title: '她', status: 'want' }, T0);

  const session = createAgentSession(db, { character_id: 'char-a' }, T0);
  appendAgentMessage(db, session.id, { role: 'user', content: '《黑镜》我已经看完了，帮我改一下片单。' }, T0);
  return { db, sessionId: session.id, settings: DEFAULT_SETTINGS, her, mirror, removed, other };
}

const MEMORY_EVIDENCE = { memory_ids: ['mem-dune-abcdefgh'] };
function create(extra = {}) {
  return { op: 'create', type: 'movie', title: '沙丘', aliases: ['Dune'], status: 'watched', rating: '8.5', reason: '主人看完并打分', confidence: 0.9, evidence: MEMORY_EVIDENCE, ...extra };
}
function update(workId, extra = {}) {
  return { op: 'update', work_id: workId, reason: '主人说看完了', confidence: 0.9, evidence: { owner_quote: '《黑镜》我已经看完了' }, ...extra };
}
function retire(workId, extra = {}) {
  return { op: 'retire', work_id: workId, reason: '不属于收录范围', confidence: 0.9, evidence: { message_ids: ['msg-her-abcdefgh'] }, ...extra };
}

function call(ctx, items, { characterId = 'char-a', summary = '整理片单' } = {}) {
  const tool = AGENT_TOOLS.find(candidate => candidate.name === 'create_works_proposal');
  assert.ok(tool, 'Agent 缺少 create_works_proposal 工具');
  const parsed = parseToolArguments(tool, JSON.stringify({ character_id: characterId, summary, items }));
  if (!parsed.ok) return { parseError: parsed.error };
  return tool.execute(parsed.args, ctx);
}
function propose(ctx, items) {
  const outcome = call(ctx, items);
  assert.equal(outcome.parseError, undefined, outcome.parseError);
  assert.equal(outcome.result.ok, true, outcome.result.error);
  assert.equal(outcome.terminate, true, '提案生成后应结束本轮，等待批准');
  const view = getProposalView(ctx.db, outcome.result.proposal_id);
  return { view, id: view.id, items: view.items, result: outcome.result };
}
function approve(ctx, proposal, itemIds = proposal.items.map(item => item.id), now = T1) {
  const outcome = applyProposalDecision(ctx.db, proposal.id, { action: 'apply', approved_item_ids: itemIds, rejected_items: [] }, now);
  assert.equal(outcome.ok, true, outcome.error);
  return outcome;
}
function catalog(db) {
  return JSON.stringify(db.prepare('SELECT * FROM character_works ORDER BY id').all());
}
function flagsOf(view, item) {
  return proposalItemFlags(item, { evidenceMemories: new Map(view.evidence_memories.map(memory => [memory.id, memory])) });
}
async function read(ctx, args) {
  const tool = AGENT_READ_TOOLS.find(candidate => candidate.name === 'get_works_catalog');
  assert.ok(tool, 'Agent 缺少 get_works_catalog 工具');
  const parsed = parseToolArguments(tool, JSON.stringify(args));
  assert.equal(parsed.ok, true, parsed.error);
  return tool.execute(parsed.args, ctx);
}

test('get_works_catalog 返回该角色全部条目（含已移除）和依据，不含其他角色', async t => {
  const ctx = setup(t);
  const result = await read(ctx, { character_id: 'char-a' });
  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.equal(result.active_count, 2);
  assert.equal(result.dismissed_count, 1);
  assert.deepEqual(result.works.map(work => work.title).sort(), ['她', '高等数学', '黑镜'].sort());
  assert.equal(result.works.some(work => work.id === ctx.other.id), false, '不能带出其他角色的条目');
  const her = result.works.find(work => work.id === ctx.her.id);
  assert.deepEqual(her, {
    id: ctx.her.id, type: 'movie', title: '她', aliases: ['Her'], status: 'watched', rating: '9', progress: '', note: '',
    first_seen_at: '2026-06-01T08:00:00.000Z', dismissed_at: null,
    source_memory_ids: ['mem-dune-abcdefgh'], source_msg_ids: ['msg-her-abcdefgh'],
  });
  assert.equal(result.works.find(work => work.id === ctx.removed.id).dismissed_at, T0);

  const onlySeries = await read(ctx, { character_id: 'char-a', type: 'series' });
  assert.deepEqual(onlySeries.works.map(work => work.id), [ctx.mirror.id]);
  assert.equal((await read(ctx, { character_id: 'char-missing' })).ok, false);
});

test('片单只能经提案修改：读工具只读，写工具只有 create_works_proposal', () => {
  assert.ok(AGENT_READ_TOOLS.some(tool => tool.name === 'get_works_catalog' && tool.kind === 'read'));
  const workTools = AGENT_WRITE_TOOLS.map(tool => tool.name).filter(name => name.includes('work'));
  assert.deepEqual(workTools, ['create_works_proposal']);
});

test('works-catalog skill 可加载，写明收录范围、依据规则与分批规则', async t => {
  const ctx = setup(t);
  const tool = AGENT_READ_TOOLS.find(candidate => candidate.name === 'load_skill');
  const parsed = parseToolArguments(tool, JSON.stringify({ name: 'works-catalog' }));
  assert.equal(parsed.ok, true, parsed.error);
  const result = await loadSkillTool.execute(parsed.args, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.skill.content, WORKS_CATALOG_SKILL.content);
  for (const rule of [
    'get_works_catalog', 'search_memories', 'search_messages', 'create_works_proposal', 'update_task_plan',
    'active', 'archived', 'summarized', 'superseded', '《', '打分', '评分',
    '主人自己的创作', '教材和考试用书', '歌曲', '只是被提到',
    'memory_merge', 'mergedInto', 'memory_extraction_supersede', 'retiredByProposalItem', '不能当依据',
    '最多 50 项', '按类型分批', '直到全部作品都已提交', '重复', 'retire 另一条', '通行的中文名',
  ]) assert.ok(result.skill.content.includes(rule), rule);
});

test('创建提案只保存修改前后，不改片单；前缀 ID 会补全', t => {
  const ctx = setup(t);
  const before = catalog(ctx.db);
  const proposal = propose(ctx, [
    create({ evidence: { memory_ids: ['mem-dune-abcd'], message_ids: ['msg-dune-abcd'] } }),
    update(ctx.mirror.id.slice(0, 8), { status: 'watched', progress: '' }),
    retire(ctx.her.id),
  ]);
  assert.equal(catalog(ctx.db), before);
  assert.equal(proposal.view.character_id, 'char-a');
  const [created, updated, retired] = proposal.items;
  assert.deepEqual(created.before, { work_creation: { character_id: 'char-a' } });
  assert.deepEqual(created.after, { work_type: 'movie', title: '沙丘', aliases: ['Dune'], status: 'watched', rating: '8.5', progress: '', note: '' });
  assert.deepEqual(created.evidence, { message_ids: ['msg-dune-abcdefgh'], memory_ids: ['mem-dune-abcdefgh'] });
  assert.deepEqual(updated.before, { work: getWork(ctx.db, ctx.mirror.id) });
  assert.deepEqual(updated.after, { progress: '', status: 'watched' });
  assert.deepEqual(retired.after, { dismissed: true });
  assert.deepEqual(proposal.view.evidence_memories.map(memory => [memory.id, memory.no_longer_true]), [['mem-dune-abcdefgh', false]]);
  assert.equal(listProposalViews(ctx.db, 'char-a', 20, 0).proposals[0].id, proposal.id);
  assert.equal(listProposalViews(ctx.db, 'char-b', 20, 0).proposals.length, 0);
});

test('批准 create：写入依据，first_seen_at 取依据里最早的时间（记忆按来源消息算）', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [create(), create({ type: 'book', title: '三体', aliases: [], status: 'watched', rating: '', evidence: { memory_ids: ['mem-archived-abcd'] }, first_seen_at: '2026-03-01' })]);
  approve(ctx, proposal);
  const dune = listWorks(ctx.db, 'char-a').find(work => work.title === '沙丘');
  assert.equal(dune.status, 'watched');
  assert.equal(dune.rating, '8.5');
  assert.deepEqual(dune.aliases, ['Dune']);
  assert.deepEqual(dune.source_memory_ids, ['mem-dune-abcdefgh']);
  assert.deepEqual(dune.source_msg_ids, []);
  assert.equal(dune.first_seen_at, MSG_EARLY, '记忆行 created_at 是 10 月，来源消息是 5 月，应取来源消息');
  const threeBody = listWorks(ctx.db, 'char-a').find(work => work.title === '三体');
  assert.equal(threeBody.first_seen_at, '2026-03-01T00:00:00.000Z', '给了 first_seen_at 就用它');
  assert.deepEqual(getProposalView(ctx.db, proposal.id).items.map(item => item.state), ['applied', 'applied']);
});

test('批准 update 按字段写入（可清空），依据并入来源；批准 retire 移除', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [
    update(ctx.mirror.id, { status: 'watched', progress: '', note: '结局很震撼', evidence: { message_ids: ['msg-her-abcdefgh'], memory_ids: ['mem-dune-abcdefgh'] } }),
    retire(ctx.her.id),
  ]);
  approve(ctx, proposal, undefined, T2);
  const mirror = getWork(ctx.db, ctx.mirror.id);
  assert.equal(mirror.status, 'watched');
  assert.equal(mirror.progress, '', '经主人批准的 update 可以清空字段');
  assert.equal(mirror.note, '结局很震撼');
  assert.deepEqual(mirror.source_msg_ids, ['msg-her-abcdefgh']);
  assert.deepEqual(mirror.source_memory_ids, ['mem-dune-abcdefgh']);
  assert.equal(mirror.updated_at, T2);
  const her = getWork(ctx.db, ctx.her.id);
  assert.equal(her.dismissed_at, T2);
  assert.equal(her.rating, '9', 'retire 只移除，不改字段');
});

test('对已移除条目 update 等于恢复；撤销回到移除状态并保留原移除时间', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [update(ctx.removed.id, { rating: '7', evidence: { message_ids: ['msg-her-abcdefgh'] } })]);
  assert.match(proposal.result.warnings[0], /移除过的条目，批准这一项会恢复它/);
  approve(ctx, proposal, undefined, T2);
  const restored = getWork(ctx.db, ctx.removed.id);
  assert.equal(restored.dismissed_at, null);
  assert.equal(restored.rating, '7');

  const undone = undoProposalItem(ctx.db, proposal.id, proposal.items[0].id, T3);
  assert.equal(undone.ok, true, undone.error);
  const back = getWork(ctx.db, ctx.removed.id);
  assert.equal(back.dismissed_at, T0);
  assert.equal(back.rating, '');
  assert.equal(getProposalView(ctx.db, proposal.id).items[0].state, 'undone');
  assert.equal(undoProposalItem(ctx.db, proposal.id, proposal.items[0].id, T3).status, 409);

  // 只恢复、不改字段也是一项有效修改
  const restoreOnly = propose(ctx, [update(ctx.removed.id, { evidence: { message_ids: ['msg-her-abcdefgh'] } })]);
  assert.deepEqual(restoreOnly.items[0].after, {});
  approve(ctx, restoreOnly, undefined, T3);
  assert.equal(getWork(ctx.db, ctx.removed.id).dismissed_at, null);
});

test('撤销 create 删除条目，撤销 update / retire 恢复原条目', t => {
  const ctx = setup(t);
  const herBefore = getWork(ctx.db, ctx.her.id);
  const mirrorBefore = getWork(ctx.db, ctx.mirror.id);
  const proposal = propose(ctx, [create(), update(ctx.mirror.id, { status: 'watched', aliases: ['Black Mirror'] }), retire(ctx.her.id)]);
  approve(ctx, proposal, undefined, T1);
  const createdId = getProposalView(ctx.db, proposal.id).items[0].result.work.id;
  assert.ok(getWork(ctx.db, createdId));
  for (const item of proposal.items) {
    const outcome = undoProposalItem(ctx.db, proposal.id, item.id, T2);
    assert.equal(outcome.ok, true, outcome.error);
  }
  assert.equal(getWork(ctx.db, createdId), null);
  const mirror = getWork(ctx.db, ctx.mirror.id);
  assert.deepEqual({ ...mirror, updated_at: null }, { ...mirrorBefore, updated_at: null });
  const her = getWork(ctx.db, ctx.her.id);
  assert.deepEqual({ ...her, updated_at: null }, { ...herBefore, updated_at: null });
});

test('批准后条目又被改动或删除时拒绝撤销并说明原因', async t => {
  for (const [label, change] of [
    ['edited', (db, id) => updateWork(db, id, { rating: '10' }, T2)],
    ['dismissed', (db, id) => updateWork(db, id, { dismissed: true }, T2)],
    ['deleted', (db, id) => db.prepare('DELETE FROM character_works WHERE id = ?').run(id)],
  ]) {
    await t.test(label, subtest => {
      const ctx = setup(subtest);
      const proposal = propose(ctx, [update(ctx.mirror.id, { status: 'watched' })]);
      approve(ctx, proposal, undefined, T1);
      change(ctx.db, ctx.mirror.id);
      const after = catalog(ctx.db);
      const outcome = undoProposalItem(ctx.db, proposal.id, proposal.items[0].id, T3);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.status, 409);
      assert.match(outcome.error, /片单条目.*批准后又被改动或删除，不能撤销/);
      assert.equal(catalog(ctx.db), after);
      assert.equal(getProposalView(ctx.db, proposal.id).items[0].state, 'applied');
    });
  }
  await t.test('created entry edited', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx, [create()]);
    approve(ctx, proposal, undefined, T1);
    const createdId = getProposalView(ctx.db, proposal.id).items[0].result.work.id;
    updateWork(ctx.db, createdId, { note: '主人自己补的' }, T2);
    const outcome = undoProposalItem(ctx.db, proposal.id, proposal.items[0].id, T3);
    assert.equal(outcome.status, 409);
    assert.equal(getWork(ctx.db, createdId).note, '主人自己补的');
  });
});

test('提案生成后条目被改动、删除或同名作品已出现时过期，不覆盖', async t => {
  await t.test('update target edited (auto update)', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx, [update(ctx.mirror.id, { status: 'watched' })]);
    updateWork(ctx.db, ctx.mirror.id, { progress: '第三季第 1 集' }, T1);
    const outcome = approve(ctx, proposal, undefined, T2);
    assert.equal(outcome.items[0].state, 'stale');
    assert.match(outcome.items[0].reason, /提案生成后已被改动或删除/);
    assert.equal(getWork(ctx.db, ctx.mirror.id).status, 'watching');
    assert.equal(getWork(ctx.db, ctx.mirror.id).progress, '第三季第 1 集');
  });
  await t.test('retire target deleted', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx, [retire(ctx.her.id)]);
    ctx.db.prepare('DELETE FROM character_works WHERE id = ?').run(ctx.her.id);
    assert.equal(approve(ctx, proposal).items[0].state, 'stale');
  });
  await t.test('same work created meanwhile', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx, [create()]);
    createWork(ctx.db, { character_id: 'char-a', work_type: 'movie', title: 'Dune', status: 'watching' }, T1);
    const before = catalog(ctx.db);
    assert.equal(approve(ctx, proposal, undefined, T2).items[0].state, 'stale');
    assert.equal(catalog(ctx.db), before);
  });
});

test('合并重复条目：update 一条并入别名、同一份提案里 retire 另一条', t => {
  const ctx = setup(t);
  const dup = createWork(ctx.db, { character_id: 'char-a', work_type: 'movie', title: 'Her', status: 'watched' }, T0);
  // 先清掉 her 里的 Her 别名，构造「两个条目是同一部作品」的情形
  updateWork(ctx.db, ctx.her.id, { aliases: [] }, T0);
  const proposal = propose(ctx, [
    update(ctx.her.id, { aliases: ['Her'], evidence: { message_ids: ['msg-her-abcdefgh'] } }),
    retire(dup.id, { reason: '与《她》重复' }),
  ]);
  approve(ctx, proposal);
  assert.deepEqual(getWork(ctx.db, ctx.her.id).aliases, ['Her']);
  assert.ok(getWork(ctx.db, dup.id).dismissed_at);
});

test('不合法的提案整份不创建，片单不变', async t => {
  const longText = n => '长'.repeat(n);
  const cases = ctx => [
    ['missing character', { characterId: 'char-missing', items: [create()] }, /角色 char-missing 不存在/],
    ['foreign work', { items: [update(ctx.other.id, { status: 'watched' })] }, /不存在或不属于该角色/],
    ['unknown work', { items: [retire('work-missing-1234')] }, /不存在或不属于该角色/],
    ['same work twice', { items: [update(ctx.mirror.id, { status: 'watched' }), retire(ctx.mirror.id)] }, /已在第 1 项中处理/],
    ['same title twice', { items: [create(), create({ title: '《DUNE》', aliases: [] })] }, /与第 1 项是同一部作品/],
    ['create clashes with active', { items: [create({ title: 'her', aliases: [] })] }, /片单里已有「她」.*改用 update/],
    ['create clashes with dismissed', { items: [create({ type: 'book', title: '高等数学', aliases: [] })] }, /移除过的条目.*update/],
    ['rename clashes', { items: [update(ctx.mirror.id, { type: 'movie', title: 'Her' })] }, /重名/],
    ['no change', { items: [update(ctx.mirror.id, { status: 'watching' })] }, /没有实际改动/],
    ['retire dismissed', { items: [retire(ctx.removed.id)] }, /已经移除/],
    ['retire with fields', { items: [retire(ctx.her.id, { status: 'want' })] }, /retire 不使用 status/],
    ['create missing status', { items: [create({ status: undefined })] }, /create 需要 status/],
    ['create with work id', { items: [create({ work_id: ctx.her.id })] }, /create 不使用 work_id/],
    ['update missing id', { items: [update(undefined, { status: 'want' })] }, /update 需要 work_id/],
    ['empty title', { items: [create({ title: '《》', aliases: [] })] }, /作品名称不能为空/],
    ['long title', { items: [create({ title: longText(101) })] }, /名称超过 100 字/],
    ['long rating', { items: [create({ rating: longText(17) })] }, /评分超过 16 字/],
    ['long progress', { items: [update(ctx.mirror.id, { progress: longText(41) })] }, /进度超过 40 字/],
    ['long note', { items: [create({ note: longText(61) })] }, /印象超过 60 字/],
    ['too many aliases', { items: [create({ aliases: Array.from({ length: 9 }, (_, i) => `别名${i}`) })] }, /别名最多 8 个/],
    ['bad first_seen_at', { items: [create({ first_seen_at: '去年夏天' })] }, /first_seen_at 不是有效的时间/],
    ['foreign memory', { items: [create({ evidence: { memory_ids: ['mem-other-abcdefg'] } })] }, /依据记忆不存在或不属于该角色/],
    ['foreign message', { items: [create({ evidence: { message_ids: ['msg-other-abcdefgh'] } })] }, /依据消息不存在或不属于该角色/],
    ['missing evidence', { items: [create({ evidence: undefined })] }, /缺少依据/],
    ['fake owner quote', { items: [create({ evidence: { owner_quote: '主人从来没说过这句话' } })] }, /owner_quote/],
    ['missing reason', { items: [create({ reason: ' ' })] }, /缺少理由/],
  ];
  const placeholder = { id: 'placeholder' };
  const labels = cases({ other: placeholder, mirror: placeholder, her: placeholder, removed: placeholder }).map(entry => entry[0]);
  for (const [index, label] of labels.entries()) {
    await t.test(label, subtest => {
      const ctx = setup(subtest);
      const [, { characterId, items }, pattern] = cases(ctx)[index];
      const before = catalog(ctx.db);
      const outcome = call(ctx, items, { characterId });
      assert.equal(outcome.parseError, undefined, outcome.parseError);
      assert.equal(outcome.result.ok, false);
      assert.match(outcome.result.error, pattern);
      assert.equal(outcome.terminate, undefined);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_proposals').get().n, 0);
      assert.equal(catalog(ctx.db), before);
    });
  }
});

test('参数层面的错误：未知类型或状态、未知字段、超过 50 项都被拒绝', t => {
  const ctx = setup(t);
  for (const items of [
    [create({ type: 'music' })],
    [create({ status: 'finished' })],
    [create({ dismissed: true })],
    [create({ op: 'merge' })],
    Array.from({ length: 51 }, (_, i) => create({ title: `作品${i}`, aliases: [] })),
    [],
  ]) {
    const outcome = call(ctx, items);
    assert.ok(outcome.parseError, JSON.stringify(items).slice(0, 80));
  }
  const fifty = call(ctx, Array.from({ length: 50 }, (_, i) => create({ title: `作品${i}`, aliases: [] })));
  assert.equal(fifty.result.ok, true, fifty.result.error);
  assert.equal(getProposalView(ctx.db, fifty.result.proposal_id).items.length, 50);
});

test('标注：被提取取代或已退场的依据记忆标出并默认不勾选，合并和归档的原始记忆照常', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [
    create({ evidence: { memory_ids: ['mem-merged-abcdef', 'mem-replaced-abcd'] } }),
    create({ type: 'book', title: '三体', aliases: [], evidence: { memory_ids: ['mem-archived-abcd', 'mem-merged-abcdef'] } }),
    create({ type: 'game', title: '星露谷物语', aliases: [], evidence: { memory_ids: ['mem-retired-abcde'] } }),
    create({ type: 'series', title: '漫长的季节', aliases: [], evidence: { note: '无原文依据：主人口头提过' } }),
  ]);
  const warnings = proposal.result.warnings;
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^第 1 项：.*mem-replaced-abcd.*已被新说法取代或已退场/);
  assert.match(warnings[1], /^第 3 项：.*mem-retired-abcde/);

  const flags = proposal.items.map(item => flagsOf(proposal.view, item));
  assert.deepEqual(flags[0].invalidEvidenceMemoryIds, ['mem-replaced-abcd']);
  assert.equal(isCheckedByDefault(flags[0]), false);
  assert.deepEqual(flags[1].invalidEvidenceMemoryIds, []);
  assert.equal(isCheckedByDefault(flags[1]), true, '归档和合并的原始记忆仍是有效依据');
  assert.deepEqual(flags[2].invalidEvidenceMemoryIds, ['mem-retired-abcde']);
  assert.equal(flags[3].noEvidence, true);
  assert.equal(isCheckedByDefault(flags[3]), false);
  assert.equal(proposalItemFlags(proposal.items[1]).noEvidence, false, '只有记忆依据也不算缺依据');

  // 依据记忆在提案之后被删除：同样标出
  ctx.db.prepare("DELETE FROM memories WHERE id = 'mem-archived-abcd'").run();
  const reloaded = getProposalView(ctx.db, proposal.id);
  assert.deepEqual(flagsOf(reloaded, reloaded.items[1]).invalidEvidenceMemoryIds, ['mem-archived-abcd']);
});

// ---- 合并重复条目在批准、撤销时不能留下重复条目或吞掉名称 ----

function mergeProposal(ctx) {
  const dup = createWork(ctx.db, { character_id: 'char-a', work_type: 'movie', title: 'Her', status: 'watched' }, T0);
  updateWork(ctx.db, ctx.her.id, { aliases: [] }, T0);
  const proposal = propose(ctx, [
    update(ctx.her.id, { aliases: ['Her'], evidence: { message_ids: ['msg-her-abcdefgh'] } }),
    retire(dup.id, { reason: '与《她》重复', confidence: 0.5 }),
  ]);
  return { dup, proposal };
}
/** 片单里带这个名称、且没有移除的条目 */
function activeHolders(db, name) {
  return listWorks(db, 'char-a').filter(work => [work.title, ...work.aliases].includes(name)).map(work => work.id);
}

test('合并只批准 update（retire 低把握默认不勾选）：update 过期，不造出重复条目', t => {
  const ctx = setup(t);
  const { dup, proposal } = mergeProposal(ctx);
  assert.equal(isCheckedByDefault(flagsOf(proposal.view, proposal.items[1])), false, '前提：retire 默认不勾选');
  const outcome = approve(ctx, proposal, [proposal.items[0].id]);
  assert.deepEqual(outcome.items.map(item => item.state), ['stale', 'rejected']);
  assert.match(outcome.items[0].reason, /与片单里的「Her」.*重名，没有修改/);
  assert.ok(outcome.items[0].reason.includes(dup.id));
  assert.deepEqual(getWork(ctx.db, ctx.her.id).aliases, []);
  assert.equal(getWork(ctx.db, dup.id).dismissed_at, null);
  assert.deepEqual(activeHolders(ctx.db, 'Her'), [dup.id]);
});

test('合并的 retire 过期（自动更新改了另一条）：update 同样过期，片单不变', t => {
  const ctx = setup(t);
  const { proposal, dup } = mergeProposal(ctx);
  updateWork(ctx.db, dup.id, { rating: '8' }, T1);
  const before = catalog(ctx.db);
  const outcome = approve(ctx, proposal, undefined, T2);
  assert.deepEqual(outcome.items.map(item => [item.seq, item.state]), [[1, 'stale'], [2, 'stale']]);
  assert.match(outcome.items[0].reason, /重名/);
  assert.match(outcome.items[1].reason, /提案生成后已被改动或删除/);
  assert.equal(catalog(ctx.db), before);
});

test('合并的 update 过期：retire 一并回滚，不会只移除不并入名称', t => {
  const ctx = setup(t);
  const { proposal, dup } = mergeProposal(ctx);
  updateWork(ctx.db, ctx.her.id, { note: '自动更新补的' }, T1);
  const before = catalog(ctx.db);
  const outcome = approve(ctx, proposal, undefined, T2);
  assert.deepEqual(outcome.items.map(item => [item.seq, item.state]), [[1, 'stale'], [2, 'stale']], '记录按序号排列');
  assert.match(outcome.items[0].reason, /提案生成后已被改动或删除/);
  assert.match(outcome.items[1].reason, /与第 1 项是同一次合并.*没有移除/);
  assert.equal(catalog(ctx.db), before, 'retire 的写入要回滚');
  assert.equal(getWork(ctx.db, dup.id).dismissed_at, null);
  assert.deepEqual(getProposalView(ctx.db, proposal.id).items.map(item => item.state), ['stale', 'stale']);
});

test('合并两项都批准后只撤销 retire：会造出重名，拒绝并说明先撤销哪一项', t => {
  const ctx = setup(t);
  const { proposal, dup } = mergeProposal(ctx);
  const outcome = approve(ctx, proposal, undefined, T1);
  assert.deepEqual(outcome.items.map(item => item.state), ['applied', 'applied'], 'retire 先于 update 应用');
  assert.deepEqual(activeHolders(ctx.db, 'Her'), [ctx.her.id]);

  const after = catalog(ctx.db);
  const refused = undoProposalItem(ctx.db, proposal.id, proposal.items[1].id, T2);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.match(refused.error, /撤销后「Her」会与片单里的「她」.*重名：先撤销把这些名称并入「她」的那一项/);
  assert.equal(catalog(ctx.db), after);
  assert.equal(getProposalView(ctx.db, proposal.id).items[1].state, 'applied');

  // 按提示先撤销 update，再撤销 retire：回到合并前
  assert.equal(undoProposalItem(ctx.db, proposal.id, proposal.items[0].id, T2).ok, true);
  const undone = undoProposalItem(ctx.db, proposal.id, proposal.items[1].id, T3);
  assert.equal(undone.ok, true, undone.error);
  assert.deepEqual(getWork(ctx.db, ctx.her.id).aliases, []);
  assert.equal(getWork(ctx.db, dup.id).dismissed_at, null);
  assert.deepEqual(activeHolders(ctx.db, 'Her'), [dup.id]);
});

test('撤销改名：旧名已被别的条目占用时拒绝', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [update(ctx.mirror.id, { title: 'Black Mirror', aliases: [] })]);
  approve(ctx, proposal, undefined, T1);
  const other = createWork(ctx.db, { character_id: 'char-a', work_type: 'series', title: '黑镜', status: 'want' }, T2);
  const outcome = undoProposalItem(ctx.db, proposal.id, proposal.items[0].id, T3);
  assert.equal(outcome.status, 409);
  assert.match(outcome.error, /撤销后「黑镜」会与片单里的「黑镜」/);
  assert.ok(outcome.error.includes(other.id));
  assert.equal(getWork(ctx.db, ctx.mirror.id).title, 'Black Mirror');
});

test('恢复已移除条目时同名作品已经加回：过期，不造出重复条目', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [update(ctx.removed.id, { rating: '7', evidence: { message_ids: ['msg-her-abcdefgh'] } })]);
  const readded = createWork(ctx.db, { character_id: 'char-a', work_type: 'book', title: '高等数学', status: 'want' }, T1);
  const before = catalog(ctx.db);
  const outcome = approve(ctx, proposal, undefined, T2);
  assert.equal(outcome.items[0].state, 'stale');
  assert.match(outcome.items[0].reason, /与片单里的「高等数学」.*重名/);
  assert.ok(outcome.items[0].reason.includes(readded.id));
  assert.equal(catalog(ctx.db), before);
  assert.equal(getWork(ctx.db, ctx.removed.id).dismissed_at, T0);
});

test('first_seen_at：依据是归档摘要或合并结果时用记忆自己的 created_at，不用来源并集里最早的消息', t => {
  const ctx = setup(t);
  const aggregate = (id, created, metadata) => insert(ctx.db, 'memories', {
    id, character_id: 'char-a', category: '偏好习惯', content: '用户看过几部电影', created_at: created,
    source_msg_ids: '["msg-dune-abcdefgh"]', metadata: JSON.stringify(metadata),
  });
  aggregate('mem-summary-abcde', '2026-09-01 00:00:00', { archiveBatchId: 'batch-1', archiveRole: 'summary', coveredMemoryIds: [] });
  aggregate('mem-mresult-abcde', '2026-08-15 00:00:00', { mergeBatchId: 'batch-2', mergeRole: 'result', mergedFromIds: [] });
  const proposal = propose(ctx, [
    create({ evidence: { memory_ids: ['mem-summary-abcde'] } }),
    create({ type: 'game', title: '星露谷物语', aliases: [], rating: '', evidence: { memory_ids: ['mem-mresult-abcde'] } }),
  ]);
  approve(ctx, proposal);
  const works = listWorks(ctx.db, 'char-a');
  assert.equal(works.find(work => work.title === '沙丘').first_seen_at, '2026-09-01T00:00:00.000Z', `不能是来源消息的 ${MSG_EARLY}`);
  assert.equal(works.find(work => work.title === '星露谷物语').first_seen_at, '2026-08-15T00:00:00.000Z');
});

test('标注顺着合并、归档链：结果或摘要已不成立时原始记忆也标出；成环的链不卡死', t => {
  const ctx = setup(t);
  const memory = (id, status, metadata) => insert(ctx.db, 'memories', {
    id, character_id: 'char-a', category: '偏好习惯', content: `虚构记忆 ${id}`, status, metadata: JSON.stringify(metadata),
  });
  memory('mem-mres-gone-abc', 'superseded', { mergeRole: 'result', supersededBy: { action: 'memory_extraction_supersede', memoryId: 'mem-dune-abcdefgh' } });
  memory('mem-morig-abcdef', 'superseded', { mergedInto: 'mem-mres-gone-abc', supersededBy: { action: 'memory_merge', memoryId: 'mem-mres-gone-abc' } });
  memory('mem-sum-retired-a', 'superseded', { archiveRole: 'summary', previousStatus: 'active', retiredByProposalItem: 9 });
  memory('mem-sorig-abcdef', 'archived', { archiveBatchId: 'batch-3', summarizedBy: 'mem-sum-retired-a', previousStatus: 'active' });
  memory('mem-cyc1-abcdefg', 'superseded', { mergedInto: 'mem-cyc2-abcdefg' });
  memory('mem-cyc2-abcdefg', 'superseded', { mergedInto: 'mem-cyc1-abcdefg' });

  const proposal = propose(ctx, [
    create({ evidence: { memory_ids: ['mem-morig-abcdef', 'mem-merged-abcdef'] } }),
    create({ type: 'book', title: '三体', aliases: [], evidence: { memory_ids: ['mem-sorig-abcdef'] } }),
    create({ type: 'game', title: '星露谷物语', aliases: [], evidence: { memory_ids: ['mem-cyc1-abcdefg'] } }),
  ]);
  const warnings = proposal.result.warnings;
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^第 1 项：依据记忆 mem-morig-abcdef 已被/);
  assert.match(warnings[1], /^第 2 项：依据记忆 mem-sorig-abcdef 已被/);
  const flags = proposal.items.map(item => flagsOf(proposal.view, item));
  assert.deepEqual(flags[0].invalidEvidenceMemoryIds, ['mem-morig-abcdef'], '合并进仍有效结果的原始记忆照常');
  assert.equal(isCheckedByDefault(flags[0]), false);
  assert.deepEqual(flags[1].invalidEvidenceMemoryIds, ['mem-sorig-abcdef']);
  assert.deepEqual(flags[2].invalidEvidenceMemoryIds, []);
  assert.equal(isCheckedByDefault(flags[2]), true);

  // 提案之后合并结果才被提取取代：重新读取视图时标出
  ctx.db.prepare(`UPDATE memories SET status = 'superseded', metadata = ? WHERE id = 'mem-dune-abcdefgh'`)
    .run(JSON.stringify({ supersededBy: { action: 'memory_extraction_supersede', memoryId: 'mem-sorig-abcdef' } }));
  const reloaded = getProposalView(ctx.db, proposal.id);
  assert.deepEqual(flagsOf(reloaded, reloaded.items[0]).invalidEvidenceMemoryIds, ['mem-morig-abcdef', 'mem-merged-abcdef']);
});
