/**
 * 酒馆 `extensions.SPreset` 配置的只读模型。
 *
 * 字段名沿用酒馆的 PascalCase / snake_case 原样，便于和预设 JSON 对照；缺失字段一律取保守默认
 * （关闭），这样不认识的版本也能安全降级到「不启用插件」。
 */

export interface SpresetChatSquash {
  enabled: boolean;
  /** 只有正文里出现 conditionalTag（默认 `<|merge|>`）时才压缩。 */
  conditionalEnabled: boolean;
  conditionalTag: string;
  role: 'system' | 'user' | 'assistant';
  userPrefix: string;
  userSuffix: string;
  charPrefix: string;
  charSuffix: string;
  prefixSystem: string;
  suffixSystem: string;
  enableSeparator: boolean;
  separator: string;
  postScriptEnabled: boolean;
  postScript: string;
}

export interface SpresetRequestProcessor {
  enabled: boolean;
  script: string;
}

export interface SpresetToolCallFormatter {
  enabled: boolean;
  script: string;
}

export interface SpresetOutputProcessor {
  enabled: boolean;
  script: string;
  consumeToolCalls: boolean;
  formatter: SpresetToolCallFormatter | null;
}

export interface SpresetToolBinding {
  /** 绑定挂在哪个预设条目上（导入时已改写成本地条目 id）。 */
  entryId: string;
  name: string;
  code: string;
  enabled: boolean;
  valid: boolean;
}

export interface SpresetConfig {
  chatSquash: SpresetChatSquash | null;
  finalRequest: SpresetRequestProcessor | null;
  output: SpresetOutputProcessor | null;
  tools: SpresetToolBinding[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseChatSquash(value: unknown): SpresetChatSquash | null {
  const raw = asRecord(value);
  if (!raw || !bool(raw.enabled)) return null;
  const role = raw.role;
  return {
    enabled: true,
    conditionalEnabled: bool(raw.conditional_enabled),
    conditionalTag: str(raw.conditional_tag, '<|merge|>'),
    role: role === 'user' || role === 'assistant' ? role : 'system',
    userPrefix: str(raw.user_prefix),
    userSuffix: str(raw.user_suffix),
    charPrefix: str(raw.char_prefix),
    charSuffix: str(raw.char_suffix),
    prefixSystem: str(raw.prefix_system),
    suffixSystem: str(raw.suffix_system),
    enableSeparator: bool(raw.enable_separator),
    separator: str(raw.squashed_separator_string, '<|sep|>'),
    postScriptEnabled: bool(raw.squashed_post_script_enable),
    postScript: str(raw.squashed_post_script),
  };
}

function parseFinalRequest(value: unknown): SpresetRequestProcessor | null {
  const raw = asRecord(value);
  if (!raw || !bool(raw.enabled)) return null;
  const script = str(raw.script);
  return script.trim() ? { enabled: true, script } : null;
}

function parseOutput(value: unknown): SpresetOutputProcessor | null {
  const raw = asRecord(value);
  if (!raw || !bool(raw.enabled)) return null;
  const formatterRaw = asRecord(raw.toolCallFormatter);
  const formatterScript = str(formatterRaw?.script);
  const formatter = formatterRaw && bool(formatterRaw.enabled) && formatterScript.trim()
    ? { enabled: true, script: formatterScript }
    : null;
  return {
    enabled: true,
    script: str(raw.script),
    consumeToolCalls: bool(raw.consumeToolCalls),
    formatter,
  };
}

function parseToolBindings(value: unknown): SpresetToolBinding[] {
  const record = asRecord(value);
  if (!record) return [];
  const tools: SpresetToolBinding[] = [];
  for (const [entryId, item] of Object.entries(record)) {
    const raw = asRecord(item);
    if (!raw || !bool(raw.enabled)) continue;
    const code = str(raw.code);
    if (!code.trim()) continue;
    const form = asRecord(raw.form);
    const name = str(raw.resolvedName).trim() || str(raw.name).trim() || str(form?.name).trim();
    if (!name) continue;
    // valid === false 表示酒馆侧也认为这份代码不可用（例如参数表是空的）。
    if (raw.valid === false) continue;
    tools.push({ entryId, name, code, enabled: true, valid: true });
  }
  return tools;
}

/** 从预设的 `extensions` 里取出 SPreset 配置；没有插件配置时返回 null。 */
export function parseSpresetConfig(
  extensions: Record<string, unknown> | null | undefined,
): SpresetConfig | null {
  const spreset = asRecord(extensions?.SPreset);
  if (!spreset) return null;

  const config: SpresetConfig = {
    chatSquash: parseChatSquash(spreset.ChatSquash),
    finalRequest: parseFinalRequest(spreset.FinalRequestProcessing),
    output: parseOutput(spreset.OutputPreprocessing),
    tools: parseToolBindings(spreset.ToolBindings),
  };

  if (!config.chatSquash && !config.finalRequest && !config.output && config.tools.length === 0) {
    return null;
  }
  return config;
}

/**
 * 是否存在「运行时」型插件配置。
 *
 * 有运行时就不该走 `spreset-protocol` 的语法翻译兜底：控制指令要留给插件脚本读，
 * 由 FinalRequestProcessing 自己去解析 registerPart。
 */
export function hasSpresetRuntime(config: SpresetConfig | null): boolean {
  return config !== null && (config.finalRequest !== null || config.output !== null || config.tools.length > 0);
}
