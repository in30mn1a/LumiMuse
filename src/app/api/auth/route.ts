import { NextRequest, NextResponse } from 'next/server';
import { issueAuthToken, timingSafeEqualString, TOKEN_TTL_MS } from '@/lib/auth-token';

// POST /api/auth — 验证访问密码，写入认证 cookie
export async function POST(request: NextRequest) {
  const password = process.env.ACCESS_PASSWORD;

  // 未设置密码时直接返回成功（本地开发模式）
  if (!password) {
    return NextResponse.json({ ok: true });
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  // 常量时间比较，避免通过响应耗时差推测密码
  const submitted = typeof body.password === 'string' ? body.password : '';
  if (!timingSafeEqualString(submitted, password)) {
    return NextResponse.json({ error: '密码不正确' }, { status: 401 });
  }

  // 验证通过，签发签名 token 并写入 httpOnly cookie
  const token = await issueAuthToken();
  const response = NextResponse.json({ ok: true });
  response.cookies.set('lumimuse_auth', token, {
    httpOnly: true,
    sameSite: 'lax',
    // 生产环境下建议开启 secure，本地 http 开发时不强制
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.floor(TOKEN_TTL_MS / 1000),
    path: '/',
  });

  return response;
}

// DELETE /api/auth — 退出登录，清除 cookie
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set('lumimuse_auth', '', {
    httpOnly: true,
    maxAge: 0,
    path: '/',
  });
  return response;
}

// GET /api/auth — 返回当前认证状态（是否启用了密码保护）
export async function GET() {
  const password = process.env.ACCESS_PASSWORD;
  return NextResponse.json({ authEnabled: !!password });
}
