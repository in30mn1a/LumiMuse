import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { loadSettings } from '@/lib/settings';
import { DEFAULT_SETTINGS, Settings } from '@/types';
import { API_KEY_MASK } from '@/lib/constants';


export async function GET() {
  const settings = loadSettings();
  const safe = {
    ...settings,
    api_key: settings.api_key ? API_KEY_MASK : '',
    image_gen: settings.image_gen ? {
      ...settings.image_gen,
      nai_api_key: settings.image_gen.nai_api_key ? API_KEY_MASK : '',
      custom_api_key: settings.image_gen.custom_api_key ? API_KEY_MASK : '',
    } : settings.image_gen,
  };
  return NextResponse.json(safe);
}

export async function PUT(request: NextRequest) {
  const updates = await request.json() as Partial<Settings>;
  const db = getDb();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const currentSettings = loadSettings();

  // 处理 image_gen 中的密钥掩码
  if (updates.image_gen) {
    const currentImgGen = currentSettings.image_gen;
    if (updates.image_gen.nai_api_key === API_KEY_MASK) {
      updates.image_gen.nai_api_key = currentImgGen?.nai_api_key || '';
    }
    if (updates.image_gen.custom_api_key === API_KEY_MASK) {
      updates.image_gen.custom_api_key = currentImgGen?.custom_api_key || '';
    }
  }

  // ── 跨 provider 密钥保护 ─────────────────────────────────────
  // 当 api_base 被切换到不同地址时，旧 api_key 不应再被发往新 base，
  // 否则会出现"旧账号密钥发到了陌生供应商"的跨账号泄漏窗口。
  // 策略：检测 api_base 变化，若客户端未在同一请求中显式提供新 api_key
  // （或仍是掩码 '********'，意味着保留旧值），则强制将 api_key 清空。
  // 客户端必须主动重新填入新 base 对应的 key 才能继续调用 LLM。
  const isApiBaseChanging =
    typeof updates.api_base === 'string' && updates.api_base !== currentSettings.api_base;
  const providesNewApiKey =
    typeof updates.api_key === 'string' && updates.api_key !== API_KEY_MASK;
  const shouldClearApiKey = isApiBaseChanging && !providesNewApiKey;

  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      // api_key === MASK 表示客户端要求保留旧值，不写入
      if (key === 'api_key' && value === API_KEY_MASK) continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      upsert.run(key, JSON.stringify(value));
    }
    // api_base 切换且无新 key 时，强制清空旧 key
    // 必须在循环之后执行，避免被本次 updates 中遗留的 api_key 字段覆盖
    if (shouldClearApiKey) {
      upsert.run('api_key', JSON.stringify(''));
    }
  });

  transaction();
  return NextResponse.json(loadSettings());
}
