import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { loadSettings } from '@/lib/settings';
import { ApiProvider } from '@/types';
import { randomUUID } from 'crypto';

const API_KEY_MASK = '********';

function rowToProvider(row: Record<string, unknown>): ApiProvider {
  return {
    id: row.id as string,
    name: row.name as string,
    api_base: row.api_base as string,
    api_key: row.api_key as string ? API_KEY_MASK : '',
    model: row.model as string,
    temperature: row.temperature as number,
    max_tokens: row.max_tokens as number,
    context_window: row.context_window as number,
    json_mode: Boolean(row.json_mode),
    created_at: row.created_at as string,
  };
}

export async function GET() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_providers ORDER BY created_at ASC').all() as Record<string, unknown>[];
  const providers = rows.map(rowToProvider);
  const settings = loadSettings();
  return NextResponse.json({ providers, active_provider_id: settings.active_provider_id || '' });
}

export async function POST(request: NextRequest) {
  const body = await request.json() as Partial<ApiProvider> & { save_as_current?: boolean };
  const db = getDb();

  const id = body.id || randomUUID();
  const apiKey = body.api_key === API_KEY_MASK ? '' : (body.api_key || '');

  db.prepare(`
    INSERT INTO api_providers (id, name, api_base, api_key, model, temperature, max_tokens, context_window, json_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    body.name || 'New Provider',
    body.api_base || '',
    apiKey,
    body.model || '',
    body.temperature ?? 1,
    body.max_tokens ?? 4096,
    body.context_window ?? 131072,
    body.json_mode ? 1 : 0,
  );

  if (body.save_as_current) {
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const transaction = db.transaction(() => {
      upsert.run('active_provider_id', JSON.stringify(id));
      upsert.run('api_base', JSON.stringify(body.api_base || ''));
      if (apiKey) upsert.run('api_key', JSON.stringify(apiKey));
      upsert.run('model', JSON.stringify(body.model || ''));
      upsert.run('temperature', JSON.stringify(body.temperature ?? 1));
      upsert.run('max_tokens', JSON.stringify(body.max_tokens ?? 4096));
      upsert.run('context_window', JSON.stringify(body.context_window ?? 131072));
      upsert.run('json_mode', JSON.stringify(body.json_mode ? 1 : 0));
    });
    transaction();
  }

  return NextResponse.json({ id });
}

export async function PUT(request: NextRequest) {
  const body = await request.json() as Partial<ApiProvider> & { save_as_current?: boolean };
  const db = getDb();

  if (!body.id) {
    return NextResponse.json({ error: '缺少供应商 ID' }, { status: 400 });
  }

  const existing = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(body.id) as Record<string, unknown> | undefined;
  if (!existing) {
    return NextResponse.json({ error: '供应商不存在' }, { status: 404 });
  }

  const apiKey = body.api_key === API_KEY_MASK ? existing.api_key as string : (body.api_key ?? existing.api_key as string);

  db.prepare(`
    UPDATE api_providers SET name = ?, api_base = ?, api_key = ?, model = ?, temperature = ?, max_tokens = ?, context_window = ?, json_mode = ?
    WHERE id = ?
  `).run(
    body.name ?? existing.name as string,
    body.api_base ?? existing.api_base as string,
    apiKey,
    body.model ?? existing.model as string,
    body.temperature ?? existing.temperature as number,
    body.max_tokens ?? existing.max_tokens as number,
    body.context_window ?? existing.context_window as number,
    body.json_mode !== undefined ? (body.json_mode ? 1 : 0) : existing.json_mode as number,
    body.id,
  );

  if (body.save_as_current) {
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const transaction = db.transaction(() => {
      upsert.run('active_provider_id', JSON.stringify(body.id));
      upsert.run('api_base', JSON.stringify(body.api_base ?? existing.api_base));
      if (apiKey && apiKey !== (existing.api_key as string)) upsert.run('api_key', JSON.stringify(apiKey));
      upsert.run('model', JSON.stringify(body.model ?? existing.model));
      upsert.run('temperature', JSON.stringify(body.temperature ?? existing.temperature));
      upsert.run('max_tokens', JSON.stringify(body.max_tokens ?? existing.max_tokens));
      upsert.run('context_window', JSON.stringify(body.context_window ?? existing.context_window));
      upsert.run('json_mode', JSON.stringify(body.json_mode !== undefined ? (body.json_mode ? 1 : 0) : existing.json_mode));
    });
    transaction();
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: '缺少供应商 ID' }, { status: 400 });
  }

  const db = getDb();
  db.prepare('DELETE FROM api_providers WHERE id = ?').run(id);

  const settings = loadSettings();
  if (settings.active_provider_id === id) {
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    upsert.run('active_provider_id', JSON.stringify(''));
  }

  return NextResponse.json({ ok: true });
}
