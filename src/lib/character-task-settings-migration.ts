import type Database from 'better-sqlite3';
import { sanitizeBackgroundSystemPromptByModel } from '@/lib/background-system-prompt';
import { isReasoningEffort, sanitizeReasoningEffortByModel } from '@/lib/reasoning-effort';
import type { ReasoningEffort } from '@/types';

export const CHARACTER_TASK_SETTINGS_MIGRATED_KEY = 'character_task_settings_migrated_v1';

export const RETIRED_BACKGROUND_SETTING_KEYS = [
  'memory_background_model',
  'memory_background_provider_id',
  'memory_background_system_prompt',
  'memory_background_system_prompt_by_model',
  'disable_deepseek_thinking_for_background',
  'memory_background_reasoning_effort_enabled',
  'memory_background_reasoning_effort',
] as const;

function readSetting(db: Database.Database, key: string): unknown {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return row.value;
  }
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function fillPrompt(
  target: Record<string, string>,
  existing: Record<string, string>,
  model: string,
  fallback: string,
): void {
  if (!model || hasOwn(existing, model) || hasOwn(target, model) || !fallback.trim()) return;
  target[model] = fallback;
}

/**
 * 把总设置里的后台供应商、模型和系统提示词抄到每个角色，只执行一次。
 * 角色已经写过的模型、供应商和同名提示词保持原样。
 */
export function migrateGlobalBackgroundTaskSettings(db: Database.Database): void {
  const marker = db.prepare('SELECT 1 AS ok FROM settings WHERE key = ?')
    .get(CHARACTER_TASK_SETTINGS_MIGRATED_KEY);
  if (marker) return;

  const globalModel = asTrimmedString(readSetting(db, 'memory_background_model'));
  const mainModel = asTrimmedString(readSetting(db, 'model'));
  const providerId = asTrimmedString(readSetting(db, 'memory_background_provider_id'));
  const currentPromptRaw = readSetting(db, 'memory_background_system_prompt');
  const currentPrompt = typeof currentPromptRaw === 'string' ? currentPromptRaw : '';
  const globalPrompts = sanitizeBackgroundSystemPromptByModel(
    readSetting(db, 'memory_background_system_prompt_by_model'),
  );
  const activeKey = globalModel || mainModel;
  if (activeKey && currentPrompt.trim()) {
    globalPrompts[activeKey] = currentPrompt;
  }

  let providerModel = '';
  if (providerId) {
    const provider = db.prepare('SELECT model FROM api_providers WHERE id = ?').get(providerId) as
      | { model?: string }
      | undefined;
    providerModel = asTrimmedString(provider?.model);
  }
  const inheritedModel = globalModel || providerModel;

  const effortEnabled = readSetting(db, 'memory_background_reasoning_effort_enabled') === true;
  const rawEffort = readSetting(db, 'memory_background_reasoning_effort');
  const globalEffort: ReasoningEffort | '' = effortEnabled && isReasoningEffort(rawEffort) && rawEffort !== 'default'
    ? rawEffort
    : '';

  const rows = db.prepare(`
    SELECT id, background_model, image_prompt_model, background_provider_id,
      background_reasoning_by_model,
      background_system_prompt_by_model, image_prompt_system_prompt_by_model
    FROM characters
  `).all() as Array<Record<string, unknown>>;

  const update = db.prepare(`
    UPDATE characters
    SET background_provider_id = ?,
      background_model = ?,
      background_reasoning_by_model = ?,
      background_system_prompt_by_model = ?,
      image_prompt_system_prompt_by_model = ?
    WHERE id = ?
  `);

  const apply = db.transaction(() => {
    for (const row of rows) {
      const hadOwnModel = asTrimmedString(row.background_model);
      const backgroundModel = hadOwnModel || inheritedModel;
      const imageModel = asTrimmedString(row.image_prompt_model);
      const nextProvider = asTrimmedString(row.background_provider_id) || providerId;
      const existingBgPrompts = sanitizeBackgroundSystemPromptByModel(
        parseMaybeJson(row.background_system_prompt_by_model),
      );
      const existingImgPrompts = sanitizeBackgroundSystemPromptByModel(
        parseMaybeJson(row.image_prompt_system_prompt_by_model),
      );
      const bgPrompts = { ...globalPrompts, ...existingBgPrompts };
      const imgPrompts = { ...globalPrompts, ...existingImgPrompts };
      fillPrompt(bgPrompts, existingBgPrompts, backgroundModel, currentPrompt);
      fillPrompt(imgPrompts, existingImgPrompts, imageModel, currentPrompt);

      const reasoning = sanitizeReasoningEffortByModel(parseMaybeJson(row.background_reasoning_by_model));
      const effortKey = backgroundModel || mainModel;
      if (!hadOwnModel && globalEffort && effortKey && !reasoning[effortKey]) {
        reasoning[effortKey] = globalEffort;
      }

      update.run(
        nextProvider,
        backgroundModel,
        JSON.stringify(reasoning),
        JSON.stringify(bgPrompts),
        JSON.stringify(imgPrompts),
        String(row.id),
      );
    }

    const remove = db.prepare('DELETE FROM settings WHERE key = ?');
    for (const key of RETIRED_BACKGROUND_SETTING_KEYS) remove.run(key);
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(CHARACTER_TASK_SETTINGS_MIGRATED_KEY, JSON.stringify(true));
  });
  apply();
}
