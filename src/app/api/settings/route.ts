import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { loadSettings } from '@/lib/settings';
import { DEFAULT_SETTINGS, Settings } from '@/types';

const API_KEY_MASK = '********';


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

  // 处理 image_gen 中的密钥掩码
  if (updates.image_gen) {
    const currentSettings = loadSettings();
    const currentImgGen = currentSettings.image_gen;
    if (updates.image_gen.nai_api_key === API_KEY_MASK) {
      updates.image_gen.nai_api_key = currentImgGen?.nai_api_key || '';
    }
    if (updates.image_gen.custom_api_key === API_KEY_MASK) {
      updates.image_gen.custom_api_key = currentImgGen?.custom_api_key || '';
    }
  }

  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      if (key === 'api_key' && value === API_KEY_MASK) continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      upsert.run(key, JSON.stringify(value));
    }
  });

  transaction();
  return NextResponse.json(loadSettings());
}
