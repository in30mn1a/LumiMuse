/**
 * Agent 记忆提案的创建：校验与入库。
 *
 * 提案只写 agent_proposals / agent_proposal_items，不碰 memories；批准与撤销另行处理。
 * 「修改前」一律由服务端从数据库读取：模型额外传的 before 等字段会被 schema 丢弃。
 * 批准时用 memoryBusinessSnapshot 与这里存下的快照比较，判断目标是否已被改动。
 */
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { MEMORY_CATEGORIES, MEMORY_KINDS, type MemoryCategory } from '@/types';
import { MAX_MEMORY_CONTENT, MAX_TAG_LENGTH, MAX_TAGS } from '@/lib/schemas';
import { normalizeTags } from '@/lib/memory-tag-spec';
import { getMergeSourceIssue, type MemoryMergeSourceIssue } from '@/lib/memory-merge';
import { memoryBusinessSnapshot, type MemoryBusinessSnapshot } from '@/lib/memory-mutations';
import { NO_EVIDENCE_NOTE } from './proposal-flags';

export const PROPOSAL_ITEM_OPS = [
  'create',
  'update',
  'retire',
  'merge',
  'archive',
  'repair_candidate',
  'discard_candidate',
  'report_conflict',
] as const;
export type ProposalItemOp = (typeof PROPOSAL_ITEM_OPS)[number];

export type ProposalItemState = 'pending' | 'applied' | 'rejected' | 'stale' | 'failed' | 'undone' | 'reported';
export type ProposalStatus = 'pending' | 'decided';

export { NO_EVIDENCE_NOTE };
export const MAX_PROPOSAL_ITEMS = 50;
const MAX_TARGET_IDS = 500;
const MAX_EVIDENCE_MESSAGES = 50;
const MAX_REASON = 2000;
const MAX_SUMMARY = 500;

/** 模型可以提议的操作。 */
const PROPOSABLE_OPS = [
  'create',
  'update',
  'retire',
  'merge',
  'archive',
  'repair_candidate',
  'discard_candidate',
  'report_conflict',
] as const;
type ProposableOp = (typeof PROPOSABLE_OPS)[number];

// MEMORY_CATEGORIES 声明为普通数组，z.enum 需要非空元组类型
const CATEGORY_VALUES = MEMORY_CATEGORIES as [MemoryCategory, ...MemoryCategory[]];

/** 未知字段直接拒绝：模型以为改了状态或 metadata、实际却被丢弃，比报错更糟。 */
const memoryFieldsSchema = z.strictObject({
  content: z.string().max(MAX_MEMORY_CONTENT, `正文不能超过 ${MAX_MEMORY_CONTENT} 字`).optional(),
  category: z.enum(CATEGORY_VALUES).optional(),
  tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS).optional(),
  memory_kind: z.enum(MEMORY_KINDS).optional(),
  importance: z.number().min(0).max(1).optional(),
  emotional_weight: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
});
type MemoryFields = z.infer<typeof memoryFieldsSchema>;
type MemoryField = keyof MemoryFields;
/** create、merge、archive 的 after_json，以及 update 的改动字段。 */
export type ProposalMemoryFields = MemoryFields;

const ALL_FIELDS: readonly MemoryField[] = [
  'content', 'category', 'tags', 'memory_kind', 'importance', 'emotional_weight', 'pinned',
];

const evidenceSchema = z.object({
  message_ids: z.array(z.string().min(1)).max(MAX_EVIDENCE_MESSAGES).default([])
    .describe('支持这项修改的角色对话消息 ID，须是查到的真实 ID'),
  note: z.string().max(MAX_REASON).optional()
    .describe(`补充说明；确实没有原文依据时 message_ids 留空，note 写「${NO_EVIDENCE_NOTE}」`),
});

const proposalItemSchema = z.object({
  op: z.enum(PROPOSABLE_OPS),
  memory_id: z.string().min(1).optional().describe('update、retire 的目标记忆 ID'),
  memory_ids: z.array(z.string().min(1)).max(MAX_TARGET_IDS).optional()
    .describe('merge、archive、report_conflict 涉及的记忆 ID'),
  candidate_id: z.number().int().positive().optional().describe('repair_candidate、discard_candidate 的待修复记录 ID'),
  fields: memoryFieldsSchema.optional().describe('新值；update 只写要改的字段'),
  memories: z.array(memoryFieldsSchema).min(1).max(MAX_PROPOSAL_ITEMS).optional()
    .describe('repair_candidate 补回的记忆，每条必填 content、category'),
  reason: z.string().max(MAX_REASON).describe('为什么这样改，写给主人看'),
  evidence: evidenceSchema.optional(),
  confidence: z.number().min(0).max(1).describe('你对这项建议的把握（0–1），不是记忆本身的置信度'),
});

export const createMemoryProposalSchema = z.object({
  character_id: z.string().min(1).describe('记忆所属角色 ID'),
  summary: z.string().max(MAX_SUMMARY).describe('一句话概括这份提案'),
  items: z.array(proposalItemSchema).min(1).max(MAX_PROPOSAL_ITEMS),
});
export type CreateMemoryProposalInput = z.infer<typeof createMemoryProposalSchema>;
type ProposalItemInput = CreateMemoryProposalInput['items'][number];

export interface ProposalEvidence {
  message_ids: string[];
  note?: string;
}

export interface ProposalMemoryTarget {
  id: string;
  snapshot: MemoryBusinessSnapshot;
}

/** 待修复记录的原提取任务。任务重试成功后不会关闭旧记录，所以要连同任务状态一起看。 */
export interface ProposalCandidateTask {
  status: string;
  result_committed: boolean;
  result_insert_count: number;
}

export interface ProposalCandidateTarget {
  id: number;
  status: string;
  task_id: number | null;
  conversation_id: string | null;
  error_reason: string | null;
  task: ProposalCandidateTask | null;
  /** 原任务已经成功：补回可能与已写入的记忆重复，卡片默认不勾选 */
  task_succeeded: boolean;
}

/** repair_candidate 的 after_json；来源消息取自依据。 */
export interface ProposalRepairAfter {
  memories: MemoryFields[];
}

/** before_json 的形状：create 为 null。 */
export type ProposalBefore =
  | { memories: ProposalMemoryTarget[] }
  | { candidate: ProposalCandidateTarget }
  | null;

export interface CreatedProposalItem {
  id: number;
  seq: number;
  op: ProposalItemOp;
  state: ProposalItemState;
  /** 需要模型和主人留意的情况，例如补回可能重复 */
  warning?: string;
}

export type CreateProposalOutcome =
  | { ok: true; proposalId: number; status: ProposalStatus; items: CreatedProposalItem[] }
  | { ok: false; errors: string[] };

interface OpRule {
  memoryId: boolean;
  memoryIds: boolean;
  candidateId: boolean;
  memories: boolean;
  /** 允许的 fields 键；null 表示不接受 fields */
  fields: readonly MemoryField[] | null;
  /** required：必须有依据；content：改正文时必须有依据；optional：给了就校验 */
  evidence: 'required' | 'content' | 'optional';
}

const NO_TARGETS = { memoryId: false, memoryIds: false, candidateId: false, memories: false } as const;

const OP_RULES: Record<ProposableOp, OpRule> = {
  create: { ...NO_TARGETS, fields: ALL_FIELDS, evidence: 'required' },
  update: { ...NO_TARGETS, memoryId: true, fields: ALL_FIELDS, evidence: 'content' },
  retire: { ...NO_TARGETS, memoryId: true, fields: null, evidence: 'required' },
  merge: {
    ...NO_TARGETS, memoryIds: true,
    fields: ['content', 'category', 'tags', 'memory_kind', 'importance'], evidence: 'required',
  },
  archive: { ...NO_TARGETS, memoryIds: true, fields: ['content'], evidence: 'required' },
  repair_candidate: { ...NO_TARGETS, candidateId: true, memories: true, fields: null, evidence: 'required' },
  discard_candidate: { ...NO_TARGETS, candidateId: true, fields: null, evidence: 'optional' },
  report_conflict: { ...NO_TARGETS, memoryIds: true, fields: null, evidence: 'required' },
};

const MERGE_ISSUE_TEXT: Record<Exclude<MemoryMergeSourceIssue, 'not_found'>, string> = {
  not_active: '不是 active 状态，不能合并',
  pinned: '已钉选，不能合并',
  reserved: '已参与过合并或归档，不能再合并',
};

interface MemoryRow {
  id: string;
  character_id: string;
  content: string;
  category: string;
  confidence: number;
  tags: string;
  source_msg_ids: string;
  memory_kind: string;
  importance: number;
  emotional_weight: number;
  status: string;
  pinned: number;
  metadata: string;
}

interface CandidateRow {
  id: number;
  character_id: string;
  status: string;
  task_id: number | null;
  conversation_id: string | null;
  error_reason: string | null;
  task_status: string | null;
  task_result_committed: number | null;
  task_result_insert_count: number | null;
  task_message_ids: string | null;
}

interface PreparedItem {
  op: ProposableOp;
  reason: string;
  evidence: ProposalEvidence;
  confidence: number;
  before: ProposalBefore;
  after: unknown;
  state: Extract<ProposalItemState, 'pending' | 'reported'>;
  memoryTargets: string[];
  candidateTarget: number | null;
  warning: string | null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function loadMemories(db: Database.Database, characterId: string, ids: readonly string[]): Map<string, MemoryRow> {
  if (ids.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT id, character_id, content, category, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, metadata
    FROM memories
    WHERE character_id = ? AND id IN (${placeholders(ids.length)})
  `).all(characterId, ...ids) as MemoryRow[];
  return new Map(rows.map(row => [row.id, row]));
}

function toTarget(row: MemoryRow): ProposalMemoryTarget {
  return { id: row.id, snapshot: memoryBusinessSnapshot(row) };
}

function sameTagSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every(tag => set.has(tag));
}

/** 规整新值：正文去首尾空白、标签归一。不判断是否为空，由各操作自己决定。 */
function normalizeFields(fields: MemoryFields): MemoryFields {
  const result: MemoryFields = { ...fields };
  if (fields.content !== undefined) result.content = fields.content.trim();
  if (fields.tags !== undefined) result.tags = normalizeTags(fields.tags);
  return result;
}

/** update 中与当前值相同的字段剔除；结果为空就是「没有实际改动」。 */
function changedFields(fields: MemoryFields, snapshot: MemoryBusinessSnapshot): MemoryFields {
  const changes: MemoryFields = {};
  for (const field of ALL_FIELDS) {
    const next = fields[field];
    if (next === undefined) continue;
    const current = snapshot[field];
    const same = field === 'tags'
      ? Array.isArray(current) && sameTagSet(current as string[], next as string[])
      : current === next;
    if (!same) Object.assign(changes, { [field]: next });
  }
  return changes;
}

function uniqueList(ids: readonly string[]): { ids: string[]; duplicated: boolean } {
  const unique = [...new Set(ids)];
  return { ids: unique, duplicated: unique.length !== ids.length };
}

function existingMessageIds(db: Database.Database, characterId: string, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  return new Set((db.prepare(`
    SELECT m.id FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.character_id = ? AND m.id IN (${placeholders(ids.length)})
  `).all(characterId, ...ids) as { id: string }[]).map(row => row.id));
}

function parseIdList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * 校验依据：message_ids 必须是该角色对话里的消息；没有消息依据时，必须是 required 以外的情况，
 * 或者明确写了「无原文依据」。
 */
function checkEvidence(
  db: Database.Database,
  characterId: string,
  input: ProposalItemInput['evidence'],
  required: boolean,
  errors: string[],
): ProposalEvidence {
  const messageIds = [...new Set(input?.message_ids ?? [])];
  const note = input?.note?.trim() || undefined;
  if (messageIds.length > 0) {
    const found = existingMessageIds(db, characterId, messageIds);
    const missing = messageIds.filter(id => !found.has(id));
    if (missing.length > 0) errors.push(`依据消息不存在或不属于该角色的对话：${missing.join('、')}`);
  } else if (required && note !== NO_EVIDENCE_NOTE) {
    errors.push(`缺少依据：请在 evidence.message_ids 给出来源消息 ID；确实没有原文依据时，note 写「${NO_EVIDENCE_NOTE}」`);
  }
  return note === undefined ? { message_ids: messageIds } : { message_ids: messageIds, note };
}

function prepareItem(
  db: Database.Database,
  characterId: string,
  item: ProposalItemInput,
  errors: string[],
): PreparedItem | null {
  const rule = OP_RULES[item.op];
  const startErrors = errors.length;

  if (item.memory_id !== undefined && !rule.memoryId) errors.push(`${item.op} 不使用 memory_id`);
  if (item.memory_ids !== undefined && !rule.memoryIds) errors.push(`${item.op} 不使用 memory_ids`);
  if (item.candidate_id !== undefined && !rule.candidateId) errors.push(`${item.op} 不使用 candidate_id`);
  if (item.memories !== undefined && !rule.memories) errors.push(`${item.op} 不使用 memories`);
  if (item.fields !== undefined) {
    if (!rule.fields) {
      errors.push(`${item.op} 不使用 fields`);
    } else {
      const extra = Object.keys(item.fields).filter(key => !rule.fields!.includes(key as MemoryField));
      if (extra.length > 0) errors.push(`${item.op} 的 fields 不能包含：${extra.join('、')}`);
    }
  }
  if (rule.memoryId && item.memory_id === undefined) errors.push(`${item.op} 需要 memory_id`);
  if (rule.memoryIds && item.memory_ids === undefined) errors.push(`${item.op} 需要 memory_ids`);
  if (rule.candidateId && item.candidate_id === undefined) errors.push(`${item.op} 需要 candidate_id`);
  if (rule.memories && item.memories === undefined) errors.push(`${item.op} 需要 memories`);

  const reason = item.reason.trim();
  if (!reason) errors.push('缺少理由');
  if (errors.length > startErrors) return null;

  const fields = item.fields ? normalizeFields(item.fields) : {};
  if (fields.content !== undefined && !fields.content) errors.push('正文不能为空');

  let before: ProposalBefore = null;
  let after: unknown = null;
  let memoryTargets: string[] = [];
  let candidateTarget: number | null = null;
  let evidenceRequired = rule.evidence === 'required';
  let evidenceInput = item.evidence;
  let warning: string | null = null;

  /** create 与 repair_candidate 的新记忆：必填正文和分类，与已有 active 记忆完全相同则没有意义。 */
  const checkNewMemory = (memory: MemoryFields, path: string, label: string) => {
    if (memory.content === undefined) errors.push(`${item.op} 需要 ${path}.content`);
    if (memory.category === undefined) errors.push(`${item.op} 需要 ${path}.category`);
    if (!memory.content) return;
    const duplicate = db.prepare(`
      SELECT id FROM memories WHERE character_id = ? AND status = 'active' AND content = ? LIMIT 1
    `).get(characterId, memory.content) as { id: string } | undefined;
    if (duplicate) errors.push(`${label}已有内容相同的 active 记忆 ${duplicate.id}，没有实际改动`);
  };

  switch (item.op) {
    case 'create': {
      checkNewMemory(fields, 'fields', '');
      after = fields;
      break;
    }
    case 'update':
    case 'retire': {
      const row = loadMemories(db, characterId, [item.memory_id!]).get(item.memory_id!);
      if (!row) {
        errors.push(`记忆 ${item.memory_id} 不存在或不属于该角色`);
        break;
      }
      if (row.status !== 'active') {
        errors.push(`记忆 ${row.id} 当前状态为 ${row.status}，只能处理 active 记忆`);
        break;
      }
      const target = toTarget(row);
      before = { memories: [target] };
      memoryTargets = [row.id];
      if (item.op === 'retire') {
        after = { status: 'superseded' };
        break;
      }
      const changes = changedFields(fields, target.snapshot);
      if (Object.keys(changes).length === 0) errors.push(`对记忆 ${row.id} 没有实际改动`);
      evidenceRequired = changes.content !== undefined;
      after = changes;
      break;
    }
    case 'merge':
    case 'archive':
    case 'report_conflict': {
      const { ids, duplicated } = uniqueList(item.memory_ids!);
      if (duplicated) errors.push('memory_ids 有重复');
      const minimum = item.op === 'archive' ? 1 : 2;
      if (ids.length < minimum) {
        errors.push(`${item.op} 至少需要 ${minimum} 条记忆`);
        break;
      }
      const rows = loadMemories(db, characterId, ids);
      const missing = ids.filter(id => !rows.has(id));
      if (missing.length > 0) {
        errors.push(`记忆不存在或不属于该角色：${missing.join('、')}`);
        break;
      }
      const ordered = ids.map(id => rows.get(id)!);
      const targets = ordered.map(toTarget);
      if (item.op === 'merge') {
        for (const row of ordered) {
          const issue = getMergeSourceIssue(row);
          if (issue) errors.push(`记忆 ${row.id} ${MERGE_ISSUE_TEXT[issue]}`);
        }
        if (fields.content === undefined) errors.push('merge 需要 fields.content');
      } else if (item.op === 'archive') {
        // 与 loadArchiveSources 相同的规则：只归档 active 的普通记忆
        for (const { id, snapshot } of targets) {
          const metadata = snapshot.metadata as Record<string, unknown> | null;
          if (snapshot.status !== 'active') errors.push(`记忆 ${id} 不是 active 状态，不能归档`);
          else if (metadata?.archiveRole === 'summary' || metadata?.archiveBatchId) {
            errors.push(`记忆 ${id} 已是归档摘要或已被归档，不能再归档`);
          }
        }
        if (fields.content === undefined) errors.push('archive 需要 fields.content（摘要正文）');
      }
      before = { memories: targets };
      memoryTargets = item.op === 'report_conflict' ? [] : ids;
      after = item.op === 'report_conflict' ? null : fields;
      break;
    }
    case 'repair_candidate':
    case 'discard_candidate': {
      const row = db.prepare(`
        SELECT c.id, c.character_id, c.status, c.task_id, c.conversation_id, c.error_reason,
          t.status AS task_status, t.result_committed AS task_result_committed,
          t.result_insert_count AS task_result_insert_count, t.message_ids AS task_message_ids
        FROM memory_extraction_candidates c
        LEFT JOIN memory_tasks t ON t.id = c.task_id
        WHERE c.id = ?
      `).get(item.candidate_id!) as CandidateRow | undefined;
      if (!row || row.character_id !== characterId) {
        errors.push(`待修复记录 ${item.candidate_id} 不存在或不属于该角色`);
        break;
      }
      if (row.status !== 'repairable') {
        errors.push(`待修复记录 ${row.id} 当前状态为 ${row.status}，不需要处理`);
        break;
      }
      const task: ProposalCandidateTask | null = row.task_status === null ? null : {
        status: row.task_status,
        result_committed: row.task_result_committed === 1,
        result_insert_count: row.task_result_insert_count ?? 0,
      };
      const taskSucceeded = task !== null && (task.status === 'done' || task.result_committed);
      before = {
        candidate: {
          id: row.id,
          status: row.status,
          task_id: row.task_id,
          conversation_id: row.conversation_id,
          error_reason: row.error_reason,
          task,
          task_succeeded: taskSucceeded,
        },
      };
      candidateTarget = row.id;
      if (item.op === 'discard_candidate') {
        after = { status: 'discarded' };
        break;
      }

      const memories = item.memories!.map(normalizeFields);
      const contents = new Set<string>();
      memories.forEach((memory, index) => {
        const path = `memories[${index}]`;
        if (memory.content !== undefined && !memory.content) errors.push(`${path} 的正文不能为空`);
        checkNewMemory(memory, path, `${path} `);
        if (memory.content && contents.has(memory.content)) errors.push(`${path} 与前面的记忆内容相同`);
        if (memory.content) contents.add(memory.content);
      });

      // 来源默认取原任务的消息；模型给了依据时只能在其中收窄
      const taskMessageIds = parseIdList(row.task_message_ids);
      const given = item.evidence?.message_ids ?? [];
      if (given.length > 0 && taskMessageIds.length > 0) {
        const outside = given.filter(id => !taskMessageIds.includes(id));
        if (outside.length > 0) errors.push(`依据消息不在原提取任务的消息范围内：${outside.join('、')}`);
      }
      if (given.length === 0) {
        const existing = existingMessageIds(db, characterId, taskMessageIds);
        evidenceInput = { ...item.evidence, message_ids: taskMessageIds.filter(id => existing.has(id)) };
      }
      if (taskSucceeded) {
        warning = `原提取任务已成功（写入 ${task!.result_insert_count} 条），补回可能与已有记忆重复`;
      }
      after = { memories } satisfies ProposalRepairAfter;
      break;
    }
  }

  const evidence = checkEvidence(db, characterId, evidenceInput, evidenceRequired, errors);
  if (errors.length > startErrors) return null;
  return {
    op: item.op,
    reason,
    evidence,
    confidence: item.confidence,
    before,
    after,
    state: item.op === 'report_conflict' ? 'reported' : 'pending',
    memoryTargets,
    candidateTarget,
    warning,
  };
}

/**
 * 校验并保存一份提案。任一项不合法时整份不保存，返回逐项原因，模型可以修正后重试。
 * 只含矛盾发现（report_conflict）的提案没有可决定的项，直接记为 decided。
 */
export function createMemoryProposal(
  db: Database.Database,
  input: CreateMemoryProposalInput,
  context: { sessionId: string | null; now: string },
): CreateProposalOutcome {
  const characterId = input.character_id;
  const character = db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId);
  if (!character) return { ok: false, errors: [`角色 ${characterId} 不存在`] };

  const errors: string[] = [];
  const summary = input.summary.trim();
  if (!summary) errors.push('缺少提案概述（summary）');

  const prepared: PreparedItem[] = [];
  const memoryClaims = new Map<string, number>();
  const candidateClaims = new Map<number, number>();
  input.items.forEach((item, index) => {
    const seq = index + 1;
    const itemErrors: string[] = [];
    const ready = prepareItem(db, characterId, item, itemErrors);
    if (ready) {
      // 同一提案里两项动同一条记忆，后一项批准时必然过期，不如创建时就指出
      for (const id of ready.memoryTargets) {
        const claimedBy = memoryClaims.get(id);
        if (claimedBy !== undefined) itemErrors.push(`记忆 ${id} 已在第 ${claimedBy} 项中处理，一条记忆只能出现在一项可执行操作里`);
        else memoryClaims.set(id, seq);
      }
      if (ready.candidateTarget !== null) {
        const claimedBy = candidateClaims.get(ready.candidateTarget);
        if (claimedBy !== undefined) itemErrors.push(`待修复记录 ${ready.candidateTarget} 已在第 ${claimedBy} 项中处理`);
        else candidateClaims.set(ready.candidateTarget, seq);
      }
      prepared.push(ready);
    }
    for (const message of itemErrors) errors.push(`第 ${seq} 项（${item.op}）：${message}`);
  });
  if (errors.length > 0) return { ok: false, errors };

  const status: ProposalStatus = prepared.some(item => item.state === 'pending') ? 'pending' : 'decided';
  return db.transaction((): CreateProposalOutcome => {
    const proposalId = Number(db.prepare(`
      INSERT INTO agent_proposals (session_id, character_id, summary, status, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(context.sessionId, characterId, summary, status, context.now, status === 'decided' ? context.now : null)
      .lastInsertRowid);
    const insertItem = db.prepare(`
      INSERT INTO agent_proposal_items (
        proposal_id, seq, op, reason, evidence_json, confidence, before_json, after_json, state
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const items = prepared.map((item, index): CreatedProposalItem => {
      const seq = index + 1;
      const id = Number(insertItem.run(
        proposalId,
        seq,
        item.op,
        item.reason,
        JSON.stringify(item.evidence),
        item.confidence,
        JSON.stringify(item.before),
        JSON.stringify(item.after),
        item.state,
      ).lastInsertRowid);
      const created: CreatedProposalItem = { id, seq, op: item.op, state: item.state };
      return item.warning ? { ...created, warning: item.warning } : created;
    });
    return { ok: true, proposalId, status, items };
  })();
}

export interface ProposalRow {
  id: number;
  session_id: string | null;
  character_id: string;
  summary: string;
  status: ProposalStatus;
  created_at: string;
  decided_at: string | null;
}

export interface ProposalItemRow {
  id: number;
  proposal_id: number;
  seq: number;
  op: ProposalItemOp;
  reason: string;
  evidence_json: string;
  confidence: number;
  before_json: string;
  after_json: string;
  state: ProposalItemState;
  reject_reason: string | null;
  result_json: string | null;
  applied_at: string | null;
}

export interface ProposalItemView {
  id: number;
  seq: number;
  op: ProposalItemOp;
  reason: string;
  evidence: ProposalEvidence;
  confidence: number;
  before: ProposalBefore;
  after: unknown;
  state: ProposalItemState;
  reject_reason: string | null;
  result: unknown;
  applied_at: string | null;
  /** 候选原任务的实时状态；before 中保留提案创建时的快照。 */
  current_candidate_task?: ProposalCandidateTask | null;
}

/** 依据消息的原文，卡片上直接显示；已删除的消息不在其中。 */
export interface ProposalEvidenceMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface ProposalView extends ProposalRow {
  items: ProposalItemView[];
  evidence_messages: ProposalEvidenceMessage[];
}

export function listProposalItems(db: Database.Database, proposalId: number): ProposalItemRow[] {
  return db.prepare('SELECT * FROM agent_proposal_items WHERE proposal_id = ? ORDER BY seq').all(proposalId) as ProposalItemRow[];
}

const PROPOSAL_COLUMNS = 'id, session_id, character_id, summary, status, created_at, decided_at';

export function getProposalView(db: Database.Database, proposalId: number): ProposalView | null {
  const proposal = db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM agent_proposals WHERE id = ?`)
    .get(proposalId) as ProposalRow | undefined;
  return proposal ? toProposalView(db, proposal) : null;
}

/** 修改历史：新的在前。会话删除后提案仍在，从这里查看和撤销。 */
export function listProposalViews(
  db: Database.Database,
  characterId: string,
  limit: number,
  offset: number,
): { proposals: ProposalView[]; has_more: boolean } {
  const rows = db.prepare(`
    SELECT ${PROPOSAL_COLUMNS} FROM agent_proposals WHERE character_id = ? ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(characterId, limit + 1, offset) as ProposalRow[];
  return { proposals: rows.slice(0, limit).map(row => toProposalView(db, row)), has_more: rows.length > limit };
}

function toProposalView(db: Database.Database, proposal: ProposalRow): ProposalView {
  const items = listProposalItems(db, proposal.id).map((row): ProposalItemView => {
    const before = JSON.parse(row.before_json) as ProposalBefore;
    const candidate = before && 'candidate' in before ? before.candidate : null;
    return {
      id: row.id,
      seq: row.seq,
      op: row.op,
      reason: row.reason,
      evidence: JSON.parse(row.evidence_json) as ProposalEvidence,
      confidence: row.confidence,
      before,
      after: JSON.parse(row.after_json) as unknown,
      state: row.state,
      reject_reason: row.reject_reason,
      result: row.result_json ? JSON.parse(row.result_json) as unknown : null,
      applied_at: row.applied_at,
      ...(candidate ? { current_candidate_task: loadCandidateTask(db, proposal.character_id, candidate.task_id) } : {}),
    };
  });
  const messageIds = [...new Set(items.flatMap(item => item.evidence.message_ids))];
  const evidenceMessages = messageIds.length === 0 ? [] : db.prepare(`
    SELECT m.id, m.role, m.content, m.created_at FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.character_id = ? AND m.id IN (${placeholders(messageIds.length)})
    ORDER BY m.created_at, m.id
  `).all(proposal.character_id, ...messageIds) as ProposalEvidenceMessage[];
  return { ...proposal, items, evidence_messages: evidenceMessages };
}

/** 原提取任务的实时状态。候选记录状态只决定能否处理，不代表任务是否已经重试成功。 */
export function loadCandidateTask(
  db: Database.Database,
  characterId: string,
  taskId: number | null,
): ProposalCandidateTask | null {
  if (taskId === null) return null;
  const row = db.prepare(`
    SELECT status, result_committed, result_insert_count
    FROM memory_tasks WHERE id = ? AND character_id = ?
  `).get(taskId, characterId) as {
    status: string;
    result_committed: number;
    result_insert_count: number | null;
  } | undefined;
  return row ? {
    status: row.status,
    result_committed: row.result_committed === 1,
    result_insert_count: row.result_insert_count ?? 0,
  } : null;
}

export function candidateTaskSucceeded(task: ProposalCandidateTask | null): boolean {
  return task !== null && (task.status === 'done' || task.result_committed);
}
