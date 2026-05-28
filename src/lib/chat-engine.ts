import { readFile, stat } from 'fs/promises';
import path from 'path';
import { getDb } from '@/lib/db';
import { Character, Message, Settings, MessageAttachment } from '@/types';
import { ChatMessage, ChatMessageContent, chatCompletionStream, chatCompletion } from '@/lib/api-client';
import { estimateTokens } from '@/lib/token-counter';
import { retrieveRelevantMemories } from '@/lib/memory-engine';
import { buildCurrentTimeInstruction, ChatTimeContext, formatChatTimestamp, resolveCurrentTimeContext } from '@/lib/chat-time';
import { serializeTypedMessages, parseMessageMetadata } from '@/lib/messages';

/**
 * 消息附件类型。重新导出 MessageAttachment 别名以保持外部 API 不变
 * （chat/route.ts、组件层等仍以 AttachmentItem 为名引用）。
 */
export type AttachmentItem = MessageAttachment;

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const LOCAL_ATTACHMENT_PREFIX = '/api/files/attachments/';
const LEGACY_ATTACHMENT_PREFIX = '/attachments/';
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function getDataUrlByteLength(dataUrl: string): number | null {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) return null;

  const meta = dataUrl.slice(0, commaIndex).toLowerCase();
  if (!meta.startsWith('data:image/')) return null;

  const payload = dataUrl.slice(commaIndex + 1);
  if (meta.endsWith(';base64')) {
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return Math.floor(payload.length * 3 / 4) - padding;
  }

  try {
    return Buffer.byteLength(decodeURIComponent(payload), 'utf8');
  } catch {
    return null;
  }
}

function resolveLocalAttachmentPath(url?: string): string | null {
  if (!url) return null;

  let pathname = url.split('?')[0].split('#')[0];
  if (/^https?:\/\//i.test(url)) {
    try {
      pathname = new URL(url).pathname;
    } catch {
      return null;
    }
  }

  let filename = '';
  if (pathname.startsWith(LOCAL_ATTACHMENT_PREFIX)) {
    filename = pathname.slice(LOCAL_ATTACHMENT_PREFIX.length);
  } else if (pathname.startsWith(LEGACY_ATTACHMENT_PREFIX)) {
    filename = pathname.slice(LEGACY_ATTACHMENT_PREFIX.length);
  } else {
    return null;
  }

  try {
    filename = decodeURIComponent(filename);
  } catch {
    return null;
  }

  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..') || filename.includes('\0')) return null;
  return path.join(process.cwd(), 'public', 'attachments', filename);
}

async function resolveAttachmentImageForModel(att: MessageAttachment): Promise<{ url?: string; note?: string }> {
  const directDataUrl = att.data || (att.url?.startsWith('data:image/') ? att.url : undefined);
  if (directDataUrl) {
    const byteLength = getDataUrlByteLength(directDataUrl);
    if (byteLength !== null && byteLength <= MAX_INLINE_IMAGE_BYTES) {
      return { url: directDataUrl };
    }
    return { note: '图片超过 5MB，已作为文字提示保留。' };
  }

  const localPath = resolveLocalAttachmentPath(att.url);
  if (localPath) {
    try {
      const fileStat = await stat(localPath);
      if (!fileStat.isFile()) return { note: '图片文件不可读取。' };
      if (fileStat.size > MAX_INLINE_IMAGE_BYTES) return { note: '图片超过 5MB，已作为文字提示保留。' };

      const ext = path.extname(localPath).slice(1).toLowerCase();
      const mimeType = IMAGE_MIME_BY_EXT[ext] || att.mimeType;
      if (!mimeType?.startsWith('image/')) return { note: '图片格式无法识别。' };

      const buffer = await readFile(localPath);
      return { url: 'data:' + mimeType + ';base64,' + buffer.toString('base64') };
    } catch {
      return { note: '图片文件不可读取。' };
    }
  }

  if (att.url && /^https?:\/\//i.test(att.url)) {
    return { url: att.url };
  }

  return { note: '图片附件没有可传给模型的内容。' };
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

export async function assemblePrompt(
  character: Character,
  messages: Message[],
  settings: Settings,
  memories: string[],
  timeContext?: ChatTimeContext,
): Promise<ChatMessage[]> {
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
    const meta = message.metadata;
    // 跳过空内容消息（可能是损坏数据）
    if (!message.content && !meta.attachments?.[0]) continue;
    // 跳过 system 角色消息（非 summary 的 system 消息不应出现在对话历史中）
    if (message.role === 'system' && !meta.isSummary) continue;

    // 估算本条消息的 token 占用：基础内容 + 可能的时间戳前缀
    // 时间戳形如 "[2026-05-13 14:30] "（约 19 个字符），在 estimateTokens 里
    // ASCII 0.25 token、空格按 0.25 计算，整体 ~5 token。预算时计入，避免长会话
    // 因为时间戳累积偏差导致预算超支。
    const TIMESTAMP_TOKEN_OVERHEAD = 5;
    const baseTokens = message.token_count || estimateTokens(message.content);
    const messageTokens = baseTokens
      + (settings.show_timestamps && message.created_at ? TIMESTAMP_TOKEN_OVERHEAD : 0);
    if (usedTokens + messageTokens > availableBudget) break;
    usedTokens += messageTokens;

    let content: ChatMessageContent = message.content;

    // summary 消息（metadata.isSummary）：以特殊前缀注入，让 AI 知道这是对话总结而非普通回复
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
    const attachments = meta.attachments;
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
        const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }> = [
          { type: 'text', text: combinedText },
        ];
        for (const att of attachments) {
          if (att.type === 'image') {
            const imageForModel = await resolveAttachmentImageForModel(att);
            if (imageForModel.url) {
              parts.push({ type: 'image_url', image_url: { url: imageForModel.url, detail: 'auto' } });
            } else {
              combinedText += `\n\n[图片附件: ${att.name}] ${imageForModel.note || '无法读取。'}`;
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
  // 多模态 content 是数组结构，不能用 JSON.stringify 直接拼接，否则下游 LLM 会收到字符串而非结构化 parts
  const merged: ChatMessage[] = [];
  for (const msg of result) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role && last.role !== 'system') {
      const lastIsArray = Array.isArray(last.content);
      const curIsArray = Array.isArray(msg.content);

      if (!lastIsArray && !curIsArray) {
        // 两条都是纯文本：直接拼接
        last.content = `${last.content as string}\n\n${msg.content as string}`;
      } else {
        // 任一是多模态：归一化为数组结构后合并
        const lastParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }> =
          lastIsArray
            ? [...(last.content as Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }>)]
            : [{ type: 'text', text: last.content as string }];
        const curParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }> =
          curIsArray
            ? (msg.content as Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }>)
            : [{ type: 'text', text: msg.content as string }];

        // 文本部分合并到第一个 text part；图片部分按出现顺序追加
        const firstTextIdx = lastParts.findIndex(p => p.type === 'text');
        const curTextSegments: string[] = [];
        const curImages: typeof curParts = [];
        for (const part of curParts) {
          if (part.type === 'text') {
            if (part.text) curTextSegments.push(part.text);
          } else {
            curImages.push(part);
          }
        }
        const curTextJoined = curTextSegments.join('\n\n');

        if (curTextJoined) {
          if (firstTextIdx >= 0) {
            const firstText = lastParts[firstTextIdx] as { type: 'text'; text: string };
            lastParts[firstTextIdx] = { type: 'text', text: `${firstText.text}\n\n${curTextJoined}` };
          } else {
            lastParts.unshift({ type: 'text', text: curTextJoined });
          }
        }
        for (const img of curImages) lastParts.push(img);

        last.content = lastParts;
      }
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
    const userMsgId = uuidv4().slice(0, 12);
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
    const promptAttachments = options?.attachments || [];
    // 落库时要求 image 必须有 URL；无 URL 的 base64 仅作为内存中的 prompt 多模态输入，
    // 不写入 messages.metadata，避免 DB 体积爆炸 + 后续 SELECT * 拖慢。
    const storedAttachments: AttachmentItem[] = [];
    for (const att of promptAttachments) {
      if (att.type === 'image') {
        if (!att.url) {
          console.warn(`[chat-engine] 丢弃无 URL 的 image 附件（仅 base64），不入库: ${att.name}`);
          continue;
        }
        storedAttachments.push({ type: att.type, name: att.name, url: att.url, mimeType: att.mimeType });
      } else {
        storedAttachments.push(att);
      }
    }
    const userMeta = storedAttachments.length > 0
      ? JSON.stringify({ attachments: storedAttachments })
      : '{}';
    // 用事务包裹 SELECT MAX(seq) + INSERT，避免并发写入产生重复 seq
    db.transaction(() => {
      const nextSeq = ((db.prepare('SELECT MAX(seq) as m FROM messages WHERE conversation_id = ?').get(conversationId) as { m: number | null }).m ?? 0) + 1;
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
        VALUES (?, ?, 'user', ?, ?, ?, ?, ?)
      `).run(userMsgId, conversationId, userContent, userTokenCount, now, nextSeq, userMeta);
    })();
  }

  const history = serializeTypedMessages(
    db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC').all(conversationId) as Message[]
  );

  // 总结截断：找到最后一条 summary 消息（metadata.isSummary），只把它（含）之后的消息作为上下文
  // summary 消息本身会以 assistant 身份注入，让 AI 知道之前发生了什么
  const lastSummaryIdx = history.findLastIndex(m => m.metadata.isSummary === true);
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
    if (settings.limit_inject) {
      // 重新生成时 userContent 为空，改用最近几条消息内容作为相关性查询
      const queryText = userContent || contextMessages.slice(-4).map(m => m.content).join(' ');
      const relevantMemories = retrieveRelevantMemories(
        queryText,
        conversation.character_id,
        settings.memory_max_inject || 30,
      );
      memoryContents = relevantMemories.map(memory => memory.content);
    } else {
      const allMemories = db.prepare(
        'SELECT content FROM memories WHERE character_id = ? ORDER BY updated_at DESC'
      ).all(conversation.character_id) as Array<{ content: string | null }>;
      memoryContents = allMemories
        .map(memory => memory.content || '')
        .filter(Boolean);
    }
  }

  const chatMessages = await assemblePrompt(character, contextMessages, settings, memoryContents, effectiveTimeContext);

  const saveAssistantMessage = async (rawText: string) => {
    // 清理 AI 可能误输出的时间戳前缀
    const fullText = stripTimestampPrefix(rawText);
    const tokenCount = estimateTokens(fullText);
    const asstNow = new Date().toISOString();
    const wasStopped = options?.signal?.aborted === true;

    if (options?.regenerateAssistantId) {
      const existing = db.prepare('SELECT content, token_count, metadata FROM messages WHERE id = ?').get(options.regenerateAssistantId) as { content: string; token_count: number; metadata: string } | undefined;
      const meta = existing ? parseMessageMetadata(existing.metadata) : {};
      const versions = meta.versions || [];

      // 如果 versions 为空（旧消息或首次重新生成），先把当前内容归档为版本 0
      if (versions.length === 0 && existing) {
        versions.push({ content: existing.content, token_count: existing.token_count });
      }

      versions.push({ content: fullText, token_count: tokenCount });
      meta.versions = versions;
      meta.activeVersion = versions.length - 1;
      if (wasStopped) {
        meta.generation_stopped = true;
        meta.generation_stop_reason = 'abort';
      } else {
        delete meta.generation_stopped;
        delete meta.generation_stop_reason;
      }

      // 用事务包裹两条 UPDATE，保持与新建分支对称、避免半成功状态
      db.transaction(() => {
        db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
          .run(fullText, tokenCount, JSON.stringify(meta), options.regenerateAssistantId);
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(asstNow, conversationId);
      })();
      await callbacks.onDone(fullText, tokenCount);
    } else {
      const asstId = uuidv4().slice(0, 12);
      const meta: Record<string, unknown> = { versions: [{ content: fullText, token_count: tokenCount }], activeVersion: 0 };
      if (wasStopped) {
        meta.generation_stopped = true;
        meta.generation_stop_reason = 'abort';
      }
      // 用事务包裹 SELECT MAX(seq) + INSERT，避免并发写入产生重复 seq
      db.transaction(() => {
        const asstSeq = ((db.prepare('SELECT MAX(seq) as m FROM messages WHERE conversation_id = ?').get(conversationId) as { m: number | null }).m ?? 0) + 1;
        db.prepare(`
          INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
        `).run(asstId, conversationId, fullText, tokenCount, asstNow, asstSeq, JSON.stringify(meta));
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(asstNow, conversationId);
      })();
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
