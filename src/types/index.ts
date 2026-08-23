import { DEFAULT_MEMORY_PACKAGE_TOKEN_BUDGET } from '@/lib/memory-prompt-contract';

export interface Character {
  id: string;
  name: string;
  avatar_url: string | null;
  basic_info: string;
  personality: string;
  scenario: string;
  greeting: string;
  example_dialogue: string;
  system_prompt: string;
  other_info: string;
  image_tags: string;
  user_image_tags: string;
  /**
   * 角色绑定的预设提示词。
   * - `null` / `'__none__'`：不使用预设（LumiMuse 传统骨架）
   * - 其他字符串：预设 id
   *
   * 新建角色默认 `'__none__'`。
   */
  active_preset_id: string | null;
  /**
   * 按聊天模型覆盖默认预设。缺省或空数组表示没有覆盖。
   * `preset_id` 为具体预设 id 或 `'__none__'`。
   */
  model_preset_bindings?: CharacterModelPresetBinding[];
  created_at: string;
  updated_at: string;
}

export interface CharacterModelPresetBinding {
  model: string;
  preset_id: string;
}

export interface Conversation {
  id: string;
  character_id: string;
  title: string;
  ignore_memory: number; // 0=正常, 1=忽略记忆提取
  parent_id?: string | null;
  parent_seq_end?: number | null;
  created_at: string;
  updated_at: string;
}

/** 消息附件（与 chat-engine.AttachmentItem 对齐，二者结构兼容） */
export interface MessageAttachment {
  type: 'image' | 'text';
  name: string;
  data?: string;
  url?: string;
  mimeType: string;
}

export interface MessageTokenCountProvenance {
  source: 'server';
  version: number;
  algorithm: string;
  fingerprint: string;
}

/** 消息历史版本（重新生成时旧内容存入 metadata.versions） */
export interface MessageVersion {
  content: string;
  token_count: number;
}

export interface GeneratedImageVersion {
  id: string;
  url: string;
  prompt: string;
}

export interface GeneratedImage {
  id: string;
  url?: string;
  prompt: string;
  status?: 'pending_prompt' | 'pending_image' | 'failed' | 'ready';
  error?: string;
  versions?: GeneratedImageVersion[];
  activeVersion?: number;
}

/**
 * 消息 metadata 的正式类型。所有字段都是可选的，因为不同消息形态用到的字段不同：
 *   - summary 消息：isSummary + summarizedIds
 *   - 用户消息：attachments + memory_extracted
 *   - 助手消息：versions + memory_extracted
 *
 * 仍保留索引签名以兼容历史字段或第三方扩展，但新代码应优先访问正式字段。
 */
export interface MessageMetadata {
  // Wire compatibility: legacy metadata intentionally mixes snake_case (`memory_extracted`)
  // and camelCase (`summarizedIds`, `generatedImages`). Do not rename these persisted keys.
  isSummary?: boolean;
  summarizedIds?: string[];
  memory_extracted?: boolean;
  attachments?: MessageAttachment[];
  token_count_provenance?: MessageTokenCountProvenance;
  versions?: MessageVersion[];
  generatedImages?: GeneratedImage[];
  /** 内联生图提示词：AI 回复中 [IMG]...[/IMG] 提取出的提示词，出图时直接复用 */
  inlineImagePrompt?: string;
  [key: string]: unknown;
}

export interface Message {
  [key: string]: unknown;
  id: string;
  /** 客户端视图归一化前，消息物理所属的对话；服务端原始行可能尚未填充。 */
  source_conversation_id?: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  token_count: number;
  created_at: string;
  metadata: MessageMetadata;
}

export const MEMORY_KINDS = [
  'general',
  'user_fact',
  'user_preference',
  'relationship_event',
  'character_promise',
  'open_thread',
  'world_state',
] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

export const MEMORY_STATUSES = [
  'active',
  'archived',
  'conflict',
  'superseded',
  'summarized',
] as const;
export type MemoryStatus = typeof MEMORY_STATUSES[number];

export interface Memory {
  [key: string]: unknown;
  id: string;
  character_id: string;
  category: MemoryCategory;
  content: string;
  confidence: number;
  tags: string[];
  source_msg_ids: string[];
  memory_kind: MemoryKind;
  importance: number;
  emotional_weight: number;
  status: MemoryStatus;
  pinned: boolean;
  last_used_at: string | null;
  usage_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type MemoryCategory =
  | '关系动态'
  | '话题历史'
  | '基础信息'
  | '偏好习惯'
  | '人格特质'
  | '重要事件'
  | '四季日常';

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  '关系动态',
  '话题历史',
  '基础信息',
  '偏好习惯',
  '人格特质',
  '重要事件',
  '四季日常',
];

export type ImageGenEngine = 'sd' | 'nai' | 'comfyui' | 'custom';

export interface ImageGenSettings {
  enabled: boolean;
  engine: ImageGenEngine;
  // SD WebUI
  sd_url: string;
  sd_model: string;
  sd_sampler: string;
  sd_steps: number;
  sd_cfg_scale: number;
  sd_width: number;
  sd_height: number;
  sd_negative_prompt: string;
  // NovelAI
  nai_api_key: string;
  nai_model: string;
  nai_sampler: string;
  nai_noise_schedule: string;
  nai_steps: number;
  nai_scale: number;
  nai_cfg_rescale: number;
  nai_width: number;
  nai_height: number;
  nai_negative_prompt: string;
  nai_artist_tags: string;
  // ComfyUI
  comfyui_url: string;
  comfyui_workflow: string;
  // 自定义 API（兼容 OpenAI DALL-E 格式或任意 URL）
  custom_url: string;
  custom_api_key: string;
  custom_model: string;
  custom_size: string;
  // 通用
  quality_tags: string;
  /**
   * 出图请求总时限（毫秒）。适用于所有生图引擎的提交、等待、轮询与下载阶段，
   * 避免慢/半挂上游让请求无限挂起。默认 120000。
   * 用户可按上游性能调大/调小。≤0 视为未设置，由路由层兜底为默认值。
   */
  generate_timeout_ms: number;
  auto_generate: boolean;
  auto_generate_keywords: string;
  // 内联提示词：让 AI 在聊天回复末尾用 [IMG]...[/IMG] 附带生图提示词，
  // 出图时直接复用该提示词，跳过单独的（慢速）提示词生成请求
  inline_prompt: boolean;
}

export const DEFAULT_IMAGE_GEN_SETTINGS: ImageGenSettings = {
  enabled: false,
  engine: 'sd',
  sd_url: 'http://127.0.0.1:7860',
  sd_model: '',
  sd_sampler: 'DPM++ 2M Karras',
  sd_steps: 28,
  sd_cfg_scale: 7,
  sd_width: 512,
  sd_height: 768,
  sd_negative_prompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark',
  nai_api_key: '',
  nai_model: 'nai-diffusion-4-5-full',
  nai_sampler: 'k_euler_ancestral',
  nai_noise_schedule: 'karras',
  nai_steps: 28,
  nai_scale: 5.5,
  nai_cfg_rescale: 0,
  nai_width: 832,
  nai_height: 1216,
  nai_negative_prompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers',
  nai_artist_tags: '',
  comfyui_url: 'http://127.0.0.1:8188',
  comfyui_workflow: '',
  custom_url: '',
  custom_api_key: '',
  custom_model: 'dall-e-3',
  custom_size: '1024x1024',
  quality_tags: 'best quality, amazing quality, very aesthetic, masterpiece',
  generate_timeout_ms: 120000,
  auto_generate: false,
  auto_generate_keywords: '画,生图,来一张,看看',
  inline_prompt: false,
};

export interface ArtistString {
  id: string;
  name: string;
  tags: string;
}

export type FontStyle = 'wenkai' | 'system' | 'serif';

/** 全局字体大小档位：通过修改 html 根 font-size 缩放 rem 体系 */
export type FontSize = 'small' | 'medium' | 'large';

// 思考强度（reasoning effort）：'default' 表示不在请求体里发送该字段，交给上游默认行为。
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ApiProvider {
  id: string;
  name: string;
  api_base: string;
  api_key: string;
  model: string;
  temperature: number;
  max_tokens: number;
  context_window: number;
  json_mode: boolean;
  created_at: string;
}

export type MemoryRetrievalMode = 'local' | 'hybrid' | 'vector';

export interface MemoryEngineSettings {
  enabled: boolean;
  allow_memory_context_in_chat: boolean;
  allow_external_memory_payloads: boolean;
  retrieval_mode: MemoryRetrievalMode;
  embedding_enabled: boolean;
  embedding_api_base: string;
  embedding_api_key: string;
  embedding_model: string;
  embedding_dimension: number;
  reranker_enabled: boolean;
  reranker_api_base: string;
  reranker_api_key: string;
  reranker_model: string;
  fallback_local_enabled: boolean;
  memory_package_token_budget: number;
  retrieval_token_budget: number;
  vector_top_k: number;
  keyword_top_k: number;
  reranker_top_k: number;
  final_top_k: number;
  embedding_timeout_ms: number;
  reranker_timeout_ms: number;
  total_retrieval_timeout_ms: number;
}

export const DEFAULT_MEMORY_ENGINE_SETTINGS: MemoryEngineSettings = {
  enabled: false,
  allow_memory_context_in_chat: true,
  allow_external_memory_payloads: true,
  retrieval_mode: 'local',
  embedding_enabled: false,
  embedding_api_base: '',
  embedding_api_key: '',
  embedding_model: '',
  embedding_dimension: 0,
  reranker_enabled: false,
  reranker_api_base: '',
  reranker_api_key: '',
  reranker_model: '',
  fallback_local_enabled: true,
  memory_package_token_budget: DEFAULT_MEMORY_PACKAGE_TOKEN_BUDGET,
  retrieval_token_budget: 8000,
  vector_top_k: 80,
  keyword_top_k: 20,
  reranker_top_k: 40,
  final_top_k: 30,
  embedding_timeout_ms: 1500,
  reranker_timeout_ms: 2000,
  total_retrieval_timeout_ms: 2500,
};

/** SillyTavern 预设提示词核心 marker（Q3 决策：6 条核心集） */
export const PRESET_MARKER_KEYS = [
  'charDescription',
  'charPersonality',
  'scenario',
  'dialogueExamples',
  'chatHistory',
  'memoryPackage',
] as const;
export type PresetMarkerKey = typeof PRESET_MARKER_KEYS[number];

export type PresetRole = 'system' | 'user' | 'assistant';

export interface PromptPreset {
  id: string;
  name: string;
  description: string;
  is_built_in: boolean;
  /** 落库前是否剥掉 AI 回复中的预设包装 XML 容器。 */
  story_plot_strip: boolean;
  /**
   * 预设自带的剥离规则：tag 名列表（如 ['story_plot', 'story_body']）。DB 里存 JSON 字符串。
   * 导入时由 preset 内容自动检测生成默认值，UI 可手工增删。
   *   - 'xxx'      剥开/闭合 <xxx> 保留内部文本（如 <content>…正文…</content> → 正文）
   *   - '#xxx'     <xxx> 起整段连内容丢弃，EOF 未闭合也丢（如 #thinking 思考草稿）
   * 普通 'story_plot' block 规则走 RONG 旧协议专用逻辑（保 body 弃 scene，仅开头触发）；
   * '#story_plot' 仍按通用 drop 规则处理。
   */
  strip_tags: string[];
  created_at: string;
  updated_at: string;
}

export interface PresetEntry {
  id: string;
  preset_id: string;
  name: string;
  role: PresetRole;
  content: string;
  is_marker: boolean;
  marker_key: PresetMarkerKey | null;
  is_system_prompt: boolean;
  /** 0=relative（按 sort_order 拼到 prompt 头部序列）；1=in-chat（按 depth 插进历史中间） */
  injection_position: 0 | 1;
  /** 仅 in-chat 用：从历史末尾消息往上数的索引，越大越远 */
  injection_depth: number;
  /** 同 depth 内排序：值越小越靠近原历史中的最新消息 */
  injection_order: number;
  forbid_overrides: boolean;
  /** 单层启用（Q2 决策）：直接决定该条目是否启用 */
  enabled: boolean;
  /** 在预设中的顺序（Q2：替代酒馆 prompt_order 数组） */
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PresetImportReport {
  preset_id: string;
  preset_name: string;
  total: number;
  enabled: number;
  markers_recognized: number;
  markers_disabled: number;
  story_plot_strip: boolean;
}

export interface Settings {
  api_base: string;
  api_key: string;
  model: string;
  json_mode: boolean;
  temperature: number;
  max_tokens: number;
  context_window: number;
  streaming: boolean;
  example_dialogue: boolean;
  memory_inject: boolean;
  memory_trigger_interval_enabled: boolean;
  memory_interval: number;
  memory_trigger_time_enabled: boolean;
  memory_trigger_time_hours: number;
  memory_trigger_keyword_enabled: boolean;
  memory_trigger_keywords: string;
  memory_max_inject: number;
  // 后台任务（记忆提取/画像/总结）专用模型；留空则回退到主聊天模型 model。检索注入不受影响。
  memory_background_model: string;
  // 后台任务专用供应商 ID；留空则使用主接口的 api_base/api_key。设置后后台任务将使用该供应商的接口和模型。
  memory_background_provider_id: string;
  // 后台 LLM 任务总时限（毫秒）；0 表示显式关闭。普通聊天不使用该设置。
  memory_background_timeout_ms: number;
  // 后台任务使用 DeepSeek 模型时关闭 thinking，避免思考内容耗尽输出 token。正常聊天不受影响。
  disable_deepseek_thinking_for_background: boolean;
  // 为后台 LLM 请求单独发送 reasoning_effort（默认关闭，不继承聊天框选择）。
  memory_background_reasoning_effort_enabled: boolean;
  memory_background_reasoning_effort: ReasoningEffort;
  theme: 'light' | 'dark';
  show_timestamps: boolean;
  /**
   * 用户浏览器上报的 IANA 时区（如 Asia/Tokyo），由聊天请求自动写入。
   * 后台任务（记忆提取 / 画像更新）没有客户端上下文，靠它把消息时间戳
   * 渲染成用户本地时间——否则容器默认 UTC 会让凌晨的对话被记成前一天，
   * 而这个错误日期会跟着记忆内容持久化下去。空串表示尚未上报，回退服务器本地时区。
   */
  client_timezone: string;
  limit_inject: boolean;
  language: 'zh' | 'en';
  font_style: FontStyle;
  font_size: FontSize;
  active_provider_id: string;
  // 高级采样参数：null 表示未设置，请求体中不会包含该字段（部分模型不支持）。
  top_p: number | null;
  frequency_penalty: number | null;
  presence_penalty: number | null;
  top_k: number | null;
  repetition_penalty: number | null;
  seed: number | null;
  // 思考强度：'default' 时请求体不包含 reasoning_effort 字段（部分模型不支持）。
  reasoning_effort: ReasoningEffort;
  // 聊天框按模型记住的思考强度；切模型时还原对应条目。
  reasoning_effort_by_model: Record<string, ReasoningEffort>;
  // 生图设置
  image_gen: ImageGenSettings;
  memory_engine: MemoryEngineSettings;
  // 画师串管理
  artist_strings: ArtistString[];
}

export const DEFAULT_SETTINGS: Settings = {
  api_base: '',
  api_key: '',
  model: '',
  json_mode: false,
  temperature: 1,
  max_tokens: 4096,
  context_window: 131072,
  streaming: true,
  example_dialogue: true,
  memory_inject: true,
  memory_trigger_interval_enabled: true,
  memory_interval: 3,
  memory_trigger_time_enabled: false,
  memory_trigger_time_hours: 24,
  memory_trigger_keyword_enabled: true,
  memory_trigger_keywords: '晚安',
  memory_max_inject: 30,
  memory_background_model: '',
  memory_background_provider_id: '',
  memory_background_timeout_ms: 1_800_000,
  disable_deepseek_thinking_for_background: false,
  memory_background_reasoning_effort_enabled: false,
  memory_background_reasoning_effort: 'medium',
  theme: 'light',
  show_timestamps: true,
  client_timezone: '',
  limit_inject: false,
  language: 'zh',
  font_style: 'wenkai',
  font_size: 'medium',
  active_provider_id: '',
  top_p: null,
  frequency_penalty: null,
  presence_penalty: null,
  top_k: null,
  repetition_penalty: null,
  seed: null,
  reasoning_effort: 'default',
  reasoning_effort_by_model: {},
  image_gen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
  memory_engine: { ...DEFAULT_MEMORY_ENGINE_SETTINGS },
  artist_strings: [],
};
export interface ChatRequest {
  conversation_id: string;
  content: string;
  client_now_iso?: string;
  client_timezone?: string;
  client_utc_offset_minutes?: number;
}
