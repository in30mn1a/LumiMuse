/**
 * 客户端图片宽高比缓存。
 *
 * 聊天列表是虚拟滚动 + 动态 measure：若 <img> 无预留尺寸，
 * 图片从 0 高度变为真实高度时会触发 row remeasure，气泡上下跳动。
 * 在渲染前记住宽高比，用 aspect-ratio 占位即可消掉该 CLS。
 *
 * 仅缓存在内存（按 URL），不写 localStorage；刷新后可从 warm 再学。
 */

const aspectByUrl = new Map<string, number>();
const inflight = new Map<string, Promise<number>>();

/** 未知尺寸时的默认宽高比：生图多为方图，用 1 作中性占位 */
export const DEFAULT_IMAGE_ASPECT_RATIO = 1;

function isValidRatio(ratio: number): boolean {
  return Number.isFinite(ratio) && ratio > 0.05 && ratio < 20;
}

/** data:/blob: 的 key 本身就是大字符串或临时地址，不值得当缓存键 */
function isCacheableKey(url: string): boolean {
  return !url.startsWith('data:') && !url.startsWith('blob:');
}

export function peekImageAspectRatio(url: string | null | undefined): number | undefined {
  if (!url) return undefined;
  return aspectByUrl.get(url);
}

export function rememberImageAspectRatio(url: string, ratio: number): void {
  if (!url || !isCacheableKey(url) || !isValidRatio(ratio)) return;
  aspectByUrl.set(url, ratio);
}

/**
 * 预热单张图片并缓存宽高比。
 * 已缓存则立即 resolve；并发请求合并。
 */
export function warmImageAspectRatio(url: string): Promise<number> {
  if (!url) return Promise.resolve(DEFAULT_IMAGE_ASPECT_RATIO);
  const cached = aspectByUrl.get(url);
  if (cached != null) return Promise.resolve(cached);
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(DEFAULT_IMAGE_ASPECT_RATIO);
  }

  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = new Promise<number>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    /** 成功才写缓存；错误路径只 resolve 默认值，避免把瞬时网络错误的 1:1 永久毒化进缓存 */
    const finish = (ratio: number, cacheIt: boolean) => {
      if (cacheIt && isValidRatio(ratio)) {
        rememberImageAspectRatio(url, ratio);
        resolve(ratio);
      } else {
        resolve(isValidRatio(ratio) ? ratio : DEFAULT_IMAGE_ASPECT_RATIO);
      }
      inflight.delete(url);
    };
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        finish(img.naturalWidth / img.naturalHeight, true);
      } else {
        finish(DEFAULT_IMAGE_ASPECT_RATIO, false);
      }
    };
    img.onerror = () => finish(DEFAULT_IMAGE_ASPECT_RATIO, false);
    img.src = url;
  });

  inflight.set(url, promise);
  return promise;
}

/** 测试用 */
export function resetImageAspectCache(): void {
  aspectByUrl.clear();
  inflight.clear();
}
