import { NextRequest, NextResponse } from 'next/server';
import { createPreset, listPresetsWithCounts } from '@/lib/prompt-presets';
import { formatZodFieldErrors, promptPresetCreateSchema } from '@/lib/schemas';

/** GET /api/prompt-presets — 列出所有预设（含条目计数） */
export async function GET() {
  try {
    const presets = listPresetsWithCounts();
    return NextResponse.json({ presets });
  } catch (err) {
    console.error('[api/prompt-presets] GET 失败', err);
    return NextResponse.json({ error: 'Failed to list presets' }, { status: 500 });
  }
}

/** POST /api/prompt-presets — 新建预设 */
export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = promptPresetCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  try {
    const preset = createPreset(parsed.data);
    return NextResponse.json(preset, { status: 201 });
  } catch (err) {
    console.error('[api/prompt-presets] POST 失败', err);
    return NextResponse.json({ error: 'Failed to create preset' }, { status: 500 });
  }
}
