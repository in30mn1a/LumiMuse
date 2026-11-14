import type { MessageMetadata, WebSearchData } from '@/types';

// 部分模型被禁止调用工具时，会把调用写成自家的文本格式（如 DeepSeek 的 DSML）塞进正文。
// 这种正文不是摘要，不能当资料交给角色。
export const LEAKED_TOOL_CALL_RE = /<｜DSML｜|<\|DSML\|>|<tool_call>|<function_calls>|<\|tool_calls?_begin\|>|<｜tool▁calls▁begin｜>/;

/**
 * 已保存的联网资料能否交给角色。修复前存下的资料可能整段是泄漏的工具调用文本，
 * 搜索失败时会被沿用，所以读取时也要拦一次。
 */
export function usableWebSearch(data: WebSearchData | undefined): WebSearchData | undefined {
  const summary = data?.summary?.trim();
  if (!summary || LEAKED_TOOL_CALL_RE.test(summary)) return undefined;
  return data;
}

/**
 * 把一条用户消息上保存的联网资料渲染成追加在正文后的文本块；没有资料时返回空串。
 *
 * 输出只取决于已保存的摘要：资料写入后这条消息的字节不再变化，
 * 后续轮次它是历史的一部分，不会破坏上游的前缀缓存。
 */
export function renderWebSearchBlock(metadata: MessageMetadata): string {
  const summary = usableWebSearch(metadata.web_search)?.summary.trim();
  if (!summary) return '';
  return [
    '<web_search_results>',
    '（以下是系统为这条消息联网查到的资料，不是用户说的话。回复时保持角色口吻，把其中的信息自然地用上，不要照抄。）',
    summary,
    '</web_search_results>',
  ].join('\n');
}
