import {
  buildChatRequestBody,
  type CompletionRequestOptions,
  type CompletionRequestResult,
} from '@/lib/api-client';
import { runWithBackgroundLlmDeadline } from '@/lib/background-llm-deadline';
import { estimateTokens } from '@/lib/token-counter';
import type { Settings } from '@/types';

export const COMPACTION_SYSTEM_PROMPT = `你是内置 Agent 的上下文压缩器。下面是 Agent 与主人较早的对话记录，可能还附带一份已有摘要。请把它们合并成一份新的完整摘要，Agent 之后会用它代替这些原始记录继续工作。

必须保留：
- 主人的目标、要求、偏好，以及明确否定过的做法
- 已经作出的决定和得出的结论
- 提案编号、其中的操作和处理结果（批准、拒绝及原因、跳过）
- 查看过的角色、对话、记忆的 ID，以及从中得到的关键事实
- Agent 笔记（remember）写入过的内容
- 尚未完成的事项和下一步计划

要求：
- 只写记录里出现过的信息，不推测、不编造；ID、编号和数字原样保留
- 已有摘要里仍然有效的信息要保留；被后续对话推翻的，以新内容为准
- 用中文，条理清楚，可以用小标题和列表；不要寒暄，也不要解释压缩过程`;

/** 已有摘要挤占记录空间时，尝试先精简摘要，为记录腾出的目标 token。 */
const MIN_BLOCK_TOKENS = 1024;
const TRUNCATED_MARK = '\n…（这条记录过长，摘要输入中只保留了开头）';

export type CompactionCompleteFn = (
  settings: Settings,
  body: Record<string, unknown>,
  options: CompletionRequestOptions,
) => Promise<CompletionRequestResult>;

export interface CompactAgentHistoryInput {
  /** 按时间排列的对话记录，每段是一条消息渲染出的纯文本 */
  blocks: readonly string[];
  previousSummary: string | null;
  /** 已解析 Agent 接口、模型和思考强度的设置 */
  settings: Settings;
  complete: CompactionCompleteFn;
  /** 单次摘要请求的输入预算（token） */
  inputBudget: number;
  maxTokens: number;
  streaming: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

function userContent(previousSummary: string, blocks: readonly string[]): string {
  const head = previousSummary ? `【已有摘要】\n${previousSummary}\n\n` : '';
  return `${head}【新的对话记录】\n${blocks.join('\n\n')}\n\n请输出合并后的完整摘要。`;
}

function truncateBlock(text: string, fits: (block: string) => boolean): string {
  if (!fits(TRUNCATED_MARK)) throw new Error('压缩摘要没有剩余输入空间');
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, middle) + TRUNCATED_MARK)) low = middle;
    else high = middle - 1;
  }
  if (low === 0) throw new Error('压缩摘要没有剩余输入空间');
  return text.slice(0, low) + TRUNCATED_MARK;
}

/** 第一条已确认可容纳；倍增探测后再二分边界，避免逐条重新估算整段前缀。 */
function fittingChunkEnd(blocks: readonly string[], start: number, fits: (chunk: readonly string[]) => boolean): number {
  let end = start + 1;
  let upper = end;
  while (end < blocks.length) {
    upper = Math.min(blocks.length, start + (end - start) * 2);
    if (!fits(blocks.slice(start, upper))) break;
    end = upper;
  }
  let high = upper - 1;
  while (end < high) {
    const middle = Math.ceil((end + high) / 2);
    if (fits(blocks.slice(start, middle))) end = middle;
    else high = middle - 1;
  }
  return end;
}

/**
 * 把较早的对话总结成一份摘要。内容超过单次预算时分段滚动：先总结前一段，
 * 再把结果作为「已有摘要」与下一段一起总结。中止、超时、上游失败、空回复或被截断都抛错，
 * 由调用方决定如何退回。
 */
export async function compactAgentHistory(input: CompactAgentHistoryInput): Promise<string> {
  const systemTokens = estimateTokens(COMPACTION_SYSTEM_PROMPT);
  const overhead = systemTokens + estimateTokens(userContent('', []));
  const fits = (previousSummary: string, blocks: readonly string[]) =>
    systemTokens + estimateTokens(userContent(previousSummary, blocks)) <= input.inputBudget;

  const summarize = async (previousSummary: string, blocks: readonly string[]): Promise<string> => {
    if (!fits(previousSummary, blocks)) throw new Error('压缩摘要超出输入预算');
    const body = buildChatRequestBody(input.settings, input.streaming);
    body.max_tokens = input.maxTokens;
    body.messages = [
      { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
      { role: 'user', content: userContent(previousSummary, blocks) },
    ];
    const result = await runWithBackgroundLlmDeadline(
      input.timeoutMs,
      signal => input.complete(input.settings, body, { signal }),
      input.signal,
    );
    const text = result.text.trim();
    if (result.completed === false || result.finishReason === 'length') throw new Error('压缩摘要被截断');
    if (!text) throw new Error('压缩摘要为空');
    return text;
  };

  let summary = input.previousSummary?.trim() ?? '';
  let start = 0;
  while (start < input.blocks.length) {
    const text = input.blocks[start];
    if (summary
      && input.inputBudget - overhead - estimateTokens(summary) < Math.min(estimateTokens(text), MIN_BLOCK_TOKENS)) {
      summary = await summarize(summary, []);
    }
    if (!fits(summary, [text])) {
      const truncated = truncateBlock(text, candidate => fits(summary, [candidate]));
      summary = await summarize(summary, [truncated]);
      start += 1;
    } else {
      const end = fittingChunkEnd(input.blocks, start, chunk => fits(summary, chunk));
      summary = await summarize(summary, input.blocks.slice(start, end));
      start = end;
    }
  }
  return summary;
}
