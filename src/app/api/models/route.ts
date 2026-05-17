import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { loadSettings } from '@/lib/settings';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟

export async function GET(request: NextRequest) {
  const db = getDb();
  const settings = loadSettings();

  // query 参数优先（用户填了但未保存时直接用），否则回退到数据库值
  const apiBase = request.nextUrl.searchParams.get('api_base') || settings.api_base;
  const apiKey  = request.nextUrl.searchParams.get('api_key')  || settings.api_key;

  if (!apiBase || !apiKey) {
    return NextResponse.json({ models: [], error: '请先配置 API 地址和密钥' });
  }

  // 强制刷新参数
  const forceRefresh = request.nextUrl.searchParams.get('refresh') === '1';

  // 读缓存
  if (!forceRefresh) {
    const cached = db.prepare('SELECT models, cached_at FROM model_cache WHERE api_base = ?').get(apiBase) as
      | { models: string; cached_at: string }
      | undefined;
    if (cached) {
      const age = Date.now() - new Date(cached.cached_at).getTime();
      if (age < CACHE_TTL_MS) {
        return NextResponse.json({ models: JSON.parse(cached.models), error: null, cached: true });
      }
    }
  }

  // 拉取最新列表
  try {
    const res = await fetch(`${apiBase}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return NextResponse.json({ models: [], error: `获取失败: ${res.status}` });
    }
    const data = await res.json();
    const models: string[] = (data.data || data.models || [])
      .map((m: { id: string } | string) => typeof m === 'string' ? m : m.id)
      .sort();

    // 写入缓存
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO model_cache (api_base, models, cached_at)
      VALUES (?, ?, ?)
      ON CONFLICT(api_base) DO UPDATE SET models = excluded.models, cached_at = excluded.cached_at
    `).run(apiBase, JSON.stringify(models), now);

    return NextResponse.json({ models, error: null, cached: false });
  } catch (err) {
    // 拉取失败时尝试返回旧缓存
    const stale = db.prepare('SELECT models FROM model_cache WHERE api_base = ?').get(apiBase) as
      | { models: string }
      | undefined;
    if (stale) {
      return NextResponse.json({ models: JSON.parse(stale.models), error: '网络错误，显示上次缓存', cached: true });
    }
    return NextResponse.json({ models: [], error: String(err) });
  }
}
