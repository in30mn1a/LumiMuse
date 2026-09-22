import { getDb } from '@/lib/db';
import {
  resolveCharacterTaskSelection,
  resolveCharacterTaskSystemPrompt,
  type BackgroundTaskTarget,
} from '@/lib/character-task-models';
import { RETIRED_BACKGROUND_SETTING_KEYS } from '@/lib/character-task-settings-migration';
import { normalizeMemoryEngineSettings } from '@/lib/memory-runtime-policy';
import { resolveReasoningEffortForModel, sanitizeReasoningEffortByModel } from '@/lib/reasoning-effort';
import { DEFAULT_SETTINGS, ImageGenSettings, MemoryEngineSettings, Settings } from '@/types';

const BOOLEAN_SETTING_KEYS: (keyof Settings)[] = [
  'json_mode',
  'streaming',
  'example_dialogue',
  'memory_inject',
  'memory_trigger_interval_enabled',
  'memory_trigger_time_enabled',
  'memory_trigger_keyword_enabled',
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

/**
 * 记录浏览器上报的 IANA 时区，供没有客户端上下文的后台任务（记忆提取 / 画像更新）
 * 把消息时间戳渲染成用户本地时间。
 *
 * 只在与已存值不同时写库：聊天是热路径，不能每轮都写一次 settings。
 * 必须校验后再存——该值来自客户端且最终会喂给 Intl.DateTimeFormat，
 * 非法值会让格式化抛错，而调用方在后台任务里，抛错等于丢记忆。
 */
export function recordClientTimezone(timeZone: unknown, current: string): void {
  if (typeof timeZone !== 'string') return;
  const trimmed = timeZone.trim();
  if (!trimmed || trimmed === current || trimmed.length > 64) return;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
  } catch {
    return;
  }

  try {
    getDb().prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('client_timezone', JSON.stringify(trimmed));
  } catch {
    // 写失败（DB 锁/只读/迁移未完成等）不得让聊天请求失败——
    // 这只是个诊断性偏好，下一轮聊天还会再试。getDb() 也放在 try 内：
    // 它在迁移失败时会抛，不能依赖"调用方一定先初始化过"这种顺序保证。
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
    const legacyLimitInject = normalizeLegacyBoolean(map.limit_inject) ?? DEFAULT_SETTINGS.limit_inject;
    merged.memory_engine = normalizeMemoryEngineSettings(map.memory_engine, legacyLimitInject);
    normalizeBooleanSettings(merged.memory_engine as unknown as Record<string, unknown>, MEMORY_ENGINE_BOOLEAN_KEYS);
    normalizeMemoryRetrievalMode(merged.memory_engine);
  } else {
    merged.memory_engine = normalizeMemoryEngineSettings(
      {},
      merged.limit_inject,
    );
  }

  merged.reasoning_effort_by_model = sanitizeReasoningEffortByModel(map.reasoning_effort_by_model);
  for (const key of RETIRED_BACKGROUND_SETTING_KEYS) {
    delete (merged as unknown as Record<string, unknown>)[key];
  }

  return merged;
}

export type { BackgroundTaskKind, BackgroundTaskTarget } from '@/lib/character-task-models';
export { resolveCharacterTaskSelection, resolveCharacterTaskSystemPrompt };

/**
 * 解析后台任务的接口和模型。
 * 角色选了供应商就用该供应商的地址和密钥；供应商缺失时回退主接口。
 * 模型优先用角色指定的任务模型，否则用主聊天模型。
 * 记忆检索注入不走这里。
 */
export function resolveBackgroundConfig(
  settings: Settings,
  target?: BackgroundTaskTarget,
): { api_base: string; api_key: string; model: string } {
  const characterModel = resolveCharacterTaskSelection(target).model;
  const model = characterModel || settings.model;
  const providerId = target?.character?.background_provider_id?.trim() ?? '';
  if (providerId) {
    const db = getDb();
    const row = db.prepare('SELECT api_base, api_key FROM api_providers WHERE id = ?').get(providerId) as
      | { api_base: string; api_key: string }
      | undefined;
    if (row?.api_base) {
      return {
        api_base: row.api_base,
        api_key: row.api_key,
        model,
      };
    }
  }
  return {
    api_base: settings.api_base,
    api_key: settings.api_key,
    model,
  };
}

function taskReasoningMap(
  target: BackgroundTaskTarget | undefined,
  source: 'image' | 'background' | 'global',
) {
  if (source === 'image') return target?.character?.image_prompt_reasoning_by_model;
  return target?.character?.background_reasoning_by_model;
}

export function buildBackgroundChatExtraBody(
  model: string,
  target?: BackgroundTaskTarget,
): Record<string, unknown> | undefined {
  const selection = resolveCharacterTaskSelection(target);
  const effort = resolveReasoningEffortForModel(
    model,
    sanitizeReasoningEffortByModel(taskReasoningMap(target, selection.effortSource)),
    'default',
  );
  if (effort === 'default') return undefined;
  return { reasoning_effort: effort };
}

/** 后台 chatCompletion 用：覆盖供应商字段，且绝不继承主聊天的 reasoning_effort。 */
export function mergeSettingsForBackgroundLlm(
  base: Settings,
  bg: { api_base: string; api_key: string; model: string },
  patch: Partial<Settings> = {},
): Settings {
  return {
    ...base,
    ...patch,
    api_base: bg.api_base,
    api_key: bg.api_key,
    model: bg.model,
    reasoning_effort: 'default',
  };
}

export {
  applyBackgroundSystemPrompt,
  resolveBackgroundSystemPrompt,
  rememberBackgroundSystemPromptForModel,
  resolveBackgroundSystemPromptForModel,
  planBackgroundModelSwitch,
  sanitizeBackgroundSystemPromptByModel,
} from './background-system-prompt';

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
