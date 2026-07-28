import { NextRequest, NextResponse } from 'next/server';
import { importSillyTavernPreset } from '@/lib/prompt-preset-import';
import { formatZodFieldErrors, promptPresetImportSchema } from '@/lib/schemas';

/** POST /api/prompt-presets/import — 上传酒馆 preset JSON 一键导入 */
export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = promptPresetImportSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const { name, json } = parsed.data;
  try {
    const report = importSillyTavernPreset(json, { presetName: name });
    return NextResponse.json(report, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/prompt-presets/import] 失败', err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
