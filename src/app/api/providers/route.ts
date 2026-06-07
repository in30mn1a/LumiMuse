import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { loadSettings } from '@/lib/settings';
import { ApiProvider } from '@/types';
import { randomUUID } from 'crypto';
import { providerCreateSchema, providerUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { API_KEY_MASK } from '@/lib/constants';
import { requireAuth } from '@/lib/route-auth';

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

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

function resolveProviderKey({
  incoming,
  fallback,
  baseChanged,
}: {
  incoming?: string;
  fallback: string;
  baseChanged: boolean;
}): string {
  if (incoming === API_KEY_MASK) {
    return baseChanged ? '' : fallback;
  }
  return incoming ?? fallback;
}

export async function GET(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_providers ORDER BY created_at ASC').all() as Record<string, unknown>[];
  const providers = rows.map(rowToProvider);
  const settings = loadSettings();
  return NextResponse.json({ providers, active_provider_id: settings.active_provider_id || '' });
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = providerCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const db = getDb();

  const id = randomUUID();
  const currentSettings = loadSettings();
  const apiBase = body.api_base || '';
  const apiKey = resolveProviderKey({
    incoming: body.api_key ?? '',
    fallback: currentSettings.api_key,
    baseChanged: apiBase !== currentSettings.api_base,
  });

  db.prepare(`
    INSERT INTO api_providers (id, name, api_base, api_key, model, temperature, max_tokens, context_window, json_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    body.name || 'New Provider',
    apiBase,
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
      upsert.run('api_base', JSON.stringify(apiBase));
      // 跨 provider 密钥保护：无论新 provider 是否带 key，都必须把 settings.api_key
      // 同步成新 provider 的值（包括空字符串）。否则旧 provider 的 key 会残留并被
      // 发往新的 api_base，造成跨账号密钥泄漏。
      upsert.run('api_key', JSON.stringify(apiKey));
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
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = providerUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const db = getDb();

  if (!isUuid(body.id)) {
    return NextResponse.json({ error: '缺少供应商 ID' }, { status: 400 });
  }

  const existing = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(body.id) as Record<string, unknown> | undefined;
  if (!existing) {
    return NextResponse.json({ error: '供应商不存在' }, { status: 404 });
  }

  const existingApiBase = existing.api_base as string;
  const apiKey = resolveProviderKey({
    incoming: body.api_key,
    fallback: existing.api_key as string,
    baseChanged: body.api_base !== undefined && body.api_base !== existingApiBase,
  });

  db.prepare(`
    UPDATE api_providers SET name = ?, api_base = ?, api_key = ?, model = ?, temperature = ?, max_tokens = ?, context_window = ?, json_mode = ?
    WHERE id = ?
  `).run(
    body.name ?? existing.name as string,
    body.api_base ?? existingApiBase,
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
      // 跨 provider 密钥保护：必须无条件同步 api_key 到 settings 表（包括空值），
      // 否则切换 active provider 时旧 key 会残留在 settings 中并被发往新 base。
      upsert.run('api_key', JSON.stringify(apiKey || ''));
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
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const id = request.nextUrl.searchParams.get('id');
  if (!isUuid(id)) {
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
