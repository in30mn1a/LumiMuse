/**
 * 记忆整理评测（TASK-EVAL-BASELINE、TASK-EVAL-SPIKE、TASK-EVAL-AGENT）。
 *
 * 用同一模型、同一虚构样本比较旧流程、验证模式和完整 Agent；Agent 只收集内存库提案，不批准角色记忆写入。
 *
 * Usage:
 *   node scripts/agent-eval-memory-review.cjs run --mode legacy|spike|agent --sample small|scale|all [--runs 3] [--model m] [--concurrency 3] [--force]
 *   node scripts/agent-eval-memory-review.cjs report [--mode agent] [--model m] [--verdicts path/to/verdicts.json]
 *
 * 配置见 scripts/agent-eval/upstream-config.cjs。原始回复和报告写到被 gitignore 的 docs/agent-eval/。
 * 已完成的运行会跳过，中断后可以直接重跑；verdicts 是 {建议 key: true|false} 的人工判定。
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { registerTsLoader } = require('../tests/helpers/register-ts-loader.cjs');
const { loadSample } = require('./agent-eval/fixtures.cjs');
const legacy = require('./agent-eval/legacy-review-prompt.cjs');
const spike = require('./agent-eval/spike-review-prompt.cjs');
const { aggregateScores, evaluateAgentGate, evaluateGate, scoreRun } = require('./agent-eval/score.cjs');
const { loadUpstreamConfig, redactSecret } = require('./agent-eval/upstream-config.cjs');

registerTsLoader();
const { agentImplementationHash, createAgentModelCaller, runAgent } = require('./agent-eval/agent-review.cjs');
const { chatCompletion, REASONING_SAFE_MAX_TOKENS } = require('../src/lib/api-client.ts');
const { buildMemoryReviewBatches } = require('../src/lib/memory-review-cluster.ts');

const OUTPUT_DIR = path.resolve(__dirname, '..', 'docs', 'agent-eval');
const REQUEST_TIMEOUT_MS = 600_000;
const RETRY_DELAYS_MS = [5_000, 20_000];
const MODES = ['legacy', 'spike', 'agent'];
const SAMPLES = ['small', 'scale'];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}

/** 与旧流程的后台设置一致：JSON 模式、非流式、安全 max_tokens、默认思考强度。 */
function createModelCaller({ apiBase, apiKey }, model) {
  const settings = {
    api_base: apiBase,
    api_key: apiKey,
    model,
    max_tokens: REASONING_SAFE_MAX_TOKENS,
    temperature: 1,
    json_mode: true,
    streaming: false,
  };
  return async messages => {
    try {
      return await chatCompletion(settings, messages, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch (error) {
      throw new Error(redactSecret(error instanceof Error ? error.message : String(error), apiKey));
    }
  };
}

/**
 * 模型自身的失败（空回复、解析失败）是旧流程会遇到的真实结果，计入 failed_calls；
 * 上游或网络失败和判断质量无关，重试后仍失败就把这次运行标记为未完成，不进入统计。
 */
function classifyCallError(message) {
  if (/^API error (429|5\d\d)\b/.test(message)) return 'retryable';
  if (/^API error /.test(message)) return 'fatal';
  if (message.includes('空内容') || message.includes('未生成内容')) return 'model';
  return 'retryable';
}

async function callOnce(call, messages, parse, retryDelaysMs) {
  const startedAt = Date.now();
  const finish = fields => ({ ...fields, elapsed_ms: Date.now() - startedAt });
  for (let attempt = 0; ; attempt += 1) {
    let raw;
    try {
      raw = await call(messages);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = classifyCallError(message);
      if (kind === 'model') return finish({ status: 'model_failed', error: message });
      if (kind === 'retryable' && attempt < retryDelaysMs.length) {
        await sleep(retryDelaysMs[attempt]);
        continue;
      }
      return finish({ status: 'transport_failed', error: message });
    }
    try {
      return finish({ status: 'ok', raw, parsed: parse(raw) });
    } catch (error) {
      return finish({ status: 'parse_failed', raw, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function textField(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function uniqueIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
}

function isCategoryChange(correction, memory) {
  return typeof correction.category === 'string'
    && legacy.LEGACY_VALID_CATEGORIES.includes(correction.category)
    && correction.category !== memory.category;
}

function batchesOf(sample, batchSize) {
  const byId = new Map(sample.memories.map(memory => [memory.id, memory]));
  return buildMemoryReviewBatches(sample.memories, { batchSize })
    .map(ids => ids.map(id => byId.get(id)));
}

function summarizeCalls(calls) {
  return {
    failed_calls: calls.filter(call => call.status === 'parse_failed' || call.status === 'model_failed').length,
    incomplete: calls.some(call => call.status === 'transport_failed'),
  };
}

function storedCall(call, fields) {
  const { parsed: _parsed, ...stored } = call;
  return { ...fields, ...stored };
}

async function runLegacy(sample, call, { concurrency = 3, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  const batches = batchesOf(sample, legacy.LEGACY_BATCH_SIZE);
  const categories = legacy.LEGACY_VALID_CATEGORIES.join('、');
  const memoryById = new Map(sample.memories.map(memory => [memory.id, memory]));

  const calls = await mapWithConcurrency(batches, concurrency, (batch, batchIndex) => {
    const prompt = legacy.buildMemoryReviewPrompt(
      batch.map(legacy.buildMemoryReviewEntry).join('\n\n'),
      categories,
      legacy.buildTagOverview(batch),
      batchIndex,
      batches.length,
    );
    return callOnce(call, [{ role: 'user', content: prompt }], legacy.parseMemoryReviewPayload, retryDelaysMs);
  });

  const normalized = { conflicts: [], merges: [], corrections: [], dropped_conflicts: [], tag_only_corrections: 0 };
  calls.forEach((result, batchIndex) => {
    if (result.status !== 'ok') return;
    const { corrections, merge_suggestions: suggestions, dropped_conflicts: droppedConflicts } = result.parsed;
    for (const suggestion of legacy.filterBatchSuggestions(suggestions, batches[batchIndex])) {
      const target = suggestion.kind === 'conflict' ? normalized.conflicts : normalized.merges;
      target.push(suggestion);
    }
    normalized.dropped_conflicts.push(...droppedConflicts);
    for (const correction of corrections) {
      const memory = memoryById.get(correction.id);
      if (!memory) continue;
      if (isCategoryChange(correction, memory)) {
        normalized.corrections.push({ id: correction.id, category: correction.category, reason: textField(correction.reason) });
      } else if (Array.isArray(correction.tags) || typeof correction.importance === 'number') {
        normalized.tag_only_corrections += 1;
      }
    }
  });

  return {
    batches: batches.map(batch => batch.map(memory => memory.id)),
    calls: calls.map((result, batch) => storedCall(result, { batch })),
    normalized,
    ...summarizeCalls(calls),
  };
}

function normalizeSpikeResult(goal, parsed, batch, normalized) {
  const batchIds = new Set(batch.map(memory => memory.id));
  const memoryById = new Map(batch.map(memory => [memory.id, memory]));

  if (goal === 'conflict') {
    for (const row of Array.isArray(parsed.conflicts) ? parsed.conflicts : []) {
      const ids = uniqueIds(row?.memory_ids);
      if (ids.length < 2 || !ids.every(id => batchIds.has(id))) continue;
      normalized.conflicts.push({ source_ids: ids, reason: textField(row.reason), evidence: textField(row.evidence) });
    }
  } else if (goal === 'duplicate') {
    // 与旧流程经过同一道过滤（同批、不含不可合并条目、来源不重叠），两边的错误合并才可比。
    const suggestions = (Array.isArray(parsed.merges) ? parsed.merges : [])
      .filter(row => textField(row?.merged_content))
      .map(row => ({
        kind: 'merge',
        source_ids: uniqueIds(row.source_ids),
        merged_content: row.merged_content.trim(),
        reason: textField(row.reason),
        evidence: textField(row.evidence),
      }));
    normalized.merges.push(...legacy.filterBatchSuggestions(suggestions, batch));
  } else {
    for (const row of Array.isArray(parsed.corrections) ? parsed.corrections : []) {
      const memory = memoryById.get(row?.id);
      if (!memory || !isCategoryChange(row, memory)) continue;
      normalized.corrections.push({ id: row.id, category: row.category, reason: textField(row.reason), evidence: textField(row.evidence) });
    }
  }
}

async function runSpike(sample, call, { concurrency = 3, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  const batches = batchesOf(sample, spike.SPIKE_BATCH_SIZE);
  const jobs = batches.flatMap((batch, batchIndex) => spike.SPIKE_GOALS.map(goal => ({ goal, batch, batchIndex })));

  const calls = await mapWithConcurrency(jobs, concurrency, job => callOnce(
    call,
    [{ role: 'user', content: spike.buildSpikePrompt(job.goal, job.batch, sample.character) }],
    spike.parseSpikePayload,
    retryDelaysMs,
  ));

  const normalized = { conflicts: [], merges: [], corrections: [], dropped_conflicts: [], tag_only_corrections: 0 };
  calls.forEach((result, index) => {
    if (result.status === 'ok') normalizeSpikeResult(jobs[index].goal, result.parsed, jobs[index].batch, normalized);
  });

  return {
    batches: batches.map(batch => batch.map(memory => memory.id)),
    calls: calls.map((result, index) => storedCall(result, { batch: jobs[index].batchIndex, goal: jobs[index].goal })),
    normalized,
    ...summarizeCalls(calls),
  };
}

const RUNNERS = { legacy: runLegacy, spike: runSpike, agent: runAgent };

function modelDir(outputDir, model) {
  return path.join(outputDir, 'runs', model.replace(/[^\w.-]+/g, '_'));
}

function readRecord(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** 跑完立刻落盘，已完成的跳过；样本变了（hash 不同）或上次未完成都会重跑。 */
async function runMode({ mode, sampleName, runs, model, call, outputDir = OUTPUT_DIR, force = false, log = () => {}, ...options }) {
  const sample = loadSample(sampleName);
  const implementationHash = mode === 'agent' ? agentImplementationHash() : null;
  const dir = modelDir(outputDir, model);
  fs.mkdirSync(dir, { recursive: true });
  const records = [];
  for (let run = 1; run <= runs; run += 1) {
    const filePath = path.join(dir, `${mode}-${sampleName}-run${run}.json`);
    if (!force && fs.existsSync(filePath)) {
      const existing = readRecord(filePath);
      if (!existing.incomplete && existing.sample_hash === sample.hash && existing.model === model && existing.mode === mode
        && (mode !== 'agent' || existing.implementation_hash === implementationHash)) {
        log(`跳过 ${mode} ${sampleName} 第 ${run} 次（已完成）`);
        records.push(existing);
        continue;
      }
    }
    const startedAt = Date.now();
    const result = await RUNNERS[mode](sample, call, { ...options, model, log });
    const record = { mode, sample: sampleName, sample_hash: sample.hash, model, run, generated_at: new Date().toISOString(),
      ...(implementationHash ? { implementation_hash: implementationHash } : {}), ...result };
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
    log(`${mode} ${sampleName} 第 ${run}/${runs} 次：${result.calls.length} 次调用，失败 ${result.failed_calls}${result.incomplete ? '，未完成（上游错误）' : ''}，${Math.round((Date.now() - startedAt) / 1000)}s`);
    records.push(record);
  }
  return records;
}

function scoreRecord(record, expected, verdicts) {
  return scoreRun({ ...record.normalized, batches: record.batches, failed_calls: record.failed_calls }, expected, verdicts);
}

function pct(value) {
  return value === null || value === undefined ? '无' : `${(value * 100).toFixed(1)}%`;
}

function num(value) {
  return value === null || value === undefined ? '无' : value.toFixed(1);
}

function accuracyText(aggregate) {
  if (aggregate.accuracy_lower === aggregate.accuracy_upper) return pct(aggregate.accuracy_lower);
  return `${pct(aggregate.accuracy_lower)} ~ ${pct(aggregate.accuracy_upper)}`;
}

function hitsPerRun(scores, select) {
  return scores.map(score => `${select(score).hits}/${select(score).total}`).join('，');
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => `${value}×${count}`).join('，') || '无';
}

function metricRows(left, right, leftScores, rightScores) {
  const rows = [
    ['矛盾检出率', pct(left.conflict_recall), pct(right.conflict_recall)],
    ['矛盾命中（每次）', hitsPerRun(leftScores, s => s.conflicts), hitsPerRun(rightScores, s => s.conflicts)],
    ['矛盾检出率（仅同批可见）', pct(left.conflict_visible_recall), pct(right.conflict_visible_recall)],
    ['矛盾检出率（含旧解析器丢弃的）', pct(left.conflict_recall_with_dropped), pct(right.conflict_recall_with_dropped)],
    ['重复检出率', pct(left.duplicate_recall), pct(right.duplicate_recall)],
    ['重复命中（每次）', hitsPerRun(leftScores, s => s.duplicates), hitsPerRun(rightScores, s => s.duplicates)],
    ['重复检出率（仅同批可见）', pct(left.duplicate_visible_recall), pct(right.duplicate_visible_recall)],
    ['误分类检出率', pct(left.misclassified_recall), pct(right.misclassified_recall)],
    ['建议准确率', accuracyText(left), accuracyText(right)],
    ['平均建议数', num(left.suggestions_per_run), num(right.suggestions_per_run)],
    ['错误合并（每次平均）', num(left.wrong_merges_per_run), num(right.wrong_merges_per_run)],
    ['理由覆盖率', pct(left.reason_coverage), pct(right.reason_coverage)],
    ['依据覆盖率', pct(left.evidence_coverage), pct(right.evidence_coverage)],
    ['模型失败的调用', String(left.failed_calls_total), String(right.failed_calls_total)],
    ['只改标签或重要度（不计分）', num(mean(leftScores.map(s => s.tag_only_corrections))), num(mean(rightScores.map(s => s.tag_only_corrections)))],
  ];
  return rows.map(row => `| ${row.join(' | ')} |`).join('\n');
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function gateLine(label, gate) {
  const accuracy = gate.accuracy_improved ? '确定提高' : gate.accuracy_undetermined ? '待人工判定' : '未提高';
  return `| ${label} | ${pct(gate.baseline_recall)} → ${pct(gate.spike_recall)}（${gate.recall_improved ? '提高' : '未提高'}） | ${accuracy} | ${gate.pass ? '通过' : '不通过'} |`;
}

function describeSuggestion(row, memoryById) {
  const quote = id => `  - ${id}：${memoryById.get(id)?.content ?? '（样本外 ID）'}`;
  const ids = row.type === 'category' ? [row.item.id] : row.item.source_ids;
  const detail = row.type === 'category' ? `改为 ${row.item.category}` : row.item.reason ?? '';
  return `- \`${row.key}\` ${detail}\n${ids.map(quote).join('\n')}`;
}

/** records: { small: { legacy: [...], spike: [...] }, scale: {...} }，只含已完成的运行。 */
function buildReport({ model, records, verdicts = {} }) {
  const sections = [];
  const gateRows = [];
  const allScores = { legacy: [], spike: [] };

  for (const sampleName of SAMPLES) {
    const sampleRecords = records[sampleName];
    if (!sampleRecords?.legacy?.length || !sampleRecords?.spike?.length) continue;
    const sample = loadSample(sampleName);
    const memoryById = new Map(sample.memories.map(memory => [memory.id, memory]));
    const scores = {
      legacy: sampleRecords.legacy.map(record => scoreRecord(record, sample.expected, verdicts)),
      spike: sampleRecords.spike.map(record => scoreRecord(record, sample.expected, verdicts)),
    };
    allScores.legacy.push(...scores.legacy);
    allScores.spike.push(...scores.spike);
    const aggregates = { legacy: aggregateScores(scores.legacy), spike: aggregateScores(scores.spike) };
    gateRows.push(gateLine(sampleName, evaluateGate(aggregates.legacy, aggregates.spike)));

    const pending = new Map();
    const wrong = { legacy: [], spike: [] };
    const missed = { legacy: [], spike: [] };
    for (const mode of ['legacy', 'spike']) {
      for (const score of scores[mode]) {
        for (const row of score.needs_review) pending.set(row.key, row);
        wrong[mode].push(...score.wrong_items.map(item => item.detail));
        missed[mode].push(...score.conflicts.missed, ...score.duplicates.missed, ...score.misclassified.missed);
      }
    }

    sections.push([
      `## 样本 ${sampleName}（${sample.memories.length} 条，hash ${sample.hash}）`,
      `旧流程 ${sampleRecords.legacy[0].batches.length} 批、${scores.legacy.length} 次运行；验证模式 ${sampleRecords.spike[0].batches.length} 批、${scores.spike.length} 次运行。`,
      '',
      '| 指标 | 旧流程 | 验证模式 |',
      '| --- | --- | --- |',
      metricRows(aggregates.legacy, aggregates.spike, scores.legacy, scores.spike),
      '',
      `漏检（埋点×次数）\n- 旧流程：${tally(missed.legacy)}\n- 验证模式：${tally(missed.spike)}`,
      '',
      `判错原因（原因×次数）\n- 旧流程：${tally(wrong.legacy)}\n- 验证模式：${tally(wrong.spike)}`,
      '',
      `### 待人工判定（${pending.size} 项）`,
      pending.size === 0 ? '无。' : [...pending.values()].map(row => describeSuggestion(row, memoryById)).join('\n'),
    ].join('\n'));
  }

  if (allScores.legacy.length > 0 && allScores.spike.length > 0) {
    gateRows.push(gateLine('合并', evaluateGate(aggregateScores(allScores.legacy), aggregateScores(allScores.spike))));
  }

  return [
    `# 记忆整理评测：${model}`,
    '',
    '## 门槛（AC-QUALITY-07）',
    '检出率取矛盾、重复、误分类三项的平均。检出率和准确率都没有高于旧流程时暂停。最终由主人确认。',
    '',
    '| 样本 | 检出率 | 准确率 | 判定 |',
    '| --- | --- | --- | --- |',
    ...gateRows,
    '',
    '## 解读前必读',
    '- 样本、来源消息和验证模式的提示词都由同一人编写，可能偏向新方案。规模样本的填充是模板生成的。',
    '- 陷阱 t6、st6 只有看到来源消息才能判断，旧流程本来就看不到来源消息。这正是被验证的假设，但也让这两项天然有利于新方案。',
    '- 验证模式不跑工具循环，跨 40 条边界的埋点结构上看不到，总检出率因此偏低；真实 Agent 能否找回它们要到 M4 才能验证。',
    '- 验证模式每批调用三次，只报分类、矛盾、重复；旧流程还要整理标签和重要度，这部分不计分。',
    '',
    ...sections.flatMap(section => [section, '']),
  ].join('\n');
}

/** 只核验已被系统接受的提案；来源重读必须先于生成提案的模型调用。 */
function foldedEvidenceItems(record) {
  const refetchedByGoal = new Map((record.phases ?? []).map(phase => [phase.goal, new Set(phase.refetched_source_ids_after_fold ?? [])]));
  const readAt = new Map();
  const items = [];
  const sameIds = (left, right) => left.length === right.length && left.every(id => right.includes(id));
  for (const [index, call] of (record.calls ?? []).entries()) {
    if (call.status !== 'ok') continue;
    const refetched = refetchedByGoal.get(call.goal) ?? new Set();
    for (const tool of call.tool_calls ?? []) {
      let args;
      try { args = JSON.parse(tool.arguments); } catch { continue; }
      if (!args || typeof args !== 'object') continue;
      if (tool.name === 'get_memory_sources' && call.folded_tools?.length > 0 && Array.isArray(args.memory_ids)) {
        for (const id of args.memory_ids) if (refetched.has(id)) readAt.set(`${call.goal}:${id}`, index);
      }
      if (tool.name !== 'create_memory_proposal' || !Array.isArray(args.items)) continue;
      for (const item of args.items) {
        if (!item || typeof item !== 'object') continue;
        const ids = Array.isArray(item.memory_ids) ? item.memory_ids : typeof item.memory_id === 'string' ? [item.memory_id] : [];
        if (ids.length === 0 || !ids.every(id => {
          const sourceCall = readAt.get(`${call.goal}:${id}`);
          return sourceCall !== undefined && sourceCall < index;
        })) continue;
        const evidence = item.evidence?.message_ids;
        // 虚构来源 ID 与 seedDatabase 中的生成规则相同，确保引用的正是重读的来源。
        if (!Array.isArray(evidence) || !ids.every(id => evidence.some(messageId => typeof messageId === 'string' && messageId.startsWith(`eval-msg-${id}-`)))) continue;
        const normalized = item.op === 'report_conflict' ? record.normalized.conflicts
          : item.op === 'merge' ? record.normalized.merges
            : item.op === 'update' ? record.normalized.corrections : [];
        const accepted = normalized.some(row => sameIds(ids, row.source_ids ?? [row.id])
          && row.reason === item.reason && row.evidence === JSON.stringify(evidence)
          && (item.op !== 'merge' || row.merged_content === item.fields?.content)
          && (item.op !== 'update' || row.category === item.fields?.category));
        if (accepted) items.push({ goal: call.goal, model_call: index + 1, op: item.op, memory_ids: ids, message_ids: evidence });
      }
    }
  }
  return items;
}

/** 最终评测保留每次运行和必备场景，不能用合并平均掩盖某个样本的退步。 */
function buildAgentReport({ model, records, verdicts = {} }) {
  const sections = [`# 完整 Agent 记忆整理评测：${model}`, '',
    '门槛按 AC-QUALITY-03：错误合并为 0，矛盾检出率和建议准确率不低于同模型旧流程，每项都有理由；小样本和规模样本分别至少 3 次。准确率用新流程下界与旧流程上界保守比较。结果仍需主人确认，未通过不进入 M5。', '',
    'Agent 使用真实循环和工具、虚构 :memory: 数据，全部提案未批准。评测的 Agent context_window 为 48000，以实际运行结果观察折叠与重新取证；角色聊天完全不受影响。折叠取证只计入重读来源之后生成、引用该来源且已被系统接受的提案，每个规模运行都须命中。', ''];
  for (const sampleName of SAMPLES) {
    const sample = loadSample(sampleName);
    const baseline = records[sampleName]?.legacy ?? [];
    const agent = records[sampleName]?.agent ?? [];
    const baselineScores = baseline.map(record => scoreRecord(record, sample.expected, verdicts));
    const agentScores = agent.map(record => scoreRecord(record, sample.expected, verdicts));
    const left = aggregateScores(baselineScores);
    const right = aggregateScores(agentScores);
    const gate = evaluateAgentGate(left, right);
    const covers = (record, ids) => record.normalized.conflicts.some(item => ids.every(id => item.source_ids.includes(id)));
    const isCrossBatch = (record, ids) => {
      const indexes = ids.map(id => record.batches.findIndex(batch => batch.includes(id)));
      return indexes.every(index => index >= 0) && new Set(indexes).size > 1;
    };
    const crossPlants = sample.expected.conflicts.filter(plant => agent.some(record => isCrossBatch(record, plant.memory_ids)));
    const mandatory = {
      full_coverage: agent.length >= 3 && agent.every(record => record.memory_unchanged && record.phases?.length === 3 && record.phases.every(phase => phase.complete)),
      cross_batch: agent.length >= 3 && crossPlants.length > 0 && agent.every(record => crossPlants.some(plant => covers(record, plant.memory_ids))),
      ...(sampleName === 'small' ? { c1_c5: agent.length >= 3 && agent.every(record => ['c1', 'c5'].every(id => covers(record, sample.expected.conflicts.find(plant => plant.id === id).memory_ids))) } : {
        folded_evidence: agent.length >= 3 && agent.every(record => foldedEvidenceItems(record).length > 0),
      }),
    };
    const passed = gate.pass && Object.values(mandatory).every(Boolean);
    sections.push(`## ${sampleName}（${sample.memories.length} 条，hash ${sample.hash}）`, '',
      `旧流程 ${baseline.length} 次；完整 Agent ${agent.length} 次。当前门槛：**${passed ? '通过，待主人确认' : '未通过或验证不足'}**。`, '',
      '| 指标 | 旧流程 | 完整 Agent |', '| --- | --- | --- |',
      metricRows(left, right, baselineScores, agentScores), '',
      '| 条件 | 结果 |', '| --- | --- |',
      ...Object.entries({ ...gate.checks, ...mandatory }).map(([name, pass]) => `| ${name} | ${pass ? '通过' : '未通过'} |`), '',
      '| 矛盾埋点 | 每次命中 | 跨批 |', '| --- | --- | --- |',
      ...sample.expected.conflicts.map(plant => `| ${plant.id} | ${agent.map(record => covers(record, plant.memory_ids) ? '是' : '否').join('，') || '无运行'} | ${agent.some(record => isCrossBatch(record, plant.memory_ids)) ? '是' : '否'} |`), '',
      '| 运行 | 模型调用 | 来源读取 | 折叠后重新取证 | 重读后有据提案 |', '| --- | --- | --- | --- | --- |',
      ...agent.map(record => `| ${record.run} | ${record.calls.length} | ${record.phases.reduce((sum, phase) => sum + phase.source_reads, 0)} | ${record.phases.reduce((sum, phase) => sum + phase.refetched_source_ids_after_fold.length, 0)} 条 | ${foldedEvidenceItems(record).length} 项 |`), '');
    const pending = new Map();
    const wrong = [];
    for (const score of [...baselineScores, ...agentScores]) {
      for (const row of score.needs_review) pending.set(row.key, row);
    }
    for (const score of agentScores) wrong.push(...score.wrong_items.map(item => item.detail));
    sections.push(`Agent 判错原因：${tally(wrong)}`, '', `### 待人工判定（${pending.size} 项）`, '',
      pending.size === 0 ? '无。' : [...pending.values()].map(row => describeSuggestion(row, new Map(sample.memories.map(memory => [memory.id, memory])))).join('\n'), '');
  }
  return sections.join('\n');
}

function loadCompletedRecords(model, outputDir = OUTPUT_DIR) {
  const dir = modelDir(outputDir, model);
  const records = {};
  const skipped = [];
  if (!fs.existsSync(dir)) return { records, skipped };
  for (const sampleName of SAMPLES) {
    const currentHash = loadSample(sampleName).hash;
    records[sampleName] = {};
    for (const mode of MODES) {
      const prefix = `${mode}-${sampleName}-run`;
      records[sampleName][mode] = fs.readdirSync(dir)
        .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
        .sort()
        .map(name => ({ name, record: readRecord(path.join(dir, name)) }))
        .filter(({ name, record }) => {
          const usable = !record.incomplete && record.sample_hash === currentHash && record.model === model && record.mode === mode
            && (mode !== 'agent' || record.implementation_hash === agentImplementationHash());
          if (!usable) skipped.push(name);
          return usable;
        })
        .map(({ record }) => record);
    }
  }
  return { records, skipped };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string' },
      sample: { type: 'string', default: 'all' },
      runs: { type: 'string', default: '3' },
      model: { type: 'string' },
      concurrency: { type: 'string', default: '3' },
      force: { type: 'boolean', default: false },
      verdicts: { type: 'string' },
    },
  });
  const command = positionals[0];
  const config = loadUpstreamConfig();
  const model = values.model || config.models[0];

  if (command === 'run') {
    if (!MODES.includes(values.mode)) throw new Error('--mode 必须是 legacy、spike 或 agent');
    const sampleNames = values.sample === 'all' ? SAMPLES : [values.sample];
    if (!sampleNames.every(name => SAMPLES.includes(name))) throw new Error('--sample 必须是 small、scale 或 all');
    const runs = Number.parseInt(values.runs, 10);
    const concurrency = Number.parseInt(values.concurrency, 10);
    if (!(runs >= 1) || !(concurrency >= 1)) throw new Error('--runs 和 --concurrency 必须是正整数');

    const call = values.mode === 'agent' ? createAgentModelCaller(config, model) : createModelCaller(config, model);
    let incomplete = 0;
    for (const sampleName of sampleNames) {
      const records = await runMode({ mode: values.mode, sampleName, runs, model, call, concurrency, force: values.force, log: console.log });
      incomplete += records.filter(record => record.incomplete).length;
    }
    if (incomplete > 0) {
      console.error(`${incomplete} 次运行因上游错误未完成，重跑同一命令即可续跑。`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'report') {
    const verdicts = values.verdicts ? JSON.parse(fs.readFileSync(values.verdicts, 'utf8')) : {};
    const { records, skipped } = loadCompletedRecords(model);
    const reportPath = path.join(OUTPUT_DIR, `report-${values.mode === 'agent' ? 'agent-' : ''}${model.replace(/[^\w.-]+/g, '_')}.md`);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(reportPath, values.mode === 'agent' ? buildAgentReport({ model, records, verdicts }) : buildReport({ model, records, verdicts }));
    if (skipped.length > 0) console.log(`未计入（未完成或样本已变）：${skipped.join('，')}`);
    console.log(`报告：${path.relative(process.cwd(), reportPath)}`);
    return;
  }

  if (command === 'models') { console.log(JSON.stringify({ models: config.models })); return; }
  throw new Error('用法：run --mode legacy|spike|agent --sample small|scale|all，或 report --mode agent，或 models');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { buildAgentReport, buildReport, createModelCaller, foldedEvidenceItems, loadCompletedRecords, runAgent, runLegacy, runMode, runSpike };
