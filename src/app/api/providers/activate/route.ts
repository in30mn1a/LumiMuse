import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(request: NextRequest) {
  const { id } = await request.json() as { id: string };
  if (!id) {
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
    if (provider.api_key) upsert.run('api_key', JSON.stringify(provider.api_key));
    upsert.run('model', JSON.stringify(provider.model || ''));
    upsert.run('temperature', JSON.stringify(provider.temperature ?? 1));
    upsert.run('max_tokens', JSON.stringify(provider.max_tokens ?? 4096));
    upsert.run('context_window', JSON.stringify(provider.context_window ?? 131072));
    upsert.run('json_mode', JSON.stringify(provider.json_mode ? 1 : 0));
  });
  transaction();

  return NextResponse.json({ ok: true });
}
