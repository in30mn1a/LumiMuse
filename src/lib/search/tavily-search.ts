import { asString, firstRecord, isHttpUrl, postSearchJson, siteOf } from './search-http';
import type { WebSearchBackend } from './web-search-backend';

// Tavily：https://docs.tavily.com/documentation/api-reference
//   search  → { results: [{ title, url, content, score, published_date? }] }
//   extract → { results: [{ url, raw_content }], failed_results: [{ url, error }] }
//             HTTP 200 也可能全部失败，要看 failed_results
const SEARCH_URL = 'https://api.tavily.com/search';
const EXTRACT_URL = 'https://api.tavily.com/extract';

function toIsoDate(value: string): string {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? '' : new Date(time).toISOString().slice(0, 10);
}

export function createTavilyBackend(apiKey: string): WebSearchBackend {
  const headers = { Authorization: `Bearer ${apiKey}` };
  return {
    async search(query, count, signal) {
      const data = await postSearchJson('Tavily', SEARCH_URL, apiKey, headers, { query, max_results: count }, signal);
      const results = (data as { results?: unknown })?.results;
      if (!Array.isArray(results)) return [];
      return results.flatMap(item => {
        const record = item as Record<string, unknown>;
        const url = asString(record?.url);
        if (!isHttpUrl(url)) return [];
        return [{
          title: asString(record.title),
          url,
          site: siteOf(url),
          // 只在 topic=news 等情况下返回，格式是 RFC 2822（"Tue, 11 Mar 2025 17:00:00 GMT"）
          date: toIsoDate(asString(record.published_date)),
          summary: asString(record.content),
        }];
      });
    },
    async fetchPage(url, signal) {
      const data = await postSearchJson('Tavily', EXTRACT_URL, apiKey, headers, { urls: [url], format: 'markdown' }, signal) as Record<string, unknown>;
      const page = firstRecord(data?.results);
      if (!page) {
        const failed = firstRecord(data?.failed_results);
        throw new Error(`Tavily extract failed: ${asString(failed?.error) || 'no content returned'}`);
      }
      const content = asString(page.raw_content);
      // extract 不返回标题，取正文第一个 Markdown 标题
      const title = content.match(/^#{1,6}[ \t]+(.+)$/m)?.[1]?.trim() ?? '';
      return { title, content };
    },
  };
}
