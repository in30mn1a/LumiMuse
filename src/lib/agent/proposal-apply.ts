/**
 * 主人对 Agent 提案的决定：逐项批准或拒绝，以及撤销已生效的项。
 *
 * 整个决定在一个事务里完成，每个批准项再套一层 savepoint：单项出错只把该项记为 failed，
 * 不影响其他项。应用前用完整记忆或角色卡快照与提案时的快照比较，不一致就记为 stale 跳过，
 * 不覆盖后来的修改；记忆使用次数、最近使用时间不算改动。撤销用同样的比较对照应用后快照。
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
import { applyMessageEdit } from '@/lib/message-mutations';
import { parseMemoryMetadata } from '@/lib/metadata';
import { publicErrorMessage } from '@/lib/public-error';
import { stripTagRulesSchema, type MemoryUpdate } from '@/lib/schemas';
import { parseStoredTimestamp } from '@/lib/memory-time-cutoff';
import {
  createWork, deleteWork, findMatchingWork, getWork, listWorks, mergeIdLists, normalizeWorkTitle, updateWork,
} from '@/lib/works-catalog';
import type { MemoryStatus, WorkEntry, WorkType } from '@/types';
import type { ProposalDecisionEventItem } from './messages';
import {
  candidateTaskSucceeded,
  existingMessageIds,
  loadCandidateTask,
  listProposalItems,
  MAX_PROPOSAL_ITEMS,
  type ProposalBefore,
  type ProposalCharacterTarget,
  type ProposalEvidence,
  type ProposalItemRow,
  type ProposalMemoryFields,
  type ProposalMemoryTarget,
  type ProposalRepairAfter,
  type ProposalRow,
  type ProposalWorkFields,
} from './proposals';
import { appendAgentMessage } from './store';
import {
  applyCharacterCardCreate, applyCharacterCardUpdate, characterCardCreateSchema, completeCharacterCard,
  loadCharacterCard, type CreatedCharacterSnapshot, type ProposalCharacterFields,
} from './character-card';
import {
  createPresetEntry,
  deletePresetEntry,
  getPresetScript,
  loadPresetEntryRecord,
  loadPresetRecord,
  restoreDeletedPresetEntry,
  setPresetScript,
  updatePresetEntryFields,
  updatePresetExtensions,
  updatePresetSettings,
  type PresetEntryAfter,
  type PresetEntryCreateAfter,
  type PresetEntryFieldPatch,
  type PresetEntryFullSnapshot,
  type PresetEntryRecord,
  type PresetEntrySnapshot,
  type PresetScriptAfter,
  type PresetSettingsAfter,
} from './preset-edit';

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
  /** 角色卡修改的应用后快照；角色卡不写入记忆修订表。 */
  character?: ProposalCharacterTarget;
  /** 新建角色整行快照，撤销不能删除后来编辑或使用过的角色。 */
  created_character?: CreatedCharacterSnapshot;
  /** 消息修改应用后的正文，撤销时据此判断之后是否又被编辑。 */
  message?: { id: string; content: string };
  /** 片单条目应用后的完整快照，撤销时据此判断之后是否又被改动。 */
  work?: WorkEntry;
  /** 预设条目修改应用后的快照，撤销时据此判断之后是否又被改动。 */
  preset_entry?: { preset_id: string } & PresetEntrySnapshot;
  /** 预设条目新建应用后的完整快照，撤销时据此判断之后是否又被改动。 */
  preset_entry_creation?: { preset_id: string; id: string } & PresetEntryCreateAfter;
  /** 预设条目删除应用后的记录，撤销时据此还原原条目。 */
  preset_entry_deletion?: { preset_id: string; id: string };
  /** 预设标签剥离设置应用后的快照，撤销时据此判断之后是否又被改动。 */
  preset_settings?: { preset_id: string; story_plot_strip: boolean; strip_tags: string[] };
  /** 预设脚本修改应用后的快照，撤销时据此判断之后是否又被改动。 */
  preset_script?: { preset_id: string; path: string; content: string };
}

type DecisionFailure = { ok: false; status: 400 | 404 | 409; error: string };

export type ApplyProposalOutcome = { ok: true; items: ProposalDecisionEventItem[] } | DecisionFailure;

export type UndoProposalOutcome = { ok: true } | DecisionFailure;

type ItemOutcome =
  | { state: 'applied'; result: ProposalApplyResult; indexIds: string[] }
  | { state: 'stale'; detail: string };

type DecidedOutcome = ItemOutcome | { state: 'failed'; detail: string };

/** 回滚合并组 savepoint 用的哨兵，只在 applyProposalDecision 内抛出和捕获。 */
const MERGE_ROLLBACK = new Error('merge unit rollback');

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

/** 批准事务内重查全部拟新增正文，避免待批期间或前一项刚写入的记忆被重复补回。 */
function newMemoryDuplicateIssue(
  db: Database.Database,
  characterId: string,
  memories: readonly ProposalMemoryFields[],
): string | null {
  const duplicate = db.prepare(`
    SELECT id FROM memories WHERE character_id = ? AND status = 'active'
      AND content IN (${memories.map(() => '?').join(', ')}) LIMIT 1
  `).get(characterId, ...memories.map(memory => memory.content!)) as { id: string } | undefined;
  return duplicate ? `已有内容相同的 active 记忆 ${duplicate.id}，本项已过期，没有修改` : null;
}

/** 消息整行，限定在该角色的对话里。 */
function loadCharacterMessage(
  db: Database.Database,
  characterId: string,
  messageId: string,
): (Record<string, unknown> & { content: string }) | undefined {
  return db.prepare(`
    SELECT m.* FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND c.character_id = ?
  `).get(messageId, characterId) as (Record<string, unknown> & { content: string }) | undefined;
}

/** 依据里仍属于该角色的记忆和消息（待批期间可能被删除），保持原顺序。 */
function liveWorkEvidence(db: Database.Database, characterId: string, evidence: ProposalEvidence): { memoryIds: string[]; messageIds: string[] } {
  const memoryIds = evidence.memory_ids ?? [];
  const foundMemories = new Set(memoryIds.length === 0 ? [] : (db.prepare(`
    SELECT id FROM memories WHERE character_id = ? AND id IN (SELECT value FROM json_each(?))
  `).all(characterId, JSON.stringify(memoryIds)) as { id: string }[]).map(row => row.id));
  const foundMessages = existingMessageIds(db, characterId, evidence.message_ids);
  return {
    memoryIds: memoryIds.filter(id => foundMemories.has(id)),
    messageIds: evidence.message_ids.filter(id => foundMessages.has(id)),
  };
}

/**
 * 依据里最早的时间，作为新条目的 first_seen_at（历史重新生成按它截断）。只给 create 用，update 不推算。
 * 记忆按它来源消息的时间算：提取是批量、延后进行的，记忆行的 created_at 往往晚于它描述的对话；
 * 来源消息都查不到时才用记忆自己的 created_at。归档摘要和合并结果的来源是全部原始记忆来源的并集，
 * 最早一条可能比这部作品第一次被提到早几个月，所以直接用它们自己的 created_at。都没有返回 null。
 */
function earliestEvidenceTime(db: Database.Database, characterId: string, memoryIds: readonly string[], messageIds: readonly string[]): string | null {
  const times: number[] = [];
  const messageTimes = (ids: readonly string[]) => (ids.length === 0 ? [] : (db.prepare(`
    SELECT m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.character_id = ? AND m.id IN (SELECT value FROM json_each(?))
  `).all(characterId, JSON.stringify(ids)) as { created_at: string }[])
    .map(row => parseStoredTimestamp(row.created_at))
    .filter((time): time is number => time !== null));
  times.push(...messageTimes(messageIds));
  const memories = memoryIds.length === 0 ? [] : db.prepare(`
    SELECT created_at, source_msg_ids, metadata FROM memories WHERE character_id = ? AND id IN (SELECT value FROM json_each(?))
  `).all(characterId, JSON.stringify(memoryIds)) as { created_at: string; source_msg_ids: string | null; metadata: string | null }[];
  for (const memory of memories) {
    const meta = parseMemoryMetadata(memory.metadata);
    const aggregated = meta.archiveRole === 'summary' || meta.mergeRole === 'result';
    let sources: string[] = [];
    if (!aggregated) {
      try {
        const parsed: unknown = JSON.parse(memory.source_msg_ids ?? '[]');
        if (Array.isArray(parsed)) sources = parsed.filter((id): id is string => typeof id === 'string');
      } catch {
        // 坏的来源列表按没有来源处理
      }
    }
    const sourceTimes = messageTimes(sources);
    if (sourceTimes.length > 0) times.push(...sourceTimes);
    else {
      const own = parseStoredTimestamp(memory.created_at);
      if (own !== null) times.push(own);
    }
  }
  if (times.length === 0) return null;
  return new Date(times.reduce((min, time) => (time < min ? time : min))).toISOString();
}

/** 条目自提案（或批准）以来是否没变：任何写入都会更新 updated_at，整条快照比较也覆盖直接改库。 */
function sameWork(current: WorkEntry | null, snapshot: WorkEntry, characterId: string): current is WorkEntry {
  return current !== null && current.character_id === characterId && JSON.stringify(current) === JSON.stringify(snapshot);
}

const workNameKeys = (names: readonly string[]) => new Set(names.map(normalizeWorkTitle).filter(Boolean));

/** 同角色同类型、未移除的条目里与 names 重名的一条（排除 excludeId 自己）；没有返回 null。 */
function activeNameClash(
  db: Database.Database,
  characterId: string,
  type: WorkType,
  names: readonly string[],
  excludeId: string,
): WorkEntry | null {
  const keys = workNameKeys(names);
  if (keys.size === 0) return null;
  return listWorks(db, characterId).find(entry => entry.id !== excludeId && entry.work_type === type
    && [entry.title, ...entry.aliases].some(name => keys.has(normalizeWorkTitle(name)))) ?? null;
}

/** update 批准后条目的类型和全部名称。 */
function workIdentityAfter(entry: WorkEntry, changes: ProposalWorkFields): { type: WorkType; names: string[] } {
  return { type: changes.work_type ?? entry.work_type, names: [changes.title ?? entry.title, ...(changes.aliases ?? entry.aliases)] };
}

/**
 * 撤销后条目新拿回的名称：撤销 retire 让条目回到片单，撤销改名让它带回旧名。这些名称可能已经并进别的条目
 * （合并重复条目后只撤销 retire），要先查重名。撤销后仍是已移除状态的条目不占名称。
 */
function namesRegainedByUndo(original: WorkEntry, applied: WorkEntry): string[] {
  if (original.dismissed_at !== null) return [];
  const names = [original.title, ...original.aliases];
  if (applied.dismissed_at !== null || applied.work_type !== original.work_type) return names;
  const kept = workNameKeys([applied.title, ...applied.aliases]);
  return names.filter(name => !kept.has(normalizeWorkTitle(name)));
}

/** 片单条目项（update / retire）的目标快照；其他项返回 null。 */
function workTarget(item: ProposalItemRow): WorkEntry | null {
  const before = JSON.parse(item.before_json) as ProposalBefore;
  return before && 'work' in before ? before.work : null;
}

/**
 * 批准项的应用顺序：片单 retire 先于 update / create，合并重复条目时保留的一条改名不会撞上待移除的那条。
 * 合并（update 保留的一条、并入另一条的名称，同一份提案里 retire 另一条）两项都批准时编成一组，
 * 组内 update 放最后；其他项各自一组。只调整片单项的先后，其他类型的提案不含片单项，顺序不变。
 */
function applyUnits(items: readonly ProposalItemRow[]): ProposalItemRow[][] {
  const retires = items.flatMap(item => {
    const target = item.op === 'retire' ? workTarget(item) : null;
    return target ? [{ item, target }] : [];
  });
  const retireIds = new Set(retires.map(({ item }) => item.id));
  const grouped = new Set<number>();
  const merges: ProposalItemRow[][] = [];
  for (const item of items) {
    const target = item.op === 'update' ? workTarget(item) : null;
    if (!target) continue;
    const next = workIdentityAfter(target, JSON.parse(item.after_json) as ProposalWorkFields);
    const keys = workNameKeys(next.names);
    const partners = retires.filter(({ item: retire, target: other }) => !grouped.has(retire.id)
      && other.work_type === next.type && [other.title, ...other.aliases].some(name => keys.has(normalizeWorkTitle(name))));
    if (partners.length === 0) continue;
    for (const { item: retire } of partners) grouped.add(retire.id);
    grouped.add(item.id);
    merges.push([...partners.map(({ item: retire }) => retire), item]);
  }
  return [
    ...retires.filter(({ item }) => !grouped.has(item.id)).map(({ item }) => [item]),
    ...merges,
    ...items.filter(item => !grouped.has(item.id) && !retireIds.has(item.id)).map(item => [item]),
  ];
}

/** 片单项的批准：create 新增条目，update 按字段写入（经主人批准可以清空，已移除的条目同时恢复），retire 移除。 */
function applyWorkItem(db: Database.Database, characterId: string, item: ProposalItemRow, before: ProposalBefore, now: string): ItemOutcome {
  const evidence = liveWorkEvidence(db, characterId, JSON.parse(item.evidence_json) as ProposalEvidence);
  const applied = (work: WorkEntry): ItemOutcome => ({
    state: 'applied', indexIds: [],
    result: { memory_ids: [], created_memory_id: null, batch_id: null, after: [], work },
  });
  if (before && 'work_creation' in before) {
    if (item.op !== 'create' || before.work_creation.character_id !== characterId) throw new Error('片单新增提案格式不正确');
    const fields = JSON.parse(item.after_json) as Required<Omit<ProposalWorkFields, 'first_seen_at'>> & { first_seen_at?: string };
    // 待批期间自动更新或主人可能已经加了同一部作品（含移除过的），不再重复新增
    const clash = findMatchingWork(db, characterId, fields.work_type, [fields.title, ...fields.aliases]);
    if (clash) {
      return {
        state: 'stale',
        detail: `片单里已有「${clash.title}」（${clash.id}）${clash.dismissed_at === null ? '' : '，是主人移除过的条目'}，没有新增`,
      };
    }
    return applied(createWork(db, {
      character_id: characterId,
      work_type: fields.work_type,
      title: fields.title,
      aliases: fields.aliases,
      status: fields.status,
      rating: fields.rating,
      progress: fields.progress,
      note: fields.note,
      source_memory_ids: evidence.memoryIds,
      source_msg_ids: evidence.messageIds,
      first_seen_at: fields.first_seen_at ?? earliestEvidenceTime(db, characterId, evidence.memoryIds, evidence.messageIds) ?? now,
    }, now));
  }
  if (!before || !('work' in before)) throw new Error('片单提案格式不正确');
  const target = before.work;
  const current = getWork(db, target.id);
  if (!sameWork(current, target, characterId)) {
    return { state: 'stale', detail: `片单条目「${target.title}」（${target.id}）在提案生成后已被改动或删除，没有修改` };
  }
  if (item.op === 'retire') return applied(updateWork(db, target.id, { dismissed: true }, now));
  if (item.op !== 'update') throw new Error(`${item.op} 不能用于片单条目`);
  const changes = JSON.parse(item.after_json) as ProposalWorkFields;
  // 创建时允许改名撞上同一份提案里要 retire 的条目，但批准时逐项独立：retire 可能没批准、已过期，
  // 恢复已移除的条目时同名作品也可能已经加回。按当前片单重查，撞上就过期，不造出重复条目
  const next = workIdentityAfter(current, changes);
  const clash = activeNameClash(db, characterId, next.type, next.names, current.id);
  if (clash) {
    return {
      state: 'stale',
      detail: `批准后会与片单里的「${clash.title}」（${clash.id}）重名，没有修改；合并重复条目要连同移除「${clash.title}」的那一项一起批准`,
    };
  }
  return applied(updateWork(db, target.id, {
    ...changes,
    // 依据并入条目的来源，片单里能追溯到这次修改凭的是什么
    source_memory_ids: mergeIdLists(current.source_memory_ids, evidence.memoryIds),
    source_msg_ids: mergeIdLists(current.source_msg_ids, evidence.messageIds),
    dismissed: false,
  }, now));
}

type PresetProposalBefore = Extract<
  NonNullable<ProposalBefore>,
  | { preset_entry: unknown }
  | { preset_entry_creation: unknown }
  | { preset_entry_deletion: unknown }
  | { preset_settings: unknown }
  | { preset_script: unknown }
>;

function isPresetBefore(before: ProposalBefore): before is PresetProposalBefore {
  return Boolean(
    before && (
      'preset_entry' in before
      || 'preset_entry_creation' in before
      || 'preset_entry_deletion' in before
      || 'preset_settings' in before
      || 'preset_script' in before
    ),
  );
}

/** 比对条目当前值与快照；可选结构字段只在快照中存在时比对，以兼容旧版已落库提案。 */
function matchesPresetEntrySnapshot(current: PresetEntryRecord, snapshot: PresetEntrySnapshot): boolean {
  if (current.name !== snapshot.name || current.enabled !== snapshot.enabled || current.content !== snapshot.content) {
    return false;
  }
  if (snapshot.is_marker !== undefined && current.is_marker !== snapshot.is_marker) return false;
  if (snapshot.role !== undefined && current.role !== snapshot.role) return false;
  if (snapshot.marker_key !== undefined && current.marker_key !== snapshot.marker_key) return false;
  if (snapshot.injection_position !== undefined && current.injection_position !== snapshot.injection_position) return false;
  if (snapshot.injection_depth !== undefined && current.injection_depth !== snapshot.injection_depth) return false;
  if (snapshot.injection_order !== undefined && current.injection_order !== snapshot.injection_order) return false;
  if (snapshot.sort_order !== undefined && current.sort_order !== snapshot.sort_order) return false;
  return true;
}

/** 删除前核对整行全部业务列，避免把待批期间主人编辑过的条目删掉。 */
function matchesFullPresetEntry(current: PresetEntryRecord, snapshot: PresetEntryFullSnapshot): boolean {
  return matchesPresetEntrySnapshot(current, snapshot)
    && current.is_system_prompt === snapshot.is_system_prompt
    && current.forbid_overrides === snapshot.forbid_overrides
    && JSON.stringify(current.injection_trigger) === JSON.stringify(snapshot.injection_trigger);
}

function applyPresetItem(
  db: Database.Database,
  item: ProposalItemRow,
  before: PresetProposalBefore,
  now: string,
): ItemOutcome {
  if ('preset_entry_creation' in before) {
    if (item.op !== 'create') throw new Error(`${item.op} 不能用于新建预设条目`);
    const target = before.preset_entry_creation;
    const preset = loadPresetRecord(db, target.preset_id);
    if (!preset) {
      return { state: 'stale', detail: `预设「${target.preset_name}」（${target.preset_id}）已删除，没有新增条目` };
    }
    if (db.prepare('SELECT 1 FROM prompt_preset_entries WHERE id = ?').get(target.id)) {
      return { state: 'stale', detail: `预设条目 ID ${target.id} 已被使用，没有新增` };
    }
    const after = JSON.parse(item.after_json) as PresetEntryCreateAfter;
    createPresetEntry(db, target.preset_id, target.id, after, now);
    return {
      state: 'applied',
      indexIds: [],
      result: {
        memory_ids: [],
        created_memory_id: null,
        batch_id: null,
        after: [],
        preset_entry_creation: { preset_id: target.preset_id, id: target.id, ...after },
      },
    };
  }

  if ('preset_entry_deletion' in before) {
    if (item.op !== 'retire') throw new Error(`${item.op} 不能用于删除预设条目`);
    const target = before.preset_entry_deletion;
    const preset = loadPresetRecord(db, target.preset_id);
    const current = preset ? loadPresetEntryRecord(db, target.preset_id, target.entry.id) : null;
    if (!preset || !current || !matchesFullPresetEntry(current, target.entry)) {
      return {
        state: 'stale',
        detail: `预设「${target.preset_name}」的条目「${target.entry.name}」（${target.entry.id}）在提案生成后已被改动或删除，没有删除`,
      };
    }
    deletePresetEntry(db, target.preset_id, target.entry.id, now);
    return {
      state: 'applied',
      indexIds: [],
      result: {
        memory_ids: [],
        created_memory_id: null,
        batch_id: null,
        after: [],
        preset_entry_deletion: { preset_id: target.preset_id, id: target.entry.id },
      },
    };
  }

  if (item.op !== 'update') throw new Error(`${item.op} 不能用于预设修改`);

  if ('preset_entry' in before) {
    const target = before.preset_entry;
    const preset = loadPresetRecord(db, target.preset_id);
    const current = preset ? loadPresetEntryRecord(db, target.preset_id, target.entry.id) : null;
    if (!preset || !current || !matchesPresetEntrySnapshot(current, target.entry)) {
      return {
        state: 'stale',
        detail: `预设「${target.preset_name}」的条目「${target.entry.name}」（${target.entry.id}）在提案生成后已被改动或删除，没有修改`,
      };
    }
    const after = JSON.parse(item.after_json) as PresetEntryAfter;
    const nextIsMarker = after.is_marker ?? current.is_marker;
    if (nextIsMarker && after.content !== undefined) {
      throw new Error(`占位标记条目「${current.name}」不能修改正文`);
    }
    const patch: PresetEntryFieldPatch = {};
    if (after.name !== undefined) patch.name = after.name;
    if (after.enabled !== undefined) patch.enabled = after.enabled;
    if (after.content !== undefined) patch.content = after.content;
    if (after.role !== undefined) patch.role = after.role;
    if (after.is_marker !== undefined) patch.is_marker = after.is_marker;
    if (after.marker_key !== undefined) patch.marker_key = after.marker_key;
    if (after.injection_position !== undefined) patch.injection_position = after.injection_position;
    if (after.injection_depth !== undefined) patch.injection_depth = after.injection_depth;
    if (after.injection_order !== undefined) patch.injection_order = after.injection_order;
    if (after.sort_order !== undefined) patch.sort_order = after.sort_order;
    updatePresetEntryFields(db, target.preset_id, target.entry.id, patch, now);
    return {
      state: 'applied',
      indexIds: [],
      result: {
        memory_ids: [],
        created_memory_id: null,
        batch_id: null,
        after: [],
        preset_entry: {
          preset_id: target.preset_id,
          id: target.entry.id,
          name: patch.name ?? current.name,
          enabled: patch.enabled ?? current.enabled,
          content: patch.content ?? current.content,
          is_marker: patch.is_marker ?? current.is_marker,
          role: patch.role ?? current.role,
          marker_key: patch.marker_key !== undefined ? patch.marker_key : current.marker_key,
          injection_position: patch.injection_position ?? current.injection_position,
          injection_depth: patch.injection_depth ?? current.injection_depth,
          injection_order: patch.injection_order ?? current.injection_order,
          sort_order: patch.sort_order ?? current.sort_order,
        },
      },
    };
  }

  if ('preset_settings' in before) {
    const target = before.preset_settings;
    const preset = loadPresetRecord(db, target.preset_id);
    if (
      !preset
      || preset.story_plot_strip !== target.story_plot_strip
      || JSON.stringify(preset.strip_tags) !== JSON.stringify(target.strip_tags)
    ) {
      return {
        state: 'stale',
        detail: `预设「${target.preset_name}」的标签剥离设置在提案生成后已被改动或删除，没有修改`,
      };
    }
    const after = JSON.parse(item.after_json) as PresetSettingsAfter;
    const patch: { story_plot_strip?: boolean; strip_tags?: string[] } = {};
    if (after.story_plot_strip !== undefined) patch.story_plot_strip = after.story_plot_strip;
    if (after.strip_tags !== undefined) {
      const validated = stripTagRulesSchema.safeParse(after.strip_tags);
      if (!validated.success) {
        throw new Error(`strip_tags 不合法：${validated.error.issues.map(issue => issue.message).join('；')}`);
      }
      patch.strip_tags = validated.data;
    }
    updatePresetSettings(db, target.preset_id, patch, now);
    return {
      state: 'applied',
      indexIds: [],
      result: {
        memory_ids: [],
        created_memory_id: null,
        batch_id: null,
        after: [],
        preset_settings: {
          preset_id: target.preset_id,
          story_plot_strip: patch.story_plot_strip ?? preset.story_plot_strip,
          strip_tags: patch.strip_tags ?? preset.strip_tags,
        },
      },
    };
  }

  const target = before.preset_script;
  const preset = loadPresetRecord(db, target.preset_id);
  const currentScript = preset ? getPresetScript(preset.extensions, target.path) : null;
  if (!preset || !currentScript || currentScript.content !== target.content) {
    return {
      state: 'stale',
      detail: `预设「${target.preset_name}」的脚本「${target.label}」（${target.path}）在提案生成后已被改动或删除，没有修改`,
    };
  }
  const after = JSON.parse(item.after_json) as PresetScriptAfter;
  const nextExtensions = setPresetScript(preset.extensions, target.path, after.content);
  updatePresetExtensions(db, target.preset_id, nextExtensions, now);
  return {
    state: 'applied',
    indexIds: [],
    result: {
      memory_ids: [],
      created_memory_id: null,
      batch_id: null,
      after: [],
      preset_script: {
        preset_id: target.preset_id,
        path: target.path,
        content: after.content,
      },
    },
  };
}

function applyItem(db: Database.Database, proposal: ProposalRow, item: ProposalItemRow, now: string): ItemOutcome {
  const characterId = proposal.character_id;
  const before = JSON.parse(item.before_json) as ProposalBefore;
  if (isPresetBefore(before)) {
    return applyPresetItem(db, item, before, now);
  }
  if (before && 'character_creation' in before) {
    if (item.op !== 'create' || characterId !== null) throw new Error('角色创建提案格式不正确');
    const id = before.character_creation.id;
    if (db.prepare('SELECT 1 FROM characters WHERE id = ?').get(id)) {
      return { state: 'stale', detail: `角色 ID ${id} 已被使用，没有创建` };
    }
    const fields = completeCharacterCard(characterCardCreateSchema.parse(JSON.parse(item.after_json)));
    const created = applyCharacterCardCreate(db, id, fields, now);
    return {
      state: 'applied', indexIds: [],
      result: {
        memory_ids: [], created_memory_id: null, batch_id: null, after: [],
        character: { id, snapshot: fields }, created_character: created,
      },
    };
  }
  if (!characterId) throw new Error('提案缺少目标角色');
  if (before && ('work' in before || 'work_creation' in before)) return applyWorkItem(db, characterId, item, before, now);
  if (before && 'character' in before) {
    const target = before.character;
    const current = loadCharacterCard(db, characterId);
    if (target.id !== characterId || !current || JSON.stringify(current) !== JSON.stringify(target.snapshot)) {
      return { state: 'stale', detail: `角色卡 ${target.id} 在提案生成后已被改动或删除，没有修改` };
    }
    if (item.op !== 'update') throw new Error(`${item.op} 不能用于角色卡修改`);
    applyCharacterCardUpdate(db, characterId, JSON.parse(item.after_json) as ProposalCharacterFields, now);
    return {
      state: 'applied', indexIds: [],
      result: {
        memory_ids: [], created_memory_id: null, batch_id: null, after: [],
        character: { id: characterId, snapshot: loadCharacterCard(db, characterId)! },
      },
    };
  }
  if (before && 'message' in before) {
    if (item.op !== 'update') throw new Error(`${item.op} 不能用于消息修改`);
    const target = before.message;
    const current = loadCharacterMessage(db, characterId, target.id);
    if (!current || current.content !== target.content) {
      return { state: 'stale', detail: `消息 ${target.id} 在提案生成后已被改动或删除，没有修改` };
    }
    const { content } = JSON.parse(item.after_json) as { content: string };
    // 不清理正文里不再引用的本地图片：撤销要能原样恢复，孤儿文件留给维护页检测
    applyMessageEdit(db, current, { content });
    return {
      state: 'applied', indexIds: [],
      result: { memory_ids: [], created_memory_id: null, batch_id: null, after: [], message: { id: target.id, content } },
    };
  }
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
    case 'create': {
      const issue = newMemoryDuplicateIssue(db, characterId, [after]);
      if (issue) return { state: 'stale', detail: issue };
      createdId = createProposalMemory(db, characterId, item, after, {}, now);
      break;
    }
    case 'update': {
      const patch: MemoryUpdate & { source_msg_ids?: string[] } = { ...after };
      if (after.source_msg_ids !== undefined) {
        const found = existingMessageIds(db, characterId, after.source_msg_ids);
        const missing = after.source_msg_ids.filter(id => !found.has(id));
        if (missing.length > 0) return { state: 'stale', detail: `来源消息 ${missing.join('、')} 已删除或不再属于该角色，没有修改` };
        const metadata = targets[0].snapshot.metadata;
        patch.metadata = {
          ...(isObject(metadata) ? metadata : {}),
          sourceAttribution: { granularity: after.source_msg_ids.length > 0 ? 'message' : 'unknown' },
        };
      }
      applyMemoryUpdate(db, targetIds[0], patch, now);
      break;
    }
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
      let memories: ProposalMemoryFields[] = [];
      if (item.op === 'repair_candidate') {
        const candidate = db.prepare(`
          SELECT id FROM memory_extraction_candidates WHERE id = ? AND character_id = ? AND status = 'repairable'
        `).get(candidateId, characterId);
        if (!candidate) return { state: 'stale', detail: `待修复记录 ${candidateId} 已被处理，没有修改` };
        memories = (JSON.parse(item.after_json) as ProposalRepairAfter).memories;
        // 整项检查在状态抢占之前完成，任一条重复都不能留下部分补回或已处理的候选。
        const issue = newMemoryDuplicateIssue(db, characterId, memories);
        if (issue) return { state: 'stale', detail: issue };
      }
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

function queueIndexing(db: Database.Database, characterId: string | null, memoryIds: readonly string[]): void {
  if (!characterId) return;
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
  let characterId: string | null = null;
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
    const toApply: ProposalItemRow[] = [];
    for (const item of items) {
      if (item.state !== 'pending') continue;
      if (approved.has(item.id)) {
        toApply.push(item);
        continue;
      }
      const head = { seq: item.seq, op: item.op };
      const reason = rejectReasons.get(item.id);
      updateItem.run('rejected', reason ?? null, null, null, item.id);
      decided.push(reason ? { ...head, state: 'rejected', reason } : { ...head, state: 'rejected' });
    }

    const run = (item: ProposalItemRow): DecidedOutcome => {
      try {
        return db.transaction(() => applyItem(db, proposal, item, now))();
      } catch (error) {
        return { state: 'failed', detail: publicErrorMessage(error, '应用时出错') };
      }
    };
    const record = (item: ProposalItemRow, result: DecidedOutcome) => {
      const head = { seq: item.seq, op: item.op };
      if (result.state === 'applied') {
        updateItem.run('applied', null, JSON.stringify(result.result), now, item.id);
        indexIds.push(...result.indexIds);
        decided.push({ ...head, state: 'applied' });
      } else {
        updateItem.run(result.state, null, JSON.stringify({ detail: result.detail }), null, item.id);
        decided.push({ ...head, state: result.state, reason: result.detail });
      }
    };
    for (const unit of applyUnits(toApply)) {
      if (unit.length === 1) {
        record(unit[0], run(unit[0]));
        continue;
      }
      // 合并组：保留条目的 update 没有生效（过期或出错）就连同 retire 一起回滚。否则另一条被移除、
      // 名称却没并进保留的条目，之后再提到这个名称时自动更新会认出已移除的条目，一直忽略
      const kept = unit[unit.length - 1];
      let results: DecidedOutcome[] = [];
      try {
        db.transaction(() => {
          results = unit.map(run);
          if (results[results.length - 1].state !== 'applied' && results.some(result => result.state === 'applied')) {
            throw MERGE_ROLLBACK;
          }
        })();
      } catch (error) {
        if (error !== MERGE_ROLLBACK) throw error;
        results = results.map((result, index): DecidedOutcome => (index === results.length - 1 || result.state !== 'applied' ? result : {
          state: 'stale',
          detail: `与第 ${kept.seq} 项是同一次合并，第 ${kept.seq} 项没有生效，这一项也没有移除（否则名称没并进保留的条目，之后再提到会被当成已移除的作品）`,
        }));
      }
      unit.forEach((item, index) => record(item, results[index]));
    }
    // 应用顺序可能与项序号不同，记录仍按序号排列
    decided.sort((a, b) => a.seq - b.seq);

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

/**
 * 排序不算改动：在侧边栏拖动任意角色都会重写全部角色的 sort_order。
 * 只比对批准时快照里的列，之后迁移新增的列不会让历史创建项全部无法撤销。
 */
function isCreatedCharacterUnchanged(current: CreatedCharacterSnapshot, created: CreatedCharacterSnapshot): boolean {
  return Object.keys(created).every(key => key === 'sort_order' || current[key] === created[key]);
}

/**
 * 片单项的撤销：批准后条目又被改动（自动更新、主人手动、其他提案）就拒绝，避免覆盖后来的修改；
 * 恢复出的条目会与未移除的条目重名时也拒绝。否则恢复批准前的条目，新增的条目直接删除。
 */
function undoWorkItem(
  db: Database.Database,
  characterId: string,
  item: ProposalItemRow,
  before: ProposalBefore,
  result: ProposalApplyResult,
  now: string,
): void {
  const applied = result.work;
  const current = applied ? getWork(db, applied.id) : null;
  if (!applied || !sameWork(current, applied, characterId)) {
    throw new ProposalUndoConflict(`片单条目「${applied?.title ?? ''}」在批准后又被改动或删除，不能撤销`);
  }
  if (before && 'work_creation' in before) {
    if (item.op !== 'create') throw new ProposalUndoConflict(`第 ${item.seq} 项（${item.op}）不能撤销`);
    deleteWork(db, applied.id);
    return;
  }
  if (!before || !('work' in before) || before.work.id !== applied.id) {
    throw new ProposalUndoConflict(`第 ${item.seq} 项（${item.op}）不能撤销`);
  }
  const original = before.work;
  const clash = activeNameClash(db, characterId, original.work_type, namesRegainedByUndo(original, applied), original.id);
  if (clash) {
    throw new ProposalUndoConflict(
      `撤销后「${original.title}」会与片单里的「${clash.title}」（${clash.id}）重名：`
      + `先撤销把这些名称并入「${clash.title}」的那一项（或手动修改、移除「${clash.title}」），再撤销这一项`,
    );
  }
  updateWork(db, original.id, {
    work_type: original.work_type,
    title: original.title,
    aliases: original.aliases,
    status: original.status,
    rating: original.rating,
    progress: original.progress,
    note: original.note,
    source_memory_ids: original.source_memory_ids,
    source_msg_ids: original.source_msg_ids,
    first_seen_at: original.first_seen_at,
    dismissed: original.dismissed_at !== null,
  }, now);
  // updateWork 移除时写当前时间；恢复成原来的移除时间，「已移除」区域的顺序和显示不变
  if (original.dismissed_at !== null) {
    db.prepare('UPDATE character_works SET dismissed_at = ? WHERE id = ?').run(original.dismissed_at, original.id);
  }
}

function undoPresetItem(
  db: Database.Database,
  item: ProposalItemRow,
  before: PresetProposalBefore,
  result: ProposalApplyResult,
  now: string,
): void {
  if ('preset_entry_creation' in before) {
    const target = before.preset_entry_creation;
    const applied = result.preset_entry_creation;
    const preset = loadPresetRecord(db, target.preset_id);
    const current = preset ? loadPresetEntryRecord(db, target.preset_id, target.id) : null;
    if (
      item.op !== 'create'
      || !applied || applied.preset_id !== target.preset_id || applied.id !== target.id
      || !preset || !current
      || !matchesPresetEntrySnapshot(current, applied)
    ) {
      throw new ProposalUndoConflict(
        `预设「${target.preset_name}」新建的条目「${applied?.name ?? ''}」（${target.id}）在批准后又被改动或删除，不能撤销`,
      );
    }
    deletePresetEntry(db, target.preset_id, target.id, now);
    return;
  }

  if ('preset_entry_deletion' in before) {
    const target = before.preset_entry_deletion;
    const applied = result.preset_entry_deletion;
    const preset = loadPresetRecord(db, target.preset_id);
    if (
      item.op !== 'retire'
      || !applied || applied.preset_id !== target.preset_id || applied.id !== target.entry.id
      || !preset
    ) {
      throw new ProposalUndoConflict(
        `预设「${target.preset_name}」已删除或状态不匹配，无法还原条目「${target.entry.name}」`,
      );
    }
    if (db.prepare('SELECT 1 FROM prompt_preset_entries WHERE id = ?').get(target.entry.id)) {
      throw new ProposalUndoConflict(
        `预设条目 ID ${target.entry.id} 已被重新占用，不能撤销删除`,
      );
    }
    restoreDeletedPresetEntry(db, target.preset_id, target.entry, now);
    return;
  }

  if ('preset_entry' in before) {
    const target = before.preset_entry;
    const applied = result.preset_entry;
    const preset = loadPresetRecord(db, target.preset_id);
    const current = preset ? loadPresetEntryRecord(db, target.preset_id, target.entry.id) : null;
    if (
      !applied || applied.preset_id !== target.preset_id || applied.id !== target.entry.id
      || !preset || !current
      || !matchesPresetEntrySnapshot(current, applied)
    ) {
      throw new ProposalUndoConflict(
        `预设「${target.preset_name}」的条目「${target.entry.name}」（${target.entry.id}）在批准后又被改动或删除，不能撤销`,
      );
    }
    const after = JSON.parse(item.after_json) as PresetEntryAfter;
    const restore: PresetEntryFieldPatch = {};
    if ('name' in after) restore.name = target.entry.name;
    if ('enabled' in after) restore.enabled = target.entry.enabled;
    if ('content' in after) restore.content = target.entry.content;
    if ('role' in after && target.entry.role !== undefined) restore.role = target.entry.role;
    if ('is_marker' in after) restore.is_marker = target.entry.is_marker;
    if ('marker_key' in after && target.entry.marker_key !== undefined) restore.marker_key = target.entry.marker_key;
    if ('injection_position' in after && target.entry.injection_position !== undefined) {
      restore.injection_position = target.entry.injection_position;
    }
    if ('injection_depth' in after && target.entry.injection_depth !== undefined) {
      restore.injection_depth = target.entry.injection_depth;
    }
    if ('injection_order' in after && target.entry.injection_order !== undefined) {
      restore.injection_order = target.entry.injection_order;
    }
    if ('sort_order' in after && target.entry.sort_order !== undefined) {
      restore.sort_order = target.entry.sort_order;
    }
    updatePresetEntryFields(db, target.preset_id, target.entry.id, restore, now);
    return;
  }

  if ('preset_settings' in before) {
    const target = before.preset_settings;
    const applied = result.preset_settings;
    const preset = loadPresetRecord(db, target.preset_id);
    if (
      !applied || applied.preset_id !== target.preset_id
      || !preset
      || preset.story_plot_strip !== applied.story_plot_strip
      || JSON.stringify(preset.strip_tags) !== JSON.stringify(applied.strip_tags)
    ) {
      throw new ProposalUndoConflict(
        `预设「${target.preset_name}」的标签剥离设置在批准后又被改动或删除，不能撤销`,
      );
    }
    const after = JSON.parse(item.after_json) as PresetSettingsAfter;
    const restore: { story_plot_strip?: boolean; strip_tags?: string[] } = {};
    if ('story_plot_strip' in after) restore.story_plot_strip = target.story_plot_strip;
    if ('strip_tags' in after) restore.strip_tags = target.strip_tags;
    updatePresetSettings(db, target.preset_id, restore, now);
    return;
  }

  const target = before.preset_script;
  const applied = result.preset_script;
  const preset = loadPresetRecord(db, target.preset_id);
  const currentScript = preset ? getPresetScript(preset.extensions, target.path) : null;
  if (
    !applied || applied.preset_id !== target.preset_id || applied.path !== target.path
    || !preset || !currentScript || currentScript.content !== applied.content
  ) {
    throw new ProposalUndoConflict(
      `预设「${target.preset_name}」的脚本「${target.label}」（${target.path}）在批准后又被改动或删除，不能撤销`,
    );
  }
  const nextExtensions = setPresetScript(preset.extensions, target.path, target.content);
  updatePresetExtensions(db, target.preset_id, nextExtensions, now);
}

function undoItem(db: Database.Database, proposal: ProposalRow, item: ProposalItemRow, now: string): string[] {
  const characterId = proposal.character_id;
  const result = JSON.parse(item.result_json!) as ProposalApplyResult;
  const before = JSON.parse(item.before_json) as ProposalBefore;
  if (isPresetBefore(before)) {
    undoPresetItem(db, item, before, result, now);
    return [];
  }
  if (before && 'character_creation' in before) {
    const id = before.character_creation.id;
    const current = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as CreatedCharacterSnapshot | undefined;
    if (item.op !== 'create' || characterId !== null || !result.created_character || result.created_character.id !== id
      || !current || !isCreatedCharacterUnchanged(current, result.created_character)) {
      throw new ProposalUndoConflict(`角色卡 ${id} 在创建后已被改动或删除，不能撤销`);
    }
    // 在删除事务内检查全部角色关联表；未来新增的数据也默认保留。
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const quotedName = `"${name.replaceAll('"', '""')}"`;
      const columns = db.prepare(`PRAGMA table_info(${quotedName})`).all() as { name: string }[];
      if (columns.some(column => column.name === 'character_id')
        && db.prepare(`SELECT 1 FROM ${quotedName} WHERE character_id = ? LIMIT 1`).get(id)) {
        throw new ProposalUndoConflict(`角色 ${id} 已有关联数据，不能撤销创建`);
      }
    }
    db.prepare('DELETE FROM characters WHERE id = ?').run(id);
    return [];
  }
  if (!characterId) throw new ProposalUndoConflict('提案缺少目标角色，不能撤销');
  if (before && ('work' in before || 'work_creation' in before)) {
    undoWorkItem(db, characterId, item, before, result, now);
    return [];
  }
  if (before && 'character' in before) {
    const applied = result.character;
    const current = loadCharacterCard(db, characterId);
    if (!applied || before.character.id !== characterId || applied.id !== characterId
      || !current || JSON.stringify(current) !== JSON.stringify(applied.snapshot)) {
      throw new ProposalUndoConflict(`角色卡 ${characterId} 在批准后又被改动或删除，不能撤销`);
    }
    const changedKeys = Object.keys(JSON.parse(item.after_json) as ProposalCharacterFields);
    const restore = Object.fromEntries(changedKeys.map(key => [key, before.character.snapshot[key as keyof ProposalCharacterFields]]));
    applyCharacterCardUpdate(db, characterId, restore, now);
    return [];
  }
  if (before && 'message' in before) {
    const applied = result.message;
    const current = loadCharacterMessage(db, characterId, before.message.id);
    if (!applied || applied.id !== before.message.id || !current || current.content !== applied.content) {
      throw new ProposalUndoConflict(`消息 ${before.message.id} 在批准后又被改动或删除，不能撤销`);
    }
    applyMessageEdit(db, current, { content: before.message.content });
    return [];
  }
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
      if (changedKeys.includes('source_msg_ids')) restore.metadata = isObject(original.metadata) ? original.metadata : {};
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
  let characterId: string | null = null;
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
