import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME, issueAuthToken, timingSafeEqualString, TOKEN_TTL_MS, verifyAuthToken } from '@/lib/auth-token';
import { bumpAuthMinIat, getAuthMinIat } from '@/lib/settings';

// ====== 进程内内存级速率限制 ======
// 同一 IP 在 RATE_LIMIT_WINDOW_MS 时间窗内最多允许 RATE_LIMIT_MAX 次失败
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 分钟
const RATE_LIMIT_MAX = 10;
// 跟踪的 IP 上限，防止大量不同 IP 的失败尝试导致 Map 无界增长而 OOM
const MAX_TRACKED_IPS = 10000;
const DIRECT_RATE_LIMIT_BUCKET = '__direct__';
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function isTrustProxyEnabled(): boolean {
  const value = process.env.TRUST_PROXY?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function hasUntrustedForwardingHeaders(request: NextRequest): boolean {
  return (
    request.headers.has('x-forwarded-for') ||
    request.headers.has('x-real-ip') ||
    request.headers.has('forwarded')
  );
}

function getClientIp(request: NextRequest): string | null {
  if (isTrustProxyEnabled()) {
    // 取 x-forwarded-for 的第一个 IP（可信反代场景）
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  // NextRequest 在当前部署目标中没有稳定的直连 IP 字段。没有转发头时使用
  // direct bucket 修复默认直连场景不限流；出现未信任转发头时保持 unknown，
  // 避免攻击者用伪造头把所有未知来源合并锁死到同一个 bucket。
  return hasUntrustedForwardingHeaders(request) ? null : DIRECT_RATE_LIMIT_BUCKET;
}

function touchAttempt(ip: string, entry: { count: number; resetAt: number }): void {
  loginAttempts.delete(ip);
  loginAttempts.set(ip, entry);
}

function sweepExpiredAttempts(now: number): void {
  for (const [key, value] of loginAttempts) {
    if (value.resetAt <= now) {
      loginAttempts.delete(key);
    }
  }
}

function evictOldestAttempt(): void {
  const oldestKey = loginAttempts.keys().next().value;
  if (oldestKey !== undefined) {
    loginAttempts.delete(oldestKey);
  }
}

// 检查是否被限流；返回 true 表示已超限，应该拒绝
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) {
    return false;
  }
  if (entry.resetAt <= now) {
    loginAttempts.delete(ip);
    return false;
  }
  touchAttempt(ip, entry);
  return entry.count >= RATE_LIMIT_MAX;
}

// 记录一次失败尝试
function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (entry) {
      loginAttempts.delete(ip);
    }
    // 写入新条目前顺手清扫所有已过期条目（resetAt <= now），物理释放内存
    sweepExpiredAttempts(now);
    // 清扫后仍达到容量上限，说明同时存在大量未过期的活跃失败 IP。
    // 只淘汰最久未使用的桶，避免攻击者靠制造新 IP 直接清空所有计数。
    while (loginAttempts.size >= MAX_TRACKED_IPS) {
      evictOldestAttempt();
    }
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count += 1;
    touchAttempt(ip, entry);
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
  if (ip && isRateLimited(ip)) {
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
    if (ip) {
      recordFailure(ip);
    }
    return NextResponse.json({ error: '密码不正确' }, { status: 401 });
  }

  // 验证通过，清零失败计数，签发签名 token 并写入 httpOnly cookie
  if (ip) {
    clearAttempts(ip);
  }
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

// DELETE /api/auth — 退出登录，清除 cookie；只有有效会话才能推进全局撤销点
export async function DELETE(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  // 清除 cookie 时也需要带上写入时的属性（secure / path），否则浏览器视作不同 cookie 而无法删除
  response.cookies.set(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
    path: '/',
  });

  if (!process.env.ACCESS_PASSWORD) {
    return response;
  }

  let minIat = 0;
  try {
    minIat = getAuthMinIat();
  } catch (err) {
    console.error('[auth] getAuthMinIat failed during logout, skipping revocation check:', err);
  }

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const valid = await verifyAuthToken(token, { minIat });
  if (valid) {
    try {
      bumpAuthMinIat();
    } catch (err) {
      // 撤销写入失败不应阻塞登出响应（cookie 清除依然有效），但要可见
      console.error('[auth] bumpAuthMinIat failed during logout:', err);
    }
  }

  return response;
}

// GET /api/auth — 返回当前认证状态（是否启用了密码保护）
export async function GET() {
  const password = process.env.ACCESS_PASSWORD;
  return NextResponse.json({ authEnabled: !!password });
}
