const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

process.env.ALLOW_LOCAL_NETWORK = '1';
registerTsLoader();
const { buildMemoryReviewBatches } = require('../src/lib/memory-review-cluster.ts');
const { loadSample, SCALE_SIZE } = require('../scripts/agent-eval/fixtures.cjs');
const { aggregateScores, evaluateGate, scoreRun } = require('../scripts/agent-eval/score.cjs');
const legacy = require('../scripts/agent-eval/legacy-review-prompt.cjs');
const {
  buildReport,
  createModelCaller,
  loadCompletedRecords,
  runLegacy,
  runMode,
  runSpike,
} = require('../scripts/agent-eval-memory-review.cjs');

const EXPECTED = {
  conflicts: [{ id: 'c1', memory_ids: ['a1', 'a2'] }, { id: 'c2', memory_ids: ['a3', 'a4'] }],
  duplicates: [{ id: 'd1', memory_ids: ['b1', 'b2', 'b3'] }],
  misclassified: [{ id: 'm1', memory_id: 'c1', expected_categories: ['四季日常'] }],
  traps: [
    { id: 't1', memory_ids: ['t1', 't2'], conflict_allowed: true },
    { id: 't2', memory_ids: ['t3', 't4'], conflict_allowed: false },
  ],
  do_not_touch: ['n1'],
};

function run(partial) {
  return { conflicts: [], merges: [], corrections: [], batches: [], ...partial };
}

function batchIndexes(batches, memoryIds) {
  return memoryIds.map(id => batches.findIndex(batch => batch.includes(id)));
}

function clusterInput(sample) {
  return sample.memories.map(memory => ({ id: memory.id, content: memory.content, importance: memory.importance }));
}

test('a conflict hit needs every planted ID, regardless of extra IDs or order', () => {
  const partial = scoreRun(run({ conflicts: [{ source_ids: ['a1', 'x'] }] }), EXPECTED);
  assert.equal(partial.conflicts.hits, 0);
  assert.deepEqual(partial.conflicts.missed, ['c1', 'c2']);

  const covered = scoreRun(run({ conflicts: [{ source_ids: ['a2', 'x', 'a1'] }] }), EXPECTED);
  assert.equal(covered.conflicts.hits, 1);
  assert.deepEqual(covered.conflicts.missed, ['c2']);
  assert.equal(covered.accuracy.correct, 1);
});

test('merging a trap or a planted conflict counts as a wrong merge', () => {
  const score = scoreRun(run({
    merges: [
      { source_ids: ['t1', 't2'], merged_content: 'x' },
      { source_ids: ['a3', 'a4'], merged_content: 'x' },
    ],
  }), EXPECTED);
  assert.deepEqual(score.wrong_merges.map(item => item.plant).sort(), ['c2', 't1']);
  assert.equal(score.accuracy.wrong, 2);
  assert.equal(score.accuracy.lower, 0);
  assert.equal(score.conflicts.hits, 0);
});

test('duplicates need the whole group for recall, partial groups are still correct', () => {
  const partial = scoreRun(run({ merges: [{ source_ids: ['b1', 'b2'], merged_content: 'x' }] }), EXPECTED);
  assert.equal(partial.duplicates.hits, 0);
  assert.equal(partial.accuracy.correct, 1);

  const whole = scoreRun(run({ merges: [{ source_ids: ['b3', 'b1', 'b2'], merged_content: 'x' }] }), EXPECTED);
  assert.equal(whole.duplicates.hits, 1);
});

test('a false conflict on a trap is wrong, on a timeline change it is neutral', () => {
  const falseConflict = scoreRun(run({ conflicts: [{ source_ids: ['t3', 't4'] }] }), EXPECTED);
  assert.equal(falseConflict.accuracy.wrong, 1);

  const timeline = scoreRun(run({ conflicts: [{ source_ids: ['t1', 't2'] }] }), EXPECTED);
  assert.equal(timeline.accuracy.total, 0);
  assert.equal(timeline.accuracy.lower, null);
});

test('anything landing on do_not_touch is wrong', () => {
  const score = scoreRun(run({
    conflicts: [{ source_ids: ['n1', 'zz'] }],
    merges: [{ source_ids: ['n1', 'yy'], merged_content: 'x' }],
    corrections: [{ id: 'n1', category: '基础信息' }],
  }), EXPECTED);
  assert.equal(score.accuracy.wrong, 3);
  assert.equal(score.accuracy.correct, 0);
});

test('category corrections must pick an accepted category', () => {
  const right = scoreRun(run({ corrections: [{ id: 'c1', category: '四季日常' }] }), EXPECTED);
  assert.equal(right.misclassified.hits, 1);
  assert.equal(right.accuracy.correct, 1);

  const wrong = scoreRun(run({ corrections: [{ id: 'c1', category: '重要事件' }] }), EXPECTED);
  assert.equal(wrong.misclassified.hits, 0);
  assert.equal(wrong.accuracy.wrong, 1);
});

test('unlabeled suggestions widen the bounds until a verdict resolves them', () => {
  const input = run({
    conflicts: [{ source_ids: ['a1', 'a2'] }],
    merges: [{ source_ids: ['u1', 'u2'], merged_content: 'x' }],
  });
  const open = scoreRun(input, EXPECTED);
  assert.equal(open.accuracy.lower, 0.5);
  assert.equal(open.accuracy.upper, 1);
  assert.equal(open.needs_review[0].key, 'merge:u1,u2');

  const rejected = scoreRun(input, EXPECTED, { 'merge:u1,u2': false });
  assert.equal(rejected.accuracy.lower, 0.5);
  assert.equal(rejected.accuracy.upper, 0.5);
  assert.deepEqual(rejected.needs_review, []);

  const accepted = scoreRun(input, EXPECTED, { 'merge:u1,u2': true });
  assert.equal(accepted.accuracy.lower, 1);
});

test('repeated suggestions across batches count once', () => {
  const score = scoreRun(run({
    conflicts: [{ source_ids: ['a1', 'a2'] }, { source_ids: ['a2', 'a1'] }],
  }), EXPECTED);
  assert.equal(score.accuracy.total, 1);
});

test('visibility separates plants the mode could never see together', () => {
  const score = scoreRun(run({ batches: [['a1', 'a2', 'a3'], ['a4']] }), EXPECTED);
  assert.equal(score.conflicts.visible_total, 1);
  assert.equal(score.conflicts.total, 2);
});

test('dropped legacy conflicts are reported apart from the frozen behaviour', () => {
  const score = scoreRun(run({ dropped_conflicts: [{ source_ids: ['a1', 'a2'] }] }), EXPECTED);
  assert.equal(score.conflicts.hits, 0);
  assert.equal(score.conflict_hits_with_dropped, 1);
});

test('the gate pauses unless recall or accuracy is really higher', () => {
  const base = { conflict_recall: 0.5, duplicate_recall: 0.5, misclassified_recall: 0.5, accuracy_lower: 0.6, accuracy_upper: 0.6, unreviewed_total: 0 };
  assert.equal(evaluateGate(base, base).pass, false);
  assert.equal(evaluateGate(base, { ...base, conflict_recall: 0.8 }).pass, true);
  assert.equal(evaluateGate(base, { ...base, accuracy_lower: 0.7, accuracy_upper: 0.7 }).pass, true);
  assert.equal(evaluateGate(base, { ...base, conflict_recall: 0.2, accuracy_lower: 0.5, accuracy_upper: 0.6 }).pass, false);

  const undetermined = evaluateGate(
    { ...base, accuracy_upper: 0.9, unreviewed_total: 3 },
    { ...base, accuracy_lower: 0.7, accuracy_upper: 0.8, unreviewed_total: 2 },
  );
  assert.equal(undetermined.accuracy_improved, false);
  assert.equal(undetermined.accuracy_undetermined, true);
});

test('aggregation averages runs and skips empty denominators', () => {
  const hit = scoreRun(run({ conflicts: [{ source_ids: ['a1', 'a2'] }] }), EXPECTED);
  const miss = scoreRun(run({}), EXPECTED);
  const aggregate = aggregateScores([hit, miss]);
  assert.equal(aggregate.runs, 2);
  assert.equal(aggregate.conflict_recall, 0.25);
  assert.equal(aggregate.accuracy_lower, 1);
});

for (const name of ['small', 'scale']) {
  test(`${name} sample: every expected key resolves to a real memory`, () => {
    const sample = loadSample(name);
    const ids = new Set(sample.memories.map(memory => memory.id));
    assert.equal(ids.size, sample.memories.length);
    const planted = [
      ...sample.expected.conflicts.flatMap(plant => plant.memory_ids),
      ...sample.expected.duplicates.flatMap(plant => plant.memory_ids),
      ...sample.expected.traps.flatMap(plant => plant.memory_ids),
      ...sample.expected.misclassified.map(plant => plant.memory_id),
      ...sample.expected.do_not_touch,
    ];
    assert.equal(new Set(planted).size, planted.length, 'a memory is used by two plants');
    for (const id of planted) assert.ok(ids.has(id), `missing ${id}`);
  });

  test(`${name} sample: memory IDs do not reveal which entries are planted`, () => {
    for (const memory of loadSample(name).memories) assert.match(memory.id, /^mem_[0-9a-f]{12}$/);
  });
}

test('small sample has about 60 memories in two 40-entry batches, with two plants across the boundary', () => {
  const sample = loadSample('small');
  assert.equal(sample.memories.length, 60);
  const batches = buildMemoryReviewBatches(clusterInput(sample), { batchSize: 40 });
  assert.equal(batches.length, 2);
  const crossing = [...sample.expected.conflicts, ...sample.expected.duplicates]
    .filter(plant => new Set(batchIndexes(batches, plant.memory_ids)).size > 1)
    .map(plant => plant.id)
    .sort();
  assert.deepEqual(crossing, ['c6', 'd5']);
});

test('scale sample is deterministic, sized as planned and split by the legacy flow', () => {
  const sample = loadSample('scale');
  assert.equal(sample.memories.length, SCALE_SIZE);
  assert.equal(new Set(sample.memories.map(memory => memory.content)).size, SCALE_SIZE);
  assert.equal(loadSample('scale').hash, sample.hash);

  const batches = buildMemoryReviewBatches(clusterInput(sample), { batchSize: legacy.LEGACY_BATCH_SIZE });
  assert.ok(batches.length >= 2);
  for (const plant of [...sample.expected.conflicts, ...sample.expected.duplicates]) {
    const crossing = new Set(batchIndexes(batches, plant.memory_ids)).size > 1;
    assert.equal(crossing, Boolean(plant.cross_legacy_batch), `${plant.id} legacy batching`);
  }
});

test('scale sample has plants both inside and across 40-entry batches', () => {
  const sample = loadSample('scale');
  const batches = buildMemoryReviewBatches(clusterInput(sample), { batchSize: 40 });
  const conflictCrossing = sample.expected.conflicts
    .map(plant => new Set(batchIndexes(batches, plant.memory_ids)).size > 1);
  assert.ok(conflictCrossing.includes(true));
  assert.ok(conflictCrossing.includes(false));
});

test('frozen legacy helpers keep the production behaviour', () => {
  assert.equal(legacy.truncateForReview('abc', 5), 'abc');
  assert.match(legacy.truncateForReview('abcdef', 3), /^abc\n\[内容过长/);

  const parsed = legacy.parseMemoryReviewPayload('```json\n{"corrections":[{"id":"a"},{"x":1}],"merge_suggestions":[{"source_ids":["a","b"],"merged_content":"m","kind":"merge"},{"source_ids":["a","b"],"merged_content":"","kind":"conflict"}]}\n```');
  assert.deepEqual(parsed.corrections, [{ id: 'a' }]);
  assert.equal(parsed.merge_suggestions.length, 1);
  assert.deepEqual(parsed.dropped_conflicts.map(item => item.source_ids), [['a', 'b']]);

  const batch = [{ id: 'a', pinned: 0 }, { id: 'b', pinned: 0 }, { id: 'c', pinned: 1 }, { id: 'd', pinned: 0 }];
  const kept = legacy.filterBatchSuggestions([
    { source_ids: ['a', 'b'], kind: 'merge' },
    { source_ids: ['b', 'd'], kind: 'merge' },
    { source_ids: ['a', 'c'], kind: 'merge' },
    { source_ids: ['a', 'c'], kind: 'conflict' },
    { source_ids: ['a', 'other-batch'], kind: 'conflict' },
  ], batch);
  assert.deepEqual(kept.map(item => `${item.kind}:${item.source_ids}`), ['merge:a,b', 'conflict:a,c']);
});

const NO_RETRY_DELAY = { retryDelaysMs: [0, 0] };

function promptText(messages) {
  return messages.map(message => message.content).join('\n');
}

function plantIds(sample, plantId) {
  return [...sample.expected.conflicts, ...sample.expected.duplicates, ...sample.expected.traps]
    .find(plant => plant.id === plantId).memory_ids;
}

test('legacy mode sends the frozen prompt and normalizes conflicts, merges and corrections', async () => {
  const sample = loadSample('small');
  const prompts = [];
  const c1 = plantIds(sample, 'c1');
  const d1 = plantIds(sample, 'd1');
  const m1 = sample.expected.misclassified.find(plant => plant.id === 'm1').memory_id;
  const filler = sample.memories.find(memory => memory.content.includes('晾衣架'));
  const reply = JSON.stringify({
    corrections: [
      { id: m1, category: '四季日常', tags: ['午餐'] },
      { id: filler.id, category: filler.category, tags: ['家务', '修理'] },
      { id: 'not-in-sample', category: '四季日常' },
    ],
    merge_suggestions: [
      { source_ids: c1, merged_content: '矛盾', kind: 'conflict', reason: '不可能同时成立' },
      { source_ids: plantIds(sample, 'c2'), merged_content: '', kind: 'conflict' },
      { source_ids: d1, merged_content: '合并', kind: 'merge', reason: '重复' },
      { source_ids: [d1[0], 'not-in-sample'], merged_content: '合并', kind: 'merge' },
    ],
  });

  const result = await runLegacy(sample, async messages => {
    prompts.push(promptText(messages));
    return reply;
  }, NO_RETRY_DELAY);

  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].startsWith('你是 LumiMuse 的记忆审核助手'));
  assert.ok(!prompts[0].includes('来源消息'));
  assert.ok(!prompts[0].includes(sample.character.persona));
  assert.deepEqual(result.normalized.conflicts.map(item => item.source_ids), [c1]);
  assert.deepEqual(result.normalized.dropped_conflicts.map(item => item.source_ids), [plantIds(sample, 'c2')]);
  assert.deepEqual(result.normalized.merges.map(item => item.source_ids), [d1]);
  assert.deepEqual(result.normalized.corrections.map(item => item.id), [m1]);
  assert.equal(result.normalized.tag_only_corrections, 1);
  assert.equal(result.failed_calls, 0);
});

test('spike mode asks one goal per call with sources and character background', async () => {
  const sample = loadSample('small');
  const prompts = [];
  await runSpike(sample, async messages => {
    prompts.push(promptText(messages));
    return '{}';
  }, NO_RETRY_DELAY);

  assert.equal(prompts.length, 6);
  for (const prompt of prompts) {
    assert.ok(prompt.includes(sample.character.persona));
    assert.ok(prompt.includes(sample.character.profile));
    assert.ok(prompt.includes('来源消息'));
    assert.equal(prompt.match(/本次唯一目标/g).length, 1);
  }
  assert.ok(prompts.some(prompt => prompt.includes('我爸来成都看我了')));
  assert.equal(prompts.filter(prompt => prompt.includes('互相矛盾')).length, 2);
});

test('spike prompts never reuse a planted memory as their own example', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'agent-eval', 'spike-review-prompt.cjs'), 'utf8');
  for (const word of ['驾照', '榴莲', '甜点', '过敏', '恐高', '潜水', '水煮鱼', '花生']) {
    assert.ok(!source.includes(word), `prompt leaks ${word}`);
  }
});

test('spike mode drops out-of-batch IDs and unchanged categories', async () => {
  const sample = loadSample('small');
  const [firstBatch, secondBatch] = buildMemoryReviewBatches(clusterInput(sample), { batchSize: 40 });
  const memory = sample.memories.find(row => row.id === firstBatch[0]);

  const result = await runSpike(sample, async messages => {
    const prompt = promptText(messages);
    if (!prompt.includes(firstBatch[0])) return '{}';
    if (prompt.includes('互相矛盾')) {
      return JSON.stringify({ conflicts: [
        { memory_ids: [firstBatch[0], firstBatch[1]], reason: 'r', evidence: 'e' },
        { memory_ids: [firstBatch[0], secondBatch[0]], reason: 'r', evidence: 'e' },
        { memory_ids: [firstBatch[0]], reason: 'r', evidence: 'e' },
      ] });
    }
    if (prompt.includes('无损合并')) {
      return JSON.stringify({ merges: [{ source_ids: [firstBatch[2], firstBatch[3]], merged_content: '', reason: 'r' }] });
    }
    return JSON.stringify({ corrections: [
      { id: firstBatch[0], category: memory.category, reason: 'same' },
      { id: firstBatch[0], category: '不存在的分类', reason: 'bad' },
      { id: secondBatch[0], category: '四季日常', reason: 'other batch' },
    ] });
  }, NO_RETRY_DELAY);

  assert.deepEqual(result.normalized.conflicts.map(item => item.source_ids), [[firstBatch[0], firstBatch[1]]]);
  assert.equal(result.normalized.conflicts[0].evidence, 'e');
  assert.deepEqual(result.normalized.merges, []);
  assert.deepEqual(result.normalized.corrections, []);
});

test('model failures are scored as failed calls and upstream failures mark the run incomplete', async () => {
  const sample = loadSample('small');
  const unparsable = await runLegacy(sample, async () => '我没有输出 JSON', NO_RETRY_DELAY);
  assert.equal(unparsable.failed_calls, 1);
  assert.equal(unparsable.incomplete, false);
  assert.equal(unparsable.calls[0].status, 'parse_failed');
  assert.equal(unparsable.calls[0].raw, '我没有输出 JSON');

  const empty = await runLegacy(sample, async () => {
    throw new Error('LLM 返回了空内容，请检查模型是否支持当前请求格式');
  }, NO_RETRY_DELAY);
  assert.equal(empty.failed_calls, 1);
  assert.equal(empty.incomplete, false);

  const rejected = await runLegacy(sample, async () => {
    throw new Error('API error 401: bad key');
  }, NO_RETRY_DELAY);
  assert.equal(rejected.failed_calls, 0);
  assert.equal(rejected.incomplete, true);
});

test('rate limits and server errors retry, client errors do not', async () => {
  const sample = loadSample('small');
  let attempts = 0;
  const recovered = await runLegacy(sample, async () => {
    attempts += 1;
    if (attempts < 3) throw new Error(attempts === 1 ? 'API error 429: slow down' : 'API error 503: busy');
    return '{}';
  }, NO_RETRY_DELAY);
  assert.equal(attempts, 3);
  assert.equal(recovered.calls[0].status, 'ok');

  attempts = 0;
  await runLegacy(sample, async () => {
    attempts += 1;
    throw new Error('API error 400: bad request');
  }, NO_RETRY_DELAY);
  assert.equal(attempts, 1);

  attempts = 0;
  const exhausted = await runLegacy(sample, async () => {
    attempts += 1;
    throw new Error('fetch failed');
  }, NO_RETRY_DELAY);
  assert.equal(attempts, 3);
  assert.equal(exhausted.incomplete, true);
});

test('the model caller matches the legacy request and never exposes the key', async () => {
  const apiKey = 'sk-eval-fixture-secret';
  const requests = [];
  let respond = (_body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"corrections":[]}' } }] }));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) });
      respond(requests.at(-1).body, res);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const call = createModelCaller({ apiBase, apiKey }, 'fixture-model');
    assert.equal(await call([{ role: 'user', content: 'hi' }]), '{"corrections":[]}');
    const { body, headers } = requests[0];
    assert.equal(headers.authorization, `Bearer ${apiKey}`);
    assert.equal(body.model, 'fixture-model');
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 16384);
    assert.equal(body.temperature, 1);
    assert.deepEqual(body.response_format, { type: 'json_object' });

    respond = (_body, res) => {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end(`bad key ${apiKey}`);
    };
    await assert.rejects(call([{ role: 'user', content: 'hi' }]), error => {
      assert.ok(!error.message.includes(apiKey));
      assert.match(error.message, /^API error 401/);
      return true;
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('runs resume from disk, rerun when incomplete, and feed a report with the gate', async () => {
  const outputDir = path.join(__dirname, '..', 'docs', 'agent-eval', `.test-${process.pid}`);
  const sample = loadSample('small');
  const c1 = plantIds(sample, 'c1');
  const t3 = plantIds(sample, 't3');
  const d1 = plantIds(sample, 'd1');
  try {
    let legacyCalls = 0;
    const legacyCall = async () => {
      legacyCalls += 1;
      return JSON.stringify({ merge_suggestions: [{ source_ids: t3, merged_content: '错误合并', kind: 'merge', reason: 'r' }] });
    };
    const common = { sampleName: 'small', model: 'fixture/model', outputDir, retryDelaysMs: [0, 0] };
    await runMode({ ...common, mode: 'legacy', runs: 2, call: legacyCall });
    assert.equal(legacyCalls, 2);
    await runMode({ ...common, mode: 'legacy', runs: 3, call: legacyCall });
    assert.equal(legacyCalls, 3);

    let failing = true;
    const spikeCall = async messages => {
      if (failing) throw new Error('API error 401: bad key');
      const prompt = promptText(messages);
      if (prompt.includes('互相矛盾') && prompt.includes(c1[0])) {
        return JSON.stringify({ conflicts: [{ memory_ids: c1, reason: 'r', evidence: 'e' }] });
      }
      if (prompt.includes('无损合并') && prompt.includes(d1[0])) {
        return JSON.stringify({ merges: [{ source_ids: d1, merged_content: '合并', reason: 'r', evidence: 'e' }] });
      }
      return '{}';
    };
    const failed = await runMode({ ...common, mode: 'spike', runs: 1, call: spikeCall });
    assert.equal(failed[0].incomplete, true);
    const beforeRetry = loadCompletedRecords(common.model, outputDir);
    assert.equal(beforeRetry.records.small.spike.length, 0);
    assert.equal(beforeRetry.skipped.length, 1);

    failing = false;
    const retried = await runMode({ ...common, mode: 'spike', runs: 3, call: spikeCall });
    assert.equal(retried[0].incomplete, false);

    const { records } = loadCompletedRecords(common.model, outputDir);
    assert.equal(records.small.legacy.length, 3);
    assert.equal(records.small.spike.length, 3);

    const report = buildReport({ model: common.model, records });
    assert.match(report, /\| small \| .* \| 通过 \|/);
    assert.match(report, /错误合并（每次平均） \| 1\.0 \| 0\.0/);
    assert.match(report, /矛盾命中（每次） \| 0\/6，0\/6，0\/6 \| 1\/6，1\/6，1\/6/);
    assert.match(report, /解读前必读/);
    assert.ok(!report.includes('undefined'));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
