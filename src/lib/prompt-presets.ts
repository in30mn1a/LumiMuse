/**
 * 预设提示词（SillyTavern preset prompts 移植）数据访问层。
 *
 * 角色绑定：characters.active_preset_id
 *   - null / '' / '__none__'：不使用预设（LumiMuse 传统骨架）
 *   - uuid：使用该预设
 *
 * 单层启用（Q2）：prompt_preset_entries.enabled 直接决定启用，无单独 order 表。
 */

import * as crypto from 'crypto';
import { getDb } from '@/lib/db';
import { stripTagRulesSchema } from '@/lib/schemas';
import {
  Character,
  PresetEntry,
  PresetMarkerKey,
  PromptPreset,
} from '@/types';

/** 新建角色的落库 sentinel；解析层与 null / '' 同义，都不使用预设。 */
export const PRESET_ID_NONE = '__none__';

function parseStripTags(value: unknown): string[] {
  const parsed = stripTagRulesSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid strip_tags: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  }
  return parsed.data;
}

function genId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToPreset(row: Record<string, unknown>): PromptPreset {
  const stripTagsRaw = row.strip_tags;
  let stripTags: string[] = [];
  if (typeof stripTagsRaw === 'string' && stripTagsRaw.trim()) {
    try {
      const parsed = JSON.parse(stripTagsRaw) as unknown;
      const validated = stripTagRulesSchema.safeParse(parsed);
      if (validated.success) stripTags = validated.data;
    } catch {
      // 非法 JSON 视作空列表（不应该发生，迁移默认 '[]'）
    }
  }
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? '',
    is_built_in: (row.is_built_in as number) === 1,
    story_plot_strip: (row.story_plot_strip as number | null | undefined) === 1,
    strip_tags: stripTags,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToEntry(row: Record<string, unknown>): PresetEntry {
  return {
    id: row.id as string,
    preset_id: row.preset_id as string,
    name: row.name as string,
    role: row.role as PresetEntry['role'],
    content: (row.content as string | null) ?? '',
    is_marker: (row.is_marker as number) === 1,
    marker_key: (row.marker_key as PresetMarkerKey | null) ?? null,
    is_system_prompt: (row.is_system_prompt as number) === 1,
    injection_position: (row.injection_position as number) === 1 ? 1 : 0,
    injection_depth: (row.injection_depth as number) ?? 4,
    injection_order: (row.injection_order as number) ?? 100,
    forbid_overrides: (row.forbid_overrides as number) === 1,
    enabled: (row.enabled as number) === 1,
    sort_order: (row.sort_order as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function listPresets(): PromptPreset[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM prompt_presets ORDER BY created_at ASC, id ASC').all() as Record<string, unknown>[];
  return rows.map(rowToPreset);
}

export function listPresetsWithCounts(): Array<PromptPreset & { entry_count: number; enabled_count: number }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      p.*,
      (SELECT COUNT(*) FROM prompt_preset_entries e WHERE e.preset_id = p.id) AS entry_count,
      (SELECT COUNT(*) FROM prompt_preset_entries e WHERE e.preset_id = p.id AND e.enabled = 1) AS enabled_count
    FROM prompt_presets p
    ORDER BY p.created_at ASC, p.id ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ...rowToPreset(r),
    entry_count: (r.entry_count as number) ?? 0,
    enabled_count: (r.enabled_count as number) ?? 0,
  }));
}

export function getPreset(id: string): PromptPreset | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM prompt_presets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToPreset(row) : null;
}

export function createPreset(input: { name: string; description?: string; id?: string; story_plot_strip?: boolean; strip_tags?: string[] }): PromptPreset {
  const db = getDb();
  const id = input.id ?? genId();
  const now = nowIso();
  const stripTags = parseStripTags(input.strip_tags ?? []);
  db.prepare(`
    INSERT INTO prompt_presets (
      id, name, description, is_built_in, story_plot_strip,
      strip_tags, created_at, updated_at
    )
    VALUES (?, ?, ?, 0, ?, ?, ?, ?)
  `).run(
    id,
    input.name.trim() || '未命名预设',
    input.description ?? '',
    (input.story_plot_strip ?? false) ? 1 : 0,
    JSON.stringify(stripTags),
    now,
    now,
  );
  return {
    id,
    name: input.name.trim() || '未命名预设',
    description: input.description ?? '',
    is_built_in: false,
    story_plot_strip: input.story_plot_strip ?? false,
    strip_tags: stripTags,
    created_at: now,
    updated_at: now,
  };
}

export function updatePreset(id: string, patch: Partial<Pick<PromptPreset, 'name' | 'description' | 'is_built_in' | 'story_plot_strip' | 'strip_tags'>>): void {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
  if (patch.description !== undefined) { fields.push('description = ?'); values.push(patch.description); }
  if (patch.is_built_in !== undefined) { fields.push('is_built_in = ?'); values.push(patch.is_built_in ? 1 : 0); }
  if (patch.story_plot_strip !== undefined) { fields.push('story_plot_strip = ?'); values.push(patch.story_plot_strip ? 1 : 0); }
  if (patch.strip_tags !== undefined) {
    const tags = parseStripTags(patch.strip_tags);
    fields.push('strip_tags = ?');
    values.push(JSON.stringify(tags));
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  db.prepare(`UPDATE prompt_presets SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deletePreset(id: string): void {
  const db = getDb();
  db.transaction(() => {
    // SQLite ALTER TABLE 无法真加 FK；这里应用层兜底，删除预设时把所有角色的 active_preset_id 解绑。
    db.prepare('UPDATE characters SET active_preset_id = NULL WHERE active_preset_id = ?').run(id);
    // prompt_preset_entries 由 REFERENCES ... ON DELETE CASCADE 处理；若因 PRAGMA foreign_keys=off 失效，手动兜底：
    db.prepare('DELETE FROM prompt_preset_entries WHERE preset_id = ?').run(id);
    db.prepare('DELETE FROM prompt_presets WHERE id = ?').run(id);
  })();
}

export function listEntries(presetId: string): PresetEntry[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM prompt_preset_entries WHERE preset_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(presetId) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function loadEnabledEntries(presetId: string): PresetEntry[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM prompt_preset_entries WHERE preset_id = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC'
  ).all(presetId) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function getEntry(entryId: string): PresetEntry | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM prompt_preset_entries WHERE id = ?').get(entryId) as Record<string, unknown> | undefined;
  return row ? rowToEntry(row) : null;
}

export interface UpsertEntryInput {
  id?: string;
  preset_id: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content?: string;
  is_marker?: boolean;
  marker_key?: PresetMarkerKey | null;
  is_system_prompt?: boolean;
  injection_position?: 0 | 1;
  injection_depth?: number;
  injection_order?: number;
  forbid_overrides?: boolean;
  enabled?: boolean;
  sort_order?: number;
}

export function upsertEntry(input: UpsertEntryInput): PresetEntry {
  const db = getDb();
  const now = nowIso();

  if (input.id) {
    const existing = getEntry(input.id);
    if (existing) {
      db.prepare(`
        UPDATE prompt_preset_entries SET
          name = ?, role = ?, content = ?, is_marker = ?, marker_key = ?,
          is_system_prompt = ?, injection_position = ?, injection_depth = ?, injection_order = ?,
          forbid_overrides = ?, enabled = ?, sort_order = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.name,
        input.role,
        input.content ?? existing.content,
        (input.is_marker ?? existing.is_marker) ? 1 : 0,
        input.marker_key !== undefined ? input.marker_key : existing.marker_key,
        (input.is_system_prompt ?? existing.is_system_prompt) ? 1 : 0,
        input.injection_position ?? existing.injection_position,
        input.injection_depth ?? existing.injection_depth,
        input.injection_order ?? existing.injection_order,
        (input.forbid_overrides ?? existing.forbid_overrides) ? 1 : 0,
        (input.enabled ?? existing.enabled) ? 1 : 0,
        input.sort_order ?? existing.sort_order,
        now,
        input.id,
      );
      return getEntry(input.id)!;
    }
  }

  const newId = input.id ?? genId();
  db.prepare(`
    INSERT INTO prompt_preset_entries (
      id, preset_id, name, role, content, is_marker, marker_key,
      is_system_prompt, injection_position, injection_depth, injection_order,
      forbid_overrides, enabled, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId,
    input.preset_id,
    input.name,
    input.role,
    input.content ?? '',
    (input.is_marker ?? false) ? 1 : 0,
    input.marker_key ?? null,
    (input.is_system_prompt ?? false) ? 1 : 0,
    input.injection_position ?? 0,
    input.injection_depth ?? 4,
    input.injection_order ?? 100,
    (input.forbid_overrides ?? false) ? 1 : 0,
    (input.enabled ?? true) ? 1 : 0,
    input.sort_order ?? 0,
    now,
    now,
  );
  return getEntry(newId)!;
}

export function deleteEntry(entryId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM prompt_preset_entries WHERE id = ?').run(entryId);
}

/**
 * 解析角色绑定的预设。
 *
 *   - null / '' / PRESET_ID_NONE：不使用预设
 *   - 其他非空字符串：使用该预设 id（不存在则返回 null）
 */
export function resolveActivePreset(character: Character): PromptPreset | null {
  const activePresetId = character.active_preset_id;
  if (
    activePresetId == null
    || activePresetId === ''
    || activePresetId === PRESET_ID_NONE
  ) {
    return null;
  }
  return getPreset(activePresetId);
}
