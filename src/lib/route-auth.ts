import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME, verifyAuthToken } from '@/lib/auth-token';
import { getAuthMinIat } from '@/lib/settings';

/**
 * Route-level authentication is a defense-in-depth check, not a replacement for proxy.ts.
 * Use it for credential/configuration APIs, destructive maintenance, and bulk import paths
 * where a future proxy matcher mistake would expose unusually broad or destructive writes.
 * Ordinary authenticated routes continue to rely on the shared proxy boundary.
 */
export async function requireAuth(request: NextRequest): Promise<NextResponse | null> {
  if (!process.env.ACCESS_PASSWORD) return null;

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const valid = await verifyAuthToken(token, { minIat: getAuthMinIat() });
  if (!valid) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }
  return null;
}
