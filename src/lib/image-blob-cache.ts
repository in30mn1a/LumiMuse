/**
 * 聊天 / 图库图片缓存（内存 blob URL + Cache API 持久层）。
 *
 * 为什么需要：
 * - 消息列表虚拟化 + 切对话会卸载 <img>，浏览器只保留 HTTP 磁盘缓存，不保证解码位图常驻内存
 * - 再挂上时即便 304/disk cache，仍要重新 decode，用户体感是「图片又加载了一次」
 * - 持有 blob: URL 时，跨对话 remount 可几乎瞬时显示
 * - HTTP 磁盘缓存不可靠：/api/files 会被 Next.js 打上 RSC Vary，且与全站共享配额；
 *   图库可达上 GB，关浏览器后再开会丢掉几张「明明加载过」的图
 *
 * 策略：
 * - 内存 LRU，按 URL 缓存 createObjectURL(blob)；条数与总字节双上限
 * - Cache API 再留一份，重开浏览器后 warm 先读本地、不走网络
 * - 淘汰内存时延迟 revoke，给「正在加载该 objectUrl 的 <img>」留出完成窗口
 * - 拉取失败记短时负缓存，避免流式渲染期间对 404 图反复发请求
 * 仅浏览器端；SSR / 不支持 fetch 时 no-op。
 */

import { rememberImageAspectRatio } from '@/lib/image-aspect-cache';

type Entry = {
  objectUrl: string;
  bytes: number;
};

type PersistItem = {
  url: string;
  bytes: number;
  at: number;
};

type PersistTombstone = {
  url: string;
  at: number;
};

type PersistState = {
  items: PersistItem[];
  tombstones: PersistTombstone[];
};

const MAX_ENTRIES = 80;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64MB：约 40 张 1.5MB PNG，移动端可承受
export const IMAGE_BLOB_PERSIST_FALLBACK_BYTES = 256 * 1024 * 1024; // 浏览器不支持容量估算时的保守回退
export const IMAGE_BLOB_PERSIST_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 防止单一站点无意占满超大磁盘
const PERSIST_AVAILABLE_SPACE_RATIO = 0.5; // 最多使用当前剩余配额的一半，给其它站点数据留余量
const PERSIST_BUDGET_REFRESH_MS = 5 * 60_000;
const PERSIST_TOUCH_INTERVAL_MS = 60_000;
const PERSIST_WRITE_BACKOFF_MS = 30_000;
const FAILURE_TTL_MS = 30_000;
const REVOKE_DELAY_MS = 5_000;
const PERSIST_CACHE_NAME = 'lumimuse-image-blobs-v1';
const PERSIST_INDEX_KEY = 'lumimuse-image-blob-index-v1';
const PERSIST_LOCK_NAME = 'lumimuse-image-blob-index-v1';
const PERSIST_INDEX_VERSION = 2;

let maxEntries = MAX_ENTRIES;
let maxTotalBytes = MAX_TOTAL_BYTES;
let maxPersistBytes = IMAGE_BLOB_PERSIST_FALLBACK_BYTES;
let persistBudgetOverride = false;
let persistBudgetResolvedAt = 0;
let persistRequestAttempted = false;

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();
const failedAt = new Map<string, number>();
const pendingRevokes = new Set<ReturnType<typeof setTimeout>>();
let totalBytes = 0;
let persistState: PersistState | null = null;
let persistWriteBackoffUntil = 0;
const persistJobs = new Set<Promise<void>>();
let persistChain = Promise.resolve();
let persistBackendOverride: CacheStorage | null = null;
let localStorageOverride: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = null;
let storageEstimateOverride: (() => Promise<{ quota?: number; usage?: number }>) | null = null;
const generations = new Map<string, number>();
const memoryTombstones = new Set<string>();
const persistTouchAt = new Map<string, number>();
const pendingPersistTouches = new Set<string>();
let persistTouchScheduled = false;

function enqueuePersist(work: () => Promise<void>): Promise<void> {
  const job = persistChain.then(work, work);
  const tracked = job.catch(() => undefined);
  persistChain = tracked;
  persistJobs.add(tracked);
  void tracked.finally(() => persistJobs.delete(tracked));
  return job;
}

async function withPersistLock<T>(work: () => Promise<T>): Promise<T> {
  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!lockManager || typeof lockManager.request !== 'function') return work();
  return lockManager.request(PERSIST_LOCK_NAME, () => work());
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof fetch === 'function' && typeof URL !== 'undefined';
}

function getCacheStorage(): CacheStorage | null {
  if (persistBackendOverride) return persistBackendOverride;
  if (typeof caches !== 'undefined' && typeof caches.open === 'function') return caches;
  return null;
}

function getLocalStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (localStorageOverride) return localStorageOverride;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

function persistReadSupported(): boolean {
  return isBrowser() && getCacheStorage() !== null;
}

function persistWriteSupported(): boolean {
  return persistReadSupported() && Date.now() >= persistWriteBackoffUntil;
}

function requestPersistentStorage(): void {
  if (persistRequestAttempted || typeof navigator === 'undefined') return;
  persistRequestAttempted = true;
  const persist = navigator.storage?.persist;
  if (typeof persist === 'function') {
    void persist.call(navigator.storage).catch(() => false);
  }
}

function isPersistableImageBlob(blob: Blob): boolean {
  return blob.type.startsWith('image/') || blob.type === '' || blob.type === 'application/octet-stream';
}

function emptyPersistState(): PersistState {
  return { items: [], tombstones: [] };
}

function parsePersistItems(items: unknown): PersistItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as PersistItem;
    if (typeof row.url !== 'string' || !row.url) return [];
    if (!Number.isFinite(row.bytes) || row.bytes < 0) return [];
    if (!Number.isFinite(row.at)) return [];
    return [{ url: row.url, bytes: row.bytes, at: row.at }];
  });
}

function parsePersistTombstones(tombstones: unknown): PersistTombstone[] {
  if (!Array.isArray(tombstones)) return [];
  return tombstones.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as PersistTombstone;
    if (typeof row.url !== 'string' || !row.url || !Number.isFinite(row.at)) return [];
    return [{ url: row.url, at: row.at }];
  });
}

function readPersistState(): { state: PersistState; authoritative: boolean } {
  const storage = getLocalStorage();
  if (!storage) return { state: persistState ?? emptyPersistState(), authoritative: false };
  try {
    const raw = storage.getItem(PERSIST_INDEX_KEY);
    if (!raw) {
      const state = emptyPersistState();
      persistState = state;
      return { state, authoritative: true };
    }
    const parsed = JSON.parse(raw) as { v?: number; items?: unknown; tombstones?: unknown };
    // v1 只有 items；就地兼容，下一次写入自动升级 v2。
    if (parsed.v !== 1 && parsed.v !== PERSIST_INDEX_VERSION) {
      const state = emptyPersistState();
      persistState = state;
      return { state, authoritative: true };
    }
    const state = {
      items: parsePersistItems(parsed.items),
      tombstones: parsed.v === PERSIST_INDEX_VERSION
        ? parsePersistTombstones(parsed.tombstones)
        : [],
    };
    persistState = state;
    return { state, authoritative: true };
  } catch {
    return { state: persistState ?? emptyPersistState(), authoritative: false };
  }
}

function writePersistState(state: PersistState): boolean {
  persistState = state;
  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    storage.setItem(PERSIST_INDEX_KEY, JSON.stringify({
      v: PERSIST_INDEX_VERSION,
      items: state.items,
      tombstones: state.tombstones,
    }));
    return true;
  } catch {
    return false;
  }
}

function generationFor(url: string): number {
  return generations.get(url) ?? 0;
}

function bumpGeneration(url: string): void {
  generations.set(url, generationFor(url) + 1);
}

function isCurrentGeneration(url: string, generation: number): boolean {
  return generationFor(url) === generation;
}

function upsertPersistItem(state: PersistState, url: string, bytes: number, at = Date.now()): PersistState {
  return {
    items: [...state.items.filter(item => item.url !== url), { url, bytes, at }],
    tombstones: state.tombstones.filter(item => item.url !== url),
  };
}

function tombstonePersistItem(state: PersistState, url: string): PersistState {
  return {
    items: state.items.filter(item => item.url !== url),
    tombstones: [...state.tombstones.filter(item => item.url !== url), { url, at: Date.now() }],
  };
}

function persistedTombstoneStatus(url: string): boolean | null {
  const { state, authoritative } = readPersistState();
  return authoritative ? state.tombstones.some(item => item.url === url) : null;
}

function schedulePersistTouch(url: string): void {
  if (!persistReadSupported() || memoryTombstones.has(url)) return;
  const now = Date.now();
  const last = persistTouchAt.get(url) ?? 0;
  if (now - last < PERSIST_TOUCH_INTERVAL_MS) return;
  persistTouchAt.set(url, now);
  pendingPersistTouches.add(url);
  if (persistTouchScheduled) return;
  persistTouchScheduled = true;
  void enqueuePersist(() => withPersistLock(async () => {
    const touches = new Set(pendingPersistTouches);
    pendingPersistTouches.clear();
    persistTouchScheduled = false;
    const { state, authoritative } = readPersistState();
    if (!authoritative) return;
    const tombstones = new Set(state.tombstones.map(item => item.url));
    const touchedAt = Date.now();
    const items = state.items.map(item => (
      touches.has(item.url) && !tombstones.has(item.url)
        ? { ...item, at: touchedAt }
        : item
    ));
    writePersistState({ ...state, items });
  })).catch(() => undefined);
}

async function resolvePersistBudget(state: PersistState): Promise<number> {
  if (persistBudgetOverride) return maxPersistBytes;
  const now = Date.now();
  if (persistBudgetResolvedAt > 0 && now - persistBudgetResolvedAt < PERSIST_BUDGET_REFRESH_MS) {
    return maxPersistBytes;
  }

  const estimate = storageEstimateOverride
    ?? (typeof navigator !== 'undefined' && typeof navigator.storage?.estimate === 'function'
      ? () => navigator.storage.estimate()
      : null);
  if (!estimate) {
    const indexedBytes = state.items.reduce((sum, item) => sum + item.bytes, 0);
    maxPersistBytes = Math.min(
      IMAGE_BLOB_PERSIST_MAX_BYTES,
      Math.max(IMAGE_BLOB_PERSIST_FALLBACK_BYTES, indexedBytes),
    );
    persistBudgetResolvedAt = now;
    return maxPersistBytes;
  }

  try {
    const result = await estimate();
    const quota = Number(result.quota);
    const usage = Number(result.usage ?? 0);
    if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(usage) || usage < 0) {
      throw new Error('Invalid storage estimate');
    }
    const indexedBytes = state.items.reduce((sum, item) => sum + item.bytes, 0);
    const nonImageUsage = Math.max(0, usage - indexedBytes);
    const adaptiveTarget = Math.floor(
      Math.max(0, quota - nonImageUsage) * PERSIST_AVAILABLE_SPACE_RATIO,
    );
    maxPersistBytes = Math.min(
      IMAGE_BLOB_PERSIST_MAX_BYTES,
      Math.max(indexedBytes, adaptiveTarget),
    );
  } catch {
    const indexedBytes = state.items.reduce((sum, item) => sum + item.bytes, 0);
    maxPersistBytes = Math.min(
      IMAGE_BLOB_PERSIST_MAX_BYTES,
      Math.max(IMAGE_BLOB_PERSIST_FALLBACK_BYTES, indexedBytes),
    );
  }
  persistBudgetResolvedAt = now;
  return maxPersistBytes;
}

function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'QuotaExceededError' || /quota/i.test(error.message);
}

async function persistMatch(url: string): Promise<Blob | null> {
  if (!persistReadSupported() || memoryTombstones.has(url)) return null;
  try {
    const before = readPersistState();
    if (!before.authoritative) return null;
    if (before.state.tombstones.some(item => item.url === url)) return null;
    if (!before.state.items.some(item => item.url === url)) return null;
    const cachesApi = getCacheStorage();
    if (!cachesApi) return null;
    const store = await cachesApi.open(PERSIST_CACHE_NAME);
    const response = await store.match(url, { ignoreVary: true });
    if (!response?.ok) return null;
    const blob = await response.blob();
    if (!isPersistableImageBlob(blob)) return null;
    const after = readPersistState();
    if (!after.authoritative) return null;
    if (memoryTombstones.has(url) || after.state.tombstones.some(item => item.url === url)) return null;
    if (!after.state.items.some(item => item.url === url)) return null;
    schedulePersistTouch(url);
    return blob;
  } catch {
    return null;
  }
}

async function persistPutLocked(
  url: string,
  blob: Blob,
  generation: number,
): Promise<void> {
  const bytes = blob.size;
  if (!persistWriteSupported() || bytes <= 0 || !isCurrentGeneration(url, generation)) return;
  try {
    const cachesApi = getCacheStorage();
    if (!cachesApi) return;
    const store = await cachesApi.open(PERSIST_CACHE_NAME);
    const initial = readPersistState();
    if (!initial.authoritative) return;
    let state = initial.state;
    const budget = await resolvePersistBudget(state);
    if (bytes > budget || !isCurrentGeneration(url, generation)) return;

    let items = state.items.filter(item => item.url !== url).sort((a, b) => a.at - b.at);
    let total = items.reduce((sum, item) => sum + item.bytes, 0);
    const evictedUrls = new Set<string>();
    let evictionFailed = false;
    while (total + bytes > budget && items.length > 1) {
      const evicted = items.shift();
      if (!evicted) break;
      try {
        await store.delete(evicted.url);
        evictedUrls.add(evicted.url);
        total -= evicted.bytes;
      } catch {
        // 删除失败就保留索引，并放弃新增写入，避免突破预算或把仍存在的条目变成孤儿。
        items.push(evicted);
        evictionFailed = true;
        break;
      }
    }
    if (evictionFailed || total + bytes > budget) {
      if (evictedUrls.size > 0) {
        const latest = readPersistState();
        if (latest.authoritative) {
          writePersistState({
            items: latest.state.items.filter(item => !evictedUrls.has(item.url)),
            tombstones: latest.state.tombstones,
          });
        }
      }
      return;
    }

    let stored = false;
    while (isCurrentGeneration(url, generation)) {
      try {
        // Cache API 自己持有二进制即可；合成响应避免把 App Router 的 RSC Vary 带进持久层。
        await store.put(url, new Response(blob, {
          status: 200,
          headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        }));
        stored = true;
        break;
      } catch (error) {
        // Cache API 的真实可用量可能低于 estimate；逐条释放 LRU，但至少保留一条旧缓存，
        // 避免单次永久写失败把所有仍可读内容删光。
        if (!isQuotaError(error) || items.length <= 1) {
          persistWriteBackoffUntil = Date.now() + PERSIST_WRITE_BACKOFF_MS;
          break;
        }
        const evicted = items.shift();
        if (!evicted) break;
        try {
          await store.delete(evicted.url);
          evictedUrls.add(evicted.url);
          total -= evicted.bytes;
        } catch {
          persistWriteBackoffUntil = Date.now() + PERSIST_WRITE_BACKOFF_MS;
          break;
        }
      }
    }
    await Promise.resolve();
    const commitRead = readPersistState();
    const commitState = commitRead.state;
    const tombstoned = memoryTombstones.has(url) || commitState.tombstones.some(item => item.url === url);
    state = {
      items: commitState.items.filter(item => item.url !== url && !evictedUrls.has(item.url)),
      tombstones: commitState.tombstones,
    };
    if (!stored || !commitRead.authoritative || !isCurrentGeneration(url, generation) || tombstoned) {
      if (stored) await store.delete(url).catch(() => false);
      if (commitRead.authoritative && evictedUrls.size > 0) writePersistState(state);
      return;
    }

    if (!writePersistState(upsertPersistItem(state, url, bytes))) {
      await store.delete(url).catch(() => false);
    }
  } catch {
    persistWriteBackoffUntil = Date.now() + PERSIST_WRITE_BACKOFF_MS;
  }
}

async function persistPut(url: string, blob: Blob, generation: number): Promise<void> {
  requestPersistentStorage();
  await withPersistLock(() => persistPutLocked(url, blob, generation));
}

async function persistDeleteLocked(url: string): Promise<void> {
  const current = readPersistState();
  const tombstonePersisted = current.authoritative
    && writePersistState(tombstonePersistItem(current.state, url));
  const cachesApi = getCacheStorage();
  if (!cachesApi) {
    if (!tombstonePersisted) throw new Error('无法持久化图片缓存删除标记');
    return;
  }
  let deletedOrAbsent = false;
  let deleteError: unknown = null;
  try {
    const store = await cachesApi.open(PERSIST_CACHE_NAME);
    const deleted = await store.delete(url);
    deletedOrAbsent = deleted;
    if (!deleted) {
      const stale = await store.match(url, { ignoreVary: true });
      deletedOrAbsent = !stale;
    }
    // tombstone 是用户删除语义，不只是重试标记；保留它可阻止其它标签页的旧 writer 复活 UUID URL。
  } catch (error) {
    // 保留 tombstone：即使底层删除失败，也不能再次命中已经被用户删除的 blob。
    deleteError = error;
  }
  if (!tombstonePersisted && !deletedOrAbsent) {
    throw deleteError instanceof Error ? deleteError : new Error('无法安全删除图片持久缓存');
  }
}

async function persistDelete(url: string): Promise<void> {
  await withPersistLock(() => persistDeleteLocked(url));
}

function putMemory(url: string, blob: Blob): string {
  const objectUrl = URL.createObjectURL(blob);
  cache.set(url, { objectUrl, bytes: blob.size });
  totalBytes += blob.size;
  evictIfNeeded();
  failedAt.delete(url);

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
  schedulePersistTouch(url);
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
    schedulePersistTouch(url);
    return Promise.resolve(hit.objectUrl);
  }

  const existing = inflight.get(url);
  if (existing) return existing;

  const generation = generationFor(url);
  const promise = (async (): Promise<string | null> => {
    try {
      const persisted = await persistMatch(url);
      if (!isCurrentGeneration(url, generation)) return null;
      if (persisted) return putMemory(url, persisted);

      const response = await fetch(url, {
        credentials: 'same-origin',
        // 与 /api/files 的 private cache 对齐：允许用浏览器 HTTP 缓存填满内存层
        cache: 'force-cache',
      });
      if (!response.ok) {
        if (!isCurrentGeneration(url, generation)) return null;
        failedAt.set(url, Date.now());
        return null;
      }
      const blob = await response.blob();
      if (!isCurrentGeneration(url, generation)) return null;
      const tombstoned = persistedTombstoneStatus(url);
      if (tombstoned) return null;
      if (tombstoned === null && persistReadSupported()) return null;
      if (!isPersistableImageBlob(blob)) {
        // 非图片（例如被重定向到登录 HTML）不进缓存
        failedAt.set(url, Date.now());
        return null;
      }
      const objectUrl = putMemory(url, blob);
      if (persistWriteSupported()) void enqueuePersist(() => persistPut(url, blob, generation)).catch(() => undefined);
      return objectUrl;
    } catch {
      if (isCurrentGeneration(url, generation) && !memoryTombstones.has(url)) {
        failedAt.set(url, Date.now());
      }
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

/** 从内存与持久层同时丢掉这些 URL（删除文件后调用） */
export function forgetImageBlobs(urls: Iterable<string>): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const url of urls) {
    if (!url || isInMemoryImageSrc(url)) continue;
    bumpGeneration(url);
    memoryTombstones.add(url);
    dropEntry(url);
    inflight.delete(url);
    failedAt.delete(url);
    jobs.push(enqueuePersist(() => persistDelete(url)));
  }
  return Promise.all(jobs).then(() => undefined);
}

function resetImageBlobMemory(): void {
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
  persistTouchAt.clear();
  pendingPersistTouches.clear();
  persistTouchScheduled = false;
  generations.clear();
  memoryTombstones.clear();
  totalBytes = 0;
  for (const timer of pendingRevokes) clearTimeout(timer);
  pendingRevokes.clear();
}

/** 测试用：模拟关浏览器——只清内存，保留 Cache API 持久层 */
export function resetImageBlobMemoryCacheForTests(): void {
  resetImageBlobMemory();
}

/** 测试用 */
export function resetImageBlobCache(): void {
  resetImageBlobMemory();
  persistState = emptyPersistState();
  persistWriteBackoffUntil = 0;
  persistBudgetResolvedAt = 0;
  persistRequestAttempted = false;
  persistBudgetOverride = false;
  maxPersistBytes = IMAGE_BLOB_PERSIST_FALLBACK_BYTES;
  generations.clear();
  memoryTombstones.clear();
  persistChain = Promise.resolve();
  const storage = getLocalStorage();
  if (storage) {
    try {
      storage.removeItem(PERSIST_INDEX_KEY);
    } catch {
      /* ignore */
    }
  }
  const cachesApi = getCacheStorage();
  if (cachesApi) void enqueuePersist(async () => {
    await cachesApi.delete(PERSIST_CACHE_NAME);
  }).catch(() => undefined);
}

export async function flushImageBlobPersistForTests(): Promise<void> {
  await Promise.all([...persistJobs]);
}

export function getImageBlobCacheSizeForTests(): number {
  return cache.size;
}

export function getImageBlobCacheBytesForTests(): number {
  return totalBytes;
}

export async function getImageBlobPersistBudgetForTests(): Promise<number> {
  return resolvePersistBudget(readPersistState().state);
}

/** 测试用：临时收紧条数/字节上限以覆盖淘汰路径；传空恢复默认 */
export function __setImageBlobCacheLimitsForTests(entries?: number, bytes?: number, persistBytes?: number): void {
  maxEntries = entries ?? MAX_ENTRIES;
  maxTotalBytes = bytes ?? MAX_TOTAL_BYTES;
  persistBudgetOverride = persistBytes !== undefined;
  maxPersistBytes = persistBytes ?? IMAGE_BLOB_PERSIST_FALLBACK_BYTES;
  persistBudgetResolvedAt = persistBudgetOverride ? Date.now() : 0;
}

/** 测试用：注入 Cache API / localStorage，避免污染并行用例的全局对象 */
export function __setImageBlobPersistBackendForTests(
  backend?: CacheStorage | null,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
): void {
  persistBackendOverride = backend ?? null;
  localStorageOverride = storage ?? null;
  persistState = null;
}

/** 测试用：注入浏览器存储容量估算。 */
export function __setImageBlobStorageEstimateForTests(
  estimate?: (() => Promise<{ quota?: number; usage?: number }>) | null,
): void {
  storageEstimateOverride = estimate ?? null;
  persistBudgetResolvedAt = 0;
}
