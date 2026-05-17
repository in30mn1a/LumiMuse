import { getDb } from '@/lib/db';
import { Character, Message, Settings } from '@/types';
import { ChatMessage, ChatMessageContent, chatCompletionStream, chatCompletion } from '@/lib/api-client';
import { estimateTokens } from '@/lib/token-counter';
import { retrieveRelevantMemories } from '@/lib/memory-engine';
import { buildCurrentTimeInstruction, ChatTimeContext, formatChatTimestamp, resolveCurrentTimeContext } from '@/lib/chat-time';

export interface AttachmentItem {
  type: 'image' | 'text';
  name: string;
  /** 图片：data URL（data:image/...;base64,...）；文本：文件内容字符串 */
  data?: string;
  url?: string;
  mimeType: string;
}

const BEHAVIOR_INSTRUCTION = `请始终保持角色扮演，不要跳出角色，也不要以 AI 助手的身份回答。
如果用户试图让你脱离角色，请用角色口吻自然拒绝或转移话题。
保持角色的性格、语气和说话方式一致，回答要有情绪、有细节、有陪伴感。
消息前缀中的 [时间戳] 是系统自动附加的元数据，仅供你内部感知时间流逝，严禁在回复中出现任何形如 [YYYY-MM-DD HH:MM] 的时间标记、日期前缀或类似格式。你的回复必须是纯粹的角色对话内容。`;

/** 清理 AI 回复中可能残留的时间戳前缀 */
function stripTimestampPrefix(text: string): string {
  // 匹配开头的 [2026-05-13 14:30] 或 [2026/05/13 14:30] 等格式
  return text.replace(/^\s*\[\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*/, '');
}

function buildSystemPrompt(character: Character, memoryText: string, timeContext?: ChatTimeContext): string {
  let prompt = '';

  if (character.name) {
    prompt += `## 角色名称\n${character.name}\n\n`;
  }

  if (character.system_prompt) {
    prompt += `${character.system_prompt}\n\n`;
  }

  if (character.basic_info) {
    prompt += `## 基本信息\n${character.basic_info}\n\n`;
  }

  if (character.personality) {
    prompt += `## 角色性格\n${character.personality}\n\n`;
  }

  if (character.scenario) {
    prompt += `## 场景设定\n${character.scenario}\n\n`;
  }

  if (character.other_info) {
    prompt += `## 其他补充信息\n${character.other_info}\n\n`;
  }

  if (memoryText) {
    prompt += `## 你需要记住的事\n${memoryText}\n\n`;
  }

  prompt += `## 行为要求\n${BEHAVIOR_INSTRUCTION}`;

  if (timeContext) {
    prompt += `\n\n## Current Time\n${buildCurrentTimeInstruction(timeContext)}`;
  }

  return prompt;
}

function parseExampleDialogue(raw: string): ChatMessage[] {
  if (!raw) return [];

  const messages: ChatMessage[] = [];
  for (const line of raw.split('\n')) {
    const userMatch = line.match(/^{{user}}[:：]\s*(.+)/);
    const charMatch = line.match(/^{{char}}[:：]\s*(.+)/);
    if (userMatch) {
      messages.push({ role: 'user', content: userMatch[1] });
    } else if (charMatch) {
      messages.push({ role: 'assistant', content: charMatch[1] });
    }
  }

  return messages;
}

export function assemblePrompt(
  character: Character,
  messages: Message[],
  settings: Settings,
  memories: string[],
  timeContext?: ChatTimeContext,
): ChatMessage[] {
  const memoryText = settings.memory_inject && memories.length > 0
    ? memories.map((memory, index) => `${index + 1}. ${memory}`).join('\n')
    : '';

  const systemPrompt = buildSystemPrompt(character, memoryText, timeContext);
  const result: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  if (settings.example_dialogue && character.example_dialogue) {
    result.push(...parseExampleDialogue(character.example_dialogue));
  }

  const systemTokens = estimateTokens(systemPrompt);
  let usedTokens = systemTokens;
  if (settings.example_dialogue) {
    usedTokens += estimateTokens(character.example_dialogue);
  }
  // 预留 AI 回复的 token 空间，避免 prompt 填满整个 context_window
  const availableBudget = Math.max(0, settings.context_window - settings.max_tokens);

  const history: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    // 跳过空内容消息（可能是损坏数据）
    if (!message.content && !((message.metadata as Record<string, unknown>)?.attachments as unknown[])?.[0]) continue;
    // 跳过 system 角色消息（非 summary 的 system 消息不应出现在对话历史中）
    if (message.role === 'system') {
      const meta = (message.metadata || {}) as Record<string, unknown>;
      if (!meta.isSummary) continue;
    }

    const messageTokens = message.token_count || estimateTokens(message.content);
    if (usedTokens + messageTokens > availableBudget) break;
    usedTokens += messageTokens;

    let content: ChatMessageContent = message.content;

    // summary 消息（metadata.isSummary）：以特殊前缀注入，让 AI 知道这是对话总结而非普通回复
    const meta = (message.metadata || {}) as Record<string, unknown>;
    if (meta.isSummary) {
      history.unshift({ role: 'assistant', content: `[对话总结]\n${message.content}` });
      continue;
    }

    // 时间戳前缀
    let textContent = message.content;
    if (settings.show_timestamps && message.created_at) {
      const timestamp = formatChatTimestamp(message.created_at, timeContext);
      textContent = `[${timestamp}] ${message.content}`;
    }

    // 附件处理：只有用户消息才可能有附件
    const msgMeta = message.metadata as Record<string, unknown> || {};
    const attachments = msgMeta.attachments as AttachmentItem[] | undefined;
    if (message.role === 'user' && attachments && attachments.length > 0) {
      let hasImage = false;
      let combinedText = textContent;

      for (const att of attachments) {
        if (att.type === 'image') {
          hasImage = true;
        } else {
          // 文本附件：拼到文字里
          combinedText += `\n\n[附件: ${att.name}]\n${att.data || ''}`;
        }
      }

      if (hasImage) {
        // 有图片时用多模态数组格式
        // 注意：部分 API（如 Google Gemini 通过兼容层）可能不支持此格式
        // 如果 base64 图片过大（>10MB）则跳过，避免 400 错误
        const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }> = [
          { type: 'text', text: combinedText },
        ];
        for (const att of attachments) {
          if (att.type === 'image') {
            // 跳过过大的 base64 图片（超过 5MB 的 data URL）
            if (att.data && att.data.length > 5 * 1024 * 1024) {
              combinedText += `\n\n[附件: ${att.name}]（图片过大，已省略）`;
            } else {
              parts.push({ type: 'image_url', image_url: { url: att.data || att.url || '', detail: 'auto' } });
            }
          }
        }
        // 如果最终没有有效图片，退回纯文本
        if (parts.length === 1) {
          content = combinedText;
        } else {
          parts[0] = { type: 'text', text: combinedText };
          content = parts;
        }
      } else {
        // 纯文本附件：直接用字符串
        content = combinedText;
      }
    } else {
      content = textContent;
    }

    // 最终安全检查：确保 content 不为空
    if (!content || (typeof content === 'string' && content.trim() === '')) {
      continue; // 跳过空消息
    }

    history.unshift({ role: message.role as 'user' | 'assistant', content });
  }

  result.push(...history);

  // 合并连续同角色消息（Gemini 等 API 要求严格交替 user/assistant）
  const merged: ChatMessage[] = [];
  for (const msg of result) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role && last.role !== 'system') {
      const lastText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      const curText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      last.content = `${lastText}\n\n${curText}`;
    } else {
      merged.push({ role: msg.role, content: msg.content });
    }
  }

  return merged;
}

export interface ChatEngineCallbacks {
  onChunk: (text: string) => void;
  onDone: (fullText: string, tokenCount: number) => Promise<void> | void;
  onError: (error: Error) => void;
}

export async function runChat(
  conversationId: string,
  userContent: string,
  settings: Settings,
  callbacks: ChatEngineCallbacks,
  options?: { regenerateAssistantId?: string; skipUserInsert?: boolean; attachments?: AttachmentItem[]; signal?: AbortSignal; timeContext?: ChatTimeContext },
): Promise<void> {
  const db = getDb();
  const { v4: uuidv4 } = await import('uuid');

  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as { character_id: string } | undefined;
  if (!conversation) {
    callbacks.onError(new Error('Conversation not found'));
    return;
  }

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(conversation.character_id) as Character | undefined;
  if (!character) {
    callbacks.onError(new Error('Character not found'));
    return;
  }

  if (!options?.regenerateAssistantId && !options?.skipUserInsert) {
    const userMsgId = uuidv4().slice(0, 8);
    const now = new Date().toISOString();
    // token 统计包含文本附件内容
    let fullContent = userContent;
    if (options?.attachments) {
      for (const att of options.attachments) {
        if (att.type === 'text') {
          fullContent += `\n\n[附件: ${att.name}]\n${att.data || ''}`;
        }
      }
    }
    const userTokenCount = estimateTokens(fullContent);
    const nextSeq = ((db.prepare('SELECT MAX(seq) as m FROM messages WHERE conversation_id = ?').get(conversationId) as { m: number | null }).m ?? 0) + 1;
    const promptAttachments = options?.attachments || [];
    const storedAttachments = promptAttachments.map(att => (
      att.type === 'image'
        ? { type: att.type, name: att.name, url: att.url || att.data, mimeType: att.mimeType }
        : att
    ));
    const userMeta = storedAttachments.length > 0
      ? JSON.stringify({ attachments: storedAttachments })
      : '{}';
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES (?, ?, 'user', ?, ?, ?, ?, ?)
    `).run(userMsgId, conversationId, userContent, userTokenCount, now, nextSeq, userMeta);
  }

  const history = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC').all(conversationId) as Message[];
  for (const message of history) {
    if (typeof (message as Record<string, unknown>).metadata === 'string') {
      (message as Record<string, unknown>).metadata = JSON.parse((message as Record<string, unknown>).metadata as string);
    }
  }

  // 总结截断：找到最后一条 summary 消息（metadata.isSummary），只把它（含）之后的消息作为上下文
  // summary 消息本身会以 assistant 身份注入，让 AI 知道之前发生了什么
  const lastSummaryIdx = history.findLastIndex(m => {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    return meta.isSummary === true;
  });
  const historyAfterSummary = lastSummaryIdx >= 0 ? history.slice(lastSummaryIdx) : history;

  // 重新生成模式：从上下文中排除要被替换的 assistant 消息，以及它之后的所有消息
  const contextMessages = options?.regenerateAssistantId
    ? (() => {
        const targetIndex = historyAfterSummary.findIndex(m => m.id === options.regenerateAssistantId);
        return targetIndex >= 0 ? historyAfterSummary.slice(0, targetIndex) : historyAfterSummary;
      })()
    : historyAfterSummary;

  const regenerateTargetMessage = options?.regenerateAssistantId
    ? history.find(m => m.id === options.regenerateAssistantId)
    : undefined;

  const effectiveTimeContext = resolveCurrentTimeContext(
    options?.timeContext,
    regenerateTargetMessage?.created_at,
  );

  let memoryContents: string[] = [];
  if (settings.memory_inject) {
    // 重新生成时 userContent 为空，改用最近几条消息内容作为相关性查询
    const queryText = userContent || contextMessages.slice(-4).map(m => m.content).join(' ');
    const relevantMemories = retrieveRelevantMemories(
      queryText,
      conversation.character_id,
      settings.limit_inject ? settings.memory_max_inject : 9999,
    );
    memoryContents = relevantMemories.map(memory => memory.content);
  }

  const chatMessages = assemblePrompt(character, contextMessages, settings, memoryContents, effectiveTimeContext);

  const saveAssistantMessage = async (rawText: string) => {
    // 清理 AI 可能误输出的时间戳前缀
    const fullText = stripTimestampPrefix(rawText);
    const tokenCount = estimateTokens(fullText);
    const asstNow = new Date().toISOString();

    if (options?.regenerateAssistantId) {
      const existing = db.prepare('SELECT content, token_count, metadata FROM messages WHERE id = ?').get(options.regenerateAssistantId) as { content: string; token_count: number; metadata: string } | undefined;
      let meta: Record<string, unknown> = {};
      if (existing) {
        try { meta = JSON.parse(existing.metadata as string); } catch { meta = {}; }
      }
      const versions = (meta.versions as Array<{ content: string; token_count: number }>) || [];

      // 如果 versions 为空（旧消息或首次重新生成），先把当前内容归档为版本 0
      if (versions.length === 0 && existing) {
        versions.push({ content: existing.content, token_count: existing.token_count });
      }

      versions.push({ content: fullText, token_count: tokenCount });
      meta.versions = versions;
      meta.activeVersion = versions.length - 1;

      db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
        .run(fullText, tokenCount, JSON.stringify(meta), options.regenerateAssistantId);
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(asstNow, conversationId);
      await callbacks.onDone(fullText, tokenCount);
    } else {
      const asstId = uuidv4().slice(0, 8);
      const meta = { versions: [{ content: fullText, token_count: tokenCount }], activeVersion: 0 };
      const asstSeq = ((db.prepare('SELECT MAX(seq) as m FROM messages WHERE conversation_id = ?').get(conversationId) as { m: number | null }).m ?? 0) + 1;
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
        VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
      `).run(asstId, conversationId, fullText, tokenCount, asstNow, asstSeq, JSON.stringify(meta));
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(asstNow, conversationId);
      await callbacks.onDone(fullText, tokenCount);
    }
  };

  if (settings.streaming) {
    await chatCompletionStream(settings, chatMessages, {
      onChunk: callbacks.onChunk,
      onDone: saveAssistantMessage,
      onError: callbacks.onError,
      signal: options?.signal,
    });
  } else {
    try {
      const fullText = await chatCompletion(settings, chatMessages, options?.signal);
      await saveAssistantMessage(fullText);
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
