import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getDb } from '@/lib/db';
import { Message, Character } from '@/types';
import { buildBackgroundChatExtraBody, loadSettings, resolveBackgroundConfig } from '@/lib/settings';
import { REASONING_SAFE_MAX_TOKENS, sanitizeUpstreamError } from '@/lib/api-client';
import { estimateTokens } from '@/lib/token-counter';
import { safeFetch } from '@/lib/ssrf-guard';
import { parseSseStream } from '@/lib/sse-parser';
import { serializeTypedMessages } from '@/lib/messages';
import { formatZodFieldErrors, summarizeBodySchema } from '@/lib/schemas';
import { readMemoryProfile, renderMemoryProfile } from '@/lib/memory-profile';

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = summarizeBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 }
    );
  }

  const { conversation_id } = parsed.data;
  if (!conversation_id) {
    return NextResponse.json({ error: 'Missing conversation_id' }, { status: 400 });
  }

  const db = getDb();

  // 读取设置
  const settings = loadSettings();

  // 获取对话和角色信息
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id) as { character_id: string; title: string } | undefined;
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(conversation.character_id) as Character | undefined;
  if (!character) {
    return NextResponse.json({ error: 'Character not found' }, { status: 404 });
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
    return NextResponse.json({ error: '消息太少，暂时不需要总结' }, { status: 400 });
  }

  // 读取当前角色的记忆画像
  const profile = readMemoryProfile(conversation.character_id, db);
  const renderedProfile = profile ? renderMemoryProfile(profile) : '';

  // 拼接角色的完整人设背景与当前记忆画像
  const charDetailsList = [
    character.basic_info?.trim() ? `【基本信息】\n${character.basic_info.trim()}` : '',
    character.personality?.trim() ? `【性格特征】\n${character.personality.trim()}` : '',
    character.scenario?.trim() ? `【场景与世界观】\n${character.scenario.trim()}` : '',
    character.other_info?.trim() ? `【其他信息】\n${character.other_info.trim()}` : '',
    renderedProfile.trim() ? `【当前记忆画像】\n${renderedProfile.trim()}` : '',
  ].filter(Boolean);

  const charDetailsText = charDetailsList.length > 0
    ? `### 🎭 角色设定与记忆背景：\n${charDetailsList.join('\n\n')}\n\n`
    : '';

  // 构建总结提示词
  const convText = messagesToSummarize
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role === 'user' ? '你' : character.name}: ${m.content}`)
    .join('\n\n');

  const summaryPrompt = `你是一个对话总结助手。请结合以下提供的人设背景和记忆画像，根据对话内容，以角色 ${character.name} 的第一人称口吻，生成一份仅供 ${character.name} 自己阅读的内心备忘日记，格式如下：

## 📖 最近发生的事
（用 2-4 句话以第一人称概括“我”最近和你发生的主要事情，重点记录“我”的内心感受、情感走向和关键交互事件）

## 💡 接下来我可以聊
（给出 2-3 条“我”接下来可以主动发起或提及的对话切入点，要自然并符合“我”的性格与人设）

注意：
- 必须全程使用角色 ${character.name} 的第一人称口吻（自称“我”或符合性格的自称，称呼用户时使用“你”）
- 这是写给 ${character.name} 自己看的备忘录，不能使用第三人称或旁观者叙事视角，也不要写成是给“你”看的内容
- 总结和后续话题建议必须深度契合人设背景和当前记忆画像
- 不要列举每一条消息，要提炼核心
- 建议要具体，不要太泛泛

${charDetailsText}对话内容：
${convText}`;

  try {
    // 使用流式调用收集完整内容（兼容性更好）
    // 客户端断开连接时同步取消上游请求，避免 reader 泄漏
    const bgConfig = resolveBackgroundConfig(settings);
    const backgroundExtraBody = buildBackgroundChatExtraBody(settings, bgConfig.model);
    const response = await safeFetch(`${bgConfig.api_base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bgConfig.api_key}`,
      },
      body: JSON.stringify({
        // 总结属后台任务，可使用独立的后台供应商/模型；留空则回退主接口。
        model: bgConfig.model,
        messages: [{ role: 'user', content: summaryPrompt }],
        // 后台模型可能是推理模型，沿用聊天的小 max_tokens 会在思考阶段耗尽导致正文被截断，故取安全下限。
        max_tokens: Math.max(settings.max_tokens || 0, REASONING_SAFE_MAX_TOKENS),
        temperature: settings.temperature,
        stream: true,
        ...backgroundExtraBody,
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${sanitizeUpstreamError(text)}`);
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
      return NextResponse.json({ error: '请求已取消' }, { status: 499 });
    }

    if (!summaryContent.trim()) {
      throw new Error('总结内容为空，模型未返回有效内容');
    }

    // 将总结作为特殊消息存入数据库（role = 'summary'）
    const summaryId = crypto.randomUUID().slice(0, 12);
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

    return NextResponse.json({ ok: true, message: summaryMessage, summarizedCount: messagesToSummarize.length });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '总结失败' }, { status: 500 });
  }
}
