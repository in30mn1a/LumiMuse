import { MemoryStatus } from '@/types';

interface SupersededByMetadata {
  action?: string;
  memoryId?: string;
  sourceMsgIds?: string[];
  supersededAt?: string;
}

export interface MemorySourceAttribution {
  granularity: 'message' | 'batch' | 'mixed' | 'unknown';
  reason?: 'missing_refs' | 'invalid_refs' | 'missing_mapping';
}

export interface MemoryMetadata {
  previousStatus?: MemoryStatus;
  supersededBy?: SupersededByMetadata;
  sourceAttribution?: MemorySourceAttribution;
  [key: string]: unknown;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function parseMemoryMetadata(value: unknown): MemoryMetadata {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as MemoryMetadata
    : {};
}

export function getMemorySourceAttribution(value: unknown): MemorySourceAttribution {
  const attribution = parseMemoryMetadata(value).sourceAttribution;
  if (!attribution || typeof attribution !== 'object' || Array.isArray(attribution)) {
    return { granularity: 'unknown' };
  }
  const { granularity, reason } = attribution;
  if (granularity !== 'message' && granularity !== 'batch' && granularity !== 'mixed') {
    return { granularity: 'unknown' };
  }
  return {
    granularity,
    ...(reason === 'missing_refs' || reason === 'invalid_refs' || reason === 'missing_mapping' ? { reason } : {}),
  };
}
