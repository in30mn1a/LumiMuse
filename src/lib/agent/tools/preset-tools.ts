import { z } from 'zod';
import {
  getPresetScript,
  isWhitelistedScriptPath,
  listPresetEntries,
  listPresetRecords,
  listPresetScripts,
  loadPresetEntryRecord,
  loadPresetRecord,
  resolvePresetEntryId,
  resolvePresetId,
} from '@/lib/agent/preset-edit';
import { defineReadTool } from './types';
import { runReadTool } from './shared';

const DEFAULT_READ_LIMIT = 20_000;
const MAX_READ_LIMIT = 40_000;
const PREVIEW_LENGTH = 120;
const MAX_FIND_MATCHES = 20;
const FIND_CONTEXT_RADIUS = 300;

export const listPresetsTool = defineReadTool({
  name: 'list_presets',
  description: '列出全部提示词预设：ID、名称、说明、标签剥离配置、条目总数与启用数、是否含 SPreset 运行时以及绑定的角色（默认绑定或按模型绑定）。',
  schema: z.object({}),
  execute: (_args, ctx) => runReadTool(ctx, () => ({
    ok: true,
    presets: listPresetRecords(ctx.db),
  })),
});

export const getPresetTool = defineReadTool({
  name: 'get_preset',
  description: '查看一个预设的概览：基本信息、剥离设置、按顺序排列的条目列表（含开关、角色、位置、长度和前 120 字预览）以及存在的 SPreset 运行时脚本列表（路径、显示名、启用状态、长度）。不返回正文或脚本全文，读全文或搜索请用 read_preset_text。preset_id 支持至少 8 位的唯一前缀。',
  schema: z.object({
    preset_id: z.string().min(1).describe('预设 ID，支持至少 8 位的唯一前缀'),
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const resolved = resolvePresetId(ctx.db, args.preset_id);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const preset = loadPresetRecord(ctx.db, resolved.id);
    if (!preset) return { ok: false, error: `预设不存在：${resolved.id}` };

    const entries = listPresetEntries(ctx.db, preset.id).map(entry => ({
      id: entry.id,
      name: entry.name,
      role: entry.role,
      enabled: entry.enabled,
      is_marker: entry.is_marker,
      marker_key: entry.marker_key,
      injection_position: entry.injection_position,
      injection_depth: entry.injection_depth,
      injection_order: entry.injection_order,
      sort_order: entry.sort_order,
      length: entry.is_marker ? 0 : entry.content.length,
      preview: entry.is_marker ? '' : entry.content.slice(0, PREVIEW_LENGTH),
    }));

    const scripts = listPresetScripts(preset.extensions).map(script => ({
      path: script.path,
      label: script.label,
      enabled: script.enabled,
      length: script.content.length,
    }));

    return {
      ok: true,
      preset: {
        id: preset.id,
        name: preset.name,
        description: preset.description,
        story_plot_strip: preset.story_plot_strip,
        strip_tags: preset.strip_tags,
        import_warnings: preset.import_warnings,
        updated_at: preset.updated_at,
      },
      entries,
      scripts,
    };
  }),
});

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

export const readPresetTextTool = defineReadTool({
  name: 'read_preset_text',
  description: `分段读取或字面量搜索预设条目正文或 SPreset 运行时脚本。entry_id 与 script 必须且只能给一个（preset_id、entry_id 均支持至少 8 位的唯一前缀；占位标记 marker 条目没有正文，会返回错误）。
偏移量 offset 按 JS 字符串下标（UTF-16 码元，与 String.prototype.slice 一致）从 0 计。
- 不传 find：按 [offset, offset + limit) 分段读取，limit 默认 ${DEFAULT_READ_LIMIT}、最大 ${MAX_READ_LIMIT}；返回 next_offset 供翻页，读到末尾为 null。
- 传 find（字面量，非正则）：搜索匹配位置，最多返回 ${MAX_FIND_MATCHES} 条（含 offset、1 起行号 line 与前后各约 ${FIND_CONTEXT_RADIUS} 字符 context），超出时 truncated 为 true。此时 offset / limit 限定搜索区间，省略则搜全文。`,
  schema: z.object({
    preset_id: z.string().min(1).describe('预设 ID，支持至少 8 位的唯一前缀'),
    entry_id: z.string().min(1).optional().describe('要读取的条目 ID（支持至少 8 位唯一前缀）；与 script 二选一'),
    script: z.string().min(1).optional().describe('要读取的 SPreset 脚本白名单路径（见 get_preset 返回的 scripts）；与 entry_id 二选一'),
    offset: z.number().int().min(0).optional().describe('起始偏移量（按 JS 字符串下标 / UTF-16 码元计，从 0 起，默认 0）'),
    limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional()
      .describe(`读取模式下默认 ${DEFAULT_READ_LIMIT}、最大 ${MAX_READ_LIMIT}；配合 find 时限定从 offset 起的搜索区间长度，省略则搜到末尾`),
    find: z.string().min(1).optional().describe('字面量搜索词（非正则）；提供时返回命中位置、行号与上下文'),
  }),
  execute: (args, ctx) => runReadTool(ctx, () => {
    const hasEntry = args.entry_id !== undefined;
    const hasScript = args.script !== undefined;
    if (hasEntry === hasScript) {
      return { ok: false, error: 'entry_id 和 script 必须且只能提供一个' };
    }

    const resolvedPreset = resolvePresetId(ctx.db, args.preset_id);
    if (!resolvedPreset.ok) return { ok: false, error: resolvedPreset.error };
    const preset = loadPresetRecord(ctx.db, resolvedPreset.id);
    if (!preset) return { ok: false, error: `预设不存在：${resolvedPreset.id}` };

    let target:
      | { kind: 'entry'; id: string; name: string }
      | { kind: 'script'; path: string; label: string };
    let content: string;

    if (hasEntry) {
      const resolvedEntry = resolvePresetEntryId(ctx.db, preset.id, args.entry_id!);
      if (!resolvedEntry.ok) return { ok: false, error: resolvedEntry.error };
      const entry = loadPresetEntryRecord(ctx.db, preset.id, resolvedEntry.id);
      if (!entry) return { ok: false, error: `条目不存在：${resolvedEntry.id}` };
      if (entry.is_marker) {
        return { ok: false, error: `条目「${entry.name}」（${entry.id}）是占位标记（marker），没有正文` };
      }
      target = { kind: 'entry', id: entry.id, name: entry.name };
      content = entry.content;
    } else {
      if (!isWhitelistedScriptPath(args.script!)) {
        return { ok: false, error: `脚本路径不在白名单内：${args.script}` };
      }
      const scriptInfo = getPresetScript(preset.extensions, args.script!);
      if (!scriptInfo) {
        return { ok: false, error: `预设「${preset.name}」不存在脚本路径：${args.script}` };
      }
      target = { kind: 'script', path: scriptInfo.path, label: scriptInfo.label };
      content = scriptInfo.content;
    }

    const totalLength = content.length;
    const offset = args.offset ?? 0;

    if (args.find === undefined) {
      const limit = args.limit ?? DEFAULT_READ_LIMIT;
      const end = Math.min(offset + limit, totalLength);
      const text = content.slice(offset, end);
      return {
        ok: true,
        target,
        total_length: totalLength,
        offset,
        text,
        next_offset: end < totalLength ? end : null,
      };
    }

    const needle = args.find;
    const rangeStart = Math.min(offset, totalLength);
    const rangeEnd = args.limit === undefined ? totalLength : Math.min(offset + args.limit, totalLength);
    const matches: Array<{ offset: number; line: number; context: string }> = [];
    let truncated = false;
    let line = 1;
    let lineCursor = 0;
    let searchFrom = rangeStart;

    while (searchFrom <= rangeEnd - needle.length) {
      const idx = content.indexOf(needle, searchFrom);
      if (idx === -1 || idx + needle.length > rangeEnd) break;
      if (matches.length >= MAX_FIND_MATCHES) {
        truncated = true;
        break;
      }
      line += countNewlines(content, lineCursor, idx);
      lineCursor = idx;
      const ctxStart = Math.max(0, idx - FIND_CONTEXT_RADIUS);
      const ctxEnd = Math.min(totalLength, idx + needle.length + FIND_CONTEXT_RADIUS);
      matches.push({ offset: idx, line, context: content.slice(ctxStart, ctxEnd) });
      searchFrom = idx + needle.length;
    }

    return {
      ok: true,
      target,
      total_length: totalLength,
      matches,
      truncated,
    };
  }),
});
