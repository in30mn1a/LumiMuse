import { sanitizeUpstreamError } from '@/lib/api-client';
import { safeFetch } from '@/lib/ssrf-guard';

/** 搜索来源共用的 JSON POST：出站走 ssrf-guard，错误正文去掉密钥后再抛。 */
export async function postSearchJson(
  label: string,
  url: string,
  apiKey: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} API error ${response.status}: ${sanitizeUpstreamError(text, apiKey)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} API returned a non-JSON response`);
  }
}

export const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

export const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/** 结果里没有站点名时，用去掉 www. 的域名代替。 */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 取 JSON 数组的第一项（不是对象时返回 undefined）。 */
export function firstRecord(value: unknown): Record<string, unknown> | undefined {
  const first: unknown = Array.isArray(value) ? value[0] : undefined;
  return first && typeof first === 'object' ? first as Record<string, unknown> : undefined;
}
