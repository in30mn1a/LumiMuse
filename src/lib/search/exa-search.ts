import { asString, firstRecord, isHttpUrl, postSearchJson, siteOf } from './search-http';
import type { WebSearchBackend } from './web-search-backend';

// Exa：https://docs.exa.ai/reference
//   search   → { results: [{ title, url, publishedDate, author, highlights?: string[] }] }
//   contents → { results: [{ url, title, text }], statuses: [{ id, status: 'success'|'error', error?: { tag } }] }
const SEARCH_URL = 'https://api.exa.ai/search';
const CONTENTS_URL = 'https://api.exa.ai/contents';

export function createExaBackend(apiKey: string): WebSearchBackend {
  const headers = { 'x-api-key': apiKey };
  return {
    async search(query, count, signal) {
      const data = await postSearchJson('Exa', SEARCH_URL, apiKey, headers, {
        query,
        numResults: count,
        // 只要相关片段做摘要，正文留给 fetchPage 按需读
        contents: { highlights: true },
      }, signal);
      const results = (data as { results?: unknown })?.results;
      if (!Array.isArray(results)) return [];
      return results.flatMap(item => {
        const record = item as Record<string, unknown>;
        const url = asString(record?.url);
        if (!isHttpUrl(url)) return [];
        const highlights = Array.isArray(record.highlights)
          ? record.highlights.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
          : [];
        return [{
          title: asString(record.title),
          url,
          site: siteOf(url),
          date: asString(record.publishedDate).slice(0, 10),
          summary: highlights.join(' … ') || asString(record.summary) || asString(record.text),
        }];
      });
    },
    async fetchPage(url, signal) {
      const data = await postSearchJson('Exa', CONTENTS_URL, apiKey, headers, { urls: [url], text: true }, signal) as Record<string, unknown>;
      const status = firstRecord(data?.statuses);
      if (status?.status === 'error') {
        const error = status.error && typeof status.error === 'object' ? status.error as Record<string, unknown> : undefined;
        throw new Error(`Exa contents failed: ${asString(error?.tag) || 'crawl failed'}`);
      }
      const page = firstRecord(data?.results);
      if (!page) throw new Error('Exa contents failed: no content returned');
      return { title: asString(page.title), content: asString(page.text) };
    },
  };
}
