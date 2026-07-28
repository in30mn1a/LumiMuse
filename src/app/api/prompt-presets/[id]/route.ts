import { NextRequest, NextResponse } from 'next/server';
import { deletePreset, getPreset, updatePreset } from '@/lib/prompt-presets';
import { formatZodFieldErrors, promptPresetUpdateSchema } from '@/lib/schemas';

/** GET /api/prompt-presets/[id] */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const preset = getPreset(id);
  if (!preset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(preset);
}

/** PATCH /api/prompt-presets/[id] — 更新 name/description */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = promptPresetUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const existing = getPreset(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  updatePreset(id, parsed.data);
  return NextResponse.json(getPreset(id));
}

/** DELETE /api/prompt-presets/[id] — 级联删除条目并解绑角色 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const existing = getPreset(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  deletePreset(id);
  return NextResponse.json({ ok: true });
}
