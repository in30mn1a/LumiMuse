import type { ChatMessage } from '@/lib/api-client';
import type { Settings } from '@/types';

/**
 * 在后台提示词字典中记住指定模型的系统提示词。
 */
export function rememberBackgroundSystemPromptForModel(
  byModel: Record<string, string>,
  model: string,
  prompt: string,
): Record<string, string> {
  const trimmedModel = model.trim();
  if (!trimmedModel) return byModel;
  if (byModel[trimmedModel] === prompt) return byModel;
  return { ...byModel, [trimmedModel]: prompt };
}

/**
 * 获取指定模型绑定的系统提示词，未绑定时返回 fallback。
 */
export function resolveBackgroundSystemPromptForModel(
  model: string,
  byModel: Record<string, string>,
  fallback = '',
): string {
  const trimmedModel = model.trim();
  if (!trimmedModel) return fallback;
  return byModel[trimmedModel] ?? fallback;
}

/**
 * 换模型切换计划：
 * 1. 先将上一模型的当前提示词存入 byModel
 * 2. 还原目标模型先前保存过的提示词（若未保存过则默认为空）
 */
export function planBackgroundModelSwitch(params: {
  previousModel: string;
  previousPrompt: string;
  nextModel: string;
  fallbackModel?: string;
  byModel: Record<string, string>;
}): { prompt: string; byModel: Record<string, string> } {
  const prevKey = (params.previousModel || params.fallbackModel || '').trim();
  const nextKey = (params.nextModel || params.fallbackModel || '').trim();

  let currentByModel = params.byModel;
  if (prevKey) {
    currentByModel = rememberBackgroundSystemPromptForModel(
      currentByModel,
      prevKey,
      params.previousPrompt,
    );
  }

  const prompt = nextKey ? resolveBackgroundSystemPromptForModel(nextKey, currentByModel, '') : '';
  const finalByModel = nextKey
    ? rememberBackgroundSystemPromptForModel(currentByModel, nextKey, prompt)
    : currentByModel;

  return {
    prompt,
    byModel: finalByModel,
  };
}

/**
 * 从 settings 中解析适用于目标模型的系统提示词。
 * 优先使用模型专属绑定的提示词；未绑定时回退至全局 memory_background_system_prompt。
 */
export function resolveBackgroundSystemPrompt(
  settings: Pick<Settings, 'memory_background_system_prompt'> & {
    memory_background_system_prompt_by_model?: Record<string, string>;
  },
  model?: string,
): string {
  const trimmedModel = model?.trim();
  if (
    trimmedModel
    && settings.memory_background_system_prompt_by_model
    && Object.prototype.hasOwnProperty.call(settings.memory_background_system_prompt_by_model, trimmedModel)
  ) {
    return settings.memory_background_system_prompt_by_model[trimmedModel];
  }
  return settings.memory_background_system_prompt || '';
}

/**
 * 将后台系统提示词附加到后台任务消息列表的最顶部。
 * - 如果 messages 第一条是 system 角色，则将自定义提示词拼接在该 system 消息内容最前方（以双换行分隔）
 * - 否则在 messages 最前方新增一条 system 消息
 * - 若未配置后台系统提示词（空字符串或纯空格），原样返回原 messages
 */
export function applyBackgroundSystemPrompt(
  messages: ChatMessage[],
  promptOrSettings?: string | (Pick<Settings, 'memory_background_system_prompt'> & {
    memory_background_system_prompt_by_model?: Record<string, string>;
  }),
  model?: string,
): ChatMessage[] {
  let prompt = '';
  if (typeof promptOrSettings === 'string') {
    prompt = promptOrSettings.trim();
  } else if (promptOrSettings) {
    prompt = resolveBackgroundSystemPrompt(promptOrSettings, model).trim();
  }
  if (!prompt) return messages;

  if (messages.length > 0 && messages[0].role === 'system') {
    const first = messages[0];
    if (typeof first.content === 'string') {
      const mergedContent = first.content.trim() ? `${prompt}\n\n${first.content}` : prompt;
      return [
        {
          ...first,
          content: mergedContent,
        },
        ...messages.slice(1),
      ];
    }
  }

  return [{ role: 'system', content: prompt }, ...messages];
}
