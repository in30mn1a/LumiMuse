import { NextRequest, NextResponse } from 'next/server';
import { getPreset, listEntries, upsertEntry } from '@/lib/prompt-presets';
import { formatZodFieldErrors, promptPresetEntryUpsertSchema } from '@/lib/schemas';

/** GET /api/prompt-presets/[id]/entries — 列出条目（按 sort_order 升序） */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const preset = getPreset(id);
  if (!preset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ entries: listEntries(id) });
}

/** POST /api/prompt-presets/[id]/entries — 新增条目 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const preset = getPreset(id);
  if (!preset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = promptPresetEntryUpsertSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // 自动计算 sort_order：取现有 max(sort_order) + 10
  if (body.sort_order === undefined) {
    const existing = listEntries(id);
    const maxSort = existing.length > 0 ? Math.max(...existing.map(e => e.sort_order)) : 0;
    body.sort_order = maxSort + 10;
  }

  const entry = upsertEntry({
    preset_id: id,
    name: body.name,
    role: body.role,
    content: body.content,
    is_marker: body.is_marker,
    marker_key: body.marker_key ?? null,
    is_system_prompt: body.is_system_prompt,
    injection_position: body.injection_position,
    injection_depth: body.injection_depth,
    injection_order: body.injection_order,
    forbid_overrides: body.forbid_overrides,
    enabled: body.enabled,
    sort_order: body.sort_order,
  });
  return NextResponse.json(entry, { status: 201 });
}
