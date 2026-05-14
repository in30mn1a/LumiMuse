import { MemoryCategory } from '@/types';

const CATEGORY_PATTERNS: Array<[RegExp, MemoryCategory]> = [
  [/关系|鍏崇郴/, '关系动态'],
  [/话题|璇濋/, '话题历史'],
  [/基础|鍩虹/, '基础信息'],
  [/偏好|鍋忓ソ/, '偏好习惯'],
  [/人格|浜烘牸/, '人格特质'],
  [/重要|閲嶈/, '重要事件'],
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
