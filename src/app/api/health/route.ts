import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkReadiness, isReady } from '@/lib/readiness';

export async function GET(request?: NextRequest) {
  const metadata = {
    ok: true,
    service: 'lumimuse',
    version: process.env.npm_package_version || '0.1.0',
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
