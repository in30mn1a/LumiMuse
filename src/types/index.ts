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
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  character_id: string;
  title: string;
  ignore_memory: number; // 0=正常, 1=忽略记忆提取
  created_at: string;
  updated_at: string;
}

export interface Message {
  [key: string]: unknown;
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  token_count: number;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface Memory {
  [key: string]: unknown;
  id: string;
  character_id: string;
  category: MemoryCategory;
  content: string;
  confidence: number;
  tags: string[];
  source_msg_ids: string[];
  created_at: string;
  updated_at: string;
}

export type MemoryCategory =
  | '关系动态'
  | '话题历史'
  | '基础信息'
  | '偏好习惯'
  | '人格特质'
  | '重要事件';

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  '关系动态',
  '话题历史',
  '基础信息',
  '偏好习惯',
  '人格特质',
  '重要事件',
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
  auto_generate: boolean;
  auto_generate_keywords: string;
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
  auto_generate: false,
  auto_generate_keywords: '画,生图,来一张,看看',
};

export type FontStyle = 'wenkai' | 'system' | 'serif';

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
  theme: 'light' | 'dark';
  show_timestamps: boolean;
  limit_inject: boolean;
  language: 'zh' | 'en';
  font_style: FontStyle;
  active_provider_id: string;
  // 生图设置
  image_gen: ImageGenSettings;
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
  theme: 'light',
  show_timestamps: true,
  limit_inject: false,
  language: 'zh',
  font_style: 'wenkai',
  active_provider_id: '',
  image_gen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
};

export interface ChatRequest {
  conversation_id: string;
  content: string;
  client_now_iso?: string;
  client_timezone?: string;
  client_utc_offset_minutes?: number;
}
