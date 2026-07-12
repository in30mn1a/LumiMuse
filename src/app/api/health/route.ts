import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkReadiness, isReady } from '@/lib/readiness';

function resolveBuildIdentifier(): string {
  const configured = process.env.LUMIMUSE_BUILD_SHA?.trim();
  return configured && /^[0-9a-f]{7,40}$/i.test(configured)
    ? configured.toLowerCase()
    : 'local';
}

export async function GET(request?: NextRequest) {
  const metadata = {
    ok: true,
    service: 'lumimuse',
    build: resolveBuildIdentifier(),
    time: new Date().toISOString(),
  };

  if (request?.nextUrl.searchParams.get('ready') !== '1') {
    return NextResponse.json(metadata);
  }

  const checks = await checkReadiness();
  const ready = isReady(checks);
  return NextResponse.json(
    { ...metadata, ok: ready, ready, checks },
    { status: ready ? 200 : 503 },
  );
}
