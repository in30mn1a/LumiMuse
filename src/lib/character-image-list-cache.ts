import type { UniqueGeneratedImageItem } from '@/lib/generated-image-assets';
import { parseJsonResponse } from '@/lib/http';

/**
 * 角色图库列表缓存（按 characterId）：
 * - ImageManagerModal 每次打开会 remount；有缓存时先秒开上次列表，再后台 revalidate
 * - 慢网下不再因列表 API 还在路上就一直显示「加载中」
 * - writeEpoch：本地写入（删除后写回）递增；在飞 GET 仅当 epoch 未变时才写回，
 *   避免慢请求覆盖用户刚完成的删除结果
 *
 * 仅缓存列表元数据（url/引用），不缓存图片二进制；图片本身由浏览器 HTTP cache 负责。
 */

const cache = new Map<string, UniqueGeneratedImageItem[]>();
const inflight = new Map<string, Promise<UniqueGeneratedImageItem[]>>();
const writeEpoch = new Map<string, number>();
const listeners = new Map<string, Set<(images: UniqueGeneratedImageItem[]) => void>>();

function getEpoch(characterId: string): number {
  return writeEpoch.get(characterId) ?? 0;
}

function bumpEpoch(characterId: string): void {
  writeEpoch.set(characterId, getEpoch(characterId) + 1);
}

function notify(characterId: string, images: UniqueGeneratedImageItem[]): void {
  const set = listeners.get(characterId);
  if (!set) return;
  for (const listener of set) listener(images);
}

export function getCharacterImageListCache(characterId: string): UniqueGeneratedImageItem[] | null {
  return cache.get(characterId) ?? null;
}

export function setCharacterImageListCache(
  characterId: string,
  next: UniqueGeneratedImageItem[],
): void {
  cache.set(characterId, next);
  bumpEpoch(characterId);
  notify(characterId, next);
}

export function subscribeCharacterImageList(
  characterId: string,
  listener: (images: UniqueGeneratedImageItem[]) => void,
): () => void {
  let set = listeners.get(characterId);
  if (!set) {
    set = new Set();
    listeners.set(characterId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(characterId);
  };
}

/**
 * 拉取角色图库列表。
 * - 默认同角色并发请求合并为同一 inflight
 * - force: 忽略在飞请求，发起新的 GET（删除等写操作后用，避免返回预删除的 inflight）
 * 成功后写入缓存并通知订阅者；若期间发生过 setCharacterImageListCache（epoch 变了）则丢弃写回。
 */
export function loadCharacterImageList(
  characterId: string,
  options?: { force?: boolean },
): Promise<UniqueGeneratedImageItem[]> {
  if (!options?.force) {
    const existing = inflight.get(characterId);
    if (existing) return existing;
  } else {
    // 抬高 epoch，使既有在飞 GET 写回时被丢弃（避免 pre-delete / 旧列表盖住 force 结果）
    bumpEpoch(characterId);
  }

  const epochAtStart = getEpoch(characterId);

  const promise = fetch(`/api/characters/${characterId}/images`)
    .then((response) => parseJsonResponse<UniqueGeneratedImageItem[]>(response))
    .then((data) => {
      if (getEpoch(characterId) !== epochAtStart) {
        return cache.get(characterId) ?? data;
      }
      // 直接写 cache + 通知，不走 setCharacterImageListCache，避免无意义抬高 epoch
      cache.set(characterId, data);
      notify(characterId, data);
      return data;
    })
    .finally(() => {
      // 仅清除自己：force 期间可能已有更新的 inflight 接手
      if (inflight.get(characterId) === promise) {
        inflight.delete(characterId);
      }
    });

  inflight.set(characterId, promise);
  return promise;
}

/** 测试 / 调试用：清空全部角色的缓存、在飞请求与订阅。 */
export function resetCharacterImageListCache(): void {
  cache.clear();
  inflight.clear();
  writeEpoch.clear();
  listeners.clear();
}
