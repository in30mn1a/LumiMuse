import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthToken } from './lib/auth-token';

// 不需要验证的路径
const PUBLIC_PATHS = ['/login', '/api/auth', '/manifest.json'];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 没有设置访问密码时，直接放行（本地开发模式）
  const password = process.env.ACCESS_PASSWORD;
  if (!password) {
    return NextResponse.next();
  }

  // 公开路径直接放行
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // 静态资源直接放行
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf)$/)
  ) {
    return NextResponse.next();
  }

  // 验证 cookie 中的签名 token（HMAC，常量时间比较，不再存放密码原文）
  const token = request.cookies.get('lumimuse_auth')?.value;
  const valid = await verifyAuthToken(token);
  if (valid) {
    // 兼容旧数据：/avatars/xxx、/generated/xxx 和 /attachments/xxx 重写到 /api/files/...
    // 该兼容入口必须在认证通过后执行，避免旧静态资源路径绕过访问密码。
    if (pathname.startsWith('/avatars/') || pathname.startsWith('/generated/') || pathname.startsWith('/attachments/')) {
      const rewriteUrl = new URL(`/api/files${pathname}`, request.url);
      return NextResponse.rewrite(rewriteUrl);
    }

    return NextResponse.next();
  }

  // API 请求未认证时返回 401，而不是重定向
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '未授权，请先登录' }, { status: 401 });
  }

  // 页面请求重定向到登录页
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('from', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * 匹配所有路径，除了：
     * - _next/static（静态文件）
     * - _next/image（图片优化）
     * - favicon.ico
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
