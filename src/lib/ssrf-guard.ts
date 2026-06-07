/**
 * SSRF（Server-Side Request Forgery）防护工具
 *
 * 出站请求前，需要校验目标 URL 是否安全。
 * 主要防御对象：
 * - 强制非 http/https 协议（避免 file://、gopher:// 等）
 * - 阻止链路本地地址（169.254.0.0/16，AWS/GCP/Azure metadata 服务）
 * - 阻止 0.0.0.0 / ::
 * - 默认阻止其他内网地址（127/8、10/8、172.16/12、192.168/16、IPv6 fc00::/7、fec0::/10、::1）
 *
 * 设计权衡：
 * 由于本应用允许自部署用户连接本地 LLM（如 Ollama）和本地生图（SD WebUI / ComfyUI），
 * 提供环境变量 ALLOW_LOCAL_NETWORK=1 显式放开 loopback/RFC1918 地址。
 * 但 metadata 服务地址永不放开。
 *
 * 注意：本模块在 DNS 解析后再次校验，避免攻击者用域名指向内网。
 */

import { lookup } from 'dns/promises';
import net from 'net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// 永不允许的特殊地址（即使开启了 ALLOW_LOCAL_NETWORK 也禁止）
const BLOCKED_IPV4_ALWAYS = [
  // 0.0.0.0/8 — "this network"
  { net: 0x00000000, mask: 0xff000000 },
  // 169.254.0.0/16 — 链路本地（含 AWS/GCP/Azure metadata 169.254.169.254）
  { net: 0xa9fe0000, mask: 0xffff0000 },
];

// 普通内网地址（默认禁止，开启 ALLOW_LOCAL_NETWORK 可放行）
const PRIVATE_IPV4_RANGES = [
  // 127.0.0.0/8 — loopback
  { net: 0x7f000000, mask: 0xff000000 },
  // 10.0.0.0/8
  { net: 0x0a000000, mask: 0xff000000 },
  // 172.16.0.0/12
  { net: 0xac100000, mask: 0xfff00000 },
  // 192.168.0.0/16
  { net: 0xc0a80000, mask: 0xffff0000 },
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result * 256) + n;
  }
  // 转为无符号 32 位
  return result >>> 0;
}

function isAlwaysBlockedIPv4(ip: string): boolean {
  const intIp = ipv4ToInt(ip);
  if (intIp === null) return false;
  return BLOCKED_IPV4_ALWAYS.some(({ net: n, mask }) => ((intIp & mask) >>> 0) === n);
}

function isPrivateIPv4(ip: string): boolean {
  const intIp = ipv4ToInt(ip);
  if (intIp === null) return false;
  return PRIVATE_IPV4_RANGES.some(({ net: n, mask }) => ((intIp & mask) >>> 0) === n);
}

function parseIPv6Words(ip: string): number[] | null {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const withoutZone = normalized.split('%')[0];
  const ipv4Match = withoutZone.match(/(.+:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let source = withoutZone;

  if (ipv4Match) {
    const intIp = ipv4ToInt(ipv4Match[2]);
    if (intIp === null) return null;
    source = `${ipv4Match[1]}${((intIp >>> 16) & 0xffff).toString(16)}:${(intIp & 0xffff).toString(16)}`;
  }

  const halves = source.split('::');
  if (halves.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const words = part.split(':');
    const parsed: number[] = [];
    for (const word of words) {
      if (!/^[0-9a-f]{1,4}$/.test(word)) return null;
      parsed.push(parseInt(word, 16));
    }
    return parsed;
  };

  const left = parsePart(halves[0]);
  const right = parsePart(halves[1] ?? '');
  if (!left || !right) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function extractIPv4MappedIPv6(ip: string): string | null {
  const words = parseIPv6Words(ip);
  if (!words || words.length !== 8) return null;
  if (!words.slice(0, 5).every(word => word === 0) || words[5] !== 0xffff) return null;

  const high = words[6];
  const low = words[7];
  return [
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ].join('.');
}

function isAlwaysBlockedIPv6(ip: string): boolean {
  // IPv6 unspecified
  if (ip === '::' || ip === '0:0:0:0:0:0:0:0') return true;
  // IPv4-mapped 中嵌入的危险地址
  const mappedIPv4 = extractIPv4MappedIPv6(ip);
  if (mappedIPv4 && isAlwaysBlockedIPv4(mappedIPv4)) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  if (ip === '::1') return true; // loopback
  const lower = ip.toLowerCase();
  // fc00::/7 — unique local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // fe80::/10 — link-local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true;
  }
  // fec0::/10 — deprecated site-local addresses
  if (lower.startsWith('fec') || lower.startsWith('fed') || lower.startsWith('fee') || lower.startsWith('fef')) {
    return true;
  }
  // IPv4-mapped 中嵌入的私有地址
  const mappedIPv4 = extractIPv4MappedIPv6(ip);
  if (mappedIPv4 && isPrivateIPv4(mappedIPv4)) return true;
  return false;
}

/**
 * 同步校验 IP 字符串：是否为危险地址。
 * 返回 null 表示安全，否则返回拒绝原因。
 */
function classifyIp(ip: string, allowLocal: boolean): string | null {
  const family = net.isIP(ip);
  if (family === 4) {
    if (isAlwaysBlockedIPv4(ip)) return '目标地址属于禁用范围（链路本地 / 0.0.0.0）';
    if (!allowLocal && isPrivateIPv4(ip)) return '目标地址属于内网，未启用 ALLOW_LOCAL_NETWORK';
    return null;
  }
  if (family === 6) {
    if (isAlwaysBlockedIPv6(ip)) return '目标地址属于禁用范围（IPv6 链路本地 / 未指定地址）';
    if (!allowLocal && isPrivateIPv6(ip)) return '目标地址属于内网（IPv6），未启用 ALLOW_LOCAL_NETWORK';
    return null;
  }
  return '目标地址不是合法 IP';
}

/**
 * 校验一个 URL 是否可被安全请求。
 *
 * 通过 DNS 解析将主机名转为 IP 后再次校验，避免攻击者通过 DNS rebinding 或
 * 用 example.com → 127.0.0.1 这种映射绕过白名单。
 *
 * 抛出 Error 表示不安全；正常返回 URL 对象表示通过。
 */
export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL 格式无效: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`仅允许 http/https 协议，收到: ${url.protocol}`);
  }

  const allowLocal = process.env.ALLOW_LOCAL_NETWORK === '1';

  // 主机名可能是 IP 或域名
  const hostname = url.hostname;
  // IPv6 字面量在 URL 里是 [::1]，URL.hostname 已剥掉方括号
  if (net.isIP(hostname)) {
    const reason = classifyIp(hostname, allowLocal);
    if (reason) throw new Error(`SSRF 防护拒绝: ${reason} (${hostname})`);
    return url;
  }

  // 域名：解析所有 A/AAAA 记录，逐一校验
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`无法解析主机名: ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new Error(`主机名无解析结果: ${hostname}`);
  }

  for (const { address } of addresses) {
    const reason = classifyIp(address, allowLocal);
    if (reason) {
      throw new Error(`SSRF 防护拒绝: ${reason} (${hostname} → ${address})`);
    }
  }

  return url;
}

/**
 * 构建一个带 socket 层 IP 校验的 undici Agent。
 *
 * 防御目标：DNS 预解析（第一道防线）与实际连接之间存在 TOCTOU 窗口。
 * 攻击者可以让域名首次解析返回公网 IP，第二次（fetch 内部）解析返回内网 IP，
 * 即所谓的 DNS rebinding。本 Agent 在 socket 建立 *之后* 检查真实 remoteAddress，
 * 命中黑名单则立刻 destroy socket。
 *
 * 注意：destroy(err) 会让上层 fetch 抛错，调用方收到的错误信息会包含具体 IP，
 * 与 assertSafeUrl 的拒绝原因风格保持一致。
 */
function createGuardedAgent(allowLocal: boolean): Dispatcher {
  const defaultConnector = buildConnector({});

  return new Agent({
    connect(opts, callback) {
      defaultConnector(opts, (err, socket) => {
        if (err || !socket) {
          callback(err, null);
          return;
        }

        // 拿到真实远端 IP（DNS 二次解析后实际连接的对象）
        const remoteAddress = socket.remoteAddress;
        if (!remoteAddress) {
          // 极少数情况：连接已断开/未就绪，保守拒绝
          socket.destroy();
          callback(new Error('SSRF 防护拒绝: 无法获取远端 IP'), null);
          return;
        }

        const reason = classifyIp(remoteAddress, allowLocal);
        if (reason) {
          socket.destroy();
          callback(
            new Error(`SSRF 防护拒绝（socket 层）: ${reason} (${remoteAddress})`),
            null,
          );
          return;
        }

        callback(null, socket);
      });
    },
  });
}

// 按 ALLOW_LOCAL_NETWORK 缓存两份 dispatcher，避免重复创建连接池
let guardedAgentStrict: Dispatcher | null = null;
let guardedAgentAllowLocal: Dispatcher | null = null;

function getGuardedAgent(allowLocal: boolean): Dispatcher {
  if (allowLocal) {
    if (!guardedAgentAllowLocal) {
      guardedAgentAllowLocal = createGuardedAgent(true);
    }
    return guardedAgentAllowLocal;
  }
  if (!guardedAgentStrict) {
    guardedAgentStrict = createGuardedAgent(false);
  }
  return guardedAgentStrict;
}

/**
 * 包装 fetch，做双层 SSRF 防护：
 * 1. DNS 预解析层（assertSafeUrl）：fail-fast，避免明显的内网 URL 浪费 socket
 * 2. socket 层（undici Agent connect hook）：真实连接 IP 再校验一次，
 *    防御 DNS rebinding（首次解析返回公网 IP，fetch 内部二次解析返回内网 IP）
 *
 * 本函数只负责出站地址安全，不设置全局超时。聊天、生图、总结和后台队列对“慢上游”的语义不同；
 * 若某个调用需要中止，应由调用方传入 AbortSignal 或在业务层做可配置 watchdog。
 */
export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
): Promise<Response> {
  let currentUrl = await assertSafeUrl(rawUrl);
  const maxRedirects = 5;
  const allowLocal = process.env.ALLOW_LOCAL_NETWORK === '1';
  const dispatcher = getGuardedAgent(allowLocal);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    // 使用 undici fetch，附带带 socket 层校验的 dispatcher
    // 类型转换：undici 与 Node lib 的 Response/RequestInit 类型不完全等价，
    // 但运行时兼容（Node 18+ 的全局 fetch 即基于 undici）
    const response = (await undiciFetch(currentUrl.toString(), {
      ...(init as Parameters<typeof undiciFetch>[1]),
      redirect: 'manual',
      dispatcher,
    })) as unknown as Response;

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    if (redirectCount === maxRedirects) {
      throw new Error('重定向次数过多');
    }

    currentUrl = await assertSafeUrl(new URL(location, currentUrl).toString());
  }

  throw new Error('重定向处理异常');
}
