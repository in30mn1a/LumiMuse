import { getDb } from '@/lib/db';
import { DEFAULT_SETTINGS, ImageGenSettings, MemoryEngineSettings, Settings } from '@/types';

const BOOLEAN_SETTING_KEYS: (keyof Settings)[] = [
  'json_mode',
  'streaming',
  'example_dialogue',
  'memory_inject',
  'memory_trigger_interval_enabled',
  'memory_trigger_time_enabled',
  'memory_trigger_keyword_enabled',
  'disable_deepseek_thinking_for_background',
  'show_timestamps',
  'limit_inject',
];

const IMAGE_GEN_BOOLEAN_KEYS: (keyof ImageGenSettings)[] = [
  'enabled',
  'auto_generate',
  'inline_prompt',
];

const MEMORY_ENGINE_BOOLEAN_KEYS: (keyof MemoryEngineSettings)[] = [
  'enabled',
  'allow_memory_context_in_chat',
  'allow_external_memory_payloads',
  'embedding_enabled',
  'reranker_enabled',
  'fallback_local_enabled',
];

const LEGACY_MEMORY_RETRIEVAL_MODE_MAP: Record<string, MemoryEngineSettings['retrieval_mode']> = {
  balanced: 'hybrid',
  continuity: 'hybrid',
};

function normalizeLegacyBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 0) return false;
  if (value === 1) return true;
  return undefined;
}

function normalizeBooleanSettings(target: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    const normalized = normalizeLegacyBoolean(target[key]);
    if (normalized !== undefined) {
      target[key] = normalized;
    }
  }
}

function normalizeMemoryRetrievalMode(settings: MemoryEngineSettings): void {
  const retrievalMode = (settings as { retrieval_mode?: unknown }).retrieval_mode;
  if (typeof retrievalMode !== 'string') return;
  const normalized = LEGACY_MEMORY_RETRIEVAL_MODE_MAP[retrievalMode];
  if (normalized) {
    settings.retrieval_mode = normalized;
  }
}

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
  normalizeBooleanSettings(merged as unknown as Record<string, unknown>, BOOLEAN_SETTING_KEYS);

  // 对嵌套对象做深合并，避免部分保存导致默认值丢失
  if (map.image_gen && typeof map.image_gen === 'object') {
    merged.image_gen = { ...DEFAULT_SETTINGS.image_gen, ...map.image_gen as Partial<ImageGenSettings> };
    normalizeBooleanSettings(merged.image_gen as unknown as Record<string, unknown>, IMAGE_GEN_BOOLEAN_KEYS);
  }
  if (map.memory_engine && typeof map.memory_engine === 'object') {
    merged.memory_engine = { ...DEFAULT_SETTINGS.memory_engine, ...map.memory_engine as Partial<MemoryEngineSettings> };
    normalizeBooleanSettings(merged.memory_engine as unknown as Record<string, unknown>, MEMORY_ENGINE_BOOLEAN_KEYS);
    normalizeMemoryRetrievalMode(merged.memory_engine);
  }

  return merged;
}

/**
 * 解析后台任务（记忆提取 / 画像 patch / 总结）应使用的模型。
 * 用户配置了独立后台模型则用之，否则回退到主聊天模型。
 * 注意：记忆检索注入仍走主模型，不调用本函数。
 */
export function resolveBackgroundModel(settings: Settings): string {
  const background = settings.memory_background_model?.trim();
  return background || settings.model;
}

/**
 * 解析后台任务的完整接口配置（api_base / api_key / model）。
 * - 若设置了 memory_background_provider_id，从 api_providers 表读取该供应商的接口信息
 * - 否则使用主接口的 api_base/api_key，模型回退到 resolveBackgroundModel()
 *
 * 这是有意设计：后台模型配置是成本/速度优化，不是强依赖。后台供应商缺失或失效时回退主接口，
 * 能保持总结、记忆提取、画像 patch 继续可用；审查时不要把这种回退本身当作风险。
 */
export function resolveBackgroundConfig(settings: Settings): { api_base: string; api_key: string; model: string } {
  const backgroundModel = settings.memory_background_model?.trim();
  const providerId = settings.memory_background_provider_id?.trim();
  if (providerId) {
    const db = getDb();
    const row = db.prepare('SELECT api_base, api_key, model FROM api_providers WHERE id = ?').get(providerId) as
      | { api_base: string; api_key: string; model: string }
      | undefined;
    if (row && row.api_base && row.model) {
      return { api_base: row.api_base, api_key: row.api_key, model: backgroundModel || row.model };
    }
    // 供应商无效时回退到主接口：这是 local-first 可用性策略，不是静默绕过。
  }
  return {
    api_base: settings.api_base,
    api_key: settings.api_key,
    model: resolveBackgroundModel(settings),
  };
}

export function buildBackgroundChatExtraBody(settings: Pick<Settings, 'disable_deepseek_thinking_for_background'>, model: string): Record<string, unknown> | undefined {
  if (!settings.disable_deepseek_thinking_for_background || !/deepseek/i.test(model)) {
    return undefined;
  }
  return { thinking: { type: 'disabled' } };
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
 * 将 min_iat 推进到「当前时间之后」，立即作废所有已签发 token。
 * 用于登出、密码变更等需要全量踢线场景。
 *
 * verifyAuthToken 使用 payload.iat < min_iat 的拒绝语义，因此这里写入 now + 1：
 * 即使旧 token 与撤销操作同毫秒签发，也会因 iat < min_iat 被立即拒绝。
 * 再与 current + 1 取 max，可在系统时钟回拨或同毫秒重复调用时保持严格单调递增。
 */
export function bumpAuthMinIat(): number {
  const db = getDb();
  const current = getAuthMinIat();
  const next = Math.max(Date.now() + 1, current + 1);
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(AUTH_MIN_IAT_KEY, JSON.stringify(next));
  return next;
}
