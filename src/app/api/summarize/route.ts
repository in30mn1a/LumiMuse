import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { Message, Character } from '@/types';
import { loadSettings } from '@/lib/settings';
import { estimateTokens } from '@/lib/token-counter';
import { safeFetch } from '@/lib/ssrf-guard';
import { parseSseStream } from '@/lib/sse-parser';
import { serializeTypedMessages } from '@/lib/messages';
import { v4 as uuidv4 } from 'uuid';

export async function POST(request: NextRequest) {
  const { conversation_id } = await request.json() as { conversation_id: string };
  if (!conversation_id) {
    return new Response(JSON.stringify({ error: 'Missing conversation_id' }), { status: 400 });
  }

  const db = getDb();

  // 读取设置
  const settings = loadSettings();

  // 获取对话和角色信息
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id) as { character_id: string; title: string } | undefined;
  if (!conversation) {
    return new Response(JSON.stringify({ error: 'Conversation not found' }), { status: 404 });
  }

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(conversation.character_id) as Character | undefined;
  if (!character) {
    return new Response(JSON.stringify({ error: 'Character not found' }), { status: 404 });
  }

  // 获取所有消息
  const allMessages = serializeTypedMessages(
    db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
    ).all(conversation_id) as Message[]
  );

  // 找到最后一条 summary 消息（metadata.isSummary），只总结它之后的内容
  const lastSummaryIdx = allMessages.findLastIndex(m => m.metadata.isSummary === true);
  const messagesToSummarize = lastSummaryIdx >= 0
    ? allMessages.slice(lastSummaryIdx + 1)
    : allMessages;

  if (messagesToSummarize.length < 2) {
    return new Response(JSON.stringify({ error: '消息太少，暂时不需要总结' }), { status: 400 });
  }

  // 构建总结提示词
  const convText = messagesToSummarize
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role === 'user' ? '用户' : character.name}: ${m.content}`)
    .join('\n\n');

  const summaryPrompt = `你是一个对话总结助手。请根据以下对话内容，生成一份简洁的总结，格式如下：

## 📖 近期对话回顾
（用 2-4 句话概括最近发生的主要事情，重点是情感走向和关键事件）

## 💡 接下来可以聊
（给出 2-3 条自然的对话延续建议，语气轻松，像朋友提议一样）

注意：
- 总结要温柔、有陪伴感，符合角色 ${character.name} 的风格
- 不要列举每一条消息，要提炼核心
- 建议要具体，不要太泛泛

对话内容：
${convText}`;

  try {
    // 使用流式调用收集完整内容（兼容性更好）
    // 客户端断开连接时同步取消上游请求，避免 reader 泄漏
    const response = await safeFetch(`${settings.api_base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.api_key}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: summaryPrompt }],
        max_tokens: settings.max_tokens,
        temperature: settings.temperature,
        stream: true,
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`);
    }

    if (!response.body) {
      throw new Error('LLM 未返回响应体');
    }

    // 读取流式响应，累积完整内容
    const reader = response.body.getReader();
    let summaryContent = '';

    try {
      await parseSseStream(reader, ({ text }) => {
        if (text) summaryContent += text;
      }, { signal: request.signal });
    } finally {
      // 无论正常结束还是异常都释放 reader
      try { await reader.cancel(); } catch { /* ignore */ }
    }

    // 客户端主动取消时，parseSseStream 内部已静默返回；这里映射成 499
    if (request.signal.aborted) {
      return new Response(JSON.stringify({ error: '请求已取消' }), { status: 499 });
    }

    if (!summaryContent.trim()) {
      throw new Error('总结内容为空，模型未返回有效内容');
    }

    // 将总结作为特殊消息存入数据库（role = 'summary'）
    const summaryId = uuidv4().slice(0, 12);
    const now = new Date().toISOString();
    const tokenCount = estimateTokens(summaryContent);
    const nextSeq = ((db.prepare('SELECT MAX(seq) as m FROM messages WHERE conversation_id = ?').get(conversation_id) as { m: number | null }).m ?? 0) + 1;

    const summarizedIds = messagesToSummarize.map(m => m.id);
    const meta = { summarizedIds, isSummary: true };

    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES (?, ?, 'system', ?, ?, ?, ?, ?)
    `).run(summaryId, conversation_id, summaryContent, tokenCount, now, nextSeq, JSON.stringify(meta));

    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation_id);

    const summaryMessage: Message = {
      id: summaryId,
      conversation_id,
      role: 'system',
      content: summaryContent,
      token_count: tokenCount,
      created_at: now,
      metadata: meta,
    };

    return new Response(JSON.stringify({ ok: true, message: summaryMessage, summarizedCount: messagesToSummarize.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : '总结失败' }), { status: 500 });
  }
}
