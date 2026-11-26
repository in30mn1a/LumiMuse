/**
 * 提案项的醒目标注。服务端校验和卡片共用，本文件不引入任何服务端模块，客户端可以直接导入。
 */
import { parseMemoryMetadata } from '@/lib/metadata';
import { contentFidelityIssues, messageEditFidelityIssues, type ContentFidelityIssues, type ContentShrink } from './content-fidelity';
import type { ProposalEvidenceMemory, ProposalItemView } from './proposals';

/** 没有原文依据时 evidence.note 以这句开头，后面可以写原因；卡片会醒目标出。 */
export const NO_EVIDENCE_NOTE = '无原文依据';

export function declaresNoEvidence(note: string | undefined): boolean {
  return typeof note === 'string' && note.trim().startsWith(NO_EVIDENCE_NOTE);
}

/**
 * 记忆本身说的事是否已不成立：被提取取代（新说法推翻了旧说法）或被 Agent 退场的记忆不能再当依据。
 * superseded 有两种来源，只能靠 metadata 区分：合并产生的 superseded 事实仍在合并结果里，照样成立；
 * 已归档、已总结的原始记忆也照样成立。只看这一行：合并结果、摘要后来是否又不成立见 memoryFactCarrier。
 */
export function isMemoryNoLongerTrue(status: string, metadata: unknown): boolean {
  if (status !== 'superseded') return false;
  const meta = parseMemoryMetadata(metadata);
  if (meta.retiredByProposalItem !== undefined) return true;
  return meta.supersededBy?.action !== 'memory_merge' && typeof meta.mergedInto !== 'string';
}

/**
 * 合并、归档的原始记忆把事实交给了谁：合并结果（mergedInto）或归档摘要（summarizedBy）。没有时返回 null。
 * 结果或摘要后来被提取取代、被退场时，原始记忆同样不再成立；服务端顺着这条链检查（proposals.ts）。
 */
export function memoryFactCarrier(status: string, metadata: unknown): string | null {
  const meta = parseMemoryMetadata(metadata);
  if (status === 'superseded') {
    if (typeof meta.mergedInto === 'string') return meta.mergedInto;
    const by = meta.supersededBy;
    return by?.action === 'memory_merge' && typeof by.memoryId === 'string' ? by.memoryId : null;
  }
  if (status === 'archived' || status === 'summarized') {
    return typeof meta.summarizedBy === 'string' ? meta.summarizedBy : null;
  }
  return null;
}

/** Agent 对建议的把握低于这个值时，卡片标出并默认不勾选。规格没有给出数值，取 0.6。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export interface ProposalItemFlags {
  noEvidence: boolean;
  lowConfidence: boolean;
  /** 原提取任务已成功时写入的条数；补回可能与它们重复。不是这种情况为 null */
  duplicateRiskCount: number | null;
  /** 改写类操作（update、merge、archive）：来源引号里的原话，新正文没有逐字保留 */
  missingQuotes: string[];
  /** 改写类操作：新正文里出现、来源里没有的生僻字，多半是错字 */
  unfamiliarChars: string[];
  /** update、merge：新正文比原文明显变短 */
  shrink: ContentShrink | null;
  /** 退场的记忆出现在同一份提案的矛盾报告里：是 Agent 对矛盾的建议，要主人确认 */
  conflictRetire: boolean;
  /** 依据记忆里已不成立（被取代、被退场）或已删除的条目；没有传入依据记忆的当前状态时为空 */
  invalidEvidenceMemoryIds: string[];
  /** 修改预设 SPreset 脚本：批准后会在聊天请求或响应时执行 */
  presetScript: boolean;
  /** 关闭了预设里的占位标记（marker）条目，会让对应内容不再进入请求 */
  disablesMarker: boolean;
}

/** 同一份提案里矛盾报告涉及的记忆 ID。 */
export function conflictMemoryIds(items: readonly Pick<ProposalItemView, 'op' | 'before'>[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.op === 'report_conflict' && item.before && 'memories' in item.before) {
      for (const target of item.before.memories) ids.add(target.id);
    }
  }
  return ids;
}

const REWRITE_OPS: ReadonlySet<string> = new Set(['update', 'merge', 'archive']);

/** 新正文与来源正文比对；update 只有改了正文时 after 才带 content。 */
function rewriteIssues(item: Pick<ProposalItemView, 'op' | 'before'> & Partial<Pick<ProposalItemView, 'after'>>): ContentFidelityIssues {
  const after = item.after as { content?: unknown } | null | undefined;
  if (!REWRITE_OPS.has(item.op) || typeof after?.content !== 'string' || !after.content) {
    return { missingQuotes: [], unfamiliarChars: [], shrink: null };
  }
  if (item.before && 'message' in item.before) return messageEditFidelityIssues(after.content, item.before.message.content);
  if (!item.before || !('memories' in item.before)) {
    return { missingQuotes: [], unfamiliarChars: [], shrink: null };
  }
  const sources = item.before.memories.map(target => (typeof target.snapshot.content === 'string' ? target.snapshot.content : ''));
  return contentFidelityIssues(item.op, after.content, sources);
}

export function proposalItemFlags(
  item: Pick<ProposalItemView, 'op' | 'evidence' | 'confidence' | 'before' | 'current_candidate_task'> & Partial<Pick<ProposalItemView, 'after'>>,
  context: {
    conflictMemoryIds?: ReadonlySet<string>;
    /** 提案视图里依据记忆的当前状态（evidence_memories），按 ID 索引 */
    evidenceMemories?: ReadonlyMap<string, Pick<ProposalEvidenceMemory, 'no_longer_true'>>;
  } = {},
): ProposalItemFlags {
  const candidate = item.before && 'candidate' in item.before ? item.before.candidate : null;
  const currentTask = item.current_candidate_task === undefined ? candidate?.task ?? null : item.current_candidate_task;
  const taskSucceeded = currentTask !== null && (currentTask.status === 'done' || currentTask.result_committed);
  const memoryIds = item.evidence.memory_ids ?? [];
  const evidenceMemories = context.evidenceMemories;
  const afterRecord = item.after && typeof item.after === 'object' ? item.after as { enabled?: unknown } : null;
  return {
    noEvidence: item.evidence.message_ids.length === 0 && memoryIds.length === 0
      && !item.evidence.owner_quote && declaresNoEvidence(item.evidence.note),
    lowConfidence: item.confidence < LOW_CONFIDENCE_THRESHOLD,
    duplicateRiskCount: item.op === 'repair_candidate' && taskSucceeded
      ? currentTask.result_insert_count
      : null,
    ...rewriteIssues(item),
    conflictRetire: item.op === 'retire' && Boolean(item.before && 'memories' in item.before
      && item.before.memories.some(target => context.conflictMemoryIds?.has(target.id))),
    invalidEvidenceMemoryIds: evidenceMemories
      ? memoryIds.filter(id => evidenceMemories.get(id)?.no_longer_true ?? true)
      : [],
    presetScript: Boolean(item.before && 'preset_script' in item.before),
    disablesMarker: Boolean(
      item.before && 'preset_entry' in item.before
      && item.before.preset_entry.entry.is_marker
      && afterRecord?.enabled === false,
    ),
  };
}

/** 有任何标注的项默认不勾选，要主人看过后自己勾上。 */
export function isCheckedByDefault(flags: ProposalItemFlags): boolean {
  return !flags.noEvidence && !flags.lowConfidence && flags.duplicateRiskCount === null
    && flags.missingQuotes.length === 0 && flags.unfamiliarChars.length === 0 && flags.shrink === null
    && !flags.conflictRetire && flags.invalidEvidenceMemoryIds.length === 0
    && !flags.presetScript && !flags.disablesMarker;
}
