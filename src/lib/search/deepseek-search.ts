import { sanitizeUpstreamError } from '@/lib/api-client';
import { safeFetch } from '@/lib/ssrf-guard';

// DeepSeek 的联网工具接口。响应格式为 2026-11-15 实测：
//   search → { results: [{ title, url, site_name, date, summary, snippet, content }] }
//   fetch  → { title, content }；抓不到的站点返回 404 { error: { message } }
const SEARCH_URL = 'https://api.deepseek.com/v1/tools/search';
const FETCH_URL = 'https://api.deepseek.com/v1/tools/fetch';

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

async function postJson(url: string, apiKey: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Search API error ${response.status}: ${sanitizeUpstreamError(text, apiKey)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Search API returned a non-JSON response');
  }
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

export async function searchWeb(
  apiKey: string,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const data = await postJson(SEARCH_URL, apiKey, { query, count, need_content: false }, signal);
  const results = (data as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap(item => {
    const record = item as Record<string, unknown>;
    const url = asString(record?.url);
    if (!/^https?:\/\//i.test(url)) return [];
    return [{
      // 接口常把标题重复成「标题 - 标题」
      title: asString(record.title).replace(/^(.+) - \1$/, '$1'),
      url,
      site: asString(record.site_name),
      date: asString(record.date).slice(0, 10),
      summary: asString(record.summary) || asString(record.snippet),
    }];
  });
}

export async function fetchWebPage(apiKey: string, url: string, signal?: AbortSignal): Promise<WebPage> {
  const data = await postJson(FETCH_URL, apiKey, { url }, signal) as Record<string, unknown>;
  return { title: asString(data?.title), content: asString(data?.content) };
}
