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
import { MEMORY_CATEGORIES } from '@/types';

// --------- 通用尺寸常量 ---------
const MAX_NAME = 100;
const MAX_LARGE_TEXT = 32 * 1024;       // personality / system_prompt
const MAX_MEDIUM_TEXT = 16 * 1024;      // 描述类字段
const MAX_MEMORY_CONTENT = 8 * 1024;
const MAX_MESSAGE_CONTENT = 100 * 1024;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const MAX_URL = 4 * 1024;
const MAX_TITLE = 200;
const MAX_API_BASE = 1024;
const MAX_API_KEY = 4096;
const MAX_MODEL_NAME = 200;

// --------- 基础 schema ---------

/** 与 MessageAttachment 对齐 */
export const attachmentSchema = z.object({
  type: z.enum(['image', 'text']),
  name: z.string().max(512),
  data: z.string().max(20 * 1024 * 1024).optional(), // 单个附件 ≤ 20MB（base64）
  url: z.string().max(MAX_URL).optional(),
  mimeType: z.string().max(255),
});

/** 消息历史版本（metadata.versions 内的单条） */
export const messageVersionSchema = z.object({
  content: z.string().max(MAX_MESSAGE_CONTENT),
  token_count: z.number().int().nonnegative(),
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

// --------- /api/memories POST ---------
export const memoryCreateSchema = z.object({
  character_id: z.string().min(1).max(64),
  category: z.string().max(50),     // 实际类别由 normalizeMemoryCategory 规整
  content: z.string().min(1).max(MAX_MEMORY_CONTENT),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS).optional(),
});
export type MemoryCreate = z.infer<typeof memoryCreateSchema>;
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
  json_mode: z.boolean().optional(),
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
