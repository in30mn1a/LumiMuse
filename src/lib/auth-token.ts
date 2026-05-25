/**
 * 认证 token 工具：使用 HMAC-SHA256 签名生成无状态会话令牌
 *
 * 同时兼容 Node Runtime（proxy / API 路由）与 Edge Runtime，
 * 仅依赖 Web Crypto API（globalThis.crypto.subtle）。
 *
 * Token 格式：base64url(payload).base64url(signature)
 * payload = JSON.stringify({ v: 1, iat: <ms>, nonce: <random> })
 *
 * 设计要点：
 * - Cookie 不再存放密码原文，泄漏 cookie 不等于泄漏密码
 * - 服务端无需维护 session 表，重启不丢失会话（除非更换密钥）
 * - 验证使用常量时间比较，避免时序攻击
 */

const TOKEN_VERSION = 1;
// Token 有效期，需与 cookie maxAge 同步
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/**
 * 鉴权 cookie 名称。
 * 生产环境（HTTPS + secure cookie）使用 `__Host-` 前缀，强制浏览器要求：
 *   - 必须 Secure（HTTPS 设置）
 *   - 必须 path=/
 *   - 禁止 domain 属性
 * 显著降低 cookie 注入 / fixation 攻击面。
 * 本地开发走 http，浏览器会拒绝 `__Host-` 前缀 cookie，因此 fallback 到不带前缀的名称。
 */
export const AUTH_COOKIE_NAME =
  process.env.NODE_ENV === 'production' ? '__Host-lumimuse_auth' : 'lumimuse_auth';

interface TokenPayload {
  v: number;
  iat: number;
  nonce: string;
}

// ---- 编码工具 ----

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa 在 Edge/Node 18+ 均可用
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(padLen));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---- 密钥管理 ----

let cachedKey: CryptoKey | null = null;
let cachedKeySource: string | null = null;
let fallbackWarned = false;

/**
 * 获取 HMAC 密钥。优先使用 AUTH_SECRET 环境变量，
 * 未设置时从 ACCESS_PASSWORD 派生（弱兜底，避免用户额外配置）。
 */
async function getHmacKey(): Promise<CryptoKey> {
  const authSecret = process.env.AUTH_SECRET;
  const secret = authSecret || process.env.ACCESS_PASSWORD || '';
  if (!secret) {
    throw new Error('AUTH_SECRET or ACCESS_PASSWORD must be set to issue/verify tokens');
  }
  // 弱兜底使用 ACCESS_PASSWORD 派生密钥时，仅首次提示一次
  if (!authSecret && !fallbackWarned) {
    fallbackWarned = true;
    console.warn(
      '[auth-token] AUTH_SECRET 未设置，正在使用 ACCESS_PASSWORD 派生 HMAC 密钥（弱兜底）。' +
        '建议设置独立的 AUTH_SECRET 环境变量（至少 32 字节随机字符串），' +
        '以避免密码与签名密钥共用、并在不修改 ACCESS_PASSWORD 时也能轮换 token 签名密钥。',
    );
  }
  if (cachedKey && cachedKeySource === secret) {
    return cachedKey;
  }
  const keyMaterial = textEncoder.encode(secret);
  // 派生 32 字节用作 HMAC key
  const digest = await crypto.subtle.digest('SHA-256', keyMaterial);
  cachedKey = await crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  cachedKeySource = secret;
  return cachedKey;
}

// ---- 常量时间字符串比较（用于密码 / token 比较） ----

/**
 * 常量时间比较两个字符串（Web Crypto 友好实现）。
 * 长度不一致时仍执行完整循环，避免长度泄漏。
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  // 用较长的一方作为循环长度，结果通过长度差异强制为不等
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i += 1) {
    const ai = i < aBytes.length ? aBytes[i] : 0;
    const bi = i < bBytes.length ? bBytes[i] : 0;
    diff |= ai ^ bi;
  }
  return diff === 0;
}

// ---- 签发与验证 ----

/**
 * 签发一个新的认证 token。
 */
export async function issueAuthToken(): Promise<string> {
  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    iat: Date.now(),
    nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(12))),
  };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(textEncoder.encode(payloadJson));

  const key = await getHmacKey();
  const sig = await crypto.subtle.sign('HMAC', key, textEncoder.encode(payloadB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));

  return `${payloadB64}.${sigB64}`;
}

/**
 * 验证一个 token 是否有效（签名正确且未过期）。
 * 出现任何异常一律返回 false，调用方不应区分失败原因（避免信息泄漏）。
 */
export async function verifyAuthToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;

  try {
    const key = await getHmacKey();
    const sigBytes = base64UrlDecode(sigB64);
    // 复制到独立的 ArrayBuffer，避免 SharedArrayBuffer 与 BufferSource 类型不兼容
    const sigBuffer = sigBytes.slice().buffer;
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBuffer,
      textEncoder.encode(payloadB64),
    );
    if (!ok) return false;

    const payloadBytes = base64UrlDecode(payloadB64);
    const payload = JSON.parse(textDecoder.decode(payloadBytes)) as TokenPayload;
    if (payload.v !== TOKEN_VERSION) return false;
    if (typeof payload.iat !== 'number') return false;

    const age = Date.now() - payload.iat;
    if (age < 0 || age > TOKEN_TTL_MS) return false;

    return true;
  } catch {
    return false;
  }
}
