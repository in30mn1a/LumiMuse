/**
 * 内置 Agent 读写预设提示词的共享逻辑：SPreset 脚本白名单、定位替换与数据库访问。
 *
 * 所有数据库函数一律接受显式传入的 db，不走全局 getDb()，以配合 Agent 只读工具与提案事务隔离。
 * 角色聊天链路不得 import 本模块。
 */
import type Database from 'better-sqlite3';
import { PRESET_ID_NONE } from '@/lib/prompt-presets';
import { presetImportWarningsSchema, stripTagRulesSchema } from '@/lib/schemas';
import { hasSpresetRuntime, parseSpresetConfig } from '@/lib/spreset/config';
import type { PresetImportWarning, PresetMarkerKey } from '@/types';

export const MIN_PRESET_ID_PREFIX = 8;
const MAX_ID_CANDIDATES = 5;

export interface PresetTextEdit {
  old_text: string;
  new_text: string;
}

export interface PresetScriptInfo {
  path: string;
  label: string;
  enabled: boolean;
  content: string;
}

export interface PresetRecord {
  id: string;
  name: string;
  description: string;
  is_built_in: boolean;
  story_plot_strip: boolean;
  strip_tags: string[];
  import_warnings: PresetImportWarning[];
  extensions: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PresetEntryRecord {
  id: string;
  preset_id: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  is_marker: boolean;
  marker_key: PresetMarkerKey | null;
  injection_position: 0 | 1;
  injection_depth: number;
  injection_order: number;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PresetEntrySnapshot {
  id: string;
  name: string;
  enabled: boolean;
  content: string;
  is_marker: boolean;
}

export interface PresetEntryBefore {
  preset_id: string;
  preset_name: string;
  entry: PresetEntrySnapshot;
}

export interface PresetSettingsBefore {
  preset_id: string;
  preset_name: string;
  story_plot_strip: boolean;
  strip_tags: string[];
}

export interface PresetScriptBefore {
  preset_id: string;
  preset_name: string;
  path: string;
  label: string;
  content: string;
}

export interface PresetEntryAfter {
  name?: string;
  enabled?: boolean;
  content?: string;
  edits?: PresetTextEdit[];
}

export interface PresetSettingsAfter {
  story_plot_strip?: boolean;
  strip_tags?: string[];
}

export interface PresetScriptAfter {
  content: string;
  edits: PresetTextEdit[];
}

export type PresetBoundCharacter =
  | { id: string; name: string; via: 'default' }
  | { id: string; name: string; via: 'model'; model: string };

export interface PresetListItem {
  id: string;
  name: string;
  description: string;
  story_plot_strip: boolean;
  strip_tags: string[];
  updated_at: string;
  entry_count: number;
  enabled_count: number;
  spreset_runtime: boolean;
  bound_characters: PresetBoundCharacter[];
}

type FixedScriptPath =
  | 'FinalRequestProcessing.script'
  | 'OutputPreprocessing.script'
  | 'OutputPreprocessing.toolCallFormatter.script'
  | 'ChatSquash.squashed_post_script';

type ParsedScriptPath =
  | { kind: 'fixed'; path: FixedScriptPath }
  | { kind: 'tool_binding'; path: string; key: string };

const FIXED_SCRIPT_PATHS: ReadonlyArray<{ path: FixedScriptPath; label: string }> = [
  { path: 'FinalRequestProcessing.script', label: '请求改写脚本' },
  { path: 'OutputPreprocessing.script', label: '输出处理脚本' },
  { path: 'OutputPreprocessing.toolCallFormatter.script', label: '工具调用格式化脚本' },
  { path: 'ChatSquash.squashed_post_script', label: '消息合并后处理脚本' },
];

const FIXED_SCRIPT_SET: ReadonlySet<string> = new Set(FIXED_SCRIPT_PATHS.map(item => item.path));
const TOOL_BINDING_PREFIX = 'ToolBindings.';
const TOOL_BINDING_SUFFIX = '.code';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function ownProperty(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 解析相对 extensions.SPreset 的白名单脚本路径。
 * 不按 "." 盲切：ToolBindings.<key>.code 中间整段作为 key（条目 ID 可能含 "."），其余四条按字面量匹配。
 */
function parseScriptPath(scriptPath: string): ParsedScriptPath | null {
  if (FIXED_SCRIPT_SET.has(scriptPath)) {
    return { kind: 'fixed', path: scriptPath as FixedScriptPath };
  }
  if (
    scriptPath.startsWith(TOOL_BINDING_PREFIX)
    && scriptPath.endsWith(TOOL_BINDING_SUFFIX)
    && scriptPath.length > TOOL_BINDING_PREFIX.length + TOOL_BINDING_SUFFIX.length
  ) {
    const key = scriptPath.slice(TOOL_BINDING_PREFIX.length, -TOOL_BINDING_SUFFIX.length);
    return { kind: 'tool_binding', path: scriptPath, key };
  }
  return null;
}

export function isWhitelistedScriptPath(scriptPath: string): boolean {
  return parseScriptPath(scriptPath) !== null;
}

function toolBindingDisplayName(binding: Record<string, unknown>, key: string): string {
  const form = asRecord(ownProperty(binding, 'form'));
  const resolved = typeof binding.resolvedName === 'string' ? binding.resolvedName.trim() : '';
  const name = typeof binding.name === 'string' ? binding.name.trim() : '';
  const formName = typeof form?.name === 'string' ? form.name.trim() : '';
  return resolved || name || formName || key;
}

function readFixedScript(spreset: Record<string, unknown>, path: FixedScriptPath): PresetScriptInfo | null {
  switch (path) {
    case 'FinalRequestProcessing.script': {
      const node = asRecord(ownProperty(spreset, 'FinalRequestProcessing'));
      if (!node || typeof ownProperty(node, 'script') !== 'string') return null;
      return { path, label: '请求改写脚本', enabled: ownProperty(node, 'enabled') === true, content: node.script as string };
    }
    case 'OutputPreprocessing.script': {
      const node = asRecord(ownProperty(spreset, 'OutputPreprocessing'));
      if (!node || typeof ownProperty(node, 'script') !== 'string') return null;
      return { path, label: '输出处理脚本', enabled: ownProperty(node, 'enabled') === true, content: node.script as string };
    }
    case 'OutputPreprocessing.toolCallFormatter.script': {
      const output = asRecord(ownProperty(spreset, 'OutputPreprocessing'));
      const node = output ? asRecord(ownProperty(output, 'toolCallFormatter')) : null;
      if (!node || typeof ownProperty(node, 'script') !== 'string') return null;
      return { path, label: '工具调用格式化脚本', enabled: ownProperty(node, 'enabled') === true, content: node.script as string };
    }
    case 'ChatSquash.squashed_post_script': {
      const node = asRecord(ownProperty(spreset, 'ChatSquash'));
      if (!node || typeof ownProperty(node, 'squashed_post_script') !== 'string') return null;
      return {
        path,
        label: '消息合并后处理脚本',
        enabled: ownProperty(node, 'squashed_post_script_enable') === true,
        content: node.squashed_post_script as string,
      };
    }
  }
}

/** 列出 extensions.SPreset 下白名单里确实存在且值为字符串的脚本。 */
export function listPresetScripts(extensions: Record<string, unknown> | null | undefined): PresetScriptInfo[] {
  const spreset = asRecord(extensions ? ownProperty(extensions, 'SPreset') : undefined);
  if (!spreset) return [];

  const scripts: PresetScriptInfo[] = [];
  for (const { path } of FIXED_SCRIPT_PATHS) {
    const info = readFixedScript(spreset, path);
    if (info) scripts.push(info);
  }

  const toolBindings = asRecord(ownProperty(spreset, 'ToolBindings'));
  if (toolBindings) {
    for (const [key, item] of Object.entries(toolBindings)) {
      if (!key) continue;
      const binding = asRecord(item);
      if (!binding || typeof ownProperty(binding, 'code') !== 'string') continue;
      const displayName = toolBindingDisplayName(binding, key);
      scripts.push({
        path: `${TOOL_BINDING_PREFIX}${key}${TOOL_BINDING_SUFFIX}`,
        label: `工具「${displayName}」的代码`,
        enabled: ownProperty(binding, 'enabled') === true,
        content: binding.code as string,
      });
    }
  }
  return scripts;
}

/** 按白名单路径读取单个脚本；非白名单或库里不存在（或非字符串）时返回 null。 */
export function getPresetScript(
  extensions: Record<string, unknown> | null | undefined,
  scriptPath: string,
): PresetScriptInfo | null {
  const parsed = parseScriptPath(scriptPath);
  if (!parsed) return null;
  const spreset = asRecord(extensions ? ownProperty(extensions, 'SPreset') : undefined);
  if (!spreset) return null;
  if (parsed.kind === 'fixed') return readFixedScript(spreset, parsed.path);

  const toolBindings = asRecord(ownProperty(spreset, 'ToolBindings'));
  const binding = toolBindings ? asRecord(ownProperty(toolBindings, parsed.key)) : null;
  if (!binding || typeof ownProperty(binding, 'code') !== 'string') return null;
  const displayName = toolBindingDisplayName(binding, parsed.key);
  return {
    path: parsed.path,
    label: `工具「${displayName}」的代码`,
    enabled: ownProperty(binding, 'enabled') === true,
    content: binding.code as string,
  };
}

/**
 * 替换 extensions.SPreset 指定白名单路径上的脚本正文，返回新对象，不修改入参。
 * 除目标路径外的全部键原样保留。目标路径必须已存在且为字符串。
 */
export function setPresetScript(
  extensions: Record<string, unknown>,
  scriptPath: string,
  text: string,
): Record<string, unknown> {
  const parsed = parseScriptPath(scriptPath);
  if (!parsed) throw new Error(`不允许修改的脚本路径：${scriptPath}`);
  const spreset = asRecord(ownProperty(extensions, 'SPreset'));
  if (!spreset) throw new Error(`预设缺少 SPreset 配置，无法写入脚本：${scriptPath}`);

  let nextSpreset: Record<string, unknown>;
  if (parsed.kind === 'fixed') {
    switch (parsed.path) {
      case 'FinalRequestProcessing.script': {
        const node = asRecord(ownProperty(spreset, 'FinalRequestProcessing'));
        if (!node || typeof ownProperty(node, 'script') !== 'string') {
          throw new Error(`脚本路径不存在：${scriptPath}`);
        }
        nextSpreset = { ...spreset, FinalRequestProcessing: { ...node, script: text } };
        break;
      }
      case 'OutputPreprocessing.script': {
        const node = asRecord(ownProperty(spreset, 'OutputPreprocessing'));
        if (!node || typeof ownProperty(node, 'script') !== 'string') {
          throw new Error(`脚本路径不存在：${scriptPath}`);
        }
        nextSpreset = { ...spreset, OutputPreprocessing: { ...node, script: text } };
        break;
      }
      case 'OutputPreprocessing.toolCallFormatter.script': {
        const output = asRecord(ownProperty(spreset, 'OutputPreprocessing'));
        const node = output ? asRecord(ownProperty(output, 'toolCallFormatter')) : null;
        if (!output || !node || typeof ownProperty(node, 'script') !== 'string') {
          throw new Error(`脚本路径不存在：${scriptPath}`);
        }
        nextSpreset = {
          ...spreset,
          OutputPreprocessing: { ...output, toolCallFormatter: { ...node, script: text } },
        };
        break;
      }
      case 'ChatSquash.squashed_post_script': {
        const node = asRecord(ownProperty(spreset, 'ChatSquash'));
        if (!node || typeof ownProperty(node, 'squashed_post_script') !== 'string') {
          throw new Error(`脚本路径不存在：${scriptPath}`);
        }
        nextSpreset = { ...spreset, ChatSquash: { ...node, squashed_post_script: text } };
        break;
      }
    }
  } else {
    const toolBindings = asRecord(ownProperty(spreset, 'ToolBindings'));
    const binding = toolBindings ? asRecord(ownProperty(toolBindings, parsed.key)) : null;
    if (!toolBindings || !binding || typeof ownProperty(binding, 'code') !== 'string') {
      throw new Error(`脚本路径不存在：${scriptPath}`);
    }
    // 用 Object.fromEntries 保持原有键顺序且避免特殊键名触发原型 setter
    const nextToolBindings = Object.fromEntries(
      Object.entries(toolBindings).map(([k, v]) => [k, k === parsed.key ? { ...binding, code: text } : v]),
    );
    nextSpreset = { ...spreset, ToolBindings: nextToolBindings };
  }

  return { ...extensions, SPreset: nextSpreset };
}

function findLiteralOccurrences(haystack: string, needle: string): { count: number; firstIndex: number } {
  let count = 0;
  let firstIndex = -1;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    if (firstIndex === -1) firstIndex = idx;
    count += 1;
    // 步进 1，重叠出现也算多次
    from = idx + 1;
  }
  return { count, firstIndex };
}

/**
 * 顺序定位替换：每处 old_text 按字面量在当前文本中必须恰好出现一次（含重叠计数）。
 * 使用 slice 拼接，避免 String.prototype.replace 对 new_text 中 $& / $1 等符号的特殊展开。
 */
export function applyTextEdits(
  text: string,
  edits: readonly PresetTextEdit[],
): { ok: true; text: string } | { ok: false; error: string } {
  if (edits.length === 0) {
    return { ok: false, error: 'edits 不能为空' };
  }
  let current = text;
  for (let index = 0; index < edits.length; index += 1) {
    const { old_text: oldText, new_text: newText } = edits[index];
    if (oldText.length === 0) {
      return { ok: false, error: `第 ${index + 1} 处替换的 old_text 不能为空` };
    }
    const { count, firstIndex } = findLiteralOccurrences(current, oldText);
    if (count === 0) {
      return {
        ok: false,
        error: `第 ${index + 1} 处替换未找到匹配（找到 0 次）：请逐字复制原文，不要改写空格或换行，或核对前几处替换后的文本`,
      };
    }
    if (count > 1) {
      return {
        ok: false,
        error: `第 ${index + 1} 处替换找到 ${count} 次，不唯一：请多带一点前后上下文让 old_text 只出现一次`,
      };
    }
    current = current.slice(0, firstIndex) + newText + current.slice(firstIndex + oldText.length);
  }
  if (current === text) {
    return { ok: false, error: '替换后的文本与原文完全相同，没有实际改动' };
  }
  return { ok: true, text: current };
}

// --------- 数据库访问（显式传入 db）---------

export type ResolvedPresetId =
  | { ok: true; id: string }
  | { ok: false; error: string };

/** 预设 ID 精确或唯一前缀（至少 8 位）解析；有歧义时列出候选。 */
export function resolvePresetId(db: Database.Database, rawId: string): ResolvedPresetId {
  if (db.prepare('SELECT 1 FROM prompt_presets WHERE id = ?').get(rawId)) {
    return { ok: true, id: rawId };
  }
  if (rawId.length >= MIN_PRESET_ID_PREFIX) {
    const matches = (db.prepare(
      'SELECT id FROM prompt_presets WHERE substr(id, 1, ?) = ? ORDER BY id LIMIT ?',
    ).all(rawId.length, rawId, MAX_ID_CANDIDATES + 1) as Array<{ id: string }>).map(row => row.id);
    if (matches.length === 1) return { ok: true, id: matches[0] };
    if (matches.length > 1) {
      const shown = matches.slice(0, MAX_ID_CANDIDATES).join('、');
      return {
        ok: false,
        error: `预设 ID ${rawId} 对应多条：${shown}${matches.length > MAX_ID_CANDIDATES ? ' 等' : ''}，请写完整 ID`,
      };
    }
  }
  return { ok: false, error: `预设不存在：${rawId}` };
}

/** 预设内条目 ID 精确或唯一前缀（至少 8 位）解析；有歧义时列出候选。 */
export function resolvePresetEntryId(db: Database.Database, presetId: string, rawId: string): ResolvedPresetId {
  if (db.prepare('SELECT 1 FROM prompt_preset_entries WHERE preset_id = ? AND id = ?').get(presetId, rawId)) {
    return { ok: true, id: rawId };
  }
  if (rawId.length >= MIN_PRESET_ID_PREFIX) {
    const matches = (db.prepare(
      'SELECT id FROM prompt_preset_entries WHERE preset_id = ? AND substr(id, 1, ?) = ? ORDER BY id LIMIT ?',
    ).all(presetId, rawId.length, rawId, MAX_ID_CANDIDATES + 1) as Array<{ id: string }>).map(row => row.id);
    if (matches.length === 1) return { ok: true, id: matches[0] };
    if (matches.length > 1) {
      const shown = matches.slice(0, MAX_ID_CANDIDATES).join('、');
      return {
        ok: false,
        error: `条目 ID ${rawId} 对应多条：${shown}${matches.length > MAX_ID_CANDIDATES ? ' 等' : ''}，请写完整 ID`,
      };
    }
  }
  return { ok: false, error: `条目 ${rawId} 不存在或不属于预设 ${presetId}` };
}

function rowToPresetRecord(row: Record<string, unknown>): PresetRecord {
  let stripTags: string[] = [];
  const parsedStripTags = parseStoredJson(row.strip_tags);
  if (parsedStripTags !== undefined) {
    const validated = stripTagRulesSchema.safeParse(parsedStripTags);
    if (validated.success) stripTags = validated.data;
  }
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : '',
    is_built_in: Number(row.is_built_in) === 1,
    story_plot_strip: Number(row.story_plot_strip) === 1,
    strip_tags: stripTags,
    import_warnings: presetImportWarningsSchema.safeParse(parseStoredJson(row.import_warnings)).data ?? [],
    extensions: asRecord(parseStoredJson(row.extensions)) ?? {},
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToEntryRecord(row: Record<string, unknown>): PresetEntryRecord {
  const role = row.role === 'user' || row.role === 'assistant' ? row.role : 'system';
  return {
    id: String(row.id),
    preset_id: String(row.preset_id),
    name: String(row.name),
    role,
    content: typeof row.content === 'string' ? row.content : '',
    is_marker: Number(row.is_marker) === 1,
    marker_key: typeof row.marker_key === 'string' ? row.marker_key as PresetMarkerKey : null,
    injection_position: Number(row.injection_position) === 1 ? 1 : 0,
    injection_depth: Number(row.injection_depth ?? 4),
    injection_order: Number(row.injection_order ?? 100),
    enabled: Number(row.enabled) === 1,
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function listPresetRecords(db: Database.Database): PresetListItem[] {
  const rows = db.prepare(`
    SELECT
      p.id, p.name, p.description, p.is_built_in, p.story_plot_strip,
      p.strip_tags, p.import_warnings, p.extensions, p.created_at, p.updated_at,
      (SELECT COUNT(*) FROM prompt_preset_entries e WHERE e.preset_id = p.id) AS entry_count,
      (SELECT COUNT(*) FROM prompt_preset_entries e WHERE e.preset_id = p.id AND e.enabled = 1) AS enabled_count
    FROM prompt_presets p
    ORDER BY p.created_at ASC, p.id ASC
  `).all() as Array<Record<string, unknown>>;

  const bindingsByPreset = new Map<string, PresetBoundCharacter[]>();
  const addBinding = (presetId: string, binding: PresetBoundCharacter) => {
    const list = bindingsByPreset.get(presetId);
    if (list) list.push(binding);
    else bindingsByPreset.set(presetId, [binding]);
  };

  const defaultRows = db.prepare(`
    SELECT id, name, active_preset_id
    FROM characters
    WHERE active_preset_id IS NOT NULL AND active_preset_id != '' AND active_preset_id != ?
    ORDER BY sort_order ASC, id ASC
  `).all(PRESET_ID_NONE) as Array<{ id: string; name: string; active_preset_id: string }>;
  for (const row of defaultRows) {
    addBinding(row.active_preset_id, { id: row.id, name: row.name, via: 'default' });
  }

  const modelRows = db.prepare(`
    SELECT b.character_id AS id, c.name, b.model, b.preset_id
    FROM character_model_preset_bindings b
    JOIN characters c ON c.id = b.character_id
    WHERE b.preset_id != ?
    ORDER BY c.sort_order ASC, c.id ASC, b.sort_order ASC, b.model ASC
  `).all(PRESET_ID_NONE) as Array<{ id: string; name: string; model: string; preset_id: string }>;
  for (const row of modelRows) {
    addBinding(row.preset_id, { id: row.id, name: row.name, via: 'model', model: row.model });
  }

  return rows.map(row => {
    const preset = rowToPresetRecord(row);
    return {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      story_plot_strip: preset.story_plot_strip,
      strip_tags: preset.strip_tags,
      updated_at: preset.updated_at,
      entry_count: Number(row.entry_count ?? 0),
      enabled_count: Number(row.enabled_count ?? 0),
      spreset_runtime: hasSpresetRuntime(parseSpresetConfig(preset.extensions)),
      bound_characters: bindingsByPreset.get(preset.id) ?? [],
    };
  });
}

export function loadPresetRecord(db: Database.Database, presetId: string): PresetRecord | null {
  const row = db.prepare(`
    SELECT id, name, description, is_built_in, story_plot_strip,
      strip_tags, import_warnings, extensions, created_at, updated_at
    FROM prompt_presets WHERE id = ?
  `).get(presetId) as Record<string, unknown> | undefined;
  return row ? rowToPresetRecord(row) : null;
}

export function listPresetEntries(db: Database.Database, presetId: string): PresetEntryRecord[] {
  const rows = db.prepare(`
    SELECT id, preset_id, name, role, content, is_marker, marker_key,
      injection_position, injection_depth, injection_order, enabled, sort_order, created_at, updated_at
    FROM prompt_preset_entries
    WHERE preset_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(presetId) as Array<Record<string, unknown>>;
  return rows.map(rowToEntryRecord);
}

export function loadPresetEntryRecord(
  db: Database.Database,
  presetId: string,
  entryId: string,
): PresetEntryRecord | null {
  const row = db.prepare(`
    SELECT id, preset_id, name, role, content, is_marker, marker_key,
      injection_position, injection_depth, injection_order, enabled, sort_order, created_at, updated_at
    FROM prompt_preset_entries
    WHERE id = ? AND preset_id = ?
  `).get(entryId, presetId) as Record<string, unknown> | undefined;
  return row ? rowToEntryRecord(row) : null;
}

export function toPresetEntrySnapshot(entry: PresetEntryRecord): PresetEntrySnapshot {
  return {
    id: entry.id,
    name: entry.name,
    enabled: entry.enabled,
    content: entry.content,
    is_marker: entry.is_marker,
  };
}

/** 只更新有变化的条目列，并同步推进条目与预设的 updated_at。 */
export function updatePresetEntryFields(
  db: Database.Database,
  presetId: string,
  entryId: string,
  patch: { name?: string; enabled?: boolean; content?: string },
  now: string,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); values.push(patch.enabled ? 1 : 0); }
  if (patch.content !== undefined) { sets.push('content = ?'); values.push(patch.content); }
  if (sets.length === 0) throw new Error('预设条目没有可更新的字段');
  sets.push('updated_at = ?');
  values.push(now, entryId, presetId);
  const entryChanges = db.prepare(
    `UPDATE prompt_preset_entries SET ${sets.join(', ')} WHERE id = ? AND preset_id = ?`,
  ).run(...values).changes;
  if (entryChanges !== 1) throw new Error(`更新预设条目 ${entryId} 失败`);
  const presetChanges = db.prepare('UPDATE prompt_presets SET updated_at = ? WHERE id = ?').run(now, presetId).changes;
  if (presetChanges !== 1) throw new Error(`更新预设 ${presetId} 时间戳失败`);
}

/** 只更新有变化的剥离设置列，写入前校验 strip_tags，并推进预设 updated_at。 */
export function updatePresetSettings(
  db: Database.Database,
  presetId: string,
  patch: { story_plot_strip?: boolean; strip_tags?: string[] },
  now: string,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.story_plot_strip !== undefined) {
    sets.push('story_plot_strip = ?');
    values.push(patch.story_plot_strip ? 1 : 0);
  }
  if (patch.strip_tags !== undefined) {
    const validated = stripTagRulesSchema.safeParse(patch.strip_tags);
    if (!validated.success) {
      throw new Error(`strip_tags 不合法：${validated.error.issues.map(issue => issue.message).join('；')}`);
    }
    sets.push('strip_tags = ?');
    values.push(JSON.stringify(validated.data));
  }
  if (sets.length === 0) throw new Error('预设剥离设置没有可更新的字段');
  sets.push('updated_at = ?');
  values.push(now, presetId);
  const changes = db.prepare(`UPDATE prompt_presets SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes;
  if (changes !== 1) throw new Error(`更新预设 ${presetId} 剥离设置失败`);
}

/** 写回整个 extensions JSON，并推进预设 updated_at。 */
export function updatePresetExtensions(
  db: Database.Database,
  presetId: string,
  extensions: Record<string, unknown>,
  now: string,
): void {
  const changes = db.prepare('UPDATE prompt_presets SET extensions = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(extensions), now, presetId).changes;
  if (changes !== 1) throw new Error(`更新预设 ${presetId} extensions 失败`);
}
