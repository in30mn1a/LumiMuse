import type { WebSearchProviderId } from '@/types';
import { createDeepSeekBackend } from './deepseek-search';
import { createExaBackend } from './exa-search';
import { createTavilyBackend } from './tavily-search';

export interface WebSearchResult {
  title: string;
  url: string;
  site: string;
  date: string;
  summary: string;
}

export interface WebPage {
  title: string;
  content: string;
}

/** 一个搜索来源：搜索 + 读正文。后台工具循环只依赖这个接口。 */
export interface WebSearchBackend {
  search(query: string, count: number, signal?: AbortSignal): Promise<WebSearchResult[]>;
  fetchPage(url: string, signal?: AbortSignal): Promise<WebPage>;
}

export function createWebSearchBackend(provider: WebSearchProviderId, apiKey: string): WebSearchBackend {
  switch (provider) {
    case 'tavily': return createTavilyBackend(apiKey);
    case 'exa': return createExaBackend(apiKey);
    case 'deepseek': return createDeepSeekBackend(apiKey);
  }
}
