import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Message } from '@/types';
import { buildBackgroundChatExtraBody, loadSettings, mergeSettingsForBackgroundLlm, resolveBackgroundConfig } from '@/lib/settings';
import { chatCompletion } from '@/lib/api-client';
import { formatZodFieldErrors, imagePromptBodySchema } from '@/lib/schemas';
import { runWithBackgroundLlmDeadline } from '@/lib/background-llm-deadline';
import { structuredLog } from '@/lib/structured-log';
import {
  IMAGE_PROMPT_SENSITIVE_TAG_PATTERN,
  imageTagCoreForSensitivity,
  partitionSensitiveImageTags,
  restoreSensitiveImageTagsToPrompt,
  splitTags,
} from '@/lib/image-prompt-sensitive-tags';
import { stripInlinePrompt } from '@/lib/inline-image-prompt';
import { resolveMessageScope } from '@/lib/conversation-chain';
import {
  formatNaiPromptFields,
  parseNaiPromptFields,
  resolveImagePromptStyle,
  type ImagePromptStyle,
} from '@/lib/nai-image';
import {
  appearanceTagsContextLabel,
  promptGenerationSystemForStyle,
  promptGenerationUserFooterForStyle,
} from '@/lib/image-prompt-instructions';

/**
 * AI 生成图片 prompt — 根据对话上下文和角色信息生成适合文生图的英文标签
 * POST body: { conversation_id: string; message_id?: string; user_hint?: string }
 * - message_id: 触发生图的消息 ID，取该消息及之前共 10 条作为上下文
 * - user_hint: 额外补充说明（最高优先级）
 * 返回: { prompt: string; negative_prompt: string }
 */

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripKnownSensitiveImageTags(text: string, originalImageTags: string): string {
  const sensitiveMatcher = new RegExp(IMAGE_PROMPT_SENSITIVE_TAG_PATTERN.source, 'giu');
  const sensitiveTerms = [...new Set(
    splitTags(originalImageTags)
      .map(imageTagCoreForSensitivity)
      .flatMap(core => [...core.matchAll(sensitiveMatcher)].map(match => match[0].toLowerCase())),
  )].sort((left, right) => right.length - left.length);

  return sensitiveTerms.reduce((sanitized, term) => {
    const termPattern = term.split(/[\s_]+/).map(escapeRegex).join('[\\s_]+');
    const latinBoundaryStart = /^[\x00-\x7F]+$/.test(term)
      ? '(?<![A-Za-z0-9])'
      : '';
    const latinBoundaryEnd = /^[\x00-\x7F]+$/.test(term)
      ? '(?![A-Za-z0-9])'
      : '';
    const variants = [
      `(?:\\d+(?:\\.\\d+)?\\s*::\\s*|::\\s*)${termPattern}\\s*(?:::)?`,
      `${termPattern}\\s*:\\s*\\d+(?:\\.\\d+)?`,
      `(?:<\\s*)?lora\\s*:\\s*${termPattern}(?:\\s*:[^\\s,，;；>]+)?[ \\t]*>?`,
      termPattern,
    ];
    const pattern = new RegExp(
      `${latinBoundaryStart}(?:${variants.join('|')})${latinBoundaryEnd}`,
      'giu',
    );
    return sanitized.replace(pattern, '');
  }, text);
}

function parseLegacyPositiveNegative(result: string): { prompt: string; negativePrompt: string } {
  let prompt = '';
  let negativePrompt = '';
  for (const line of result.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('POSITIVE:')) {
      prompt = trimmed.slice(9).trim();
    } else if (trimmed.startsWith('NEGATIVE:')) {
      negativePrompt = trimmed.slice(9).trim();
    }
  }
  if (!prompt) {
    prompt = result.replace(/POSITIVE:|NEGATIVE:.*$/gm, '').trim();
  }
  return { prompt, negativePrompt };
}

function parseGeneratedImagePrompt(
  result: string,
  style: ImagePromptStyle,
  tags: {
    characterImageTags?: string;
    userImageTags?: string;
  },
): { prompt: string; negativePrompt: string } {
  if (style === 'nai-v5') {
    const fields = parseNaiPromptFields(result);
    if (fields.structured) {
      return {
        prompt: restoreSensitiveImageTagsToPrompt(
          formatNaiPromptFields(fields),
          tags.characterImageTags,
          tags.userImageTags,
        ),
        negativePrompt: fields.uc,
      };
    }
  }

  const parsed = parseLegacyPositiveNegative(result);
  return {
    prompt: restoreSensitiveImageTagsToPrompt(parsed.prompt, tags.characterImageTags, tags.userImageTags),
    negativePrompt: parsed.negativePrompt,
  };
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = imagePromptBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 }
    );
  }

  const { conversation_id, message_id, user_hint } = parsed.data;

  try {
    if (!conversation_id) {
      return NextResponse.json({ error: '缺少 conversation_id' }, { status: 400 });
    }

    const db = getDb();
    const loadedSettings = loadSettings();
    const promptStyle = resolveImagePromptStyle(loadedSettings.image_gen);
    const backgroundConfig = resolveBackgroundConfig(loadedSettings);
    const settings = mergeSettingsForBackgroundLlm(loadedSettings, backgroundConfig, {
      json_mode: false,
      max_tokens: 16384,
    });
    const backgroundExtraBody = buildBackgroundChatExtraBody(loadedSettings, settings.model);

    if (!settings.api_base || !settings.model) {
      return NextResponse.json({ error: '请先配置 LLM API' }, { status: 400 });
    }

    // 获取对话信息
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id) as { character_id: string } | undefined;
    if (!conversation) {
      return NextResponse.json({ error: '对话不存在' }, { status: 404 });
    }

    // 获取角色信息（含 image_tags）
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(conversation.character_id) as {
      name: string;
      personality: string;
      scenario: string;
      image_tags?: string;
      user_image_tags?: string;
    } | undefined;

    // 获取消息上下文：基于触发生图的消息，取该消息及之前共 10 条
    // 链式子对话的历史消息在父对话里，范围要沿 parent 链展开
    const scope = resolveMessageScope(db, conversation_id);
    let messages: Pick<Message, 'role' | 'content'>[];
    if (message_id) {
      // 先找到目标消息的 seq
      const targetMsg = db.prepare(
        `SELECT seq FROM messages WHERE id = ? AND ${scope.sql}`
      ).get(message_id, ...scope.params) as { seq: number } | undefined;
      if (targetMsg) {
        messages = db.prepare(
          `SELECT role, content FROM messages WHERE ${scope.sql} AND role IN ('user','assistant') AND seq <= ? ORDER BY seq DESC LIMIT 10`
        ).all(...scope.params, targetMsg.seq) as Pick<Message, 'role' | 'content'>[];
      } else {
        messages = [];
      }
    } else {
      // 兜底：取最新 10 条
      messages = db.prepare(
        `SELECT role, content FROM messages WHERE ${scope.sql} AND role IN ('user','assistant') ORDER BY seq DESC LIMIT 10`
      ).all(...scope.params) as Pick<Message, 'role' | 'content'>[];
    }
    messages.reverse();

    // 构建上下文
    let context = '';
    const originalImageTags = [character?.image_tags, character?.user_image_tags]
      .filter(Boolean)
      .join(', ')
      .trim();
    if (character) {
      context += `【角色信息】\n`;
      context += `角色名：${character.name}\n`;
      if (character.personality) context += `性格/外貌描述：${character.personality}\n`;
      if (character.scenario) context += `世界观/场景设定：${character.scenario}\n`;
      if (character.image_tags) {
        const { safeForLlm } = partitionSensitiveImageTags(character.image_tags);
        if (safeForLlm) {
          context += `\n${appearanceTagsContextLabel(promptStyle, 'character')}\n${safeForLlm}\n`;
        }
      }
      if (character.user_image_tags) {
        const { safeForLlm: safeUserTags } = partitionSensitiveImageTags(character.user_image_tags);
        if (safeUserTags) {
          context += `\n${appearanceTagsContextLabel(promptStyle, 'user')}\n${safeUserTags}\n`;
        }
      }
    }

    context += '\n【最近对话（用于推断当前场景、动作、情绪）】\n';
    for (const msg of messages) {
      const role = msg.role === 'user' ? '用户' : character?.name || 'AI';
      context += `${role}：${stripInlinePrompt(msg.content)}\n`;
    }

    if (user_hint) {
      context += `\n【用户额外指定（最高优先级）】\n${user_hint}\n`;
    }

    context += `\n${promptGenerationUserFooterForStyle(promptStyle)}`;

    // 气泡生图会把角色描述、场景与最近消息一并发给提示词生成 LLM。
    // 即使 image_tags 中的敏感项在这些自由文本字段里重复出现，出站前也必须统一剥离；
    // LLM 返回后仍会按 originalImageTags 恢复到最终 NAI/SD prompt。
    const contextForLlm = stripKnownSensitiveImageTags(context, originalImageTags);

    const result = await runWithBackgroundLlmDeadline(
      loadedSettings.memory_background_timeout_ms,
      signal => chatCompletion(settings, [
        { role: 'system', content: promptGenerationSystemForStyle(promptStyle) },
        { role: 'user', content: contextForLlm },
      ], signal, backgroundExtraBody),
    );

    const parsedOutput = parseGeneratedImagePrompt(result, promptStyle, {
      characterImageTags: character?.image_tags,
      userImageTags: character?.user_image_tags,
    });

    return NextResponse.json({
      prompt: parsedOutput.prompt,
      negative_prompt: parsedOutput.negativePrompt,
    });
  } catch (err) {
    structuredLog('error', 'image.prompt.failed', {
      requestId: request.headers?.get('x-request-id') ?? undefined,
      operation: 'generate_prompt',
      status: 'failed',
    }, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '生成 prompt 失败' },
      { status: 500 }
    );
  }
}
