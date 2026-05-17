import { MemoryCategory } from '@/types';

const CATEGORY_PATTERNS: Array<[RegExp, MemoryCategory]> = [
  [/关系/, '关系动态'],
  [/话题/, '话题历史'],
  [/基础/, '基础信息'],
  [/偏好/, '偏好习惯'],
  [/人格/, '人格特质'],
  [/重要/, '重要事件'],
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
