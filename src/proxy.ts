import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME, verifyAuthToken } from './lib/auth-token';
import { getAuthMinIat } from './lib/settings';

// ⚠️ Next.js 16 约定：中间件入口文件名为 `proxy.ts`，导出函数名为 `proxy`。
// 这是 Next.js 16 官方重命名（从旧版的 `middleware.ts` / `middleware` 改来），
// 目的是与后端语境中的 "middleware" 概念区分。
// 请勿基于旧版经验改回 `middleware.ts` —— 那样会导致鉴权链完全失效，
// 所有 /api/* 接口（含 maintenance / settings / import 等高危路由）将对外裸奔。
// 官方文档：https://nextjs.org/docs (Next.js 16+ Proxy 章节)
//
// 运行时：Next.js 16 的 Proxy 总是运行在 Node.js 运行时（这是与旧版 Edge middleware
// 的主要区别之一），因此可以直接 import better-sqlite3 / fs 等原生 Node 模块。
// 注意：不允许在 config 中显式设置 `runtime`，否则 build 会报错
// "Route segment config is not allowed in Proxy file"。

// 不需要验证的路径
const PUBLIC_PATHS = ['/login', '/api/auth', '/api/health', '/manifest.json'];

// ── M3 CSRF 防御 ──────────────────────────────────────────────
// 对所有写方法（POST/PUT/PATCH/DELETE）强制要求 application/json，
// HTML form 提交无法设置该 Content-Type，从而天然挡住跨站 form 攻击。
//
// 上传接口例外：multipart/form-data 是文件上传必须的，需要白名单放行。
// 注意：跨站 form 也能发 multipart，所以白名单路径自身必须有其他防御
// （/api/upload 已做：MIME + 扩展名 + 魔术字节三重校验）。
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MULTIPART_ALLOWED_PATHS = new Set(['/api/upload']);

function isWriteRequestBlockedByCsrf(request: NextRequest, pathname: string): NextResponse | null {
  if (!pathname.startsWith('/api/')) return null;
  if (!MUTATING_METHODS.has(request.method)) return null;

  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  // Content-Type 可能带 charset / boundary 参数，比对前缀即可
  const isJson = contentType.startsWith('application/json');
  const isMultipart = contentType.startsWith('multipart/form-data');

  if (isJson) return null;
  if (isMultipart && MULTIPART_ALLOWED_PATHS.has(pathname)) return null;

  return NextResponse.json(
    { error: '请求 Content-Type 不被允许' },
    { status: 415 },
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 没有设置访问密码时，直接放行（本地开发模式）
  // 注意：本地模式下我们也跳过 CSRF 拦截。原因是无认证场景本就没有"跨域窃取"价值，
  // 强行拦截反而会阻止开发者用普通 form 调试接口。
  const password = process.env.ACCESS_PASSWORD;
  if (!password) {
    return NextResponse.next();
  }

  // 公开路径只做精确匹配，避免 `/api/health/*`、`/api/auth/*` 这类子命名空间被误放行。
  // 但对公开 API 的写请求仍然要做 CSRF 校验（登录接口若被 form 跨站提交也是问题）。
  const isPublic = PUBLIC_PATHS.includes(pathname);

  // ── M3 CSRF 拦截（先于鉴权，避免 401 错误把请求性质暴露） ──
  const csrfBlock = isWriteRequestBlockedByCsrf(request, pathname);
  if (csrfBlock) return csrfBlock;

  if (isPublic) {
    return NextResponse.next();
  }

  // 静态资源直接放行（只放行明确的固定路径前缀，不再按扩展名通配，
  // 否则未认证用户可通过 `/avatars/xxx.png` 等路径绕过鉴权读 public 目录）
  if (
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.json' ||
    pathname === '/sw.js' ||
    pathname === '/robots.txt'
  ) {
    return NextResponse.next();
  }

  // 读取服务端撤销点。getAuthMinIat 失败时回落到 0 = 不做撤销检查，
  // 避免 SQLite IO 异常导致所有用户被踢下线。
  let minIat = 0;
  try {
    minIat = getAuthMinIat();
  } catch (err) {
    console.error('[proxy] getAuthMinIat failed, skipping revocation check:', err);
  }

  // 验证 cookie 中的签名 token（HMAC，常量时间比较，不再存放密码原文）
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const valid = await verifyAuthToken(token, { minIat });
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
  // 注意：Next.js 16 Proxy 始终运行在 Node.js 运行时，不能（也不需要）显式设置 `runtime`。
  // 这里之所以可以直接 import better-sqlite3（getAuthMinIat → getDb）就是因为 Node runtime。
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
