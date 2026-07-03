/**
 * 集中管理 API 路由的 zod 校验 schema。
 *
 * 字段长度上限的约定（基于现有业务场景）：
 *  - 角色 name ≤ 100
 *  - personality / system_prompt ≤ 32KB
 *  - description / introduction（basic_info / scenario / greeting / example_dialogue / other_info / image_tags）≤ 16KB
 *  - memory content ≤ 8KB
 *  - confidence ∈ [0, 1]
 *  - tags 数组 ≤ 20 项，每个 ≤ 50 字符
 *  - message content ≤ 100KB
 */
import { z } from 'zod';
import { MEMORY_CATEGORIES, MEMORY_KINDS, MEMORY_STATUSES } from '@/types';

// --------- 通用尺寸常量 ---------
const MAX_NAME = 100;
const MAX_LARGE_TEXT = 32 * 1024;       // personality / system_prompt
const MAX_MEDIUM_TEXT = 16 * 1024;      // 描述类字段
const MAX_MEMORY_CONTENT = 8 * 1024;
const MAX_MESSAGE_CONTENT = 100 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_TEXT_ATTACHMENT_CHARS = MAX_MESSAGE_CONTENT;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const MAX_URL = 4 * 1024;
const MAX_TITLE = 200;
const MAX_API_BASE = 1024;
const MAX_API_KEY = 4096;
const MAX_MODEL_NAME = 200;
const MAX_COMFYUI_WORKFLOW = 64 * 1024;
const MAX_SHORT_SETTING = 512;

// --------- 基础 schema ---------
const unknownRecordSchema = z.record(z.string(), z.unknown());

// --------- /api/settings PUT ---------
const settingMediumTextSchema = z.string().max(MAX_MEDIUM_TEXT);
const settingUrlSchema = z.string().max(MAX_URL);
const settingApiBaseSchema = z.string().max(MAX_API_BASE);
const settingApiKeySchema = z.string().max(MAX_API_KEY);
const settingModelSchema = z.string().max(MAX_MODEL_NAME);
const settingFiniteNumberSchema = z.number().finite();
const settingNonNegativeNumberSchema = settingFiniteNumberSchema.nonnegative();
const settingNonNegativeIntegerSchema = z.number().int().nonnegative();
const settingPositiveIntegerSchema = z.number().int().min(1);

const imageGenSettingsSchema = z.looseObject({
  enabled: z.boolean().optional(),
  engine: z.enum(['sd', 'nai', 'comfyui', 'custom']).optional(),
  sd_url: settingUrlSchema.optional(),
  sd_model: settingModelSchema.optional(),
  sd_sampler: z.string().max(MAX_SHORT_SETTING).optional(),
  sd_steps: settingNonNegativeIntegerSchema.optional(),
  sd_cfg_scale: settingNonNegativeNumberSchema.optional(),
  sd_width: settingNonNegativeIntegerSchema.optional(),
  sd_height: settingNonNegativeIntegerSchema.optional(),
  sd_negative_prompt: settingMediumTextSchema.optional(),
  nai_api_key: settingApiKeySchema.optional(),
  nai_model: settingModelSchema.optional(),
  nai_sampler: z.string().max(MAX_SHORT_SETTING).optional(),
  nai_noise_schedule: z.string().max(MAX_SHORT_SETTING).optional(),
  nai_steps: settingNonNegativeIntegerSchema.optional(),
  nai_scale: settingNonNegativeNumberSchema.optional(),
  nai_cfg_rescale: settingNonNegativeNumberSchema.min(0).max(1).optional(),
  nai_width: settingNonNegativeIntegerSchema.optional(),
  nai_height: settingNonNegativeIntegerSchema.optional(),
  nai_negative_prompt: settingMediumTextSchema.optional(),
  nai_artist_tags: settingMediumTextSchema.optional(),
  comfyui_url: settingUrlSchema.optional(),
  comfyui_workflow: z.string().max(MAX_COMFYUI_WORKFLOW).optional(),
  custom_url: settingUrlSchema.optional(),
  custom_api_key: settingApiKeySchema.optional(),
  custom_model: settingModelSchema.optional(),
  custom_size: z.string().max(MAX_SHORT_SETTING).optional(),
  quality_tags: settingMediumTextSchema.optional(),
  auto_generate: z.boolean().optional(),
  auto_generate_keywords: settingMediumTextSchema.optional(),
  inline_prompt: z.boolean().optional(),
});

const memoryEngineSettingsSchema = z.looseObject({
  enabled: z.boolean().optional(),
  allow_memory_context_in_chat: z.boolean().optional(),
  allow_external_memory_payloads: z.boolean().optional(),
  retrieval_mode: z.enum(['local', 'hybrid', 'vector']).optional(),
  embedding_enabled: z.boolean().optional(),
  embedding_api_base: settingApiBaseSchema.optional(),
  embedding_api_key: settingApiKeySchema.optional(),
  embedding_model: settingModelSchema.optional(),
  embedding_dimension: z.union([settingNonNegativeNumberSchema, z.nan()]).optional(),
  reranker_enabled: z.boolean().optional(),
  reranker_api_base: settingApiBaseSchema.optional(),
  reranker_api_key: settingApiKeySchema.optional(),
  reranker_model: settingModelSchema.optional(),
  fallback_local_enabled: z.boolean().optional(),
  memory_package_token_budget: settingPositiveIntegerSchema.optional(),
  retrieval_token_budget: settingPositiveIntegerSchema.optional(),
  vector_top_k: settingPositiveIntegerSchema.optional(),
  keyword_top_k: settingPositiveIntegerSchema.optional(),
  reranker_top_k: settingPositiveIntegerSchema.optional(),
  final_top_k: settingPositiveIntegerSchema.optional(),
  embedding_timeout_ms: settingNonNegativeNumberSchema.optional(),
  reranker_timeout_ms: settingNonNegativeNumberSchema.optional(),
  total_retrieval_timeout_ms: settingNonNegativeNumberSchema.optional(),
});

const artistStringSettingsSchema = z.looseObject({
  id: z.string().max(64),
  name: z.string().max(MAX_NAME),
  tags: settingMediumTextSchema,
});

// 设置项会继续演进：已知字段强类型校验，未知字段仍允许通过以保持前后端兼容。
export const settingsUpdateSchema = z.looseObject({
  api_base: settingApiBaseSchema.optional(),
  api_key: settingApiKeySchema.optional(),
  model: settingModelSchema.optional(),
  json_mode: z.boolean().optional(),
  temperature: settingFiniteNumberSchema.min(0).max(10).optional(),
  max_tokens: settingPositiveIntegerSchema.max(10_000_000).optional(),
  context_window: settingPositiveIntegerSchema.max(100_000_000).optional(),
  // 高级采样参数：null 表示未设置，请求体不包含该字段
  top_p: z.union([z.null(), settingFiniteNumberSchema.min(0).max(1)]).optional(),
  frequency_penalty: z.union([z.null(), settingFiniteNumberSchema.min(-2).max(2)]).optional(),
  presence_penalty: z.union([z.null(), settingFiniteNumberSchema.min(-2).max(2)]).optional(),
  top_k: z.union([z.null(), settingPositiveIntegerSchema.max(1000)]).optional(),
  repetition_penalty: z.union([z.null(), settingFiniteNumberSchema.min(0).max(10)]).optional(),
  seed: z.union([z.null(), z.number().int().min(0).max(2_147_483_647)]).optional(),
  streaming: z.boolean().optional(),
  example_dialogue: z.boolean().optional(),
  memory_inject: z.boolean().optional(),
  memory_trigger_interval_enabled: z.boolean().optional(),
  memory_interval: settingNonNegativeNumberSchema.optional(),
  memory_trigger_time_enabled: z.boolean().optional(),
  memory_trigger_time_hours: settingNonNegativeNumberSchema.optional(),
  memory_trigger_keyword_enabled: z.boolean().optional(),
  memory_trigger_keywords: settingMediumTextSchema.optional(),
  memory_max_inject: settingNonNegativeNumberSchema.optional(),
  memory_background_model: settingModelSchema.optional(),
  memory_background_provider_id: z.string().max(64).optional(),
  disable_deepseek_thinking_for_background: z.boolean().optional(),
  theme: z.enum(['light', 'dark']).optional(),
  show_timestamps: z.boolean().optional(),
  limit_inject: z.boolean().optional(),
  language: z.enum(['zh', 'en']).optional(),
  font_style: z.enum(['wenkai', 'system', 'serif']).optional(),
  active_provider_id: z.string().max(64).optional(),
  image_gen: imageGenSettingsSchema.optional(),
  memory_engine: memoryEngineSettingsSchema.optional(),
  artist_strings: z.array(artistStringSettingsSchema).optional(),
});
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

// --------- /api/summarize ---------
export const summarizeBodySchema = z.object({
  conversation_id: z.string().optional(),
});
export type SummarizeBody = z.infer<typeof summarizeBodySchema>;

// --------- /api/image-gen ---------
const imageGenOverrideSchema = z.object({
  sd_sampler: z.string().max(MAX_SHORT_SETTING).optional(),
  sd_steps: settingNonNegativeIntegerSchema.optional(),
  sd_cfg_scale: settingNonNegativeNumberSchema.optional(),
  sd_width: settingNonNegativeIntegerSchema.optional(),
  sd_height: settingNonNegativeIntegerSchema.optional(),
  sd_negative_prompt: settingMediumTextSchema.optional(),
  nai_sampler: z.string().max(MAX_SHORT_SETTING).optional(),
  nai_noise_schedule: z.string().max(MAX_SHORT_SETTING).optional(),
  nai_steps: settingNonNegativeIntegerSchema.optional(),
  nai_scale: settingNonNegativeNumberSchema.optional(),
  nai_cfg_rescale: settingNonNegativeNumberSchema.min(0).max(1).optional(),
  nai_width: settingNonNegativeIntegerSchema.optional(),
  nai_height: settingNonNegativeIntegerSchema.optional(),
  nai_negative_prompt: settingMediumTextSchema.optional(),
  nai_artist_tags: settingMediumTextSchema.optional(),
  custom_size: z.string().max(MAX_SHORT_SETTING).optional(),
  quality_tags: settingMediumTextSchema.optional(),
}).strict();

export const imageGenBodySchema = z.object({
  prompt: z.string().optional(),
  negative_prompt: z.string().optional(),
  override: imageGenOverrideSchema.optional(),
});
export type ImageGenBody = z.infer<typeof imageGenBodySchema>;

// --------- /api/image-gen/prompt ---------
export const imagePromptBodySchema = z.object({
  conversation_id: z.string().min(1).max(64),
  message_id: z.string().optional(),
  user_hint: z.string().optional(),
});
export type ImagePromptBody = z.infer<typeof imagePromptBodySchema>;

/** 与 MessageAttachment 对齐 */
export const attachmentSchema = z.object({
  type: z.enum(['image', 'text']),
  name: z.string().max(512),
  data: z.string().max(20 * 1024 * 1024).optional(), // 单个附件 ≤ 20MB（base64）
  url: z.string().max(MAX_URL).optional(),
  mimeType: z.string().max(255),
});

function estimateAttachmentPayloadBytes(value: string): number {
  const commaIndex = value.indexOf(',');
  if (commaIndex >= 0) {
    const meta = value.slice(0, commaIndex).toLowerCase();
    const payload = value.slice(commaIndex + 1);
    if (meta.startsWith('data:') && meta.includes(';base64')) {
      const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
      return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
    }
    if (meta.startsWith('data:')) {
      try {
        return Buffer.byteLength(decodeURIComponent(payload), 'utf8');
      } catch {
        return Buffer.byteLength(payload, 'utf8');
      }
    }
  }

  return Buffer.byteLength(value, 'utf8');
}

export function validateChatAttachmentTotals(attachments: ChatBody['attachments']): { error: string; status: 413 } | null {
  if (!attachments || attachments.length === 0) return null;

  let totalAttachmentBytes = 0;
  let totalTextAttachmentChars = 0;
  for (const attachment of attachments) {
    if (attachment.data) {
      totalAttachmentBytes += estimateAttachmentPayloadBytes(attachment.data);
      if (attachment.type === 'text') {
        totalTextAttachmentChars += attachment.data.length;
      }
    }
    if (attachment.url) {
      totalAttachmentBytes += Buffer.byteLength(attachment.url, 'utf8');
    }
  }

  if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    return { error: 'Attachments too large', status: 413 };
  }
  if (totalTextAttachmentChars > MAX_TOTAL_TEXT_ATTACHMENT_CHARS) {
    return { error: 'Text attachments too large', status: 413 };
  }
  return null;
}

/** 消息历史版本（metadata.versions 内的单条） */
export const messageVersionSchema = z.object({
  content: z.string().max(MAX_MESSAGE_CONTENT),
  token_count: z.number().int().nonnegative(),
});

export const generatedImageVersionSchema = z.object({
  id: z.string().max(64),
  url: z.string().max(MAX_URL),
  prompt: z.string().max(MAX_MESSAGE_CONTENT),
});

export const generatedImageSchema = z.object({
  id: z.string().max(64),
  url: z.string().max(MAX_URL).optional(),
  prompt: z.string().max(MAX_MESSAGE_CONTENT),
  status: z.enum(['pending_prompt', 'pending_image', 'failed', 'ready']).optional(),
  error: z.string().max(MAX_MESSAGE_CONTENT).optional(),
  versions: z.array(generatedImageVersionSchema).max(100).optional(),
  activeVersion: z.number().int().nonnegative().optional(),
});

/**
 * 消息 metadata。允许未知字段（保持向后兼容），但对正式字段做类型约束。
 * 注：z.record 在 zod 4 需要显式 key/value schema。
 */
export const messageMetadataSchema: z.ZodType<Record<string, unknown>> = z.looseObject({
  isSummary: z.boolean().optional(),
  summarizedIds: z.array(z.string().max(64)).max(10000).optional(),
  memory_extracted: z.boolean().optional(),
  attachments: z.array(attachmentSchema).max(50).optional(),
  versions: z.array(messageVersionSchema).max(100).optional(),
  activeVersion: z.number().int().nonnegative().optional(),
  generatedImages: z.array(generatedImageSchema).max(100).optional(),
});

// --------- /api/chat ---------
export const chatBodySchema = z.object({
  conversation_id: z.string().min(1).max(64),
  content: z.string().max(MAX_MESSAGE_CONTENT).optional().default(''),
  regenerate_assistant_id: z.string().min(1).max(64).optional(),
  skip_user_insert: z.boolean().optional(),
  attachments: z.array(attachmentSchema).max(50).optional(),
  client_now_iso: z.string().max(64).optional(),
  client_timezone: z.string().max(128).optional(),
  client_utc_offset_minutes: z.number().int().min(-1440).max(1440).optional(),
});
export type ChatBody = z.infer<typeof chatBodySchema>;

// --------- /api/characters ---------
export const characterCreateSchema = z.object({
  name: z.string().max(MAX_NAME).optional(),
  avatar_url: z.string().max(MAX_URL).nullable().optional(),
  basic_info: z.string().max(MAX_MEDIUM_TEXT).optional(),
  personality: z.string().max(MAX_LARGE_TEXT).optional(),
  scenario: z.string().max(MAX_MEDIUM_TEXT).optional(),
  greeting: z.string().max(MAX_MEDIUM_TEXT).optional(),
  example_dialogue: z.string().max(MAX_MEDIUM_TEXT).optional(),
  system_prompt: z.string().max(MAX_LARGE_TEXT).optional(),
  other_info: z.string().max(MAX_MEDIUM_TEXT).optional(),
  image_tags: z.string().max(MAX_MEDIUM_TEXT).optional(),
  user_image_tags: z.string().max(MAX_MEDIUM_TEXT).optional(),
});
export type CharacterCreate = z.infer<typeof characterCreateSchema>;

/** 角色 PUT，所有字段都可选 */
export const characterUpdateSchema = characterCreateSchema;
export type CharacterUpdate = z.infer<typeof characterUpdateSchema>;

// --------- /api/conversations ---------
export const conversationCreateSchema = z.object({
  character_id: z.string().min(1).max(64),
  title: z.string().max(MAX_TITLE).optional(),
});
export type ConversationCreate = z.infer<typeof conversationCreateSchema>;

/** PUT 至少要提供 title 或 ignore_memory 之一 */
export const conversationUpdateSchema = z.object({
  title: z.string().max(MAX_TITLE).optional(),
  ignore_memory: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
});
export type ConversationUpdate = z.infer<typeof conversationUpdateSchema>;

// --------- /api/conversations/[id]/messages POST ---------
export const conversationMessageCreateSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(MAX_MESSAGE_CONTENT),
  token_count: z.number().int().nonnegative().optional(),
  metadata: messageMetadataSchema.optional(),
});
export type ConversationMessageCreate = z.infer<typeof conversationMessageCreateSchema>;

// --------- /api/messages POST ---------
export const messageCreateSchema = z.object({
  conversation_id: z.string().min(1).max(64),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(MAX_MESSAGE_CONTENT),
  token_count: z.number().int().nonnegative().optional(),
  metadata: messageMetadataSchema.optional(),
});
export type MessageCreate = z.infer<typeof messageCreateSchema>;

// --------- /api/messages/[id] PUT ---------
export const messageUpdateSchema = z.object({
  content: z.string().max(MAX_MESSAGE_CONTENT).optional(),
  metadata: messageMetadataSchema.optional(),
  activeVersion: z.number().int().nonnegative().optional(),
  attachments: z.array(attachmentSchema).max(50).optional(),
});
export type MessageUpdate = z.infer<typeof messageUpdateSchema>;

const memoryWritableFields = {
  category: z.string().max(50).optional(),     // 实际类别由 normalizeMemoryCategory 规整
  content: z.string().min(1).max(MAX_MEMORY_CONTENT).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS).optional(),
  memory_kind: z.enum(MEMORY_KINDS).optional(),
  importance: z.number().min(0).max(1).optional(),
  emotional_weight: z.number().min(0).max(1).optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
  pinned: z.union([z.boolean(), z.number().int().min(0).max(1)]).transform(v => !!v).optional(),
  last_used_at: z.string().max(64).nullable().optional(),
  usage_count: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

// --------- /api/memories POST ---------
export const memoryCreateSchema = z.object({
  character_id: z.string().min(1).max(64),
  ...memoryWritableFields,
  category: z.string().max(50),
  content: z.string().min(1).max(MAX_MEMORY_CONTENT),
});
export type MemoryCreate = z.infer<typeof memoryCreateSchema>;

// --------- /api/memories/[id] PUT ---------
export const memoryUpdateSchema = z.object({
  character_id: z.string().min(1).max(64).optional(),
  ...memoryWritableFields,
});
export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>;

// 让 TS 知道 MEMORY_CATEGORIES 在某些地方仍然有用（避免被打成 dead-import）
export const ALLOWED_MEMORY_CATEGORIES = MEMORY_CATEGORIES;

// --------- /api/providers POST/PUT ---------
const providerCommonFields = {
  name: z.string().max(MAX_NAME).optional(),
  api_base: z.string().max(MAX_API_BASE).optional(),
  api_key: z.string().max(MAX_API_KEY).optional(),
  model: z.string().max(MAX_MODEL_NAME).optional(),
  temperature: z.number().min(0).max(10).optional(),
  max_tokens: z.number().int().min(1).max(10_000_000).optional(),
  context_window: z.number().int().min(1).max(100_000_000).optional(),
  json_mode: z.union([z.boolean(), z.number().int().min(0).max(1)]).transform(v => !!v).optional(),
  save_as_current: z.boolean().optional(),
};

export const providerCreateSchema = z.object(providerCommonFields);
export type ProviderCreate = z.infer<typeof providerCreateSchema>;

export const providerUpdateSchema = z.object({
  id: z.string().min(1).max(64),
  ...providerCommonFields,
});
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;

// --------- 通用错误响应辅助 ---------
/**
 * 把 zod SafeParseError 的字段错误打平成 `{ field: ["message", ...] }`。
 * 只暴露最外层 fieldErrors，避免把内部对象路径泄漏给客户端。
 */
export function formatZodFieldErrors(error: z.ZodError): Record<string, string[]> {
  const flat = error.flatten();
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(flat.fieldErrors)) {
    if (Array.isArray(value) && value.length > 0) {
      result[key] = value as string[];
    }
  }
  // formErrors 也带上一个特殊键 _form，便于客户端区分
  if (flat.formErrors.length > 0) {
    result._form = flat.formErrors;
  }
  return result;
}
