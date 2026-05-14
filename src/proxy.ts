import { NextRequest, NextResponse } from 'next/server';

// 不需要验证的路径
const PUBLIC_PATHS = ['/login', '/api/auth', '/manifest.json'];

export function proxy(request: NextRequest) {
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

  // 兼容旧数据：/avatars/xxx 和 /generated/xxx 重写到 /api/files/...
  if (pathname.startsWith('/avatars/') || pathname.startsWith('/generated/')) {
    const rewriteUrl = new URL(`/api/files${pathname}`, request.url);
    return NextResponse.rewrite(rewriteUrl);
  }

  // 检查 cookie 里的认证令牌
  const token = request.cookies.get('lumimuse_auth')?.value;
  if (token === process.env.ACCESS_PASSWORD) {
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
