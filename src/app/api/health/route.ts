import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({
    ok: true,
    service: 'lumimuse',
    version: process.env.npm_package_version || '0.1.0',
    time: new Date().toISOString(),
  });
}
