import { NextRequest, NextResponse } from 'next/server';
import { deleteEntry, getEntry, upsertEntry } from '@/lib/prompt-presets';
import { formatZodFieldErrors, promptPresetEntryUpsertSchema } from '@/lib/schemas';

/** GET /api/prompt-presets/[id]/entries/[entryId] */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  const entry = getEntry(entryId);
  if (!entry || entry.preset_id !== id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json(entry);
}

/** PATCH /api/prompt-presets/[id]/entries/[entryId] — 局部更新 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  const existing = getEntry(entryId);
  if (!existing || existing.preset_id !== id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  // PATCH 允许部分字段：对 upsertSchema 做 partial
  const partialSchema = promptPresetEntryUpsertSchema.partial();
  const parsed = partialSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const updated = upsertEntry({
    id: entryId,
    preset_id: existing.preset_id,
    name: body.name ?? existing.name,
    role: body.role ?? existing.role,
    content: body.content,
    is_marker: body.is_marker,
    marker_key: body.marker_key !== undefined ? body.marker_key : existing.marker_key,
    is_system_prompt: body.is_system_prompt,
    injection_position: body.injection_position,
    injection_depth: body.injection_depth,
    injection_order: body.injection_order,
    forbid_overrides: body.forbid_overrides,
    enabled: body.enabled,
    sort_order: body.sort_order,
  });
  return NextResponse.json(updated);
}

/** DELETE /api/prompt-presets/[id]/entries/[entryId] */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  const existing = getEntry(entryId);
  if (!existing || existing.preset_id !== id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  deleteEntry(entryId);
  return NextResponse.json({ ok: true });
}
