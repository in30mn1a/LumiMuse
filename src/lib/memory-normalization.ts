import { Memory, MemoryKind, MEMORY_KINDS } from '@/types';
import { inferMemoryDefaults, normalizeMemoryCategory } from '@/lib/memory-category';

type MemoryRowFields = Memory & {
  category: unknown;
  tags: unknown;
  source_msg_ids: unknown;
  memory_kind: unknown;
  importance: unknown;
  emotional_weight: unknown;
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
  };
}
