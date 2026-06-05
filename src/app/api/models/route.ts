import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { loadSettings } from '@/lib/settings';
import { safeFetch } from '@/lib/ssrf-guard';
import { API_KEY_MASK } from '@/lib/constants';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟

interface ModelsRequestParams {
  apiBase: string;
  apiKey: string;
  forceRefresh: boolean;
}

type CredentialSource = 'chat' | 'embedding' | 'reranker';

/**
 * 解析模型列表请求参数：
 * - GET 仅支持 refresh 标志，api_base/api_key 必须从已保存的 settings 中读取（避免敏感信息进 URL）
 * - POST 允许 body 中传入临时凭证（用于设置页未保存时试连），仅在请求生命周期内使用，不会落 URL
 */
function readGetParams(request: NextRequest): ModelsRequestParams {
  const settings = loadSettings();
  return {
    apiBase: settings.api_base || '',
    apiKey: settings.api_key || '',
    forceRefresh: request.nextUrl.searchParams.get('refresh') === '1',
  };
}

async function readPostParams(request: NextRequest): Promise<ModelsRequestParams> {
  let body: {
    api_base?: string;
    api_key?: string;
    refresh?: boolean;
    credential_source?: CredentialSource;
    provider_id?: string;
  } = {};
  try {
    body = await request.json();
  } catch {
    // 允许空 body，回退到 settings
  }
  const forceRefresh = body.refresh === true;
  const providerId = body.provider_id?.trim();
  if (providerId) {
    const provider = readProviderParams(providerId);
    return {
      apiBase: provider?.api_base || '',
      apiKey: provider?.api_key || '',
      forceRefresh,
    };
  }

  const settings = loadSettings();
  const apiBase = body.api_base || settings.api_base || '';
  const apiKey = resolvePostApiKey(settings, apiBase, body);
  return {
    apiBase,
    apiKey,
    forceRefresh,
  };
}

function readProviderParams(providerId: string): { api_base: string; api_key: string; model: string } | undefined {
  return getDb()
    .prepare('SELECT api_base, api_key, model FROM api_providers WHERE id = ?')
    .get(providerId) as { api_base: string; api_key: string; model: string } | undefined;
}

function sameApiBase(a: string | undefined, b: string | undefined): boolean {
  const normalize = (value: string | undefined) => (value || '').trim().replace(/\/+$/, '');
  return normalize(a) !== '' && normalize(a) === normalize(b);
}

function resolvePostApiKey(
  settings: ReturnType<typeof loadSettings>,
  apiBase: string,
  body: { api_key?: string; credential_source?: CredentialSource },
): string {
  if (body.api_key && body.api_key !== API_KEY_MASK) return body.api_key;

  const engine = settings.memory_engine;
  if (
    body.credential_source === 'embedding' &&
    sameApiBase(apiBase, engine.embedding_api_base)
  ) {
    return engine.embedding_api_key || '';
  }
  if (
    body.credential_source === 'reranker' &&
    sameApiBase(apiBase, engine.reranker_api_base)
  ) {
    return engine.reranker_api_key || '';
  }
  if (sameApiBase(apiBase, settings.api_base)) return settings.api_key || '';

  if (sameApiBase(apiBase, engine.embedding_api_base)) return engine.embedding_api_key || '';
  if (sameApiBase(apiBase, engine.reranker_api_base)) return engine.reranker_api_key || '';

  return '';
}

async function handle(params: ModelsRequestParams): Promise<NextResponse> {
  const { apiBase, apiKey, forceRefresh } = params;
  if (!apiBase || !apiKey) {
    return NextResponse.json({ models: [], error: '请先配置 API 地址和密钥' });
  }

  const db = getDb();

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
    const res = await safeFetch(`${apiBase}/models`, {
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

export async function GET(request: NextRequest) {
  return handle(readGetParams(request));
}

export async function POST(request: NextRequest) {
  return handle(await readPostParams(request));
}
