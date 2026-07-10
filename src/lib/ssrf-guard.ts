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

type Ipv4Range = { net: number; mask: number };
type Ipv6Range = { network: string; prefixLength: number };

// 永不允许的特殊地址（即使开启了 ALLOW_LOCAL_NETWORK 也禁止）
const BLOCKED_IPV4_ALWAYS: Ipv4Range[] = [
  // 0.0.0.0/8 — "this network"
  { net: 0x00000000, mask: 0xff000000 },
  // 169.254.0.0/16 — 链路本地（含 AWS/GCP/Azure metadata 169.254.169.254）
  { net: 0xa9fe0000, mask: 0xffff0000 },
  // 192.0.0.0/24 — IETF 协议分配（下方单独放行两个 globally reachable anycast）
  { net: 0xc0000000, mask: 0xffffff00 },
  // 192.0.2.0/24 — TEST-NET-1
  { net: 0xc0000200, mask: 0xffffff00 },
  // 192.88.99.0/24 — 已弃用的 6to4 relay anycast
  { net: 0xc0586300, mask: 0xffffff00 },
  // 198.18.0.0/15 — benchmark
  { net: 0xc6120000, mask: 0xfffe0000 },
  // 198.51.100.0/24 — TEST-NET-2
  { net: 0xc6336400, mask: 0xffffff00 },
  // 203.0.113.0/24 — TEST-NET-3
  { net: 0xcb007100, mask: 0xffffff00 },
  // 224.0.0.0/4 — multicast
  { net: 0xe0000000, mask: 0xf0000000 },
  // 240.0.0.0/4 — reserved（含 limited broadcast）
  { net: 0xf0000000, mask: 0xf0000000 },
];

// 普通内网地址（默认禁止，开启 ALLOW_LOCAL_NETWORK 可放行）
const LOCAL_IPV4_RANGES: Ipv4Range[] = [
  // 127.0.0.0/8 — loopback
  { net: 0x7f000000, mask: 0xff000000 },
  // 10.0.0.0/8
  { net: 0x0a000000, mask: 0xff000000 },
  // 172.16.0.0/12
  { net: 0xac100000, mask: 0xfff00000 },
  // 192.168.0.0/16
  { net: 0xc0a80000, mask: 0xffff0000 },
  // 100.64.0.0/10 — shared address space（CGNAT / overlay）
  { net: 0x64400000, mask: 0xffc00000 },
];

const BLOCKED_IPV6_ALWAYS: Ipv6Range[] = [
  { network: '::', prefixLength: 128 }, // unspecified
  { network: '100::', prefixLength: 64 }, // discard-only
  { network: '2001:2::', prefixLength: 48 }, // benchmark
  { network: '2001:10::', prefixLength: 28 }, // deprecated ORCHIDv1
  { network: '2001:20::', prefixLength: 28 }, // ORCHIDv2
  { network: '2001:db8::', prefixLength: 32 }, // documentation
  { network: '3fff::', prefixLength: 20 }, // documentation
  { network: '5f00::', prefixLength: 16 }, // segment-routing SIDs, limited domain
  { network: 'fe80::', prefixLength: 10 }, // link-local
  { network: 'ff00::', prefixLength: 8 }, // multicast
];

const LOCAL_IPV6_RANGES: Ipv6Range[] = [
  { network: '::1', prefixLength: 128 }, // loopback
  { network: 'fc00::', prefixLength: 7 }, // unique local
  { network: 'fec0::', prefixLength: 10 }, // deprecated site-local
];

const PUBLIC_IPV4_EXCEPTIONS = new Set([
  ipv4ToInt('192.0.0.9'), // Port Control Protocol anycast
  ipv4ToInt('192.0.0.10'), // TURN anycast
]);

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

function isInIpv4Ranges(ip: string, ranges: Ipv4Range[]): boolean {
  const intIp = ipv4ToInt(ip);
  if (intIp === null) return false;
  return ranges.some(({ net: n, mask }) => ((intIp & mask) >>> 0) === n);
}

function isAlwaysBlockedIPv4(ip: string): boolean {
  const intIp = ipv4ToInt(ip);
  if (intIp === null) return false;
  if (PUBLIC_IPV4_EXCEPTIONS.has(intIp)) return false;
  return isInIpv4Ranges(ip, BLOCKED_IPV4_ALWAYS);
}

function isLocalIPv4(ip: string): boolean {
  return isInIpv4Ranges(ip, LOCAL_IPV4_RANGES);
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

function isInIpv6Range(ip: string, range: Ipv6Range): boolean {
  const words = parseIPv6Words(ip);
  const networkWords = parseIPv6Words(range.network);
  if (!words || !networkWords) return false;

  const fullWords = Math.floor(range.prefixLength / 16);
  for (let index = 0; index < fullWords; index += 1) {
    if (words[index] !== networkWords[index]) return false;
  }

  const remainingBits = range.prefixLength % 16;
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (words[fullWords] & mask) === (networkWords[fullWords] & mask);
}

function classifyIpv4(ip: string, allowLocal: boolean): string | null {
  if (isAlwaysBlockedIPv4(ip)) return '目标地址属于禁用的特殊用途地址段';
  if (!allowLocal && isLocalIPv4(ip)) return '目标地址属于内网，未启用 ALLOW_LOCAL_NETWORK';
  return null;
}

function classifyIpv6(ip: string, allowLocal: boolean): string | null {
  const mappedIPv4 = extractIPv4MappedIPv6(ip);
  if (mappedIPv4) return classifyIpv4(mappedIPv4, allowLocal);
  if (BLOCKED_IPV6_ALWAYS.some(range => isInIpv6Range(ip, range))) {
    return '目标地址属于禁用的 IPv6 特殊用途地址段';
  }
  if (!allowLocal && LOCAL_IPV6_RANGES.some(range => isInIpv6Range(ip, range))) {
    return '目标地址属于内网（IPv6），未启用 ALLOW_LOCAL_NETWORK';
  }
  return null;
}

/**
 * 同步校验 IP 字符串：是否为危险地址。
 * 返回 null 表示安全，否则返回拒绝原因。
 */
function classifyIp(ip: string, allowLocal: boolean): string | null {
  const family = net.isIP(ip);
  if (family === 4) {
    return classifyIpv4(ip, allowLocal);
  }
  if (family === 6) {
    return classifyIpv6(ip, allowLocal);
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
  // IPv6 字面量在 URL 里是 [::1]，剥去方括号后再判定是否为 IP
  let ipCandidate = hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    ipCandidate = hostname.slice(1, -1);
  }

  if (net.isIP(ipCandidate)) {
    const reason = classifyIp(ipCandidate, allowLocal);
    if (reason) throw new Error(`SSRF 防护拒绝: ${reason} (${ipCandidate})`);
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
  const currentHeaders = new Headers(init?.headers);

  const stripCredentialHeaders = () => {
    for (const name of ['authorization', 'proxy-authorization', 'cookie', 'cookie2']) {
      currentHeaders.delete(name);
    }
  };

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    // 使用 undici fetch，附带带 socket 层校验的 dispatcher
    // 类型转换：undici 与 Node lib 的 Response/RequestInit 类型不完全等价，
    // 但运行时兼容（Node 18+ 的全局 fetch 即基于 undici）
    const response = (await undiciFetch(currentUrl.toString(), {
      ...(init as Parameters<typeof undiciFetch>[1]),
      headers: currentHeaders,
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

    const nextUrl = await assertSafeUrl(new URL(location, currentUrl).toString());
    if (nextUrl.origin !== currentUrl.origin) {
      stripCredentialHeaders();
    }
    currentUrl = nextUrl;
  }

  throw new Error('重定向处理异常');
}
