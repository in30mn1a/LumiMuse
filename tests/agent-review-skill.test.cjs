const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');
installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');
registerTsLoader();
const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { buildMemoryReviewBatches } = require('../src/lib/memory-review-cluster.ts');
const { clearMemoryReviewPlanCacheForTests, MEMORY_REVIEW_PLAN_TTL_MS } = require('../src/lib/memory-review-plan.ts');
const { TAG_SPEC_PROMPT_SECTION } = require('../src/lib/memory-tag-spec.ts');
const { MEMORY_REVIEW_SKILL, AGENT_SKILLS } = require('../src/lib/agent/skills/memory-review.ts');
const { loadSkillTool, prepareMemoryReviewTool, readReviewBatchTool } = require('../src/lib/agent/tools/review-tools.ts');

function setup(t, count = 120) {
  const db = new Database(':memory:');
  __migrateForTests(db);
  __setDbForTests(db);
  clearMemoryReviewPlanCacheForTests();
  t.after(() => { clearMemoryReviewPlanCacheForTests(); db.close(); });
  db.prepare("INSERT INTO characters (id, name) VALUES ('review-a', '虚构角色'), ('review-b', '另一个虚构角色')").run();
  const insert = db.prepare('INSERT INTO memories (id, character_id, category, content, status, importance) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < count; i += 1) insert.run(`review-${String(i).padStart(3, '0')}`, 'review-a', '四季日常', `第${i}条完整记忆。${i === 0 ? '不可截断的细节。'.repeat(700) : ''}`, 'active', 0.5);
  insert.run('review-inactive', 'review-a', '基础信息', '已退场的内容。', 'superseded', 0.5);
  insert.run('review-other', 'review-b', '基础信息', '其他角色的内容。', 'active', 0.5);
  return { db, ctx: { db, sessionId: 'fictional-review-session', settings: DEFAULT_SETTINGS } };
}
async function execute(tool, args, ctx) {
  const parsed = tool.schema.parse(args);
  return tool.execute(parsed, ctx);
}

test('skill uses the shared tag source and spells out evidence, cross-batch and timeline rules', async t => {
  const { ctx } = setup(t);
  const result = await execute(loadSkillTool, { name: 'memory-review' }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.skill.content, MEMORY_REVIEW_SKILL.content);
  assert.ok(result.skill.content.includes(TAG_SPEC_PROMPT_SECTION));
  for (const rule of ['get_memory_sources', 'search_memories', 'get_memories', 'folded', '宁长勿简', 'report_conflict', '不得因「只是时间变化」而跳过', 'retire', '置顶', '角色自称「我」', 'create_memory_proposal']) assert.ok(result.skill.content.includes(rule), rule);
  assert.deepEqual(AGENT_SKILLS.map(skill => skill.name), ['memory-review']);
  assert.equal(loadSkillTool.schema.safeParse({ name: '../../secret' }).success, false);
});

test('120 target IDs are read in full exactly once, including long content, under query_only', async t => {
  const { db, ctx } = setup(t);
  const before = JSON.stringify(db.prepare('SELECT * FROM memories ORDER BY id').all());
  db.pragma('query_only = ON');
  const plan = await execute(prepareMemoryReviewTool, { character_id: 'review-a' }, ctx);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.total_memories, 120);
  const ids = [];
  for (let i = 0; i < plan.total_batches; i += 1) {
    const result = await execute(readReviewBatchTool, { plan_id: plan.plan_id, character_id: 'review-a', batch_index: i }, ctx);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.stale_ids, []);
    ids.push(...result.memories.map(memory => memory.id));
    for (const memory of result.memories) assert.equal(memory.content, db.prepare('SELECT content FROM memories WHERE id = ?').get(memory.id).content);
    assert.equal(result.next_batch_index, i + 1 < plan.total_batches ? i + 1 : null);
  }
  assert.equal(ids.length, 120);
  assert.equal(new Set(ids).size, 120);
  assert.equal(ids.includes('review-other'), false);
  assert.equal(ids.includes('review-inactive'), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM memories ORDER BY id').all()), before);
  const reread = await execute(readReviewBatchTool, { plan_id: plan.plan_id, character_id: 'review-a', batch_index: 0 }, ctx);
  assert.deepEqual(reread.memories.map(memory => memory.id), ids.slice(0, plan.batch_sizes[0]));
});

test('batch reads current values, reports removed targets, and refuses wrong roles or indexes', async t => {
  const { db, ctx } = setup(t, 3);
  const plan = await execute(prepareMemoryReviewTool, { character_id: 'review-a' }, ctx);
  db.prepare("UPDATE memories SET content = '主人后来修改的原文。' WHERE id = 'review-000'").run();
  db.prepare("DELETE FROM memories WHERE id = 'review-001'").run();
  db.prepare("UPDATE memories SET status = 'superseded' WHERE id = 'review-002'").run();
  const args = { plan_id: plan.plan_id, character_id: 'review-a', batch_index: 0 };
  const result = await execute(readReviewBatchTool, args, ctx);
  assert.deepEqual(result.memories.map(memory => memory.content), ['主人后来修改的原文。']);
  assert.deepEqual(result.stale_ids.sort(), ['review-001', 'review-002']);
  assert.equal((await execute(readReviewBatchTool, { ...args, character_id: 'review-b' }, ctx)).ok, false);
  assert.equal((await execute(readReviewBatchTool, { ...args, batch_index: plan.total_batches }, ctx)).ok, false);
  assert.equal((await execute(prepareMemoryReviewTool, { character_id: 'missing' }, ctx)).ok, false);
});

test('batch gives source counts instead of source id lists', async t => {
  const { db, ctx } = setup(t, 2);
  const sourceIds = Array.from({ length: 120 }, (_, i) => `src-msg-${i}`);
  db.prepare('UPDATE memories SET source_msg_ids = ? WHERE id = ?').run(JSON.stringify(sourceIds), 'review-000');
  const plan = await execute(prepareMemoryReviewTool, { character_id: 'review-a' }, ctx);
  const result = await execute(readReviewBatchTool, { plan_id: plan.plan_id, character_id: 'review-a', batch_index: 0 }, ctx);
  assert.equal(result.ok, true, result.error);
  const byId = new Map(result.memories.map(memory => [memory.id, memory]));
  assert.equal(byId.get('review-000').source_count, 120);
  assert.equal(byId.get('review-001').source_count, 0);
  assert.equal(result.memories.some(memory => 'source_msg_ids' in memory), false);
  assert.equal(JSON.stringify(result).includes('src-msg-'), false);
});

test('expired plans require preparation again and the new plan uses current target membership', async t => {
  const { db, ctx } = setup(t, 3);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T08:00:00Z') });
  const plan = await execute(prepareMemoryReviewTool, { character_id: 'review-a' }, ctx);
  t.mock.timers.tick(MEMORY_REVIEW_PLAN_TTL_MS + 1);
  const expired = await execute(readReviewBatchTool, { plan_id: plan.plan_id, character_id: 'review-a', batch_index: 0 }, ctx);
  assert.equal(expired.ok, false);
  assert.match(expired.error, /过期.*重新/);
  db.prepare("DELETE FROM memories WHERE id = 'review-001'").run();
  const fresh = await execute(prepareMemoryReviewTool, { character_id: 'review-a' }, ctx);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.total_memories, 2);
});

test('empty roles return an empty plan and known credentials in batch data are redacted', async t => {
  const { db, ctx } = setup(t, 0);
  const empty = await execute(prepareMemoryReviewTool, { character_id: 'review-a' }, ctx);
  assert.equal(empty.total_memories, 0);
  assert.equal(empty.total_batches, 0);
  const secret = 'fixture-review-credential-0e78c1';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('api_key', JSON.stringify(secret));
  db.prepare('INSERT INTO memories (id, character_id, category, content) VALUES (?, ?, ?, ?)').run('review-secret', 'review-a', '基础信息', `不应返回凭据 ${secret}`);
  const plan = await execute(prepareMemoryReviewTool, { character_id: 'review-a' }, ctx);
  const result = await execute(readReviewBatchTool, { plan_id: plan.plan_id, character_id: 'review-a', batch_index: 0 }, ctx);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.match(result.memories[0].content, /\[REDACTED\]/);
});

function cluster(prefix, count, embedding, importance) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${String(i).padStart(3, '0')}`, content: `虚构簇${prefix}条目${i}`, importance, embedding }));
}
test('39 + 2 clusters remain whole only when opted in; default and false match the original batches', () => {
  const first = cluster('a', 39, [1, 0], 0.8);
  const second = cluster('b', 2, [0, 1], 0.4);
  const input = [...first, ...second];
  const original = [input.slice(0, 40).map(item => item.id), [second[1].id]];
  assert.deepEqual(buildMemoryReviewBatches(input, { batchSize: 40 }), original);
  assert.deepEqual(buildMemoryReviewBatches(input, { batchSize: 40, keepClustersTogether: false }), original);
  assert.deepEqual(buildMemoryReviewBatches(input, { batchSize: 40, keepClustersTogether: true }), [first.map(item => item.id), second.map(item => item.id)]);
});

test('oversized clusters split without losing IDs, and later small clusters remain intact', () => {
  const first = cluster('a', 81, [1, 0], 0.8);
  const second = cluster('b', 2, [0, 1], 0.4);
  const batches = buildMemoryReviewBatches([...first, ...second], { batchSize: 40, keepClustersTogether: true });
  assert.deepEqual(batches.map(batch => batch.length), [40, 40, 3]);
  assert.deepEqual(batches.flat(), [...first, ...second].map(item => item.id));
});
