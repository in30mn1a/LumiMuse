import { Memory, MemoryCategory } from '@/types';

const CATEGORY_PATTERNS: Array<[RegExp, MemoryCategory]> = [
  [/关系/, '关系动态'],
  [/话题/, '话题历史'],
  [/基础/, '基础信息'],
  [/偏好/, '偏好习惯'],
  [/人格/, '人格特质'],
  [/重要/, '重要事件'],
  [/四季/, '四季日常'],
  [/日常/, '四季日常'],
];

export function normalizeMemoryCategory(value: string): MemoryCategory {
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(value)) return category;
  }
  return '话题历史';
}

export function isMemoryCategory(value: string): value is MemoryCategory {
  return CATEGORY_PATTERNS.some(([, category]) => category === value);
}

export function inferMemoryDefaults(categoryValue: string): Pick<Memory, 'memory_kind' | 'importance' | 'emotional_weight'> {
  const category = normalizeMemoryCategory(categoryValue);
  switch (category) {
    case '基础信息':
      return { memory_kind: 'user_fact', importance: 0.85, emotional_weight: 0.0 };
    case '人格特质':
      return { memory_kind: 'user_fact', importance: 0.8, emotional_weight: 0.0 };
    case '重要事件':
      return { memory_kind: 'relationship_event', importance: 0.75, emotional_weight: 0.65 };
    case '偏好习惯':
      return { memory_kind: 'user_preference', importance: 0.65, emotional_weight: 0.0 };
    case '关系动态':
      return { memory_kind: 'relationship_event', importance: 0.6, emotional_weight: 0.6 };
    case '四季日常':
      return { memory_kind: 'general', importance: 0.4, emotional_weight: 0.0 };
    case '话题历史':
    default:
      return { memory_kind: 'general', importance: 0.45, emotional_weight: 0.0 };
  }
}
