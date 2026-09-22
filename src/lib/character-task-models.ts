import type Database from 'better-sqlite3';
import { sanitizeBackgroundSystemPromptByModel } from '@/lib/background-system-prompt';
import {
  sanitizeReasoningEffortByModel,
} from '@/lib/reasoning-effort';
import type { ReasoningEffort } from '@/types';

export interface CharacterTaskModelFields {
  background_provider_id: string;
  background_model: string;
  image_prompt_model: string;
  background_reasoning_by_model: Record<string, ReasoningEffort>;
  image_prompt_reasoning_by_model: Record<string, ReasoningEffort>;
  background_system_prompt_by_model: Record<string, string>;
  image_prompt_system_prompt_by_model: Record<string, string>;
}

export const EMPTY_CHARACTER_TASK_MODELS: CharacterTaskModelFields = {
  background_provider_id: '',
  background_model: '',
  image_prompt_model: '',
  background_reasoning_by_model: {},
  image_prompt_reasoning_by_model: {},
  background_system_prompt_by_model: {},
  image_prompt_system_prompt_by_model: {},
};

function parseStoredMap(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export function serializeReasoningMap(value: unknown): string {
  return JSON.stringify(sanitizeReasoningEffortByModel(parseStoredMap(value)));
}

export function serializePromptMap(value: unknown): string {
  return JSON.stringify(sanitizeBackgroundSystemPromptByModel(parseStoredMap(value)));
}

export function normalizeCharacterTaskModels(row: unknown): CharacterTaskModelFields {
  const record = row && typeof row === 'object'
    ? row as Record<string, unknown>
    : {};
  return {
    background_provider_id: typeof record.background_provider_id === 'string' ? record.background_provider_id : '',
    background_model: typeof record.background_model === 'string' ? record.background_model : '',
    image_prompt_model: typeof record.image_prompt_model === 'string' ? record.image_prompt_model : '',
    background_reasoning_by_model: sanitizeReasoningEffortByModel(
      parseStoredMap(record.background_reasoning_by_model),
    ),
    image_prompt_reasoning_by_model: sanitizeReasoningEffortByModel(
      parseStoredMap(record.image_prompt_reasoning_by_model),
    ),
    background_system_prompt_by_model: sanitizeBackgroundSystemPromptByModel(
      parseStoredMap(record.background_system_prompt_by_model),
    ),
    image_prompt_system_prompt_by_model: sanitizeBackgroundSystemPromptByModel(
      parseStoredMap(record.image_prompt_system_prompt_by_model),
    ),
  };
}

export function presentCharacter<T extends Record<string, unknown>>(row: T): T & CharacterTaskModelFields {
  return {
    ...row,
    ...normalizeCharacterTaskModels(row),
  };
}

function isMissingTaskModelSchema(error: unknown): boolean {
  return error instanceof Error && /no such (table|column)/i.test(error.message);
}

export type BackgroundTaskKind = 'background' | 'image_prompt';

export interface BackgroundTaskTarget {
  character?: CharacterTaskModelFields | null;
  kind?: BackgroundTaskKind;
}

/**
 * 角色指定了模型时返回该模型，并标明思考强度和系统提示词该读哪张表。
 * 生图模型留空时跟随本角色的后台任务模型，两处都留空才回到主聊天模型。
 */
export function resolveCharacterTaskSelection(target?: BackgroundTaskTarget): {
  model: string;
  effortSource: 'image' | 'background' | 'global';
} {
  const character = target?.character;
  if (!character) return { model: '', effortSource: 'global' };

  const backgroundModel = character.background_model?.trim() ?? '';
  if (target?.kind === 'image_prompt') {
    const imageModel = character.image_prompt_model?.trim() ?? '';
    if (imageModel) return { model: imageModel, effortSource: 'image' };
    if (backgroundModel) return { model: backgroundModel, effortSource: 'background' };
    return { model: '', effortSource: 'global' };
  }

  if (backgroundModel) return { model: backgroundModel, effortSource: 'background' };
  return { model: '', effortSource: 'global' };
}

/** 按实际发出的模型名，从角色对应的提示词表里取系统提示词。没有条目就是空。 */
export function resolveCharacterTaskSystemPrompt(
  target: BackgroundTaskTarget | undefined,
  resolvedModel: string,
): string {
  const modelKey = resolvedModel?.trim() ?? '';
  if (!modelKey) return '';
  const selection = resolveCharacterTaskSelection(target);
  const map = selection.effortSource === 'image'
    ? target?.character?.image_prompt_system_prompt_by_model
    : target?.character?.background_system_prompt_by_model;
  return sanitizeBackgroundSystemPromptByModel(map)[modelKey] ?? '';
}

/** 读角色上的任务模型。旧库还没有这些列时回退为空，调用方继续用主聊天模型。 */
export function loadCharacterTaskModels(db: Database.Database, characterId: string): CharacterTaskModelFields {
  try {
    const row = db.prepare(
      `SELECT background_provider_id, background_model, image_prompt_model,
              background_reasoning_by_model, image_prompt_reasoning_by_model,
              background_system_prompt_by_model, image_prompt_system_prompt_by_model
       FROM characters WHERE id = ?`,
    ).get(characterId);
    return normalizeCharacterTaskModels(row);
  } catch (error) {
    if (isMissingTaskModelSchema(error)) return { ...EMPTY_CHARACTER_TASK_MODELS };
    throw error;
  }
}
