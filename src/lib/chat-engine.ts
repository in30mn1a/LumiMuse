import * as crypto from 'crypto';
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { getDb } from '@/lib/db';
import { Character, Message, Settings, MessageAttachment } from '@/types';
import { ChatMessage, ChatMessageContent, chatCompletionStream, chatCompletion, LlmUsage } from '@/lib/api-client';
import { estimateTokens } from '@/lib/token-counter';
import { retrieveRelevantMemories } from '@/lib/memory-engine';
import { retrieveWorkingMemoryPackage } from '@/lib/memory-retrieval';
import { buildCurrentTimeInstruction, ChatTimeContext, formatChatTimestamp, resolveCurrentTimeContext } from '@/lib/chat-time';
import { serializeTypedMessages, parseMessageMetadata } from '@/lib/messages';
import { buildInlinePromptInstruction, extractInlinePrompt, stripInlinePrompt } from '@/lib/inline-image-prompt';
import {
  buildMessageTokenCountContent,
  createMessageTokenCount,
  metadataWithTokenCountProvenance,
  resolveMessageTokenCount,
} from '@/lib/message-token-provenance';
import {
  DEFAULT_MEMORY_PACKAGE_TOKEN_BUDGET,
  MEMORY_CONTEXT_TITLE,
  MEMORY_USAGE_PRINCIPLES,
} from '@/lib/memory-prompt-contract';

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

function normalizeMemoryContextText(memoryText: string): string {
  const trimmed = memoryText.trim();
  if (!trimmed) return '';

  const body = trimmed.startsWith(MEMORY_CONTEXT_TITLE)
    ? trimmed.slice(MEMORY_CONTEXT_TITLE.length).trim()
    : trimmed;
  const bodyWithoutPrinciples = body.replace(/\n*### 记忆使用原则[\s\S]*$/u, '').trim();

  return [
    MEMORY_CONTEXT_TITLE,
    bodyWithoutPrinciples,
    MEMORY_USAGE_PRINCIPLES,
  ].filter(Boolean).join('\n\n');
}

function memoryPackageTokenBudget(settings: Settings): number {
  const budget = Number(settings.memory_engine?.memory_package_token_budget);
  return Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_MEMORY_PACKAGE_TOKEN_BUDGET;
}

function renderLegacyMemoryContext(memories: string[], settings: Settings): string {
  const selected: string[] = [];
  const budget = memoryPackageTokenBudget(settings);

  for (const memory of memories) {
    const content = memory.trim();
    if (!content) continue;

    const next = [...selected, content];
    const candidateText = normalizeMemoryContextText(
      `### 本轮相关回忆\n${next.map(item => `- ${item}`).join('\n')}`,
    );
    if (estimateTokens(candidateText) <= budget) {
      selected.push(content);
    }
  }

  if (selected.length === 0) return '';
  return `### 本轮相关回忆\n${selected.map(item => `- ${item}`).join('\n')}`;
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
    prompt += `${normalizeMemoryContextText(memoryText)}\n\n`;
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
  memories: string[] | string,
  timeContext?: ChatTimeContext,
): Promise<ChatMessage[]> {
  const memoryText = settings.memory_inject
    ? (typeof memories === 'string' ? memories.trim() : renderLegacyMemoryContext(memories, settings))
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
    const baseTokens = resolveMessageTokenCount(message).tokenCount;
    const messageTokens = baseTokens
      + (settings.show_timestamps && message.created_at ? TIMESTAMP_TOKEN_OVERHEAD : 0);
    // 至少保证最新一条有效消息(通常是当前用户输入)进入上下文,即使系统提示+记忆包已逼近预算——
    // 否则它会被整条丢弃,模型收不到用户当下的输入,违反「当前消息优先」。后续较旧消息仍按预算截断。
    if (history.length > 0 && usedTokens + messageTokens > availableBudget) break;
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
      let combinedText = buildMessageTokenCountContent(textContent, message.role, attachments);

      for (const att of attachments) {
        if (att.type === 'image') {
          hasImage = true;
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
  // 内联生图提示词：把指令追加到最后一条 user 消息尾部（约束力最强，实测稳定触发）。
  // 仅作用于发给模型的请求副本，不落库 —— 避免污染对话记录 / 记忆 / 前端显示。
  if (settings.image_gen?.enabled && settings.image_gen?.inline_prompt) {
    const instruction = buildInlinePromptInstruction(character.image_tags, character.user_image_tags);
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const msg = merged[i];
      if (msg.role !== 'user') continue;
      if (typeof msg.content === 'string') {
        msg.content = `${msg.content}\n\n${instruction}`;
      } else if (Array.isArray(msg.content)) {
        // 多模态：追加到第一个 text part；若无 text part 则插入一个
        const textIdx = msg.content.findIndex(p => p.type === 'text');
        if (textIdx >= 0) {
          const part = msg.content[textIdx] as { type: 'text'; text: string };
          msg.content[textIdx] = { type: 'text', text: `${part.text}\n\n${instruction}` };
        } else {
          msg.content.unshift({ type: 'text', text: instruction });
        }
      }
      break;
    }
  }

  return merged;
}

export interface ChatEngineCallbacks {
  onChunk: (text: string) => void;
  onDone: (fullText: string, tokenCount: number) => Promise<void> | void;
  onError: (error: Error) => void;
  /**
   * 上游返回真实 usage 时触发（流式在最后一个 chunk，非流式在响应 body）。
   * 上游未返回 usage 时不调用，调用方应保留估算逻辑作为 fallback。
   */
  onUsage?: (usage: LlmUsage) => void;
}

export async function runChat(
  conversationId: string,
  userContent: string,
  settings: Settings,
  callbacks: ChatEngineCallbacks,
  options?: { regenerateAssistantId?: string; skipUserInsert?: boolean; attachments?: AttachmentItem[]; signal?: AbortSignal; timeContext?: ChatTimeContext },
): Promise<void> {
  const db = getDb();

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
    const userMsgId = crypto.randomUUID().slice(0, 12);
    const now = new Date().toISOString();
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
    const userTokenResult = createMessageTokenCount(userContent, 'user', storedAttachments);
    const userMeta = JSON.stringify(metadataWithTokenCountProvenance(
      storedAttachments.length > 0 ? { attachments: storedAttachments } : {},
      userTokenResult.provenance,
    ));
    // 用事务包裹 SELECT MAX(seq) + INSERT，避免并发写入产生重复 seq
    db.transaction(() => {
      const nextSeq = ((db.prepare('SELECT MAX(seq) as m FROM messages WHERE conversation_id = ?').get(conversationId) as { m: number | null }).m ?? 0) + 1;
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
        VALUES (?, ?, 'user', ?, ?, ?, ?, ?)
      `).run(userMsgId, conversationId, userContent, userTokenResult.tokenCount, now, nextSeq, userMeta);
    })();
  }

  const regenerateTargetMessage = options?.regenerateAssistantId
    ? db.prepare('SELECT created_at, seq FROM messages WHERE id = ? AND conversation_id = ?')
        .get(options.regenerateAssistantId, conversationId) as { created_at: string; seq: number } | undefined
    : undefined;

  // 正常聊天定位全局最后一条 summary；重新生成则只定位目标消息之前的最后 summary。
  // 这样既保持有界读取，也不会把目标之后的“未来消息”错误送入重新生成上下文。
  const summarySql = `
    SELECT seq
    FROM messages
    WHERE conversation_id = ?
      ${regenerateTargetMessage ? 'AND seq < ?' : ''}
      AND CASE WHEN json_valid(metadata)
               THEN json_extract(metadata, '$.isSummary') = 1
               ELSE 0 END
    ORDER BY seq DESC
    LIMIT 1
  `;
  const lastSummary = (regenerateTargetMessage
    ? db.prepare(summarySql).get(conversationId, regenerateTargetMessage.seq)
    : db.prepare(summarySql).get(conversationId)) as { seq: number } | undefined;
  const historySql = [
    'SELECT * FROM messages WHERE conversation_id = ?',
    lastSummary ? 'AND seq >= ?' : '',
    regenerateTargetMessage ? 'AND seq < ?' : '',
    'ORDER BY created_at ASC, seq ASC',
  ].filter(Boolean).join(' ');
  const historyParams: Array<string | number> = [conversationId];
  if (lastSummary) historyParams.push(lastSummary.seq);
  if (regenerateTargetMessage) historyParams.push(regenerateTargetMessage.seq);
  const history = serializeTypedMessages(
    db.prepare(historySql).all(...historyParams) as Message[]
  );
  const repairTokenCount = db.prepare(
    'UPDATE messages SET token_count = ?, metadata = ? WHERE id = ?',
  );
  const contextMessages = history.map(message => {
    const resolved = resolveMessageTokenCount(message);
    if (resolved.reused) return message;
    const metadata = metadataWithTokenCountProvenance(message.metadata, resolved.provenance);
    repairTokenCount.run(resolved.tokenCount, JSON.stringify(metadata), message.id);
    return { ...message, token_count: resolved.tokenCount, metadata };
  });

  const effectiveTimeContext = resolveCurrentTimeContext(
    options?.timeContext,
    regenerateTargetMessage?.created_at,
  );

  let memoryContents: string[] | string = [];
  // 上一轮记忆注入统计：注入条数 + 实际 token 数（来自 workingMemoryPackage 或 fallback）
  // 存入 assistant 消息 metadata.last_memory_injection，供前端 TokenBreakdownModal 展示
  let lastMemoryInjection: { count: number; tokens: number; mode?: string } | undefined;
  if (settings.memory_inject) {
    // 重新生成时 userContent 为空，改用最近几条消息内容作为相关性查询
    const queryText = userContent || contextMessages.slice(-4).map(m => m.content).join(' ');
    try {
      // 记忆包预算额外受当前 context_window 钳制:不超过「可用预算(context_window - max_tokens)」的一半,
      // 为系统提示、对话历史和当前用户消息留出空间,避免记忆包撑爆上下文、挤掉当前对话。
      // 正常大窗口配置(默认 context_window=131072)下该上限远大于记忆预算,不产生影响;仅在窗口调得很小时收紧。
      const availableBudget = Math.max(0, settings.context_window - settings.max_tokens);
      const memoryBudgetCap = Math.floor(availableBudget / 2);
      const retrievalSettings = memoryBudgetCap > 0 && memoryBudgetCap < settings.memory_engine.memory_package_token_budget
        ? { ...settings, memory_engine: { ...settings.memory_engine, memory_package_token_budget: memoryBudgetCap } }
        : settings;
      const workingMemoryPackage = await retrieveWorkingMemoryPackage({
        characterId: conversation.character_id,
        queryText,
        settings: retrievalSettings,
      });
      memoryContents = workingMemoryPackage.text;
      lastMemoryInjection = {
        count: workingMemoryPackage.selectedMemories.length,
        tokens: workingMemoryPackage.tokenCount,
        mode: workingMemoryPackage.mode,
      };
    } catch (error) {
      console.warn('[chat-engine] 工作记忆包检索失败，回退旧记忆检索:', error);
      try {
        const relevantMemories = retrieveRelevantMemories(
          queryText,
          conversation.character_id,
          settings.memory_max_inject || 30,
        );
        memoryContents = relevantMemories.map(memory => memory.content);
        // fallback 路径没有精确 tokenCount，用 0 表示未知（前端不展示 token 数，只展示条数）
        lastMemoryInjection = { count: relevantMemories.length, tokens: 0, mode: 'legacy-fallback' };
      } catch (fallbackError) {
        console.warn('[chat-engine] 旧记忆检索回退也失败，本轮不注入记忆:', fallbackError);
        memoryContents = [];
        lastMemoryInjection = { count: 0, tokens: 0, mode: 'failed' };
      }
    }
  }

  const chatMessages = await assemblePrompt(character, contextMessages, settings, memoryContents, effectiveTimeContext);

  // 捕获上游返回的真实 usage（流式在最后一个 chunk，非流式在响应 body）。
  // abort 场景下可能未捕获到（usage 在流末尾），此时 metadata 不写入 last_usage。
  let capturedUsage: LlmUsage | undefined;

  const saveAssistantMessage = async (rawText: string) => {
    // 清理 AI 可能误输出的时间戳前缀
    const withoutTs = stripTimestampPrefix(rawText);
    // 内联生图提示词：提取 [IMG]...[/IMG] 并从正文剥离，保证落库/上下文/记忆/token 都干净
    const inlinePrompt = extractInlinePrompt(withoutTs);
    const fullText = inlinePrompt ? stripInlinePrompt(withoutTs) : withoutTs;
    const tokenResult = createMessageTokenCount(fullText, 'assistant');
    const tokenCount = tokenResult.tokenCount;
    const asstNow = new Date().toISOString();
    const wasStopped = options?.signal?.aborted === true;

    // 上报真实 usage 给上层（chat/route.ts 会通过 SSE 传给前端）
    if (capturedUsage && callbacks.onUsage) {
      try {
        callbacks.onUsage(capturedUsage);
      } catch {
        // 上报失败不影响保存
      }
    }

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
      if (inlinePrompt) {
        meta.inlineImagePrompt = inlinePrompt;
      } else {
        delete meta.inlineImagePrompt;
      }
      if (wasStopped) {
        meta.generation_stopped = true;
        meta.generation_stop_reason = 'abort';
      } else {
        delete meta.generation_stopped;
        delete meta.generation_stop_reason;
      }
      // 保存上游真实 usage，供前端展示「上次真实输入 token」校准估算
      if (capturedUsage) {
        meta.last_usage = capturedUsage;
      }
      // 保存本轮记忆注入统计（条数 + token 数 + 模式），供前端展示
      if (lastMemoryInjection) {
        meta.last_memory_injection = lastMemoryInjection;
      }
      meta.token_count_provenance = tokenResult.provenance;

      // 用事务包裹两条 UPDATE，保持与新建分支对称、避免半成功状态
      // 注：重新生成 assistant 消息时不调用 invalidateMemoriesForSourceMessage。
      // 记忆内容来自「用户事实 + assistant 回复」，重新生成只改变回复内容，
      // 用户事实仍然有效；之前在此处让记忆 superseded 是错误设计，会让正常记忆被误标。
      db.transaction(() => {
        db.prepare('UPDATE messages SET content = ?, token_count = ?, metadata = ? WHERE id = ?')
          .run(fullText, tokenCount, JSON.stringify(meta), options.regenerateAssistantId);
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(asstNow, conversationId);
      })();
      await callbacks.onDone(fullText, tokenCount);
    } else {
      const asstId = crypto.randomUUID().slice(0, 12);
      const meta: Record<string, unknown> = {
        versions: [{ content: fullText, token_count: tokenCount }],
        activeVersion: 0,
        token_count_provenance: tokenResult.provenance,
      };
      if (inlinePrompt) {
        meta.inlineImagePrompt = inlinePrompt;
      }
      if (wasStopped) {
        meta.generation_stopped = true;
        meta.generation_stop_reason = 'abort';
      }
      // 保存上游真实 usage，供前端展示「上次真实输入 token」校准估算
      if (capturedUsage) {
        meta.last_usage = capturedUsage;
      }
      // 保存本轮记忆注入统计（条数 + token 数 + 模式），供前端展示
      if (lastMemoryInjection) {
        meta.last_memory_injection = lastMemoryInjection;
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
      onUsage: (usage) => { capturedUsage = usage; },
      signal: options?.signal,
    });
  } else {
    try {
      const fullText = await chatCompletion(
        settings,
        chatMessages,
        options?.signal,
        undefined,
        (usage) => { capturedUsage = usage; },
      );
      await saveAssistantMessage(fullText);
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
