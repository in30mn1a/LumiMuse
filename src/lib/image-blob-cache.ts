/**
 * 聊天图片内存缓存（blob object URL）。
 *
 * 为什么需要：
 * - 消息列表虚拟化 + 切对话会卸载 <img>，浏览器只保留 HTTP 磁盘缓存，不保证解码位图常驻内存
 * - 再挂上时即便 304/disk cache，仍要重新 decode，用户体感是「图片又加载了一次」
 * - 持有 blob: URL 时，跨对话 remount 可几乎瞬时显示
 *
 * 策略：
 * - LRU，按 URL 缓存 createObjectURL(blob)；条数与总字节双上限
 * - 淘汰时延迟 revoke，给「正在加载该 objectUrl 的 <img>」留出完成窗口
 * - 拉取失败记短时负缓存，避免流式渲染期间对 404 图反复发请求
 * 仅浏览器端；SSR / 不支持 fetch 时 no-op。
 */

import { rememberImageAspectRatio } from '@/lib/image-aspect-cache';

type Entry = {
  objectUrl: string;
  bytes: number;
};

const MAX_ENTRIES = 80;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64MB：约 40 张 1.5MB PNG，移动端可承受
const FAILURE_TTL_MS = 30_000;
const REVOKE_DELAY_MS = 5_000;

let maxEntries = MAX_ENTRIES;
let maxTotalBytes = MAX_TOTAL_BYTES;

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();
const failedAt = new Map<string, number>();
const pendingRevokes = new Set<ReturnType<typeof setTimeout>>();
let totalBytes = 0;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof fetch === 'function' && typeof URL !== 'undefined';
}

/** data:/blob: 本身已在内存，不二次包一层 */
export function isInMemoryImageSrc(url: string): boolean {
  return url.startsWith('blob:') || url.startsWith('data:');
}

function touch(url: string, entry: Entry): void {
  cache.delete(url);
  cache.set(url, entry);
}

function revokeLater(objectUrl: string): void {
  // 立即 revoke 可能打断「刚被淘汰但仍在 <img> 加载中」的 objectUrl；延迟一个窗口再释放
  const timer = setTimeout(() => {
    pendingRevokes.delete(timer);
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      /* ignore */
    }
  }, REVOKE_DELAY_MS);
  // Node（测试环境）里 unref，避免空转计时器拖住进程退出；浏览器无此方法
  (timer as unknown as { unref?: () => void }).unref?.();
  pendingRevokes.add(timer);
}

function dropEntry(url: string): void {
  const entry = cache.get(url);
  if (!entry) return;
  cache.delete(url);
  totalBytes -= entry.bytes;
  revokeLater(entry.objectUrl);
}

function evictIfNeeded(): void {
  while (cache.size > maxEntries || totalBytes > maxTotalBytes) {
    const oldest = cache.keys().next().value;
    if (!oldest) return;
    dropEntry(oldest);
  }
}

function isRecentlyFailed(url: string): boolean {
  const at = failedAt.get(url);
  if (at == null) return false;
  if (Date.now() - at < FAILURE_TTL_MS) return true;
  failedAt.delete(url);
  return false;
}

export function peekImageBlobUrl(url: string | null | undefined): string | undefined {
  if (!url || isInMemoryImageSrc(url)) return url || undefined;
  const entry = cache.get(url);
  if (!entry) return undefined;
  touch(url, entry);
  return entry.objectUrl;
}

/**
 * 把远程/同源图片拉进内存 blob 缓存，返回 object URL。
 * 失败返回 null（调用方继续用原 src），并记 30s 负缓存。
 */
export function warmImageBlob(url: string): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  if (isInMemoryImageSrc(url)) return Promise.resolve(url);
  if (!isBrowser()) return Promise.resolve(null);
  if (isRecentlyFailed(url)) return Promise.resolve(null);

  const hit = cache.get(url);
  if (hit) {
    touch(url, hit);
    return Promise.resolve(hit.objectUrl);
  }

  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = (async (): Promise<string | null> => {
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        // 与 /api/files 的 private cache 对齐：允许用浏览器 HTTP 缓存填满内存层
        cache: 'force-cache',
      });
      if (!response.ok) {
        failedAt.set(url, Date.now());
        return null;
      }
      const blob = await response.blob();
      if (!blob.type.startsWith('image/') && blob.type !== '' && blob.type !== 'application/octet-stream') {
        // 非图片（例如被重定向到登录 HTML）不进缓存
        failedAt.set(url, Date.now());
        return null;
      }
      const objectUrl = URL.createObjectURL(blob);
      cache.set(url, { objectUrl, bytes: blob.size });
      totalBytes += blob.size;
      evictIfNeeded();
      failedAt.delete(url);

      // 顺带解码拿宽高比，供占位用（失败忽略）
      if (typeof Image !== 'undefined') {
        const probe = new Image();
        probe.onload = () => {
          if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
            rememberImageAspectRatio(url, probe.naturalWidth / probe.naturalHeight);
          }
        };
        probe.src = objectUrl;
      }

      return objectUrl;
    } catch {
      failedAt.set(url, Date.now());
      return null;
    }
  })().finally(() => {
    // finally 回调在 promise settle（微任务）后才执行，此时 const promise 已完成赋值
    if (inflight.get(url) === promise) inflight.delete(url);
  });

  inflight.set(url, promise);
  return promise;
}

export function warmImageBlobs(urls: Iterable<string>): void {
  for (const url of urls) {
    if (!url || isInMemoryImageSrc(url)) continue;
    void warmImageBlob(url);
  }
}

/** 测试用 */
export function resetImageBlobCache(): void {
  for (const entry of cache.values()) {
    try {
      URL.revokeObjectURL(entry.objectUrl);
    } catch {
      /* ignore */
    }
  }
  cache.clear();
  inflight.clear();
  failedAt.clear();
  totalBytes = 0;
  for (const timer of pendingRevokes) clearTimeout(timer);
  pendingRevokes.clear();
}

export function getImageBlobCacheSizeForTests(): number {
  return cache.size;
}

export function getImageBlobCacheBytesForTests(): number {
  return totalBytes;
}

/** 测试用：临时收紧条数/字节上限以覆盖淘汰路径；传空恢复默认 */
export function __setImageBlobCacheLimitsForTests(entries?: number, bytes?: number): void {
  maxEntries = entries ?? MAX_ENTRIES;
  maxTotalBytes = bytes ?? MAX_TOTAL_BYTES;
}
