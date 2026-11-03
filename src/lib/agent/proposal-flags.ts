/**
 * 提案项的醒目标注。服务端校验和卡片共用，本文件不引入任何服务端模块，客户端可以直接导入。
 */
import type { ProposalItemView } from './proposals';

/** 没有原文依据时 evidence.note 必须写成这句；卡片会醒目标出。 */
export const NO_EVIDENCE_NOTE = '无原文依据';

/** Agent 对建议的把握低于这个值时，卡片标出并默认不勾选。规格没有给出数值，取 0.6。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export interface ProposalItemFlags {
  noEvidence: boolean;
  lowConfidence: boolean;
  /** 原提取任务已成功时写入的条数；补回可能与它们重复。不是这种情况为 null */
  duplicateRiskCount: number | null;
}

export function proposalItemFlags(item: Pick<ProposalItemView, 'op' | 'evidence' | 'confidence' | 'before' | 'current_candidate_task'>): ProposalItemFlags {
  const candidate = item.before && 'candidate' in item.before ? item.before.candidate : null;
  const currentTask = item.current_candidate_task === undefined ? candidate?.task ?? null : item.current_candidate_task;
  const taskSucceeded = currentTask !== null && (currentTask.status === 'done' || currentTask.result_committed);
  return {
    noEvidence: item.evidence.message_ids.length === 0 && item.evidence.note === NO_EVIDENCE_NOTE,
    lowConfidence: item.confidence < LOW_CONFIDENCE_THRESHOLD,
    duplicateRiskCount: item.op === 'repair_candidate' && taskSucceeded
      ? currentTask.result_insert_count
      : null,
  };
}

/** 有任何标注的项默认不勾选，要主人看过后自己勾上。 */
export function isCheckedByDefault(flags: ProposalItemFlags): boolean {
  return !flags.noEvidence && !flags.lowConfidence && flags.duplicateRiskCount === null;
}
