import {
  buildChatRequestBody,
  completeRequest,
  REASONING_SAFE_MAX_TOKENS,
  type ChatToolCall,
} from '@/lib/api-client';
import { runWithBackgroundLlmDeadline } from '@/lib/background-llm-deadline';
import { loadCharacterTaskModels, resolveCharacterTaskSystemPrompt } from '@/lib/character-task-models';
import { formatChatTimestamp, type ChatTimeContext } from '@/lib/chat-time';
import { getDb } from '@/lib/db';
import {
  buildBackgroundChatExtraBody,
  mergeSettingsForBackgroundLlm,
  resolveBackgroundConfig,
  resolveWebSearchApiKey,
} from '@/lib/settings';
import type { Message, Settings, WebSearchData, WebSearchSource } from '@/types';
import { fetchWebPage, searchWeb, type WebPage, type WebSearchResult } from './deepseek-search';
import { LEAKED_TOOL_CALL_RE } from './web-search-context';

// 先搜后答的「搜」：后台模型带 search_web / fetch_url 两个工具自己决定查什么、读哪页，
// 最后交回一份限长摘要。聊天主模型拿到的只有摘要文本——主链路的工具通道可能已被预设独占，
// 所以搜索不能做成主模型的工具。

const RESULTS_PER_SEARCH = 8;
const PAGE_CHUNK_CHARS = 10_000;
const RECENT_MESSAGE_COUNT = 8;
const FALLBACK_SOURCE_COUNT = 5;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: '用搜索引擎查找网页。返回带编号的结果（标题、站点、日期、摘要）。可多次调用，换关键词、换语言或换角度。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词，不要写成完整句子' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: `读取某条搜索结果的网页正文，每次返回 ${PAGE_CHUNK_CHARS} 字符。正文更长时用返回的 next_start_index 继续读。`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'search_web 结果的编号' },
          start_index: { type: 'integer', description: '从第几个字符开始读，默认 0' },
        },
        required: ['id'],
      },
    },
  },
];

function summaryRules(summaryTargetChars: number): string[] {
  return [
    '- 只写查到的事实（时间、数字、名称、经过、各方评价），不确定或来源互相矛盾的地方照实说明，不要编造。',
    '- 用户问的事如果还没有确切结果（比如比赛还在进行、消息还没公布），写清楚目前查到的进展，并说明结果尚未查到。',
    '- 不要扮演角色，不要写给用户的回复，不要评论对话本身。',
    `- 摘要用中文，目标长度约 ${summaryTargetChars} 字，信息密度优先。`,
    '- 摘要正文里不要出现结果编号。最后单独一行写 `SOURCES: ` 加上你实际依据的结果编号，用英文逗号分隔，例如 `SOURCES: 1,4,7`。',
  ];
}

function conversationBlock(conversationText: string, nowText: string): string[] {
  return [`当前时间：${nowText}`, '', '<conversation>', conversationText, '</conversation>'];
}

function buildInstruction(conversationText: string, nowText: string, summaryTargetChars: number): string {
  return [
    '你是一名资料检索助手。下面是一段用户与角色的对话，用户希望角色在回复最后一条用户消息前先联网了解相关的最新信息。',
    '你的任务：用 search_web 搜索，必要时用 fetch_url 读正文，然后写一份资料摘要，供角色回复时参考。',
    '',
    '要求：',
    '- 查询只用关键词，可以多轮搜索、换语言、换角度；搜索摘要不够具体时再读正文。',
    '- 查询里只放要查的公开话题，不要放对话原文、人名昵称等私人信息。',
    ...summaryRules(summaryTargetChars),
    '',
    ...conversationBlock(conversationText, nowText),
  ].join('\n');
}

/** 收尾请求：不带工具，把已经查到的全部内容平铺给模型，只让它写摘要。 */
function buildSynthesisInstruction(
  conversationText: string,
  nowText: string,
  summaryTargetChars: number,
  materials: string,
): string {
  return [
    '你是一名资料检索助手。下面是一段用户与角色的对话，以及已经为它联网查到的资料（方括号里是结果编号）。',
    '搜索已经结束，不能再查。请只根据这些资料写一份资料摘要，供角色回复最后一条用户消息时参考。',
    '',
    '要求：',
    ...summaryRules(summaryTargetChars),
    '',
    ...conversationBlock(conversationText, nowText),
    '',
    '<search_results>',
    materials,
    '</search_results>',
  ].join('\n');
}


export interface WebSearchLoopInput {
  /** 已解析好的后台 LLM 配置（接口/密钥/模型）。 */
  llm: Settings;
  extraBody?: Record<string, unknown>;
  systemPrompt?: string;
  searchApiKey: string;
  conversationText: string;
  nowText: string;
  summaryTargetChars: number;
  maxRounds: number;
  signal?: AbortSignal;
}

function parseArgs(call: ChatToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const SOURCES_LINE_RE = /^[ \t]*SOURCES[ \t]*[:：](.*)$/gim;

export async function runWebSearchLoop(input: WebSearchLoopInput): Promise<WebSearchData> {
  const { llm, searchApiKey, signal } = input;
  const results: WebSearchResult[] = [];
  const idByUrl = new Map<string, number>();
  const pages = new Map<number, WebPage>();
  const queries: string[] = [];
  // 每次工具调用的结果，收尾请求要把它们平铺给模型
  const materials: string[] = [];
  let lastToolError = '';

  const runTool = async (call: ChatToolCall): Promise<string> => {
    const output = await runToolInner(call);
    if (!output.startsWith('错误：')) {
      const args = parseArgs(call);
      materials.push(call.name === 'fetch_url'
        ? `（[${Number(args.id)}] 的正文）\n${output}`
        : output);
    }
    return output;
  };

  const runToolInner = async (call: ChatToolCall): Promise<string> => {
    const args = parseArgs(call);
    try {
      if (call.name === 'search_web') {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return '错误：缺少 query。';
        queries.push(query);
        const found = await searchWeb(searchApiKey, query, RESULTS_PER_SEARCH, signal);
        if (found.length === 0) return '没有找到结果，换个关键词试试。';
        return found.map(result => {
          let id = idByUrl.get(result.url);
          if (id === undefined) {
            results.push(result);
            id = results.length;
            idByUrl.set(result.url, id);
          }
          const head = [`[${id}] ${result.title}`, result.site, result.date].filter(Boolean).join(' | ');
          return `${head}\n${result.summary}`;
        }).join('\n\n');
      }
      if (call.name === 'fetch_url') {
        const id = Number(args.id);
        const result = results[id - 1];
        if (!Number.isInteger(id) || !result) return '错误：id 不是已有的搜索结果编号。';
        let page = pages.get(id);
        if (!page) {
          page = await fetchWebPage(searchApiKey, result.url, signal);
          pages.set(id, page);
        }
        const start = Number.isInteger(args.start_index) && (args.start_index as number) > 0 ? args.start_index as number : 0;
        const chunk = page.content.slice(start, start + PAGE_CHUNK_CHARS);
        if (!chunk) return '这一页没有更多正文。';
        const next = start + PAGE_CHUNK_CHARS;
        return next < page.content.length
          ? `${chunk}\n\n[正文未完，next_start_index=${next}]`
          : chunk;
      }
      return `错误：未知工具 ${call.name}。`;
    } catch (error) {
      if (signal?.aborted) throw error;
      // 单次工具失败交还给模型（换来源/换关键词），不让整轮搜索作废。
      lastToolError = error instanceof Error ? error.message : String(error);
      return `错误：${lastToolError}`;
    }
  };

  const messages: Array<Record<string, unknown>> = [];
  if (input.systemPrompt?.trim()) messages.push({ role: 'system', content: input.systemPrompt.trim() });
  messages.push({
    role: 'user',
    content: buildInstruction(input.conversationText, input.nowText, input.summaryTargetChars),
  });

  const baseBody = () => ({
    ...buildChatRequestBody(llm, false),
    max_tokens: Math.max(llm.max_tokens || 0, REASONING_SAFE_MAX_TOKENS),
  });
  const request = () => completeRequest(llm, {
    ...baseBody(),
    messages,
    tools: TOOLS,
    ...input.extraBody,
  }, { signal });

  let finalText = '';
  for (let round = 0; round < input.maxRounds; round += 1) {
    const response = await request();
    if (response.toolCalls.length === 0) {
      finalText = response.text;
      break;
    }
    messages.push({
      role: 'assistant',
      content: response.text || null,
      tool_calls: response.toolCalls.map((call, index) => ({
        id: call.id || `call_${round}_${index}`,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
        ...(call.extra_content === undefined ? {} : { extra_content: call.extra_content }),
      })),
      ...response.assistantFields,
    });
    for (const [index, call] of response.toolCalls.entries()) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id || `call_${round}_${index}`,
        content: await runTool(call),
      });
    }
  }

  if (results.length === 0) {
    throw new Error(lastToolError || '后台模型没有执行搜索（该模型可能不支持工具调用）');
  }

  // 轮数用尽、或模型把工具调用写进了正文：另发一次不带工具的请求，只让它根据已有资料写摘要。
  // 不在原对话上加 tool_choice=none——带着工具历史，部分模型仍会把调用写成文本。
  if (!finalText.trim() || LEAKED_TOOL_CALL_RE.test(finalText)) {
    const synthesis = await completeRequest(llm, {
      ...baseBody(),
      messages: [
        ...(input.systemPrompt?.trim() ? [{ role: 'system', content: input.systemPrompt.trim() }] : []),
        {
          role: 'user',
          content: buildSynthesisInstruction(
            input.conversationText,
            input.nowText,
            input.summaryTargetChars,
            materials.join('\n\n---\n\n'),
          ),
        },
      ],
      ...input.extraBody,
    }, { signal });
    finalText = synthesis.text;
    if (LEAKED_TOOL_CALL_RE.test(finalText)) throw new Error('后台模型没有返回资料摘要');
  }

  const cited: number[] = [];
  for (const match of finalText.matchAll(SOURCES_LINE_RE)) {
    for (const token of match[1].split(/[^0-9]+/)) {
      const id = Number(token);
      if (token && results[id - 1] && !cited.includes(id)) cited.push(id);
    }
  }
  const summary = finalText.replace(SOURCES_LINE_RE, '').trim();
  if (!summary) throw new Error('后台模型没有返回资料摘要');

  // 模型没按约定列来源时：读过正文的页面最可能是依据，其次取靠前的搜索结果。
  const sourceIds = cited.length > 0
    ? cited
    : pages.size > 0
      ? [...pages.keys()]
      : results.slice(0, FALLBACK_SOURCE_COUNT).map((_, index) => index + 1);
  const sources: WebSearchSource[] = sourceIds.map(id => ({
    title: results[id - 1].title || results[id - 1].site || results[id - 1].url,
    url: results[id - 1].url,
  }));

  return { summary, sources, queries, searched_at: new Date().toISOString() };
}

/**
 * 聊天链路入口：按角色的后台任务配置解析模型，取最近几条对话作为检索依据。
 * 任何失败都以抛错返回，由调用方决定降级（聊天不得因此中断）。
 */
export async function runWebSearchForChat(input: {
  settings: Settings;
  characterId: string;
  characterName: string;
  messages: Message[];
  timeContext?: ChatTimeContext;
  signal?: AbortSignal;
}): Promise<WebSearchData> {
  const { settings } = input;
  const searchApiKey = resolveWebSearchApiKey(settings);
  if (!searchApiKey) throw new Error('未配置联网搜索密钥');

  const taskTarget = {
    character: loadCharacterTaskModels(getDb(), input.characterId),
    kind: 'background' as const,
  };
  const llm = mergeSettingsForBackgroundLlm(settings, resolveBackgroundConfig(settings, taskTarget));
  if (!llm.api_base.trim() || !llm.model.trim()) throw new Error('后台模型未配置');

  const conversationText = input.messages
    .filter(message => message.role !== 'system' && message.content.trim())
    .slice(-RECENT_MESSAGE_COUNT)
    .map(message => `${message.role === 'user' ? '用户' : input.characterName || '角色'}: ${message.content.trim()}`)
    .join('\n\n');
  if (!conversationText) throw new Error('没有可用于检索的对话内容');

  return runWithBackgroundLlmDeadline(
    settings.memory_background_timeout_ms,
    signal => runWebSearchLoop({
      llm,
      extraBody: buildBackgroundChatExtraBody(llm.model, taskTarget),
      systemPrompt: resolveCharacterTaskSystemPrompt(taskTarget, llm.model),
      searchApiKey,
      conversationText,
      nowText: formatChatTimestamp(new Date().toISOString(), input.timeContext),
      summaryTargetChars: settings.web_search.summary_target_chars,
      maxRounds: settings.web_search.max_rounds,
      signal,
    }),
    input.signal,
  );
}
