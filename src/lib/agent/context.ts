import type Database from 'better-sqlite3';
import { REASONING_SAFE_MAX_TOKENS, type LlmUsage } from '@/lib/api-client';
import type { Settings } from '@/types';

/** 预计输入超过「窗口减去输出预留」的这个比例时自动压缩较早的对话。 */
export const AGENT_COMPACT_RATIO = 0.8;
/** 真实 usage 与估算的比值上限，防止一次异常的 usage 让阈值失真。 */
const MAX_CALIBRATION_RATIO = 3;

/** Agent 请求的 `max_tokens`：沿用全局设置，并至少留出推理模型需要的输出空间。 */
export function agentOutputReserve(settings: Pick<Settings, 'max_tokens'>): number {
  return Math.max(settings.max_tokens || 0, REASONING_SAFE_MAX_TOKENS);
}

/**
 * 输入可用空间（token）：窗口减去输出预留；预留超过半个窗口时（例如窗口设得很小），
 * 仍给输入留一半，免得变成 0 或负数。超过它的请求在上游大概率放不下。
 */
export function agentInputBudget(window: number, reserve: number): number {
  return Math.max(window - reserve, Math.floor(window / 2));
}

/** 自动压缩阈值（token）：输入可用空间的固定比例。 */
export function agentCompactThreshold(window: number, reserve: number): number {
  return Math.floor(agentInputBudget(window, reserve) * AGENT_COMPACT_RATIO);
}

/** 存在 `agent_sessions.last_usage_json` 里的最近一次上游 usage。 */
export interface AgentLastUsage {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  /** 发出这次请求时本地估算的输入 token，用来校准之后的估算 */
  estimated_prompt_tokens: number;
  at: string;
}

/** 界面显示的上下文占用。`used` 与服务端判断是否压缩用的是同一个数。 */
export interface AgentContextStatus {
  window: number;
  used: number;
  threshold: number;
  last_usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number } | null;
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function readAgentLastUsage(db: Database.Database, sessionId: string): AgentLastUsage | null {
  const row = db.prepare('SELECT last_usage_json FROM agent_sessions WHERE id = ?').get(sessionId) as
    | { last_usage_json: string | null }
    | undefined;
  if (!row?.last_usage_json) return null;
  try {
    const value = JSON.parse(row.last_usage_json) as Record<string, unknown>;
    const prompt = nonNegative(value.prompt_tokens);
    const completion = nonNegative(value.completion_tokens);
    const estimated = nonNegative(value.estimated_prompt_tokens);
    if (prompt === null || completion === null || estimated === null || typeof value.model !== 'string') return null;
    const cached = nonNegative(value.cached_tokens);
    return {
      model: value.model,
      prompt_tokens: prompt,
      completion_tokens: completion,
      ...(cached === null ? {} : { cached_tokens: cached }),
      estimated_prompt_tokens: estimated,
      at: typeof value.at === 'string' ? value.at : '',
    };
  } catch {
    return null;
  }
}

export function saveAgentLastUsage(db: Database.Database, sessionId: string, usage: AgentLastUsage): void {
  db.prepare('UPDATE agent_sessions SET last_usage_json = ? WHERE id = ?').run(JSON.stringify(usage), sessionId);
}

export function toAgentLastUsage(usage: LlmUsage, model: string, estimated: number, at: string): AgentLastUsage {
  const cached = nonNegative(usage.prompt_tokens_details?.cached_tokens);
  return {
    model,
    prompt_tokens: nonNegative(usage.prompt_tokens) ?? 0,
    completion_tokens: nonNegative(usage.completion_tokens) ?? 0,
    ...(cached === null ? {} : { cached_tokens: cached }),
    estimated_prompt_tokens: estimated,
    at,
  };
}

/**
 * 本地估算到上游真实 token 的放大系数。只在同一模型的 usage 上校准，只放大不缩小：
 * 估算偏高时只会提前压缩，偏低时才需要纠正，避免请求被上游拒绝。
 */
export function agentCalibrationRatio(last: AgentLastUsage | null, model: string): number {
  if (!last || last.model !== model || last.estimated_prompt_tokens <= 0 || last.prompt_tokens <= 0) return 1;
  return Math.min(MAX_CALIBRATION_RATIO, Math.max(1, last.prompt_tokens / last.estimated_prompt_tokens));
}

export function publicLastUsage(last: AgentLastUsage | null): AgentContextStatus['last_usage'] {
  if (!last) return null;
  return {
    prompt_tokens: last.prompt_tokens,
    completion_tokens: last.completion_tokens,
    ...(last.cached_tokens === undefined ? {} : { cached_tokens: last.cached_tokens }),
  };
}
