import { NextRequest, NextResponse } from 'next/server';
import { buildLumiMusePresetExport, buildSillyTavernPresetExport } from '@/lib/prompt-preset-export';
import { getPreset } from '@/lib/prompt-presets';

function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').trim();
  return Array.from(sanitized).slice(0, 80).join('') || 'prompt-preset';
}

function contentDisposition(prefix: string, name: string): string {
  const unicodeFilename = `${prefix}-${sanitizeFilename(name)}.json`;
  const asciiFilename = unicodeFilename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encodedFilename = encodeURIComponent(unicodeFilename)
    .replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

/** GET /api/prompt-presets/[id]/export?format=lumimuse|sillytavern */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const format = (request.nextUrl.searchParams.get('format') || 'lumimuse').toLowerCase();
  const preset = getPreset(id);
  if (!preset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (format === 'lumimuse') {
    const payload = buildLumiMusePresetExport(id);
    if (!payload) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return new NextResponse(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': contentDisposition('lumimuse-preset', preset.name),
      },
    });
  }
  if (format === 'sillytavern' || format === 'st') {
    const payload = buildSillyTavernPresetExport(id);
    if (!payload) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return new NextResponse(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': contentDisposition('st-preset', preset.name),
      },
    });
  }
  return NextResponse.json({ error: 'Unknown format' }, { status: 400 });
}
