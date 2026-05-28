import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

async function requireAuth(request: NextRequest): Promise<NextResponse | null> {
  if (!process.env.ACCESS_PASSWORD) return null;
  const { AUTH_COOKIE_NAME, verifyAuthToken } = await import('@/lib/auth-token');
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const valid = await verifyAuthToken(token);
  if (!valid) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }
  return null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const { id } = await request.json() as { id: string };
  if (!isUuid(id)) {
    return NextResponse.json({ error: '缺少供应商 ID' }, { status: 400 });
  }

  const db = getDb();
  const provider = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!provider) {
    return NextResponse.json({ error: '供应商不存在' }, { status: 404 });
  }

  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const transaction = db.transaction(() => {
    upsert.run('active_provider_id', JSON.stringify(id));
    upsert.run('api_base', JSON.stringify(provider.api_base || ''));
    // 切换 provider 时必须同步 api_key（包括空字符串），避免旧密钥残留到新 api_base。
    upsert.run('api_key', JSON.stringify(provider.api_key || ''));
    upsert.run('model', JSON.stringify(provider.model || ''));
    upsert.run('temperature', JSON.stringify(provider.temperature ?? 1));
    upsert.run('max_tokens', JSON.stringify(provider.max_tokens ?? 4096));
    upsert.run('context_window', JSON.stringify(provider.context_window ?? 131072));
    upsert.run('json_mode', JSON.stringify(provider.json_mode ? 1 : 0));
  });
  transaction();

  return NextResponse.json({ ok: true });
}
