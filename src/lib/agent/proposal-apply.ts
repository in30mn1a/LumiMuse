/**
 * 主人对 Agent 提案的决定：逐项批准或拒绝，以及撤销已生效的项。
 *
 * 整个决定在一个事务里完成，每个批准项再套一层 savepoint：单项出错只把该项记为 failed，
 * 不影响其他项。应用前用 memoryBusinessSnapshot 与提案时的快照比较，不一致就记为 stale 跳过，
 * 不覆盖后来的修改；只变使用次数、最近使用时间不算改动。撤销用同样的比较对照应用后快照。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { executeMemorySummaryArchive, undoMemorySummaryArchiveBatch } from '@/lib/memory-archive';
import { invalidateMemoryTokenCache } from '@/lib/memory-engine';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';
import { executeMemoryMerge, undoMemoryMergeBatch } from '@/lib/memory-merge';
import {
  applyMemoryUpdate,
  createMemoryRow,
  memoryBusinessSnapshot,
  type MemoryBusinessSnapshot,
} from '@/lib/memory-mutations';
import { publicErrorMessage } from '@/lib/public-error';
import type { MemoryUpdate } from '@/lib/schemas';
import type { MemoryStatus } from '@/types';
import type { ProposalDecisionEventItem } from './messages';
import {
  candidateTaskSucceeded,
  loadCandidateTask,
  listProposalItems,
  MAX_PROPOSAL_ITEMS,
  type ProposalBefore,
  type ProposalEvidence,
  type ProposalItemRow,
  type ProposalMemoryFields,
  type ProposalMemoryTarget,
  type ProposalRepairAfter,
  type ProposalRow,
} from './proposals';
import { appendAgentMessage } from './store';

const MAX_REJECT_REASON = 2000;

const applyDecisionSchema = z.object({
  action: z.literal('apply'),
  approved_item_ids: z.array(z.number().int().positive()).max(MAX_PROPOSAL_ITEMS).default([]),
  /** 没有列出、也没有批准的 pending 项同样记为拒绝，只是没有原因 */
  rejected_items: z.array(z.object({
    id: z.number().int().positive(),
    reason: z.string().max(MAX_REJECT_REASON).optional(),
  })).max(MAX_PROPOSAL_ITEMS).default([]),
});

export const proposalDecisionSchema = z.discriminatedUnion('action', [
  applyDecisionSchema,
  z.object({ action: z.literal('undo'), item_id: z.number().int().positive() }),
]);
export type ProposalDecisionInput = z.infer<typeof applyDecisionSchema>;

/** 已应用项的 result_json：撤销时据此判断冲突。 */
export interface ProposalApplyResult {
  /** 受影响的全部记忆，含新生成的合并结果、归档摘要 */
  memory_ids: string[];
  created_memory_id: string | null;
  batch_id: string | null;
  /** 每一行应用后的业务快照 */
  after: ProposalMemoryTarget[];
}

type DecisionFailure = { ok: false; status: 400 | 404 | 409; error: string };

export type ApplyProposalOutcome = { ok: true; items: ProposalDecisionEventItem[] } | DecisionFailure;

export type UndoProposalOutcome = { ok: true } | DecisionFailure;

type ItemOutcome =
  | { state: 'applied'; result: ProposalApplyResult; indexIds: string[] }
  | { state: 'stale'; detail: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function loadSnapshots(
  db: Database.Database,
  characterId: string,
  ids: readonly string[],
): Map<string, MemoryBusinessSnapshot> {
  if (ids.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT id, content, category, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, metadata
    FROM memories
    WHERE character_id = ? AND id IN (${ids.map(() => '?').join(', ')})
  `).all(characterId, ...ids) as (MemoryBusinessSnapshot & { id: string })[];
  return new Map(rows.map(row => [row.id, memoryBusinessSnapshot(row)]));
}

/** 提案之后被改动或删除的目标。快照字段顺序固定、JSON 键已排序，可以直接比较序列化结果。 */
function changedTargets(db: Database.Database, characterId: string, targets: readonly ProposalMemoryTarget[]): string[] {
  const current = loadSnapshots(db, characterId, targets.map(target => target.id));
  return targets
    .filter(target => {
      const snapshot = current.get(target.id);
      return !snapshot || JSON.stringify(snapshot) !== JSON.stringify(target.snapshot);
    })
    .map(target => target.id);
}

interface RevisionEntry {
  memoryId: string;
  /** 新建的行没有修改前快照，删除的行没有修改后快照 */
  before: MemoryBusinessSnapshot | null;
  after: MemoryBusinessSnapshot | null;
}

/** 每条受影响的记忆各记一条修订，理由和依据取自提案项。 */
function insertRevisions(
  db: Database.Database,
  characterId: string,
  item: ProposalItemRow,
  action: 'apply' | 'undo',
  entries: readonly RevisionEntry[],
  now: string,
): void {
  const insert = db.prepare(`
    INSERT INTO memory_revisions (
      character_id, memory_id, proposal_item_id, op, action, reason, evidence_json, before_json, after_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entry of entries) {
    insert.run(
      characterId,
      entry.memoryId,
      item.id,
      item.op,
      action,
      item.reason,
      item.evidence_json,
      entry.before ? JSON.stringify(entry.before) : null,
      entry.after ? JSON.stringify(entry.after) : null,
      now,
    );
  }
}

/** create 与补回共用：依据消息就是新记忆的来源，记忆详情和 get_memory_sources 可以据此回溯。 */
function createProposalMemory(
  db: Database.Database,
  characterId: string,
  item: ProposalItemRow,
  fields: ProposalMemoryFields,
  metadata: Record<string, unknown>,
  now: string,
): string {
  const evidence = JSON.parse(item.evidence_json) as ProposalEvidence;
  const memory = createMemoryRow(db, {
    character_id: characterId,
    content: fields.content!,
    category: fields.category!,
    tags: fields.tags,
    memory_kind: fields.memory_kind,
    importance: fields.importance,
    emotional_weight: fields.emotional_weight,
    pinned: fields.pinned,
    metadata: { ...metadata, createdByProposalItem: item.id },
  }, now);
  if (evidence.message_ids.length > 0) {
    db.prepare('UPDATE memories SET source_msg_ids = ? WHERE id = ?').run(JSON.stringify(evidence.message_ids), memory.id);
  }
  return memory.id;
}

function applyItem(db: Database.Database, proposal: ProposalRow, item: ProposalItemRow, now: string): ItemOutcome {
  const characterId = proposal.character_id;
  const before = JSON.parse(item.before_json) as ProposalBefore;
  const after = JSON.parse(item.after_json) as ProposalMemoryFields;
  const targets = before && 'memories' in before ? before.memories : [];

  const changed = changedTargets(db, characterId, targets);
  if (changed.length > 0) {
    return { state: 'stale', detail: `记忆 ${changed.join('、')} 在提案生成后已被改动或删除，没有修改` };
  }

  if (item.op === 'repair_candidate' && before && 'candidate' in before && !before.candidate.task_succeeded) {
    const currentTask = loadCandidateTask(db, characterId, before.candidate.task_id);
    if (candidateTaskSucceeded(currentTask)) {
      return {
        state: 'stale',
        detail: `原提取任务 ${before.candidate.task_id} 在提案生成后已成功，旧补回项需要重新审阅，没有修改`,
      };
    }
  }

  const targetIds = targets.map(target => target.id);
  let createdId: string | null = null;
  let batchId: string | null = null;
  const repairedIds: string[] = [];
  switch (item.op) {
    case 'create':
      createdId = createProposalMemory(db, characterId, item, after, {}, now);
      break;
    case 'update':
      applyMemoryUpdate(db, targetIds[0], after, now);
      break;
    case 'retire': {
      const { snapshot } = targets[0];
      const metadata = isObject(snapshot.metadata) ? snapshot.metadata : {};
      applyMemoryUpdate(db, targetIds[0], {
        status: 'superseded',
        metadata: { ...metadata, previousStatus: snapshot.status, retiredByProposalItem: item.id },
      }, now);
      break;
    }
    case 'merge':
      batchId = randomUUID();
      createdId = executeMemoryMerge(db, {
        batchId,
        characterId,
        resultMemoryId: randomUUID(),
        sourceIds: targetIds,
        mergedContent: after.content!,
        category: after.category,
        tags: after.tags,
        importance: after.importance,
        memoryKind: after.memory_kind,
        now,
      }).resultMemoryId;
      break;
    case 'archive':
      batchId = randomUUID();
      createdId = executeMemorySummaryArchive(db, {
        batchId,
        characterId,
        summaryMemoryId: randomUUID().slice(0, 12),
        summaryContent: after.content!,
        coveredMemoryIds: targetIds,
        now,
      }).summaryMemory.id;
      break;
    case 'repair_candidate':
    case 'discard_candidate': {
      const candidateId = before && 'candidate' in before ? before.candidate.id : null;
      // 条件更新即抢占：记录已被处理时 changes 为 0，重复批准不会重复补回
      const changes = db.prepare(`
        UPDATE memory_extraction_candidates SET status = ?, updated_at = ?
        WHERE id = ? AND character_id = ? AND status = 'repairable'
      `).run(item.op === 'repair_candidate' ? 'repaired' : 'discarded', now, candidateId, characterId).changes;
      if (changes === 0) return { state: 'stale', detail: `待修复记录 ${candidateId} 已被处理，没有修改` };
      if (item.op === 'discard_candidate') {
        return { state: 'applied', result: { memory_ids: [], created_memory_id: null, batch_id: null, after: [] }, indexIds: [] };
      }
      // 外层 savepoint 保证整项要么全部补回、要么连记录状态一起回滚
      const { memories } = JSON.parse(item.after_json) as ProposalRepairAfter;
      for (const memory of memories) {
        repairedIds.push(createProposalMemory(db, characterId, item, memory, { repairedFromCandidate: candidateId }, now));
      }
      break;
    }
    default:
      throw new Error(`${item.op} 不能批准`);
  }

  const memoryIds = createdId ? [...targetIds, createdId] : [...targetIds, ...repairedIds];
  const current = loadSnapshots(db, characterId, memoryIds);
  const afterTargets = memoryIds.map((id): ProposalMemoryTarget => {
    const snapshot = current.get(id);
    if (!snapshot) throw new Error(`应用后找不到记忆 ${id}`);
    return { id, snapshot };
  });

  const beforeById = new Map(targets.map(target => [target.id, target.snapshot]));
  insertRevisions(db, characterId, item, 'apply', afterTargets.map(target => ({
    memoryId: target.id,
    before: beforeById.get(target.id) ?? null,
    after: target.snapshot,
  })), now);

  return {
    state: 'applied',
    result: { memory_ids: memoryIds, created_memory_id: createdId, batch_id: batchId, after: afterTargets },
    // create、update、retire、补回由 memory-mutations 按手动编辑路径入队；合并结果和归档摘要与对应路由一样在提交后入队
    indexIds: item.op === 'merge' || item.op === 'archive' ? [createdId!] : [],
  };
}

function decidableError(item: ProposalItemRow | undefined, id: number, verb: string): string | null {
  if (!item) return `项 ${id} 不属于这份提案`;
  if (item.state === 'reported') return `第 ${item.seq} 项是矛盾发现，只作记录，不能${verb}`;
  if (item.state !== 'pending') return `第 ${item.seq} 项已经处理过`;
  return null;
}

function queueIndexing(db: Database.Database, characterId: string, memoryIds: readonly string[]): void {
  let queued = false;
  for (const memoryId of memoryIds) {
    try {
      if (enqueueMemoryEmbeddingTask(memoryId, characterId, 'created', db)) queued = true;
    } catch (error) {
      console.error('Failed to enqueue embedding after agent proposal mutation', { memoryId, characterId, error });
    }
  }
  if (queued) triggerMemoryIndexProcessing();
}

/**
 * 决定一份 pending 提案：批准的项逐个应用，其余 pending 项记为拒绝。
 * 决定结果写成会话里的 event 消息，下一轮发给模型时它能看到拒绝原因。
 */
export function applyProposalDecision(
  db: Database.Database,
  proposalId: number,
  input: ProposalDecisionInput,
  now: string,
): ApplyProposalOutcome {
  let characterId = '';
  const indexIds: string[] = [];
  const outcome = db.transaction((): ApplyProposalOutcome => {
    const proposal = db.prepare(`
      SELECT id, session_id, character_id, summary, status, created_at, decided_at FROM agent_proposals WHERE id = ?
    `).get(proposalId) as ProposalRow | undefined;
    if (!proposal) return { ok: false, status: 404, error: '提案不存在' };
    if (proposal.status !== 'pending') return { ok: false, status: 409, error: '这份提案已经处理过' };
    characterId = proposal.character_id;

    const items = listProposalItems(db, proposalId);
    const byId = new Map(items.map(item => [item.id, item]));
    const approved = new Set<number>();
    for (const id of input.approved_item_ids) {
      const error = decidableError(byId.get(id), id, '批准');
      if (error) return { ok: false, status: 400, error };
      approved.add(id);
    }
    const rejectReasons = new Map<number, string>();
    for (const { id, reason } of input.rejected_items) {
      const error = decidableError(byId.get(id), id, '拒绝');
      if (error) return { ok: false, status: 400, error };
      if (approved.has(id)) return { ok: false, status: 400, error: `第 ${byId.get(id)!.seq} 项不能同时批准和拒绝` };
      const trimmed = reason?.trim();
      if (trimmed) rejectReasons.set(id, trimmed);
    }

    const updateItem = db.prepare(`
      UPDATE agent_proposal_items SET state = ?, reject_reason = ?, result_json = ?, applied_at = ? WHERE id = ?
    `);
    const decided: ProposalDecisionEventItem[] = [];
    for (const item of items) {
      if (item.state !== 'pending') continue;
      const head = { seq: item.seq, op: item.op };
      if (!approved.has(item.id)) {
        const reason = rejectReasons.get(item.id);
        updateItem.run('rejected', reason ?? null, null, null, item.id);
        decided.push(reason ? { ...head, state: 'rejected', reason } : { ...head, state: 'rejected' });
        continue;
      }
      let result: ItemOutcome;
      try {
        result = db.transaction(() => applyItem(db, proposal, item, now))();
      } catch (error) {
        const detail = publicErrorMessage(error, '应用时出错');
        updateItem.run('failed', null, JSON.stringify({ detail }), null, item.id);
        decided.push({ ...head, state: 'failed', reason: detail });
        continue;
      }
      if (result.state === 'stale') {
        updateItem.run('stale', null, JSON.stringify({ detail: result.detail }), null, item.id);
        decided.push({ ...head, state: 'stale', reason: result.detail });
      } else {
        updateItem.run('applied', null, JSON.stringify(result.result), now, item.id);
        indexIds.push(...result.indexIds);
        decided.push({ ...head, state: 'applied' });
      }
    }

    db.prepare(`UPDATE agent_proposals SET status = 'decided', decided_at = ? WHERE id = ?`).run(now, proposalId);
    if (proposal.session_id) {
      appendAgentMessage(db, proposal.session_id, {
        role: 'event',
        content: JSON.stringify({ kind: 'proposal_decision', proposal_id: proposalId, items: decided }),
      }, now);
    }
    return { ok: true, items: decided };
  })();

  if (outcome.ok) queueIndexing(db, characterId, indexIds);
  return outcome;
}

/** 撤销会覆盖批准之后的修改：只要涉及的记忆有任何业务字段变化就拒绝。 */
class ProposalUndoConflict extends Error {}

function assertUnchangedSinceApply(
  db: Database.Database,
  characterId: string,
  after: readonly ProposalMemoryTarget[],
): void {
  const changed = changedTargets(db, characterId, after);
  if (changed.length > 0) {
    throw new ProposalUndoConflict(`记忆 ${changed.join('、')} 在批准后又被改动或删除，不能撤销`);
  }
}

/**
 * 合并、归档的冲突保护：现有 undo 函数按批次 ID 恢复，不检查批次后来是否变化，
 * 所以先确认批次成员与结果行和应用时完全一致，再交给它们。
 */
function assertBatchUndoable(
  db: Database.Database,
  characterId: string,
  op: 'merge' | 'archive',
  result: ProposalApplyResult,
): void {
  const batchKey = op === 'merge' ? '$.mergeBatchId' : '$.archiveBatchId';
  const currentIds = (db.prepare(`
    SELECT id FROM memories WHERE character_id = ? AND json_extract(metadata, ?) = ?
  `).all(characterId, batchKey, result.batch_id) as { id: string }[]).map(row => row.id);
  const recorded = new Set(result.memory_ids);
  const current = new Set(currentIds);
  const drifted = [
    ...result.memory_ids.filter(id => !current.has(id)),
    ...currentIds.filter(id => !recorded.has(id)),
  ];
  if (drifted.length > 0) {
    throw new ProposalUndoConflict(`记忆 ${drifted.join('、')} 已离开或加入这次${op === 'merge' ? '合并' : '归档'}，不能撤销`);
  }
  assertUnchangedSinceApply(db, characterId, result.after);
}

function assertCandidateStatus(db: Database.Database, characterId: string, candidateId: number, expected: string): void {
  const row = db.prepare('SELECT status FROM memory_extraction_candidates WHERE id = ? AND character_id = ?')
    .get(candidateId, characterId) as { status: string } | undefined;
  if (!row) throw new ProposalUndoConflict(`待修复记录 ${candidateId} 已删除，不能撤销`);
  if (row.status !== expected) {
    throw new ProposalUndoConflict(`待修复记录 ${candidateId} 当前状态为 ${row.status}，不能撤销`);
  }
}

function restoreBatchMemberSnapshots(
  db: Database.Database,
  characterId: string,
  targets: readonly ProposalMemoryTarget[],
  restoredMemoryIds: readonly string[],
  now: string,
): void {
  const targetsById = new Map(targets.map(target => [target.id, target.snapshot]));
  const restore = db.prepare(`
    UPDATE memories SET status = ?, metadata = ?, updated_at = ? WHERE id = ? AND character_id = ?
  `);
  for (const memoryId of restoredMemoryIds) {
    const original = targetsById.get(memoryId);
    if (!original) throw new Error(`撤销后找不到记忆 ${memoryId} 的原快照`);
    const changes = restore.run(original.status, JSON.stringify(original.metadata), now, memoryId, characterId).changes;
    if (changes !== 1) throw new Error(`恢复记忆 ${memoryId} 的原始业务状态失败`);
  }
}

function undoItem(db: Database.Database, proposal: ProposalRow, item: ProposalItemRow, now: string): string[] {
  const characterId = proposal.character_id;
  const result = JSON.parse(item.result_json!) as ProposalApplyResult;
  const before = JSON.parse(item.before_json) as ProposalBefore;
  const targets = before && 'memories' in before ? before.memories : [];
  const candidateId = before && 'candidate' in before ? before.candidate.id : null;

  switch (item.op) {
    case 'create':
    case 'update':
    case 'retire':
      assertUnchangedSinceApply(db, characterId, result.after);
      break;
    case 'merge':
    case 'archive':
      assertBatchUndoable(db, characterId, item.op, result);
      break;
    case 'repair_candidate':
      assertUnchangedSinceApply(db, characterId, result.after);
      assertCandidateStatus(db, characterId, candidateId!, 'repaired');
      break;
    case 'discard_candidate':
      assertCandidateStatus(db, characterId, candidateId!, 'discarded');
      break;
    default:
      throw new ProposalUndoConflict(`第 ${item.seq} 项（${item.op}）不能撤销`);
  }

  const deleted: string[] = [];
  const indexIds: string[] = [];
  switch (item.op) {
    case 'create':
      db.prepare('DELETE FROM memories WHERE id = ? AND character_id = ?').run(result.created_memory_id, characterId);
      deleted.push(result.created_memory_id!);
      break;
    case 'update': {
      // 只恢复本项改过的字段；快照里的字段与 MemoryUpdate 同名同类型
      const changedKeys = Object.keys(JSON.parse(item.after_json) as ProposalMemoryFields);
      const original = targets[0].snapshot;
      const restore = Object.fromEntries(changedKeys.map(key => [key, original[key as keyof MemoryBusinessSnapshot]]));
      applyMemoryUpdate(db, targets[0].id, restore as MemoryUpdate, now);
      break;
    }
    case 'retire': {
      const original = targets[0].snapshot;
      applyMemoryUpdate(db, targets[0].id, {
        status: original.status as MemoryStatus,
        metadata: isObject(original.metadata) ? original.metadata : {},
      }, now);
      break;
    }
    case 'merge': {
      const undone = undoMemoryMergeBatch(db, { batchId: result.batch_id!, characterId, now });
      restoreBatchMemberSnapshots(db, characterId, targets, undone.restoredMemoryIds, now);
      indexIds.push(...undone.restoredMemoryIds);
      deleted.push(result.created_memory_id!);
      break;
    }
    case 'archive': {
      const undone = undoMemorySummaryArchiveBatch(db, { batchId: result.batch_id!, characterId, now });
      restoreBatchMemberSnapshots(db, characterId, targets, undone.restoredMemoryIds, now);
      indexIds.push(...undone.restoredMemoryIds);
      deleted.push(result.created_memory_id!);
      break;
    }
    case 'repair_candidate':
    case 'discard_candidate': {
      const remove = db.prepare('DELETE FROM memories WHERE id = ? AND character_id = ?');
      for (const memoryId of result.memory_ids) {
        remove.run(memoryId, characterId);
        deleted.push(memoryId);
      }
      db.prepare(`
        UPDATE memory_extraction_candidates SET status = 'repairable', updated_at = ? WHERE id = ? AND character_id = ?
      `).run(now, candidateId, characterId);
      break;
    }
  }
  for (const memoryId of deleted) invalidateMemoryTokenCache(memoryId);

  const current = loadSnapshots(db, characterId, result.memory_ids);
  insertRevisions(db, characterId, item, 'undo', result.after.map(target => ({
    memoryId: target.id,
    before: target.snapshot,
    after: current.get(target.id) ?? null,
  })), now);
  return indexIds;
}

/**
 * 撤销一个已生效的项。冲突时整项拒绝、数据不变；撤销只动这一项记录的记忆，
 * 之后的聊天记录和其他记忆不受影响。
 */
export function undoProposalItem(
  db: Database.Database,
  proposalId: number,
  itemId: number,
  now: string,
): UndoProposalOutcome {
  let characterId = '';
  let indexIds: string[] = [];
  const outcome = db.transaction((): UndoProposalOutcome => {
    const proposal = db.prepare(`
      SELECT id, session_id, character_id, summary, status, created_at, decided_at FROM agent_proposals WHERE id = ?
    `).get(proposalId) as ProposalRow | undefined;
    if (!proposal) return { ok: false, status: 404, error: '提案不存在' };
    characterId = proposal.character_id;
    const item = db.prepare('SELECT * FROM agent_proposal_items WHERE id = ? AND proposal_id = ?')
      .get(itemId, proposalId) as ProposalItemRow | undefined;
    if (!item) return { ok: false, status: 404, error: `项 ${itemId} 不属于这份提案` };
    if (item.state === 'undone') return { ok: false, status: 409, error: `第 ${item.seq} 项已经撤销过` };
    if (item.state !== 'applied') return { ok: false, status: 400, error: `第 ${item.seq} 项没有生效，不能撤销` };

    try {
      // savepoint：冲突检查都在写入之前，这一层只是保证意外中断时不留下半截修改
      indexIds = db.transaction(() => undoItem(db, proposal, item, now))();
    } catch (error) {
      if (error instanceof ProposalUndoConflict) return { ok: false, status: 409, error: error.message };
      throw error;
    }
    const result = JSON.parse(item.result_json!) as ProposalApplyResult;
    db.prepare(`UPDATE agent_proposal_items SET state = 'undone', result_json = ? WHERE id = ?`)
      .run(JSON.stringify({ ...result, undone_at: now }), item.id);
    return { ok: true };
  })();
  if (outcome.ok) queueIndexing(db, characterId, indexIds);
  return outcome;
}
