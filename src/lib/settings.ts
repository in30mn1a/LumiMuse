import { getDb } from '@/lib/db';
import { DEFAULT_SETTINGS, Settings } from '@/types';

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

  return { ...DEFAULT_SETTINGS, ...map } as Settings;
}
