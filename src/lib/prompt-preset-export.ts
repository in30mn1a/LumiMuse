/**
 * 预设导出：
 *   - LumiMuse native format（full round-trip）
 *   - SillyTavern-compatible format（可重新导入到酒馆或他人）
 */

import { listEntries, getPreset } from '@/lib/prompt-presets';
import { PresetEntry, PromptPreset } from '@/types';

/** LumiMuse native：完整保真（含 enabled/sort_order/story_plot_strip/MarkerKey/is_marker） */
export interface LumiMusePresetExport {
  version: 1;
  format: 'lumimuse-prompt-preset';
  preset: {
    name: string;
    description: string;
    story_plot_strip: boolean;
  };
  entries: Array<{
    name: string;
    role: 'system' | 'user' | 'assistant';
    content: string;
    is_marker: boolean;
    marker_key: string | null;
    is_system_prompt: boolean;
    injection_position: 0 | 1;
    injection_depth: number;
    injection_order: number;
    forbid_overrides: boolean;
    enabled: boolean;
    sort_order: number;
  }>;
}

export function buildLumiMusePresetExport(presetId: string): LumiMusePresetExport | null {
  const preset = getPreset(presetId);
  if (!preset) return null;
  const entries = listEntries(presetId);
  return {
    version: 1,
    format: 'lumimuse-prompt-preset',
    preset: {
      name: preset.name,
      description: preset.description,
      story_plot_strip: preset.story_plot_strip,
    },
    entries: entries.map(e => ({
      name: e.name,
      role: e.role,
      content: e.content,
      is_marker: e.is_marker,
      marker_key: e.marker_key,
      is_system_prompt: e.is_system_prompt,
      injection_position: e.injection_position,
      injection_depth: e.injection_depth,
      injection_order: e.injection_order,
      forbid_overrides: e.forbid_overrides,
      enabled: e.enabled,
      sort_order: e.sort_order,
    })),
  };
}

/**
 * SillyTavern 兼容：模拟酒馆 preset export。
 *   - prompts: 仅非 marker 文本条目（酒馆 export 也不带内建 marker）
 *   - prompt_order: 包含全部条目（含 marker identifier 占位），entry.enabled 与 prompt.enabled 同步
 *
 * 与我们的 schema 差异：
 *   - prompts[].system_prompt / role / content / injection_position / injection_depth / injection_order 保留
 *   - 内建 marker identifier 作为占位（charDescription 等）出现在 order 中
 *   - 我们额外把 story_plot_strip 写到顶层 `lumimuse_story_plot_strip` 字段（酒馆导入时忽略）
 */
export interface StPresetExportPrompt {
  identifier: string;
  name: string;
  system_prompt: boolean;
  role: 'system' | 'user' | 'assistant';
  content: string;
  injection_position: number;
  injection_depth: number;
  injection_order: number;
  forbid_overrides: boolean;
  injection_trigger: string[];
  enabled: boolean;
  marker: boolean;
}

export interface StPresetExport {
  prompts: StPresetExportPrompt[];
  prompt_order: Array<{
    character_id: number;
    order: Array<{ identifier: string; enabled: boolean }>;
  }>;
  lumimuse_story_plot_strip?: boolean;
}

export function buildSillyTavernPresetExport(presetId: string): StPresetExport | null {
  const preset = getPreset(presetId);
  if (!preset) return null;
  const entries = listEntries(presetId);

  const prompts: StPresetExportPrompt[] = [];
  const order: Array<{ identifier: string; enabled: boolean }> = [];

  for (const e of entries) {
    // 用 entry.id 作为 identifier；marker 用 marker_key 作为标识符以匹配酒馆内建 marker 集
    const identifier = e.is_marker && e.marker_key ? e.marker_key : e.id;

    // 酒馆 export 不包含 marker 的内容（内容来自动态替换）
    const content = e.content;

    prompts.push({
      identifier,
      name: e.name,
      system_prompt: e.is_system_prompt,
      role: e.role,
      content,
      injection_position: e.injection_position,
      injection_depth: e.injection_depth,
      injection_order: e.injection_order,
      forbid_overrides: e.forbid_overrides,
      injection_trigger: [],
      enabled: e.enabled,
      marker: e.is_marker,
    });
    order.push({ identifier, enabled: e.enabled });
  }

  return {
    prompts,
    prompt_order: [{ character_id: 100001, order }],
    lumimuse_story_plot_strip: preset.story_plot_strip,
  };
}
