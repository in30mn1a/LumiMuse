// 聊天消息快照的浏览器本地持久层（IndexedDB）。
// 作为 chat-message-cache 内存 Map 的 write-through 副作用存在，用于重开浏览器后
// 进入会话时立即渲染上次的消息快照（stale-while-revalidate 的 stale 部分）。
// 失败不阻塞：任何一步出错即静默关闭持久化，内存缓存与网络加载完全不受影响。

const DB_NAME = 'lumimuse-chat-cache';
const DB_VERSION = 1;
const STORE_NAME = 'conversations';
const RECORD_VERSION = 1;
const DEFAULT_PUT_DEBOUNCE_MS = 300;

export type StoredRecord<T> = {
  v: number;
  savedAt: number;
  snapshot: T;
};

export type ChatCacheBackend<T> = {
  getAll(): Promise<Array<{ id: string; record: StoredRecord<T> }>>;
  put(id: string, record: StoredRecord<T>): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
};

export type ChatCachePersistence<T> = {
  /** 读取全部有效快照，按 savedAt 升序（最旧在前，便于按 LRU 顺序填充内存 Map）。只执行一次，结果 memoize。 */
  hydrate(): Promise<Array<{ id: string; snapshot: T }>>;
  /** 防抖落盘。触发时通过 getSnapshot 取最新快照，返回 null 表示已被清除则跳过。 */
  schedulePut(id: string, getSnapshot: () => T | null): void;
  remove(id: string): void;
  removeAll(): void;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

/** SSR 或浏览器不支持 IndexedDB 时返回 null，持久化整体退化为 no-op。 */
export function createIndexedDbBackend<T>(): ChatCacheBackend<T> | null {
  if (typeof indexedDB === 'undefined') return null;

  let dbPromise: Promise<IDBDatabase> | null = null;
  const getDb = () => {
    dbPromise ??= openDb();
    return dbPromise;
  };

  const withStore = async (
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<void> => {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = run(tx.objectStore(STORE_NAME));
      request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  };

  return {
    async getAll() {
      const db = await getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const keysRequest = store.getAllKeys();
        const valuesRequest = store.getAll();
        tx.oncomplete = () => {
          const values = valuesRequest.result as Array<StoredRecord<T>>;
          resolve(keysRequest.result.map((key, index) => ({ id: String(key), record: values[index] })));
        };
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB getAll failed'));
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB getAll aborted'));
      });
    },
    put: (id, record) => withStore('readwrite', store => store.put(record, id)),
    delete: id => withStore('readwrite', store => store.delete(id)),
    clear: () => withStore('readwrite', store => store.clear()),
  };
}

function isValidRecord<T>(record: unknown): record is StoredRecord<T> {
  if (typeof record !== 'object' || record === null) return false;
  const candidate = record as Partial<StoredRecord<T>>;
  return candidate.v === RECORD_VERSION
    && typeof candidate.savedAt === 'number'
    && typeof candidate.snapshot === 'object'
    && candidate.snapshot !== null
    && Array.isArray((candidate.snapshot as { messages?: unknown }).messages);
}

export function createChatCachePersistence<T>(
  backend: ChatCacheBackend<T> | null,
  options?: { debounceMs?: number },
): ChatCachePersistence<T> {
  const debounceMs = options?.debounceMs ?? DEFAULT_PUT_DEBOUNCE_MS;
  const pendingPuts = new Map<string, ReturnType<typeof setTimeout>>();
  let disabled = backend === null;
  let hydratePromise: Promise<Array<{ id: string; snapshot: T }>> | null = null;

  const disable = () => {
    disabled = true;
    for (const timer of pendingPuts.values()) clearTimeout(timer);
    pendingPuts.clear();
  };

  const cancelPendingPut = (id: string) => {
    const timer = pendingPuts.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingPuts.delete(id);
    }
  };

  return {
    hydrate() {
      hydratePromise ??= (async () => {
        if (disabled || !backend) return [];
        try {
          const rows = await backend.getAll();
          return rows
            .filter(row => isValidRecord<T>(row.record))
            .sort((a, b) => a.record.savedAt - b.record.savedAt)
            .map(row => ({ id: row.id, snapshot: row.record.snapshot }));
        } catch {
          disable();
          return [];
        }
      })();
      return hydratePromise;
    },

    schedulePut(id, getSnapshot) {
      if (disabled || !backend) return;
      cancelPendingPut(id);
      pendingPuts.set(id, setTimeout(() => {
        pendingPuts.delete(id);
        if (disabled) return;
        const snapshot = getSnapshot();
        if (snapshot === null) return;
        backend.put(id, { v: RECORD_VERSION, savedAt: Date.now(), snapshot }).catch(disable);
      }, debounceMs));
    },

    remove(id) {
      cancelPendingPut(id);
      if (disabled || !backend) return;
      backend.delete(id).catch(disable);
    },

    removeAll() {
      for (const timer of pendingPuts.values()) clearTimeout(timer);
      pendingPuts.clear();
      if (disabled || !backend) return;
      backend.clear().catch(disable);
    },
  };
}
