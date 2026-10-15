/**
 * SillyTavern preset JSON 一键导入。
 *
 * 标准 prompts/order 与官方 Prompt Manager 导出统一校验后导入。
 * 仅导入提示词相关设置；预设参数不导入，扩展配置不执行，并以兼容说明报告。
 *
 * 映射规则：
 *   - 条目 identifier 是 uuid → 普通文本条目（is_marker=false）
 *   - identifier 是酒馆内建 marker（如 'charDescription'）：
 *       * charDescription/charPersonality/scenario/dialogueExamples/chatHistory → 6 条核心 marker
 *       * 其余 marker 条目（worldInfoBefore/After、personaDescription、agentTask 等）→ 墓碑
 *         （is_marker=false, content='', enabled=false, name 保留）
 *   - marker 判据取条目自带的 `marker` 字段：酒馆的 marker 是无正文占位符，而 main/nsfw/
 *     jailbreak/enhanceDefinitions 是**有正文的普通内建条目**，按普通文本条目导入
 *   - prompt_order.entry.enabled 优先于 prompt.enabled（Q2 单层：合并到 entries.enabled）
 *   - 有排序时未列入的 prompt 追加并禁用；无排序配置时按 prompts 顺序和 enabled 导入
 *   - 排序引用省略的核心动态 marker 时重建空占位，其他悬空引用报告后剔除
 *   - injection_trigger 保留，仅 normal/regenerate 场景可实际执行
 *   - sort_order = order 数组下标 * 10
 *
 * 事务包裹：preset + entries 一次性入库；任何一步失败回滚。
 */

import * as crypto from 'crypto';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import {
  presetImportWarningsSchema,
  presetInjectionTriggerSchema,
  stripTagRulesSchema,
} from '@/lib/schemas';
import { findUnsupportedStMacros } from '@/lib/st-macros';
import { PresetImportReport, PresetMarkerKey } from '@/types';

/** 酒馆内建 marker → LumiMuse 6 条核心 marker 的映射（Q3）。 */
const CORE_MARKER_MAP: Record<string, PresetMarkerKey> = {
  charDescription: 'charDescription',
  charPersonality: 'charPersonality',
  scenario: 'scenario',
  dialogueExamples: 'dialogueExamples',
  chatHistory: 'chatHistory',
  // LumiMuse 特有；纳入映射以保证 SillyTavern 兼容格式导出后仍能回导。
  memoryPackage: 'memoryPackage',
};

interface RawPrompt {
  identifier: string;
  name?: string;
  enabled?: boolean;
  role?: string;
  content?: string;
  marker?: boolean;
  system_prompt?: boolean;
  position?: unknown;
  injection_position?: number;
  injection_depth?: number;
  injection_order?: number;
  forbid_overrides?: boolean;
  injection_trigger?: string[];
}

interface RawOrderEntry {
  identifier: string;
  enabled?: boolean;
}

interface RawOrderBlock {
  character_id: number;
  order: RawOrderEntry[];
}

interface RawLumiMusePreset {
  version: 1;
  format: 'lumimuse-prompt-preset';
  preset: {
    name: string;
    description: string;
    story_plot_strip: boolean;
    strip_tags?: string[];
    import_warnings: string[];
  };
  entries: RawLumiMusePresetEntry[];
}

interface RawLumiMusePresetEntry {
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  is_marker: boolean;
  marker_key: PresetMarkerKey | null;
  is_system_prompt: boolean;
  injection_position: 0 | 1;
  injection_depth: number;
  injection_order: number;
  forbid_overrides: boolean;
  injection_trigger: string[];
  enabled: boolean;
  sort_order: number;
}

/** 解析 role 字符串到 LumiMuse schema 三值；不识别时默认 user（酒馆原生条目米田多数是 user）。 */
function normalizeRole(raw: unknown): 'system' | 'user' | 'assistant' {
  if (raw === 'system' || raw === 'user' || raw === 'assistant') return raw;
  return 'user';
}

/** 严格兜底数字字段：缺省/非有限值回退 default。 */
function normalizeInteger(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
}

/** injection_depth 无业务上限，但必须是非负整数。 */
function normalizeInjectionDepth(raw: unknown, fallback: number): number {
  const n = normalizeInteger(raw, fallback);
  return n >= 0 ? n : fallback;
}

function isPresetMarkerKey(raw: unknown): raw is PresetMarkerKey {
  return typeof raw === 'string' && Object.hasOwn(CORE_MARKER_MAP, raw);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const identifierSchema = z.string().refine(value => value.trim().length > 0, 'identifier 不能为空');
const stPromptSchema = z.looseObject({
  identifier: identifierSchema,
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  role: z.enum(['system', 'user', 'assistant']).optional(),
  content: z.string().optional(),
  marker: z.boolean().optional(),
  system_prompt: z.boolean().optional(),
  injection_position: z.union([z.literal(0), z.literal(1)]).optional(),
  injection_depth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  injection_order: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  forbid_overrides: z.boolean().optional(),
  injection_trigger: presetInjectionTriggerSchema.optional(),
});
const stOrderEntrySchema = z.object({ identifier: identifierSchema, enabled: z.boolean().optional() });

function validateImportField<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`导入失败：${field} 无效 - ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  }
  return parsed.data;
}

function assertUniqueIdentifiers(values: Array<{ identifier: string }>, field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.identifier)) throw new Error(`导入失败：${field} identifier 重复：${value.identifier}`);
    seen.add(value.identifier);
  }
}

function parseStOrder(data: Record<string, unknown>, directEmpty: boolean, warnings: Set<string>): RawOrderEntry[] | null {
  if (data.prompt_order == null) return null;
  if (!Array.isArray(data.prompt_order)) throw new Error('导入失败：prompt_order 必须是数组');
  if (data.prompt_order.length === 0) return directEmpty ? [] : null;
  const first = asRecord(data.prompt_order[0]);
  if (first && Object.hasOwn(first, 'identifier')) {
    const entries = validateImportField(z.array(stOrderEntrySchema), data.prompt_order, 'prompt_order');
    assertUniqueIdentifiers(entries, 'prompt_order');
    return entries;
  }
  const blocks: RawOrderBlock[] = [];
  const seen = new Set<string>();
  for (const [index, value] of data.prompt_order.entries()) {
    const block = asRecord(value);
    if (!block || (typeof block.character_id !== 'number' && typeof block.character_id !== 'string')
      || (typeof block.character_id === 'number' && !Number.isSafeInteger(block.character_id))
      || (typeof block.character_id === 'string' && !/^\d+$/.test(block.character_id))) {
      throw new Error(`导入失败：prompt_order[${index}] 排序组无效`);
    }
    const characterId = Number(block.character_id);
    if (!Number.isSafeInteger(characterId) || seen.has(String(characterId))) {
      throw new Error(`导入失败：prompt_order character_id 无效或重复：${String(block.character_id)}`);
    }
    seen.add(String(characterId));
    const order = validateImportField(z.array(stOrderEntrySchema), block.order, `prompt_order[${index}].order`);
    assertUniqueIdentifiers(order, `prompt_order[${index}].order`);
    blocks.push({ character_id: characterId, order });
  }
  const chosen = blocks.find(block => block.character_id === 100001)
    ?? blocks.find(block => block.order.length > 0) ?? blocks[0];
  if (chosen.character_id !== 100001) {
    warnings.add(`没有 character_id=100001 排序组，已回退到 character_id=${chosen.character_id}。`);
  }
  return chosen.order;
}

const ST_IGNORED_PARAMETER_KEYS = [
  'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty',
  'repetition_penalty', 'seed', 'reasoning_effort', 'openai_max_tokens', 'stream_openai',
  'sampling_params', 'max_tokens', 'streaming', 'openai_max_context', 'context_window',
  'top_a', 'min_p', 'typical_p', 'tfs', 'epsilon_cutoff', 'eta_cutoff',
  'mirostat', 'mirostat_tau', 'mirostat_eta', 'n',
] as const;

function isActiveSetting(value: unknown): boolean {
  if (value == null || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  const object = asRecord(value);
  return object ? Object.keys(object).length > 0 : true;
}

function collectStWarnings(data: Record<string, unknown>, warnings: Set<string>): void {
  const handled = new Set<string>([
    'prompts', 'prompt_order', 'name', 'extensions', 'lumimuse_story_plot_strip',
    'lumimuse_import_warnings', ...ST_IGNORED_PARAMETER_KEYS,
  ]);
  if (ST_IGNORED_PARAMETER_KEYS.some(key => Object.hasOwn(data, key))) {
    warnings.add('预设参数不导入，聊天沿用 LumiMuse 自身设置。');
  }
  for (const [key, value] of Object.entries(data)) {
    if (!handled.has(key) && isActiveSetting(value)) {
      warnings.add(`未支持的预设字段 ${key} 未应用；不改变 LumiMuse 全局、上下文或后台设置。`);
    }
  }
  if (isActiveSetting(data.extensions)) {
    warnings.add('检测到第三方插件配置；不执行脚本、正则、界面、历史处理或工具绑定。原提示词正文保持不变。');
    const spreset = asRecord(asRecord(data.extensions)?.SPreset);
    const bindings = spreset?.ToolBindings;
    const tools = Array.isArray(bindings) ? bindings : Object.values(asRecord(bindings) ?? {});
    for (const value of tools) {
      const tool = asRecord(value);
      if (!tool || tool.enabled === false) continue;
      const name = typeof tool.resolvedName === 'string' ? tool.resolvedName
        : typeof tool.name === 'string' ? tool.name : '未命名工具';
      warnings.add(`预设依赖 SPreset.ToolBindings 工具 ${name}；LumiMuse 不发送或执行此插件工具，要求调用它的正文可能无法正常产生聊天回复。`);
    }
  }
}

function parseLumiMusePreset(data: Record<string, unknown>): RawLumiMusePreset | null {
  if (data.format !== 'lumimuse-prompt-preset') return null;
  const preset = asRecord(data.preset);
  if (data.version !== 1 || !preset || !Array.isArray(data.entries)) {
    throw new Error('导入失败：LumiMuse 预设结构无效');
  }
  if (
    typeof preset.name !== 'string'
    || typeof preset.description !== 'string'
    || typeof preset.story_plot_strip !== 'boolean'
  ) {
    throw new Error('导入失败：LumiMuse 预设元数据不完整');
  }

  const entries = data.entries.map((value, index) => {
    const entry = asRecord(value);
    if (!entry) {
      throw new Error(`导入失败：LumiMuse 条目 ${index + 1} 必须是对象`);
    }
    if (
      typeof entry.name !== 'string'
      || (entry.role !== 'system' && entry.role !== 'user' && entry.role !== 'assistant')
      || typeof entry.content !== 'string'
      || typeof entry.is_marker !== 'boolean'
      || typeof entry.is_system_prompt !== 'boolean'
      || (entry.injection_position !== 0 && entry.injection_position !== 1)
      || typeof entry.injection_depth !== 'number'
      || !Number.isSafeInteger(entry.injection_depth)
      || entry.injection_depth < 0
      || typeof entry.injection_order !== 'number'
      || !Number.isSafeInteger(entry.injection_order)
      || typeof entry.forbid_overrides !== 'boolean'
      || typeof entry.enabled !== 'boolean'
      || typeof entry.sort_order !== 'number'
      || !Number.isSafeInteger(entry.sort_order)
    ) {
      throw new Error(`导入失败：LumiMuse 条目 ${index + 1} 字段无效`);
    }

    const markerKey = entry.marker_key;
    if (
      (entry.is_marker && !isPresetMarkerKey(markerKey))
      || (!entry.is_marker && markerKey !== null)
    ) {
      throw new Error(`导入失败：LumiMuse 条目 ${index + 1} marker 状态不一致`);
    }

    return {
      name: entry.name,
      role: entry.role as RawLumiMusePresetEntry['role'],
      content: entry.content,
      is_marker: entry.is_marker,
      marker_key: markerKey as PresetMarkerKey | null,
      is_system_prompt: entry.is_system_prompt,
      injection_position: entry.injection_position as 0 | 1,
      injection_depth: entry.injection_depth,
      injection_order: entry.injection_order,
      forbid_overrides: entry.forbid_overrides,
      injection_trigger: validateImportField(presetInjectionTriggerSchema,
        Object.hasOwn(entry, 'injection_trigger') ? entry.injection_trigger : [], `条目 ${index + 1} injection_trigger`),
      enabled: entry.enabled,
      sort_order: entry.sort_order,
    } satisfies RawLumiMusePresetEntry;
  });

  let stripTags: string[] | undefined;
  if (Object.hasOwn(preset, 'strip_tags')) {
    const validated = stripTagRulesSchema.safeParse(preset.strip_tags);
    if (!validated.success) {
      throw new Error(
        `导入失败：LumiMuse strip_tags 无效 - ${validated.error.issues.map(issue => issue.message).join('; ')}`,
      );
    }
    stripTags = validated.data;
  }

  return {
    version: 1,
    format: 'lumimuse-prompt-preset',
    preset: {
      name: preset.name,
      description: preset.description,
      story_plot_strip: preset.story_plot_strip,
      strip_tags: stripTags,
      import_warnings: validateImportField(presetImportWarningsSchema,
        Object.hasOwn(preset, 'import_warnings') ? preset.import_warnings : [], 'import_warnings'),
    },
    entries,
  };
}

/**
 * 导入酒馆 preset JSON。
 *
 * @param jsonText - 完整 JSON 字符串（不预先 parse，由本函数 parse 以保证错误信息一致）
 * @param opts - 可选项：presetName 显式指定（默认从 JSON.name 取，再退到 '导入预设'）
 */
export function importSillyTavernPreset(
  jsonText: string,
  opts: { presetName?: string } = {},
): PresetImportReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.replace(/^\uFEFF/, '')) as unknown;
  } catch (err) {
    throw new Error(`导入失败：JSON 解析失败 - ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsedRecord = asRecord(parsed);
  if (!parsedRecord) {
    throw new Error('导入失败：预设 JSON 顶层必须是对象');
  }
  const nativePreset = parseLumiMusePreset(parsedRecord);
  if (nativePreset) {
    return importLumiMusePreset(nativePreset, opts);
  }

  const wrapped = parsedRecord.version === 1
    && (parsedRecord.type === 'full' || parsedRecord.type === 'character');
  const data = wrapped ? asRecord(parsedRecord.data) : parsedRecord;
  if (!data) throw new Error('导入失败：Prompt Manager data 必须是对象');
  const rawPrompts: RawPrompt[] = validateImportField(z.array(stPromptSchema), data.prompts, 'prompts');
  assertUniqueIdentifiers(rawPrompts, 'prompts');
  if (Object.hasOwn(data, 'name') && typeof data.name !== 'string') {
    throw new Error('导入失败：name 必须是字符串');
  }
  const warnings = new Set(validateImportField(
    presetImportWarningsSchema,
    Object.hasOwn(data, 'lumimuse_import_warnings') ? data.lumimuse_import_warnings : [],
    'lumimuse_import_warnings',
  ));
  const selectedOrder = parseStOrder(data, wrapped, warnings);
  const rawOrders = selectedOrder ?? rawPrompts.map(prompt => ({
    identifier: prompt.identifier, enabled: prompt.enabled ?? true,
  }));
  collectStWarnings(data, warnings);

  for (const prompt of rawPrompts) {
    for (const trigger of prompt.injection_trigger ?? []) {
      if (trigger !== 'normal' && trigger !== 'regenerate') {
        warnings.add(`条目 ${prompt.name || prompt.identifier} 的生成场景 ${trigger} 已保留，但 LumiMuse 当前仅执行 normal/regenerate 场景。`);
      }
    }
  }

  const presetName = (opts.presetName && opts.presetName.trim())
    || (typeof data.name === 'string' && data.name.trim())
    || '导入预设';

  // 拿 db
  const db = getDb();
  const presetId = crypto.randomUUID();
  const now = new Date().toISOString();

  let total = 0;
  let enabledCount = 0;
  let markersRecognized = 0;
  let markersDisabled = 0;

  // 自动检测预设剥离协议 → 生成默认 strip_tags：
  //   - RONG：任一 content 含 <story_plot 或 {{setvar::rong_var_schema → story_plot_strip=1 + RONG tags
  //   - 可待：任一 content 同时出现 <content 与 (<thinking|think|output-template) → story_plot_strip=1 + 可待 tags
  // 两者都不命中 → story_plot_strip=0、strip_tags=[];
  // UI 可手工增删、往返格式（LumiMuse native export）亦可自定义（见 importLumiMusePreset）。
  //
  // 可待判据要求 tag 名后紧跟结束符（`>` / 空白 / `/`），避免 <content_policy>、<thinking_style>
  // 这类同前缀 tag 误命中：可待默认 tags 里的 #think / #thinking / #output-template 是 drop 规则，
  // 误判会连内容一起丢掉正文，代价远高于 block 规则误判（只多剥一层标签）。
  const allContents = rawPrompts.map(p => (typeof p?.content === 'string' ? p.content : '')).join('\n');
  const isRongProtocol = allContents.includes('<story_plot') || allContents.includes('setvar::rong_var_schema');
  const isKedaiProtocol = /<content[\s>/]/.test(allContents)
    && /<(?:thinking|think|output-template)[\s>/]/.test(allContents);

  const RONG_TAGS = [
    'story_plot',
    'story_scene',
    'story_body',
    'story_after_format',
    'story_done',
  ];
  // 可待预设实际输出：<scene>…地点…</scene> + <content>…正文…</content> + <think|thinking>…思考…</think|thinking> + <output-template>…</output-template>
  // scene/content 剥 tag 保内部；think/thinking（草稿）与 output-template（模板）成对丢整块。
  // think 与 thinking 在酒馆生态里常被混用，同时列出两种。
  const KEDAI_TAGS = ['content', 'scene', '#think', '#thinking', '#output-template'];

  const storyPlotStrip = isRongProtocol || isKedaiProtocol;
  const defaultStripTags = isRongProtocol ? RONG_TAGS : (isKedaiProtocol ? KEDAI_TAGS : []);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO prompt_presets (
        id, name, description, is_built_in, story_plot_strip,
        strip_tags, import_warnings, created_at, updated_at
      )
      VALUES (?, ?, '', 0, ?, ?, ?, ?, ?)
    `).run(presetId, presetName, storyPlotStrip ? 1 : 0, JSON.stringify(defaultStripTags), '[]', now, now);

    const insertEntry = db.prepare(`
      INSERT INTO prompt_preset_entries (
        id, preset_id, name, role, content, is_marker, marker_key,
        is_system_prompt, injection_position, injection_depth, injection_order,
        forbid_overrides, injection_trigger, enabled, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 预先建立 identifier → prompt 索引，避免 order × prompts 的二次扫描。
    const promptByIdentifier = new Map<string, RawPrompt>();
    for (const prompt of rawPrompts) {
      if (
        prompt
        && typeof prompt.identifier === 'string'
        && !promptByIdentifier.has(prompt.identifier)
      ) {
        promptByIdentifier.set(prompt.identifier, prompt);
      }
    }

    // 已处理 identifier 集合（含 order 未覆盖的部分，稍后追加）
    const handledIdentifiers = new Set<string>();

    // 先按 order 数组顺序处理：保证 sort_order 与酒馆 order 一致
    for (let orderIndex = 0; orderIndex < rawOrders.length; orderIndex += 1) {
      const o = rawOrders[orderIndex];
      if (!o || typeof o.identifier !== 'string') continue;
      const identifier = o.identifier;
      if (handledIdentifiers.has(identifier)) continue;

      let prompt = promptByIdentifier.get(identifier);
      if (!prompt && Object.hasOwn(CORE_MARKER_MAP, identifier)) {
        prompt = { identifier, name: identifier, marker: true, system_prompt: true, role: 'system' };
      }
      if (!prompt) {
        warnings.add(`排序引用 ${identifier} 没有对应提示词正文，已跳过；不会伪造缺失内容。`);
        continue;
      }

      handledIdentifiers.add(identifier);
      const sortOrder = orderIndex * 10;
      const entryEnabled = typeof o.enabled === 'boolean'
        ? o.enabled
        : (typeof prompt.enabled === 'boolean' ? prompt.enabled : true);

      insertOne({
        prompt,
        identifier,
        kind: 'order',
        entryEnabled,
        sortOrder,
      });
    }

    // 再追加 order 缺失的 prompts：酒馆不渲染未列入 order 的条目，故强制 disabled（条目保留，UI 可手动开）
    let appendIndex = rawOrders.length;
    for (const prompt of rawPrompts) {
      if (!prompt || typeof prompt.identifier !== 'string') continue;
      if (handledIdentifiers.has(prompt.identifier)) continue;
      handledIdentifiers.add(prompt.identifier);
      const sortOrder = appendIndex++ * 10;
      insertOne({
        prompt,
        identifier: prompt.identifier,
        kind: 'extra',
        entryEnabled: false,
        sortOrder,
      });
    }

    function insertOne(args: {
      prompt: RawPrompt;
      identifier: string;
      kind: 'order' | 'extra';
      entryEnabled: boolean;
      sortOrder: number;
    }): void {
      const { prompt, identifier, entryEnabled, sortOrder } = args;

      const isCoreMarker = Object.hasOwn(CORE_MARKER_MAP, identifier);
      // 墓碑判据看条目自带的 marker 字段：酒馆的 marker 是无正文占位条目。
      // main/nsfw/jailbreak/enhanceDefinitions 在酒馆里是 marker=false 的普通内建条目（有正文），
      // 不在此列，按普通文本条目导入以保留内容。
      const isTombstone = !isCoreMarker && prompt.marker === true;

      // marker 决策：
      //   - 核心 marker → marker_key=CORE_MAP[identifier], is_marker=1, content=''
      //   - 墓碑 marker → is_marker=0, content='', enabled=false
      //   - uuid / marker=false 内建条目 → 普通文本条目（content= prompt.content）
      let isMarker = 0;
      let markerKey: PresetMarkerKey | null = null;
      let content = (typeof prompt.content === 'string' ? prompt.content : '');
      let enabled = entryEnabled;

      if (isCoreMarker) {
        isMarker = 1;
        markerKey = CORE_MARKER_MAP[identifier];
        content = '';
        if (enabled) markersRecognized += 1;
      } else if (isTombstone) {
        isMarker = 0;
        markerKey = null;
        content = '';
        enabled = false;
        markersDisabled += 1;
        warnings.add(`条目 ${prompt.name || identifier} (${identifier}) 缺少对应世界书、用户人设或其他动态数据，已保留为空占位并禁用。`);
      }
      if (enabled && content) {
        for (const macro of findUnsupportedStMacros(content)) {
          warnings.add(`条目 ${prompt.name || identifier} 包含未支持的宏或宏写法 {{${macro}}}，不会假装已完整解析。`);
        }
      }

      const entryId = crypto.randomUUID();
      insertEntry.run(
        entryId,
        presetId,
        (typeof prompt.name === 'string' && prompt.name.trim()) ? prompt.name : identifier,
        normalizeRole(prompt.role),
        content,
        isMarker,
        markerKey,
        prompt.system_prompt ? 1 : 0,
        normalizeInteger(prompt.injection_position, 0) === 1 ? 1 : 0,
        normalizeInjectionDepth(prompt.injection_depth, 4),
        normalizeInteger(prompt.injection_order, 100),
        prompt.forbid_overrides ? 1 : 0,
        JSON.stringify(prompt.injection_trigger ?? []),
        enabled ? 1 : 0,
        sortOrder,
        now,
        now,
      );
      total += 1;
      if (enabled) enabledCount += 1;
    }
    if (enabledCount === 0) warnings.add('当前启用条目为 0；预设已保存，但这些条目不会参与聊天。');
    db.prepare('UPDATE prompt_presets SET import_warnings = ? WHERE id = ?')
      .run(JSON.stringify([...warnings]), presetId);
  })();

  return {
    preset_id: presetId,
    preset_name: presetName,
    total,
    enabled: enabledCount,
    markers_recognized: markersRecognized,
    markers_disabled: markersDisabled,
    story_plot_strip: storyPlotStrip,
    warnings: [...warnings],
  };
}

function importLumiMusePreset(
  data: RawLumiMusePreset,
  opts: { presetName?: string },
): PresetImportReport {
  const db = getDb();
  const presetId = crypto.randomUUID();
  const now = new Date().toISOString();
  const sourceName = typeof data.preset.name === 'string' ? data.preset.name.trim() : '';
  // 原生格式的名称属于 round-trip 数据；UI 传入的文件名只在原生名称为空时兜底。
  const presetName = sourceName || (opts.presetName && opts.presetName.trim()) || '导入预设';
  const description = typeof data.preset.description === 'string' ? data.preset.description : '';
  const storyPlotStrip = data.preset.story_plot_strip === true;
  const stripTags = data.preset.strip_tags ?? [];

  let total = 0;
  let enabledCount = 0;
  let markersRecognized = 0;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO prompt_presets (
        id, name, description, is_built_in, story_plot_strip,
        strip_tags, import_warnings, created_at, updated_at
      )
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(presetId, presetName, description, storyPlotStrip ? 1 : 0, JSON.stringify(stripTags),
      JSON.stringify(data.preset.import_warnings), now, now);

    const insertEntry = db.prepare(`
      INSERT INTO prompt_preset_entries (
        id, preset_id, name, role, content, is_marker, marker_key,
        is_system_prompt, injection_position, injection_depth, injection_order,
        forbid_overrides, injection_trigger, enabled, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let index = 0; index < data.entries.length; index += 1) {
      const raw = data.entries[index];
      insertEntry.run(
        crypto.randomUUID(),
        presetId,
        raw.name,
        raw.role,
        raw.content,
        raw.is_marker ? 1 : 0,
        raw.marker_key,
        raw.is_system_prompt ? 1 : 0,
        raw.injection_position,
        raw.injection_depth,
        raw.injection_order,
        raw.forbid_overrides ? 1 : 0,
        JSON.stringify(raw.injection_trigger),
        raw.enabled ? 1 : 0,
        raw.sort_order,
        now,
        now,
      );
      total += 1;
      if (raw.enabled) enabledCount += 1;
      if (raw.enabled && raw.is_marker) markersRecognized += 1;
    }
  })();

  return {
    preset_id: presetId,
    preset_name: presetName,
    total,
    enabled: enabledCount,
    markers_recognized: markersRecognized,
    markers_disabled: 0,
    story_plot_strip: storyPlotStrip,
    warnings: data.preset.import_warnings,
  };
}
