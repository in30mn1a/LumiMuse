import type { ReasoningEffort } from '@/types';

export const REASONING_EFFORT_VALUES = [
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORT_VALUES);
const MAX_REASONING_EFFORT_BY_MODEL = 256;
const MAX_MODEL_NAME = 200;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_SET.has(value);
}

/** 丢掉非法 key/value，避免脏设置把聊天框思考强度打坏。 */
export function sanitizeReasoningEffortByModel(value: unknown): Record<string, ReasoningEffort> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const result: Record<string, ReasoningEffort> = {};
  for (const [rawModel, effort] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(result).length >= MAX_REASONING_EFFORT_BY_MODEL) break;
    const model = rawModel.trim();
    if (!model || model.length > MAX_MODEL_NAME) continue;
    if (model === '__proto__' || model === 'constructor' || model === 'prototype') continue;
    if (isReasoningEffort(effort)) {
      result[model] = effort;
    }
  }
  return result;
}

export function resolveReasoningEffortForModel(
  model: string,
  byModel: Record<string, ReasoningEffort>,
  fallback: ReasoningEffort = 'default',
): ReasoningEffort {
  if (!model) return fallback;
  return byModel[model] ?? fallback;
}

export function rememberReasoningEffortForModel(
  byModel: Record<string, ReasoningEffort>,
  model: string,
  effort: ReasoningEffort,
): Record<string, ReasoningEffort> {
  if (!model || byModel[model] === effort) return byModel;
  return { ...byModel, [model]: effort };
}

/** 换模型：先记下当前模型的强度，再还原目标模型上次用过的（没有则 default）。 */
export function planModelReasoningSwitch(params: {
  previousModel: string;
  previousEffort: ReasoningEffort;
  nextModel: string;
  byModel: Record<string, ReasoningEffort>;
}): { effort: ReasoningEffort; byModel: Record<string, ReasoningEffort> } {
  const remembered = rememberReasoningEffortForModel(
    params.byModel,
    params.previousModel,
    params.previousEffort,
  );
  const effort = resolveReasoningEffortForModel(params.nextModel, remembered, 'default');
  return {
    effort,
    byModel: rememberReasoningEffortForModel(remembered, params.nextModel, effort),
  };
}
