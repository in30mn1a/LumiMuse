import { MemoryStatus } from '@/types';

interface SupersededByMetadata {
  action?: string;
  memoryId?: string;
  sourceMsgIds?: string[];
  supersededAt?: string;
}

export interface MemoryMetadata {
  previousStatus?: MemoryStatus;
  supersededBy?: SupersededByMetadata;
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
