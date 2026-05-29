import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME, issueAuthToken, timingSafeEqualString, TOKEN_TTL_MS } from '@/lib/auth-token';
import { bumpAuthMinIat } from '@/lib/settings';

// ====== 进程内内存级速率限制 ======
// 同一 IP 在 RATE_LIMIT_WINDOW_MS 时间窗内最多允许 RATE_LIMIT_MAX 次失败
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 分钟
const RATE_LIMIT_MAX = 10;
// 跟踪的 IP 上限，防止大量不同 IP 的失败尝试导致 Map 无界增长而 OOM
const MAX_TRACKED_IPS = 10000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function getClientIp(request: NextRequest): string {
  // 取 x-forwarded-for 的第一个 IP（反代场景）
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

// 检查是否被限流；返回 true 表示已超限，应该拒绝
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    return false;
  }
  return entry.count >= RATE_LIMIT_MAX;
}

// 记录一次失败尝试
function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    // 写入新条目前顺手清扫所有已过期条目（resetAt <= now），物理释放内存
    for (const [key, value] of loginAttempts) {
      if (value.resetAt <= now) {
        loginAttempts.delete(key);
      }
    }
    // 清扫后仍达到容量上限，说明同时存在大量未过期的活跃失败 IP。
    // 权衡：直接清空整个 Map 是最简单稳妥的兜底，可避免无界增长；
    // 代价是极端情况下会重置所有 IP 的失败计数（限流短暂放宽），
    // 但这种规模的并发攻击场景本应由上游反代/WAF 处理，此处仅作内存兜底。
    if (loginAttempts.size >= MAX_TRACKED_IPS) {
      loginAttempts.clear();
    }
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

// 成功登录后清零该 IP 的计数
function clearAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// POST /api/auth — 验证访问密码，写入认证 cookie
export async function POST(request: NextRequest) {
  const password = process.env.ACCESS_PASSWORD;

  // 未设置密码时直接返回成功（本地开发模式，无需限流）
  if (!password) {
    return NextResponse.json({ ok: true });
  }

  const ip = getClientIp(request);

  // 限流检查：超过阈值直接 429
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: '尝试次数过多，请稍后再试' },
      { status: 429 }
    );
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
    recordFailure(ip);
    return NextResponse.json({ error: '密码不正确' }, { status: 401 });
  }

  // 验证通过，清零失败计数，签发签名 token 并写入 httpOnly cookie
  clearAttempts(ip);
  const token = await issueAuthToken();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // 生产环境下建议开启 secure，本地 http 开发时不强制
    // 注意：`__Host-` 前缀要求 secure=true + path=/ + 不设 domain，三者必须同时满足
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.floor(TOKEN_TTL_MS / 1000),
    path: '/',
  });

  return response;
}

// DELETE /api/auth — 退出登录，清除 cookie 并作废所有已签发的 token
export async function DELETE() {
  // 服务端撤销：推进 min_iat，让所有签发时间早于此刻的 token 全部失效。
  // 这是真正的"登出"——即便 cookie 已被窃取或浏览器外其他副本仍持有，也会立即失效。
  // 仅在启用了访问密码的部署中才需要撤销（无密码模式下 token 体系本就不生效）。
  if (process.env.ACCESS_PASSWORD) {
    try {
      bumpAuthMinIat();
    } catch (err) {
      // 撤销写入失败不应阻塞登出响应（cookie 清除依然有效），但要可见
      console.error('[auth] bumpAuthMinIat failed during logout:', err);
    }
  }

  const response = NextResponse.json({ ok: true });
  // 清除 cookie 时也需要带上写入时的属性（secure / path），否则浏览器视作不同 cookie 而无法删除
  response.cookies.set(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
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
