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

// ─── 认证 token 撤销机制（M2） ─────────────────────────────────
//
// 在 settings 表里维护一个特殊 key `auth.min_iat`，表示「token 签发时间下限」。
// verifyAuthToken 会拒绝 payload.iat < min_iat 的 token，从而让登出 / 改密
// 能立即作废所有现存会话——即使 cookie 已被窃取，攻击者也无法继续重放。
//
// 第一次启动 / 旧库升级时该 key 不存在，返回 0，意味着所有现存 token 继续有效，
// 保持向后兼容；只有显式 bumpAuthMinIat() 之后才会形成撤销点。
const AUTH_MIN_IAT_KEY = 'auth.min_iat';

export function getAuthMinIat(): number {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(AUTH_MIN_IAT_KEY) as
    | { value: string }
    | undefined;
  if (!row) return 0;
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
  } catch {
    // 兜底：万一历史数据是纯数字字符串
    const n = Number(row.value);
    return Number.isFinite(n) ? n : 0;
  }
}

/**
 * 将 min_iat 推进到「当前时间」，立即作废所有签发时间早于现在的 token。
 * 用于登出、密码变更等需要全量踢线场景。
 *
 * 取 max(now, current + 1)：极端情况下系统时钟回拨或同毫秒重复调用，
 * 仍保证严格单调递增，避免之前刚签发的 token 因 iat == min_iat 被误放行。
 */
export function bumpAuthMinIat(): number {
  const db = getDb();
  const current = getAuthMinIat();
  const next = Math.max(Date.now(), current + 1);
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(AUTH_MIN_IAT_KEY, JSON.stringify(next));
  return next;
}
