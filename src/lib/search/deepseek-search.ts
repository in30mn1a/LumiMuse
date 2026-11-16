import { asString, isHttpUrl, postSearchJson } from './search-http';
import type { WebSearchBackend } from './web-search-backend';

// DeepSeek 的联网工具接口。响应格式为 2026-11-15 实测：
//   search → { results: [{ title, url, site_name, date, summary, snippet, content }] }
//   fetch  → { title, content }；抓不到的站点返回 404 { error: { message } }
const SEARCH_URL = 'https://api.deepseek.com/v1/tools/search';
const FETCH_URL = 'https://api.deepseek.com/v1/tools/fetch';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 接口把发布日期写成北京时间零点的 UTC 时刻（11 月 15 日的新闻是 `2026-11-14T16:00:00+00:00`），
 * 直接截前 10 位会早一天，所以带时刻的值先换算到北京时间再取日期。
 */
function toBeijingDate(value: string): string {
  const normalized = value.trim().replace(/^(\d{4}-\d{2}-\d{2})[ T]/, '$1T');
  if (!normalized.includes('T')) return value.slice(0, 10);
  // 没写时区偏移的时刻按 UTC 解析，结果不随服务器时区变化
  const time = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(time) ? value.slice(0, 10) : new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function createDeepSeekBackend(apiKey: string): WebSearchBackend {
  const headers = { Authorization: `Bearer ${apiKey}` };
  return {
    async search(query, count, signal) {
      const data = await postSearchJson('DeepSeek', SEARCH_URL, apiKey, headers, { query, count, need_content: false }, signal);
      const results = (data as { results?: unknown })?.results;
      if (!Array.isArray(results)) return [];
      return results.flatMap(item => {
        const record = item as Record<string, unknown>;
        const url = asString(record?.url);
        if (!isHttpUrl(url)) return [];
        return [{
          // 接口常把标题重复成「标题 - 标题」
          title: asString(record.title).replace(/^(.+) - \1$/, '$1'),
          url,
          site: asString(record.site_name),
          date: toBeijingDate(asString(record.date)),
          summary: asString(record.summary) || asString(record.snippet),
        }];
      });
    },
    async fetchPage(url, signal) {
      const data = await postSearchJson('DeepSeek', FETCH_URL, apiKey, headers, { url }, signal) as Record<string, unknown>;
      return { title: asString(data?.title), content: asString(data?.content) };
    },
  };
}
