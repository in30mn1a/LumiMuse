/**
 * 记忆整理评测的计分器（纯函数，不调用模型）。
 *
 * 新旧流程先归一成同一种结构，再用同一组埋点和同一口径计分：
 *   { conflicts: [{source_ids, reason, evidence}],
 *     merges: [{source_ids, merged_content, reason, evidence}],
 *     corrections: [{id, category, reason, evidence}],
 *     batches: string[][], failed_calls: number, tag_only_corrections: number,
 *     dropped_conflicts: [{source_ids}] }
 *
 * 口径：
 * - 命中：建议的 ID 集合覆盖埋点的全部 ID。
 * - 错误：落在「不应改动」的条目上；合并了陷阱或矛盾；把陷阱报成矛盾；改错分类。
 * - 未标注：其他建议。不能自动判断，列出来人工判定后通过 verdicts 计入；
 *   没有判定时给出准确率的上下界。
 * - 只改标签或重要度的修正不计入准确率：旧流程的目标包含它们，验证模式不做，无法同口径比较。
 */

function coversAll(sourceIds, memoryIds) {
  const set = new Set(sourceIds);
  return memoryIds.every(id => set.has(id));
}

function itemKey(type, ids, suffix = '') {
  return `${type}:${[...ids].sort().join(',')}${suffix ? `:${suffix}` : ''}`;
}

function sameBatchLookup(batches) {
  const batchOf = new Map();
  (batches ?? []).forEach((batch, index) => batch.forEach(id => batchOf.set(id, index)));
  return memoryIds => {
    const first = batchOf.get(memoryIds[0]);
    return first !== undefined && memoryIds.every(id => batchOf.get(id) === first);
  };
}

function dedupeByKey(items, keyOf) {
  const seen = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.entries()].map(([key, item]) => ({ key, item }));
}

function recallSummary(plants, isHit, isVisible) {
  const rows = plants.map(plant => ({ id: plant.id, hit: isHit(plant), visible: isVisible(plant) }));
  const visible = rows.filter(row => row.visible);
  return {
    total: rows.length,
    hits: rows.filter(row => row.hit).length,
    visible_total: visible.length,
    visible_hits: visible.filter(row => row.hit).length,
    missed: rows.filter(row => !row.hit).map(row => row.id),
  };
}

function scoreRun(run, expected, verdicts = {}) {
  const doNotTouch = new Set(expected.do_not_touch);
  const touchesProtected = ids => ids.some(id => doNotTouch.has(id));
  const isVisible = sameBatchLookup(run.batches);
  const noCategoryPlants = new Map(expected.misclassified.map(plant => [plant.memory_id, plant]));

  const conflicts = dedupeByKey(run.conflicts, item => itemKey('conflict', item.source_ids));
  const merges = dedupeByKey(run.merges, item => itemKey('merge', item.source_ids));
  const corrections = dedupeByKey(run.corrections, item => itemKey('category', [item.id], item.category));

  const judged = [];
  const wrongMergePlants = new Map();
  const record = (type, key, item, label, detail) => judged.push({ type, key, item, label, detail });

  for (const { key, item } of conflicts) {
    const ids = item.source_ids;
    if (touchesProtected(ids)) {
      record('conflict', key, item, 'wrong', '落在不应改动的条目上');
    } else if (expected.conflicts.some(plant => coversAll(ids, plant.memory_ids))) {
      record('conflict', key, item, 'correct');
    } else {
      const trap = expected.traps.find(plant => coversAll(ids, plant.memory_ids));
      if (trap && !trap.conflict_allowed) record('conflict', key, item, 'wrong', `把陷阱 ${trap.id} 报成矛盾`);
      else if (trap) record('conflict', key, item, 'neutral', `时序变化 ${trap.id} 报成矛盾，不计对错`);
      else record('conflict', key, item, 'unlabeled');
    }
  }

  for (const { key, item } of merges) {
    const ids = item.source_ids;
    const badPlant = [...expected.traps, ...expected.conflicts].find(plant => coversAll(ids, plant.memory_ids));
    if (badPlant) {
      wrongMergePlants.set(key, badPlant.id);
      record('merge', key, item, 'wrong', `合并了不应合并的 ${badPlant.id}`);
    } else if (touchesProtected(ids)) {
      record('merge', key, item, 'wrong', '落在不应改动的条目上');
    } else if (expected.duplicates.some(plant => coversAll(ids, plant.memory_ids) || coversAll(plant.memory_ids, ids))) {
      record('merge', key, item, 'correct');
    } else {
      record('merge', key, item, 'unlabeled');
    }
  }

  for (const { key, item } of corrections) {
    if (doNotTouch.has(item.id)) {
      record('category', key, item, 'wrong', '落在不应改动的条目上');
      continue;
    }
    const plant = noCategoryPlants.get(item.id);
    if (!plant) record('category', key, item, 'unlabeled');
    else if (plant.expected_categories.includes(item.category)) record('category', key, item, 'correct');
    else record('category', key, item, 'wrong', `${plant.id} 应改为 ${plant.expected_categories.join('或')}`);
  }

  for (const item of run.unsupported_suggestions ?? []) {
    record('unsupported', `unsupported:${item.id}`, item, 'wrong', `本次目标不允许的操作 ${item.op}`);
  }

  const counted = judged.filter(row => row.label !== 'neutral');
  const resolved = counted.map(row => {
    if (row.label !== 'unlabeled' || !(row.key in verdicts)) return row;
    return { ...row, label: verdicts[row.key] ? 'correct' : 'wrong', detail: '人工判定' };
  });
  const correct = resolved.filter(row => row.label === 'correct').length;
  const wrong = resolved.filter(row => row.label === 'wrong').length;
  const unlabeled = resolved.filter(row => row.label === 'unlabeled').length;
  const denominator = counted.length;

  const coverage = field => {
    if (judged.length === 0) return null;
    return judged.filter(row => typeof row.item[field] === 'string' && row.item[field].trim()).length / judged.length;
  };
  const conflictHit = sourceSets => plant => sourceSets.some(ids => coversAll(ids, plant.memory_ids));
  const reportedConflictSets = conflicts.map(({ item }) => item.source_ids);
  const droppedConflictSets = (run.dropped_conflicts ?? []).map(item => item.source_ids);

  return {
    conflicts: recallSummary(expected.conflicts, conflictHit(reportedConflictSets), plant => isVisible(plant.memory_ids)),
    conflict_hits_with_dropped: expected.conflicts
      .filter(conflictHit([...reportedConflictSets, ...droppedConflictSets])).length,
    duplicates: recallSummary(
      expected.duplicates,
      plant => merges.some(({ item }) => coversAll(item.source_ids, plant.memory_ids)),
      plant => isVisible(plant.memory_ids),
    ),
    misclassified: recallSummary(
      expected.misclassified,
      plant => corrections.some(({ item }) => item.id === plant.memory_id && plant.expected_categories.includes(item.category)),
      () => true,
    ),
    wrong_merges: resolved
      .filter(row => row.type === 'merge' && row.label === 'wrong')
      .map(row => ({ key: row.key, ...(wrongMergePlants.has(row.key)
        ? { plant: wrongMergePlants.get(row.key) } : { detail: row.detail }) })),
    accuracy: {
      correct,
      wrong,
      unlabeled,
      total: denominator,
      lower: denominator === 0 ? null : correct / denominator,
      upper: denominator === 0 ? null : (correct + unlabeled) / denominator,
    },
    reason_coverage: coverage('reason'),
    evidence_coverage: coverage('evidence'),
    failed_calls: run.failed_calls ?? 0,
    tag_only_corrections: run.tag_only_corrections ?? 0,
    needs_review: judged
      .filter(row => row.label === 'unlabeled' && !(row.key in verdicts))
      .map(row => ({ key: row.key, type: row.type, item: row.item })),
    wrong_items: resolved
      .filter(row => row.label === 'wrong')
      .map(row => ({ key: row.key, type: row.type, detail: row.detail })),
  };
}

function mean(values) {
  const known = values.filter(value => value !== null && value !== undefined);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length;
}

function aggregateScores(scores) {
  const rate = (select, field) => mean(scores.map(score => {
    const part = select(score);
    return part[field] === 0 ? null : part[field === 'total' ? 'hits' : 'visible_hits'] / part[field];
  }));
  return {
    runs: scores.length,
    conflict_recall: rate(score => score.conflicts, 'total'),
    conflict_visible_recall: rate(score => score.conflicts, 'visible_total'),
    conflict_recall_with_dropped: mean(scores.map(score => (
      score.conflicts.total === 0 ? null : score.conflict_hits_with_dropped / score.conflicts.total
    ))),
    duplicate_recall: rate(score => score.duplicates, 'total'),
    duplicate_visible_recall: rate(score => score.duplicates, 'visible_total'),
    misclassified_recall: rate(score => score.misclassified, 'total'),
    accuracy_lower: mean(scores.map(score => score.accuracy.lower)),
    accuracy_upper: mean(scores.map(score => score.accuracy.upper)),
    suggestions_per_run: mean(scores.map(score => score.accuracy.total)),
    wrong_merges_per_run: mean(scores.map(score => score.wrong_merges.length)),
    reason_coverage: mean(scores.map(score => score.reason_coverage)),
    evidence_coverage: mean(scores.map(score => score.evidence_coverage)),
    failed_calls_total: scores.reduce((sum, score) => sum + score.failed_calls, 0),
    unreviewed_total: scores.reduce((sum, score) => sum + score.needs_review.length, 0),
  };
}

/**
 * AC-QUALITY-07 的门槛：检出率和准确率都没有高于基线就暂停。
 * 还有未判定的建议时，准确率用保守比较：验证模式的下界要高于基线的上界才算确定提高。
 */
function evaluateGate(baseline, spike) {
  const recall = aggregate => mean([aggregate.conflict_recall, aggregate.duplicate_recall, aggregate.misclassified_recall]);
  const recallImproved = recall(spike) > recall(baseline);
  const accuracyImproved = spike.accuracy_lower > baseline.accuracy_upper;
  const accuracyPossiblyImproved = spike.accuracy_upper > baseline.accuracy_lower;
  return {
    baseline_recall: recall(baseline),
    spike_recall: recall(spike),
    recall_improved: recallImproved,
    accuracy_improved: accuracyImproved,
    accuracy_undetermined: !accuracyImproved && accuracyPossiblyImproved && (spike.unreviewed_total + baseline.unreviewed_total) > 0,
    pass: recallImproved || accuracyImproved,
  };
}

/** M4 的最终门槛：以准确率保守下界比较，缺少运行或指标时不能判为通过。 */
function evaluateAgentGate(baseline, agent) {
  const atLeast = (value, target) => Number.isFinite(value) && Number.isFinite(target) && value >= target;
  const checks = {
    enough_runs: baseline.runs >= 3 && agent.runs >= 3,
    no_wrong_merges: agent.wrong_merges_per_run === 0,
    conflict_recall: atLeast(agent.conflict_recall, baseline.conflict_recall),
    suggestion_accuracy: atLeast(agent.accuracy_lower, baseline.accuracy_upper),
    all_reasons: agent.reason_coverage === 1,
  };
  return { pass: Object.values(checks).every(Boolean), checks, accuracy_undetermined: agent.unreviewed_total + baseline.unreviewed_total > 0 };
}

module.exports = { aggregateScores, evaluateAgentGate, evaluateGate, scoreRun };
