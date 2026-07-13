import type { Character } from '@/types';
import { parseJsonResponse } from '@/lib/http';

/**
 * 模块级角色列表缓存：
 * - 移动端 Modal 侧栏每次打开会重新挂载 CharacterList，缓存避免重复冷启动闪空白
 * - 多实例（桌面常驻 + 移动抽屉）通过 subscribe 共享同一份列表与乐观更新
 */
let cache: Character[] | null = null;
let inflight: Promise<Character[]> | null = null;
const listeners = new Set<(characters: Character[]) => void>();

export function getCharacterListCache(): Character[] | null {
  return cache;
}

export function setCharacterListCache(next: Character[]): void {
  cache = next;
  for (const listener of listeners) {
    listener(next);
  }
}

export function subscribeCharacterList(listener: (characters: Character[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 拉取角色列表；并发请求合并为同一 inflight，成功后写入缓存并通知订阅者。 */
export function loadCharacterList(): Promise<Character[]> {
  if (inflight) return inflight;

  inflight = fetch('/api/characters')
    .then((response) => parseJsonResponse<Character[]>(response))
    .then((data) => {
      setCharacterListCache(data);
      return data;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** 测试 / 调试用：清空缓存与订阅。 */
export function resetCharacterListCache(): void {
  cache = null;
  inflight = null;
  listeners.clear();
}
