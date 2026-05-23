import { getDb } from '@/lib/db';
import { DEFAULT_SETTINGS, ImageGenSettings, Settings } from '@/types';

export function loadSettings(): Settings {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const map: Record<string, unknown> = {};

  for (const row of rows) {
    try {
      map[row.key] = JSON.parse(row.value);
    } catch {
      map[row.key] = row.value;
    }
  }

  const merged = { ...DEFAULT_SETTINGS, ...map } as Settings;

  // 对嵌套对象做深合并，避免部分保存导致默认值丢失
  if (map.image_gen && typeof map.image_gen === 'object') {
    merged.image_gen = { ...DEFAULT_SETTINGS.image_gen, ...map.image_gen as Partial<ImageGenSettings> };
  }

  return merged;
}
