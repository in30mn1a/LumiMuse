import { NextRequest } from 'next/server';
import { runChat, AttachmentItem } from '@/lib/chat-engine';
import { getDb } from '@/lib/db';
import { Settings, Message } from '@/types';
import { loadSettings } from '@/lib/settings';
import { enqueueExtraction } from '@/lib/memory-queue';
import { ChatTimeContext } from '@/lib/chat-time';

export async function POST(request: NextRequest) {
  const { conversation_id, content, regenerate_assistant_id, skip_user_insert, attachments, client_now_iso, client_timezone, client_utc_offset_minutes } = await request.json() as {
    conversation_id: string;
    content: string;
    regenerate_assistant_id?: string;
    skip_user_insert?: boolean;
    attachments?: AttachmentItem[];
    client_now_iso?: string;
    client_timezone?: string;
    client_utc_offset_minutes?: number;
  };

  if (!conversation_id || (!regenerate_assistant_id && !content && (!attachments || attachments.length === 0))) {
    return new Response(JSON.stringify({ error: 'Missing conversation_id or content' }), { status: 400 });
  }

  const db = getDb();
  const settings = loadSettings();
  const timeContext: ChatTimeContext = {
    clientNowIso: client_now_iso,
    timeZone: client_timezone,
    utcOffsetMinutes: typeof client_utc_offset_minutes === 'number' ? client_utc_offset_minutes : undefined,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // 用 closed 标志保证 controller 只被关一次
      // 并且所有 enqueue 都在 try/catch 中兜底，避免异步回调在流已关闭后抛 ERR_INVALID_STATE
      let closed = false;
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 已被底层关闭（如客户端 abort），忽略
        }
      };
      const send = (event: string, data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          // 流已关闭（客户端断开或 abort），标记为 closed 防止后续再写
          closed = true;
        }
      };

      // 客户端断开 / abort 时立刻标记关闭，避免后续 onChunk/onDone 异步回调继续 enqueue
      const onAbort = () => {
        closed = true;
      };
      request.signal.addEventListener('abort', onAbort);

      try {
        const options = regenerate_assistant_id
          ? { regenerateAssistantId: regenerate_assistant_id, skipUserInsert: true, signal: request.signal }
          : skip_user_insert
            ? { skipUserInsert: true, signal: request.signal }
            : attachments && attachments.length > 0
              ? { attachments, signal: request.signal }
              : { signal: request.signal };

        await runChat(conversation_id, content, settings, {
          onChunk: (text) => send('chunk', JSON.stringify({ text })),
          onDone: async (fullText, tokenCount) => {
            send('done', JSON.stringify({ token_count: tokenCount }));

            const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id) as { character_id: string; ignore_memory: number } | undefined;
            if (!conversation) return;

            // 该对话设置了"忽略记忆提取"，跳过所有触发逻辑
            if (conversation.ignore_memory) return;

            const allMessages = db.prepare(
              'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
            ).all(conversation_id) as Message[];

            for (const msg of allMessages) {
              if (typeof (msg as Record<string, unknown>).metadata === 'string') {
                (msg as Record<string, unknown>).metadata = JSON.parse((msg as Record<string, unknown>).metadata as string);
              }
            }

            // 未提取的用户消息（排除 summary 类型）
            const unextracted = allMessages.filter(message => {
              const meta = message.metadata as Record<string, unknown> || {};
              return message.role === 'user' && !meta.memory_extracted;
            });

            if (unextracted.length === 0) return;

            // 构建完整对话片段：未提取的用户消息 + 紧随其后的 assistant 回复
            // 用 Set 记录未提取用户消息的 id，再把它们之间/之后的 assistant 消息也纳入
            const unextractedIds = new Set(unextracted.map(m => m.id));
            const extractionMessages: Message[] = [];
            let includeNext = false;
            for (const msg of allMessages) {
              const msgMeta = (msg.metadata || {}) as Record<string, unknown>;
              if (msgMeta.isSummary) continue;
              if (unextractedIds.has(msg.id)) {
                extractionMessages.push(msg);
                includeNext = true; // 下一条 assistant 消息也要带上
              } else if (includeNext && msg.role === 'assistant') {
                const meta = msg.metadata as Record<string, unknown> || {};
                if (!meta.memory_extracted) {
                  extractionMessages.push(msg);
                }
                includeNext = false;
              } else {
                includeNext = false;
              }
            }

            // 记忆提取触发判断
            let shouldExtract = false;

            // 1. 间隔消息数触发
            if (settings.memory_trigger_interval_enabled && unextracted.length >= settings.memory_interval) {
              shouldExtract = true;
            }

            // 2. 关键词触发
            if (!shouldExtract && settings.memory_trigger_keyword_enabled && settings.memory_trigger_keywords) {
              const keywords = settings.memory_trigger_keywords.split(',').map(k => k.trim()).filter(Boolean);
              const lastUserMsg = unextracted[unextracted.length - 1]?.content || '';
              if (keywords.some(kw => lastUserMsg.includes(kw))) {
                shouldExtract = true;
              }
            }

            // 3. 固定时间间隔触发：检查距离上次提取是否超过设定小时数
            if (!shouldExtract && settings.memory_trigger_time_enabled && unextracted.length > 0) {
              const hours = settings.memory_trigger_time_hours || 24;
              const lastExtractedMsg = allMessages
                .filter(m => {
                  const meta = m.metadata as Record<string, unknown> || {};
                  return m.role === 'user' && meta.memory_extracted;
                })
                .pop();
              const lastExtractedTime = lastExtractedMsg ? new Date(lastExtractedMsg.created_at).getTime() : 0;
              const now = Date.now();
              if (now - lastExtractedTime >= hours * 60 * 60 * 1000) {
                shouldExtract = true;
              }
            }

            if (shouldExtract) {
              enqueueExtraction(conversation.character_id, conversation_id, extractionMessages);
              send('memory', JSON.stringify({ status: 'extracting' }));
            }
          },
          onError: (error) => {
            send('error', JSON.stringify({ message: error.message }));
            safeClose();
          },
        }, { ...options, timeContext });

        setTimeout(() => safeClose(), 100);
      } catch (err) {
        send('error', JSON.stringify({ message: err instanceof Error ? err.message : 'Unknown error' }));
        safeClose();
      } finally {
        request.signal.removeEventListener('abort', onAbort);
      }
    },
    cancel() {
      // 客户端主动断开（abort/关闭标签页），ReadableStream 会调用 cancel
      // 不需要做额外事情：send/safeClose 会在 closed 标志下自动变成 no-op
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
