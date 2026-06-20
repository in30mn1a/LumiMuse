import { NextRequest } from 'next/server';
import { runChat } from '@/lib/chat-engine';
import { getDb } from '@/lib/db';
import { Message } from '@/types';
import { loadSettings } from '@/lib/settings';
import { enqueueExtraction } from '@/lib/memory-queue';
import { ChatTimeContext } from '@/lib/chat-time';
import { serializeTypedMessages } from '@/lib/messages';
import { chatBodySchema, formatZodFieldErrors, validateChatAttachmentTotals } from '@/lib/schemas';

const EXTRACTING_SIGNAL = JSON.stringify({ status: 'extracting' });
const STREAM_CLOSE_DELAY_MS = 100;
const UNKNOWN_ERROR_LABEL = 'Unknown error';

function isMemoryProcessed(message: Message): boolean {
  return Boolean(
    message.metadata.memory_extracted ||
    typeof message.metadata.memory_noop_extracted_at === 'string'
  );
}

export async function POST(request: NextRequest) {
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const parsed = chatBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const {
    conversation_id,
    content,
    regenerate_assistant_id,
    skip_user_insert,
    attachments,
    client_now_iso,
    client_timezone,
    client_utc_offset_minutes,
  } = parsed.data;

  if (!regenerate_assistant_id && !content && (!attachments || attachments.length === 0)) {
    return new Response(JSON.stringify({ error: 'Missing conversation_id or content' }), { status: 400 });
  }

  const attachmentLimitError = validateChatAttachmentTotals(attachments);
  if (attachmentLimitError) {
    return new Response(
      JSON.stringify({ error: attachmentLimitError.error }),
      { status: attachmentLimitError.status, headers: { 'Content-Type': 'application/json' } },
    );
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
          onUsage: (usage) => send('usage', JSON.stringify(usage)),
          onDone: async (fullText, tokenCount) => {
            send('done', JSON.stringify({ token_count: tokenCount }));

            const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id) as { character_id: string; ignore_memory: number } | undefined;
            if (!conversation) return;

            // 该对话设置了"忽略记忆提取"，跳过所有触发逻辑
            if (conversation.ignore_memory) return;

            // 记忆触发判定 + 入队属于"事后"工作，包含较多 DB 查询和遍历，
            // 同步执行会阻塞 SSE 流的关闭。用 queueMicrotask 异步化，让 done 事件
            // 尽快下发、流尽快关闭；消息保存仍由 runChat 内部同步完成，不会丢消息。
            queueMicrotask(() => {
              try {
                const allMessages = serializeTypedMessages(
                  db.prepare(
                    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
                  ).all(conversation_id) as Message[]
                );

                // 未提取的用户消息（排除 summary 类型）
                const unextracted = allMessages.filter(
                  message => message.role === 'user' && !isMemoryProcessed(message)
                );

                if (unextracted.length === 0) return;

                // 构建完整对话片段：未提取的用户消息 + 紧随其后的 assistant 回复
                // 用 Set 记录未提取用户消息的 id，再把它们之间/之后的 assistant 消息也纳入
                const unextractedIds = new Set(unextracted.map(m => m.id));
                const extractionMessages: Message[] = [];
                let includeNext = false;
                for (const msg of allMessages) {
                  if (msg.metadata.isSummary) continue;
                  if (unextractedIds.has(msg.id)) {
                    extractionMessages.push(msg);
                    includeNext = true; // 下一条 assistant 消息也要带上
                  } else if (includeNext && msg.role === 'assistant') {
                    if (!isMemoryProcessed(msg)) {
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
                    .filter(m => m.role === 'user' && isMemoryProcessed(m))
                    .pop();
                  const lastExtractedTime = lastExtractedMsg ? new Date(lastExtractedMsg.created_at).getTime() : 0;
                  const now = Date.now();
                  if (now - lastExtractedTime >= hours * 60 * 60 * 1000) {
                    shouldExtract = true;
                  }
                }

                if (shouldExtract) {
                  enqueueExtraction(conversation.character_id, conversation_id, extractionMessages);
                  // send 内部已对 closed 做兜底，即便流已关闭也是 no-op
                  send('memory', EXTRACTING_SIGNAL);
                }
              } catch (err) {
                // 异步任务必须自己捕获异常，避免 unhandled rejection 导致进程崩溃
                console.error('Memory trigger evaluation failed:', err);
              }
            });
          },
          onError: (error) => {
            send('error', JSON.stringify({ message: error.message }));
            safeClose();
          },
        }, { ...options, timeContext });

        setTimeout(() => safeClose(), STREAM_CLOSE_DELAY_MS);
      } catch (err) {
        send('error', JSON.stringify({ message: err instanceof Error ? err.message : UNKNOWN_ERROR_LABEL }));
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
