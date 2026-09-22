import type Database from 'better-sqlite3';
import {
  sanitizeReasoningEffortByModel,
} from '@/lib/reasoning-effort';
import type { ReasoningEffort } from '@/types';

export interface CharacterTaskModelFields {
  background_model: string;
  image_prompt_model: string;
  background_reasoning_by_model: Record<string, ReasoningEffort>;
  image_prompt_reasoning_by_model: Record<string, ReasoningEffort>;
}

export const EMPTY_CHARACTER_TASK_MODELS: CharacterTaskModelFields = {
  background_model: '',
  image_prompt_model: '',
  background_reasoning_by_model: {},
  image_prompt_reasoning_by_model: {},
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

export function normalizeCharacterTaskModels(row: unknown): CharacterTaskModelFields {
  const record = row && typeof row === 'object'
    ? row as Record<string, unknown>
    : {};
  return {
    background_model: typeof record.background_model === 'string' ? record.background_model : '',
    image_prompt_model: typeof record.image_prompt_model === 'string' ? record.image_prompt_model : '',
    background_reasoning_by_model: sanitizeReasoningEffortByModel(
      parseStoredMap(record.background_reasoning_by_model),
    ),
    image_prompt_reasoning_by_model: sanitizeReasoningEffortByModel(
      parseStoredMap(record.image_prompt_reasoning_by_model),
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

/** 读角色上的任务模型。旧库还没有这些列或这张表时回退为空，调用方继续用全局后台模型。 */
export function loadCharacterTaskModels(db: Database.Database, characterId: string): CharacterTaskModelFields {
  try {
    const row = db.prepare(
      `SELECT background_model, image_prompt_model, background_reasoning_by_model, image_prompt_reasoning_by_model
       FROM characters WHERE id = ?`,
    ).get(characterId);
    return normalizeCharacterTaskModels(row);
  } catch (error) {
    if (isMissingTaskModelSchema(error)) return { ...EMPTY_CHARACTER_TASK_MODELS };
    throw error;
  }
}
