import { Memory, MemoryKind, MEMORY_KINDS, MEMORY_STATUSES, MemoryStatus } from '@/types';
import { inferMemoryDefaults, normalizeMemoryCategory } from '@/lib/memory-category';
import { parseMemoryMetadata } from '@/lib/metadata';

type MemoryRowFields = Memory & {
  category: unknown;
  tags: unknown;
  source_msg_ids: unknown;
  memory_kind: unknown;
  importance: unknown;
  emotional_weight: unknown;
  pinned: unknown;
  status: unknown;
  last_used_at: unknown;
  usage_count: unknown;
  metadata: unknown;
};

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function numberOrDefault(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

function normalizeMemoryKind(value: unknown, fallback: MemoryKind): MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
    ? value as MemoryKind
    : fallback;
}

/**
 * 规范化 pinned：DB 列是 INTEGER(0/1)，也可能被外部写入 boolean。
 * 统一转成真正的 boolean，消除「类型说是 boolean 运行时却是 number」的类型谎言，
 * 让下游可以直接用 memory.pinned 而不必再 Number(...)>0 防御。
 */
function normalizePinned(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  return Boolean(value);
}

/**
 * 规范化 status：DB 列是 TEXT，理论上恒为合法 MemoryStatus，但外部导入/旧数据
 * 可能写入未知值。未知值回退 'active'，保证下游 string 比较安全。
 */
function normalizeMemoryStatus(value: unknown): MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value)
    ? value as MemoryStatus
    : 'active';
}

/**
 * 规范化 usage_count：DB 列是 INTEGER，但 JSON 导入/外部数据可能写入非数字。
 * 非有限值回退 0。
 */
function normalizeUsageCount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeMemoryRow(record: Memory): Memory {
  const raw = record as MemoryRowFields;
  const category = normalizeMemoryCategory(String(raw.category || '话题历史'));
  const defaults = inferMemoryDefaults(category);

  return {
    ...record,
    category,
    tags: parseJsonArray(raw.tags),
    source_msg_ids: parseJsonArray(raw.source_msg_ids),
    memory_kind: normalizeMemoryKind(raw.memory_kind, defaults.memory_kind),
    importance: numberOrDefault(raw.importance, defaults.importance),
    emotional_weight: numberOrDefault(raw.emotional_weight, defaults.emotional_weight),
    pinned: normalizePinned(raw.pinned),
    status: normalizeMemoryStatus(raw.status),
    last_used_at: typeof raw.last_used_at === 'string' ? raw.last_used_at : null,
    usage_count: normalizeUsageCount(raw.usage_count),
    metadata: parseMemoryMetadata(raw.metadata),
  };
}
