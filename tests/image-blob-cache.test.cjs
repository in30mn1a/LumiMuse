'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { Blob } = require('node:buffer');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  isInMemoryImageSrc,
  peekImageBlobUrl,
  resetImageBlobCache,
  resetImageBlobMemoryCacheForTests,
  flushImageBlobPersistForTests,
  forgetImageBlobs,
  warmImageBlob,
  getImageBlobCacheSizeForTests,
  getImageBlobCacheBytesForTests,
  getImageBlobPersistBudgetForTests,
  IMAGE_BLOB_PERSIST_FALLBACK_BYTES,
  IMAGE_BLOB_PERSIST_MAX_BYTES,
  __setImageBlobCacheLimitsForTests,
  __setImageBlobPersistBackendForTests,
  __setImageBlobStorageEstimateForTests,
} = require('../src/lib/image-blob-cache.ts');

/** 打开浏览器分支（isBrowser 检查 window/fetch/URL），并注入可编程 fetch stub */
function withBrowserEnv(fetchImpl, fn) {
  const hadWindow = 'window' in globalThis;
  const originalFetch = globalThis.fetch;
  globalThis.window = globalThis.window || {};
  globalThis.fetch = fetchImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (!hadWindow) delete globalThis.window;
      globalThis.fetch = originalFetch;
    });
}

function imageResponse(bytes) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

function createMemoryCacheStorage(options = {}) {
  const buckets = new Map();
  return {
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const store = buckets.get(name);
      return {
        async match(request) {
          const key = typeof request === 'string' ? request : request.url;
          const response = store.get(key);
          return response ? response.clone() : undefined;
        },
        async put(request, response) {
          const key = typeof request === 'string' ? request : request.url;
          if (options.shouldFailPut?.(key, store)) throw new Error('QuotaExceededError');
          store.set(key, response);
        },
        async delete(request) {
          const key = typeof request === 'string' ? request : request.url;
          if (options.shouldFailDelete?.(key)) throw new Error('Storage I/O failure');
          return store.delete(key);
        },
      };
    },
    async delete(name) {
      return buckets.delete(name);
    },
  };
}

function readPersistIndex(storage) {
  return JSON.parse(storage.getItem('lumimuse-image-blob-index-v1'));
}

function loadFreshImageBlobCacheModule() {
  const modulePath = require.resolve('../src/lib/image-blob-cache.ts');
  const original = require.cache[modulePath];
  delete require.cache[modulePath];
  const fresh = require(modulePath);
  return {
    fresh,
    restore() {
      delete require.cache[modulePath];
      if (original) require.cache[modulePath] = original;
    },
  };
}

function createMemoryLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

async function withPersistEnv(fetchImpl, fn, options = {}) {
  const hadWindow = 'window' in globalThis;
  const originalFetch = globalThis.fetch;
  globalThis.window = globalThis.window || {};
  globalThis.fetch = fetchImpl;
  __setImageBlobPersistBackendForTests(
    options.cacheStorage || createMemoryCacheStorage(),
    options.localStorage || createMemoryLocalStorage(),
  );
  try {
    return await fn();
  } finally {
    await flushImageBlobPersistForTests();
    resetImageBlobCache();
    await flushImageBlobPersistForTests();
    __setImageBlobPersistBackendForTests();
    __setImageBlobStorageEstimateForTests();
    if (!hadWindow) delete globalThis.window;
    globalThis.fetch = originalFetch;
  }
}

test('image-blob-cache: data/blob urls are treated as in-memory', () => {
  resetImageBlobCache();
  assert.equal(isInMemoryImageSrc('blob:http://localhost/x'), true);
  assert.equal(isInMemoryImageSrc('data:image/png;base64,xx'), true);
  assert.equal(isInMemoryImageSrc('/api/files/generated/a.png'), false);
  assert.equal(peekImageBlobUrl('data:image/png;base64,xx'), 'data:image/png;base64,xx');
});

test('image-blob-cache: empty warm returns null without throwing', async () => {
  resetImageBlobCache();
  assert.equal(await warmImageBlob(''), null);
  assert.equal(getImageBlobCacheSizeForTests(), 0);
});

test('image-blob-cache: peek unknown remote url is undefined in node', () => {
  resetImageBlobCache();
  assert.equal(peekImageBlobUrl('/api/files/generated/nope.png'), undefined);
});

test('image-blob-cache: caches success, merges inflight, evicts LRU by count', async () => {
  resetImageBlobCache();
  __setImageBlobCacheLimitsForTests(2, undefined);
  try {
    let fetchCalls = 0;
    await withBrowserEnv(async () => {
      fetchCalls += 1;
      return imageResponse(10);
    }, async () => {
      // inflight 合并：同 URL 并发只发一次请求，拿到同一 objectUrl
      const [a, b] = await Promise.all([warmImageBlob('/img/a.png'), warmImageBlob('/img/a.png')]);
      assert.equal(fetchCalls, 1);
      assert.ok(a && a.startsWith('blob:'));
      assert.equal(a, b);
      assert.equal(peekImageBlobUrl('/img/a.png'), a);

      // LRU：上限 2，插入第三个后最旧的 a 被淘汰
      await warmImageBlob('/img/b.png');
      await warmImageBlob('/img/c.png');
      assert.equal(getImageBlobCacheSizeForTests(), 2);
      assert.equal(peekImageBlobUrl('/img/a.png'), undefined);
      assert.ok(peekImageBlobUrl('/img/b.png'));
      assert.ok(peekImageBlobUrl('/img/c.png'));
    });
  } finally {
    __setImageBlobCacheLimitsForTests();
    resetImageBlobCache();
  }
});

test('image-blob-cache: evicts by total byte budget and keeps accounting', async () => {
  resetImageBlobCache();
  __setImageBlobCacheLimitsForTests(undefined, 25);
  try {
    await withBrowserEnv(async () => imageResponse(10), async () => {
      await warmImageBlob('/img/1.png');
      await warmImageBlob('/img/2.png');
      assert.equal(getImageBlobCacheBytesForTests(), 20);
      // 第三张（10B）使总量 30 > 25，最旧的 1.png 被淘汰，回到 20
      await warmImageBlob('/img/3.png');
      assert.equal(getImageBlobCacheSizeForTests(), 2);
      assert.equal(getImageBlobCacheBytesForTests(), 20);
      assert.equal(peekImageBlobUrl('/img/1.png'), undefined);
    });
  } finally {
    __setImageBlobCacheLimitsForTests();
    resetImageBlobCache();
  }
});

test('image-blob-cache: failed fetch is negative-cached within TTL', async () => {
  resetImageBlobCache();
  let fetchCalls = 0;
  await withBrowserEnv(async () => {
    fetchCalls += 1;
    return { ok: false, blob: async () => new Blob([]) };
  }, async () => {
    assert.equal(await warmImageBlob('/img/gone.png'), null);
    assert.equal(fetchCalls, 1);
    // TTL 内重试直接短路，不再发请求（流式渲染期间对 404 图反复 warm 的场景）
    assert.equal(await warmImageBlob('/img/gone.png'), null);
    assert.equal(fetchCalls, 1);
  });
  resetImageBlobCache();
});

test('image-blob-cache: non-image content type is rejected and negative-cached', async () => {
  resetImageBlobCache();
  let fetchCalls = 0;
  await withBrowserEnv(async () => {
    fetchCalls += 1;
    return { ok: true, blob: async () => new Blob(['<html></html>'], { type: 'text/html' }) };
  }, async () => {
    assert.equal(await warmImageBlob('/img/login.html'), null);
    assert.equal(getImageBlobCacheSizeForTests(), 0);
    assert.equal(await warmImageBlob('/img/login.html'), null);
    assert.equal(fetchCalls, 1);
  });
  resetImageBlobCache();
});

test('image-blob-cache: persist layer survives memory reset without refetch', async () => {
  resetImageBlobCache();
  let fetchCalls = 0;
  await withPersistEnv(async () => {
    fetchCalls += 1;
    return imageResponse(8);
  }, async () => {
    const first = await warmImageBlob('/img/keep.png');
    await flushImageBlobPersistForTests();
    assert.ok(first && first.startsWith('blob:'));
    assert.equal(fetchCalls, 1);

    resetImageBlobMemoryCacheForTests();
    assert.equal(peekImageBlobUrl('/img/keep.png'), undefined);

    const second = await warmImageBlob('/img/keep.png');
    assert.ok(second && second.startsWith('blob:'));
    assert.equal(fetchCalls, 1, 'reopen must be served from Cache API, not network');
    assert.ok(peekImageBlobUrl('/img/keep.png'));
  });
});

test('image-blob-cache: a fresh module instance reuses the persisted blob after restart', async () => {
  resetImageBlobCache();
  const cacheStorage = createMemoryCacheStorage();
  const storage = createMemoryLocalStorage();
  let fetchCalls = 0;
  await withPersistEnv(async () => {
    fetchCalls += 1;
    return imageResponse(8);
  }, async () => {
    await warmImageBlob('/img/fresh-restart.png');
    await flushImageBlobPersistForTests();
    fetchCalls = 0;
    resetImageBlobMemoryCacheForTests();

    const { fresh, restore } = loadFreshImageBlobCacheModule();
    try {
      fresh.__setImageBlobPersistBackendForTests(cacheStorage, storage);
      const objectUrl = await fresh.warmImageBlob('/img/fresh-restart.png');
      assert.ok(objectUrl?.startsWith('blob:'));
      assert.equal(fetchCalls, 0, 'a new JS module instance should read Cache API before network');
      await fresh.flushImageBlobPersistForTests();
      fresh.resetImageBlobMemoryCacheForTests();
      fresh.__setImageBlobPersistBackendForTests();
    } finally {
      restore();
    }
  }, { cacheStorage, localStorage: storage });
});

test('image-blob-cache: persist LRU evicts oldest by byte budget', async () => {
  resetImageBlobCache();
  __setImageBlobCacheLimitsForTests(undefined, undefined, 25);
  let fetchCalls = 0;
  await withPersistEnv(async (url) => {
    fetchCalls += 1;
    return imageResponse(10);
  }, async () => {
    await warmImageBlob('/img/p1.png');
    await warmImageBlob('/img/p2.png');
    await warmImageBlob('/img/p3.png');
    await flushImageBlobPersistForTests();

    resetImageBlobMemoryCacheForTests();
    fetchCalls = 0;
    await warmImageBlob('/img/p2.png');
    await warmImageBlob('/img/p3.png');
    assert.equal(fetchCalls, 0);

    const oldest = await warmImageBlob('/img/p1.png');
    assert.ok(oldest && oldest.startsWith('blob:'));
    assert.equal(fetchCalls, 1, 'oldest persisted blob should have been evicted');
  });
  __setImageBlobCacheLimitsForTests();
});

test('image manager gallery thumbs reuse the blob cache instead of raw remote src', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/chat/ImageManagerModal.tsx'), 'utf8');
  assert.match(source, /peekImageBlobUrl/);
  assert.match(source, /warmImageBlob/);
  assert.match(source, /forgetImageBlobs/);
  assert.match(source, /function CachedGalleryImage/);
});

test('image-blob-cache: forgetImageBlobs drops persist so next warm refetches', async () => {
  resetImageBlobCache();
  let fetchCalls = 0;
  await withPersistEnv(async () => {
    fetchCalls += 1;
    return imageResponse(8);
  }, async () => {
    await warmImageBlob('/img/gone.png');
    await flushImageBlobPersistForTests();
    await forgetImageBlobs(['/img/gone.png']);
    await flushImageBlobPersistForTests();
    assert.equal(peekImageBlobUrl('/img/gone.png'), undefined, 'forget must drop the memory entry immediately');
    resetImageBlobMemoryCacheForTests();

    fetchCalls = 0;
    await warmImageBlob('/img/gone.png');
    assert.equal(fetchCalls, 1);
  });
});

test('image-blob-cache: forget invalidates an older in-flight warm before it can revive memory or persist', async () => {
  resetImageBlobCache();
  let fetchCalls = 0;
  let resolveFirstFetch;
  await withPersistEnv(async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Promise(resolve => {
        resolveFirstFetch = resolve;
      });
    }
    return imageResponse(8);
  }, async () => {
    const warming = warmImageBlob('/img/race.png');
    while (!resolveFirstFetch) await Promise.resolve();

    await forgetImageBlobs(['/img/race.png']);
    resolveFirstFetch(imageResponse(8));
    assert.equal(await warming, null, 'a pre-delete warm result must be discarded');
    await flushImageBlobPersistForTests();
    assert.equal(peekImageBlobUrl('/img/race.png'), undefined);

    resetImageBlobMemoryCacheForTests();
    await warmImageBlob('/img/race.png');
    assert.equal(fetchCalls, 2, 'a restart must not hit a blob revived by the stale warm');
  });
});

test('image-blob-cache: a rejected pre-delete warm does not negative-cache the deleted generation', async () => {
  resetImageBlobCache();
  let fetchCalls = 0;
  let rejectFirstFetch;
  await withPersistEnv(async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Promise((_, reject) => {
        rejectFirstFetch = reject;
      });
    }
    return imageResponse(8);
  }, async () => {
    const warming = warmImageBlob('/img/rejected-race.png');
    while (!rejectFirstFetch) await Promise.resolve();
    const forgetting = forgetImageBlobs(['/img/rejected-race.png']);
    rejectFirstFetch(new Error('stale network failure'));
    assert.equal(await warming, null);
    await forgetting;

    resetImageBlobMemoryCacheForTests();
    const fresh = await warmImageBlob('/img/rejected-race.png');
    assert.equal(fresh, null, 'the tombstone should still block the physically deleted URL');
    assert.equal(fetchCalls, 2);
  });
});

test('image-blob-cache: memory hits refresh persistent LRU recency', async () => {
  resetImageBlobCache();
  __setImageBlobCacheLimitsForTests(undefined, undefined, 20);
  const originalNow = Date.now;
  let now = 1;
  let fetchCalls = 0;
  Date.now = () => now;
  try {
    await withPersistEnv(async () => {
      fetchCalls += 1;
      return imageResponse(10);
    }, async () => {
      await warmImageBlob('/img/hot-a.png');
      await flushImageBlobPersistForTests();
      now = 2;
      await warmImageBlob('/img/cold-b.png');
      await flushImageBlobPersistForTests();

      now = 60_002;
      assert.ok(peekImageBlobUrl('/img/hot-a.png'));
      await flushImageBlobPersistForTests();
      now = 60_003;
      await warmImageBlob('/img/new-c.png');
      await flushImageBlobPersistForTests();

      resetImageBlobMemoryCacheForTests();
      fetchCalls = 0;
      await warmImageBlob('/img/hot-a.png');
      assert.equal(fetchCalls, 0, 'recently viewed a should remain persisted');
      await warmImageBlob('/img/cold-b.png');
      assert.equal(fetchCalls, 1, 'older b should be the persisted entry that was evicted');
    });
  } finally {
    Date.now = originalNow;
    __setImageBlobCacheLimitsForTests();
  }
});

test('image-blob-cache: a persist quota failure does not disable reads of existing entries', async () => {
  resetImageBlobCache();
  let failNewWrites = false;
  const cacheStorage = createMemoryCacheStorage({
    shouldFailPut: url => failNewWrites && url === '/img/quota-c.png',
  });
  let fetchCalls = 0;
  await withPersistEnv(async () => {
    fetchCalls += 1;
    return imageResponse(8);
  }, async () => {
    await warmImageBlob('/img/quota-a.png');
    await warmImageBlob('/img/quota-b.png');
    await flushImageBlobPersistForTests();

    failNewWrites = true;
    await warmImageBlob('/img/quota-c.png');
    await flushImageBlobPersistForTests();
    resetImageBlobMemoryCacheForTests();

    fetchCalls = 0;
    await warmImageBlob('/img/quota-b.png');
    assert.equal(fetchCalls, 0, 'a failed write must not turn off persistent reads');
  }, { cacheStorage });
});

test('image-blob-cache: storage estimate sets an adaptive budget instead of the 256MB fallback', async () => {
  resetImageBlobCache();
  __setImageBlobStorageEstimateForTests(async () => ({ quota: 100, usage: 0 }));
  let fetchCalls = 0;
  try {
    await withPersistEnv(async () => {
      fetchCalls += 1;
      return imageResponse(20);
    }, async () => {
      await warmImageBlob('/img/adaptive-a.png');
      await warmImageBlob('/img/adaptive-b.png');
      await warmImageBlob('/img/adaptive-c.png');
      await flushImageBlobPersistForTests();

      resetImageBlobMemoryCacheForTests();
      fetchCalls = 0;
      await warmImageBlob('/img/adaptive-b.png');
      await warmImageBlob('/img/adaptive-c.png');
      assert.equal(fetchCalls, 0, 'the two newest 20-byte entries should fit the adaptive 50-byte budget');
      await warmImageBlob('/img/adaptive-a.png');
      assert.equal(fetchCalls, 1, 'the oldest entry should be evicted once the adaptive budget is exceeded');
    });
  } finally {
    __setImageBlobStorageEstimateForTests();
  }
});

test('image-blob-cache: adaptive budget is stable across refreshes and clamped to 4GB', async () => {
  resetImageBlobCache();
  const storage = createMemoryLocalStorage();
  __setImageBlobStorageEstimateForTests(async () => ({ quota: 20 * 1024 ** 3, usage: 0 }));
  await withPersistEnv(async () => imageResponse(20), async () => {
    assert.equal(await getImageBlobPersistBudgetForTests(), IMAGE_BLOB_PERSIST_MAX_BYTES);
    await warmImageBlob('/img/adaptive-stable.png');
    await flushImageBlobPersistForTests();
    assert.equal(await getImageBlobPersistBudgetForTests(), IMAGE_BLOB_PERSIST_MAX_BYTES);
  }, { localStorage: storage });
});

test('image-blob-cache: estimate failures use the 256MB fallback and usage excludes other site data', async () => {
  resetImageBlobCache();
  await withPersistEnv(async () => imageResponse(8), async () => {
    __setImageBlobStorageEstimateForTests(async () => {
      throw new Error('estimate unavailable');
    });
    assert.equal(await getImageBlobPersistBudgetForTests(), IMAGE_BLOB_PERSIST_FALLBACK_BYTES);

    __setImageBlobStorageEstimateForTests(async () => ({ quota: 100, usage: 40 }));
    assert.equal(
      await getImageBlobPersistBudgetForTests(),
      30,
      'half of quota remaining after non-image site data should be available to the image cache',
    );
  });
});

test('image-blob-cache: quota retry can evict several small old entries without deleting the whole cache', async () => {
  resetImageBlobCache();
  const storage = createMemoryLocalStorage();
  const cacheStorage = createMemoryCacheStorage({
    shouldFailPut: (url, store) => url === '/img/quota-large.png' && store.size > 1,
  });
  let fetchCalls = 0;
  await withPersistEnv(async (url) => {
    fetchCalls += 1;
    return imageResponse(url === '/img/quota-large.png' ? 10 : 4);
  }, async () => {
    await warmImageBlob('/img/quota-old-a.png');
    await warmImageBlob('/img/quota-old-b.png');
    await warmImageBlob('/img/quota-old-c.png');
    await warmImageBlob('/img/quota-large.png');
    await flushImageBlobPersistForTests();

    const index = readPersistIndex(storage);
    assert.deepEqual(
      index.items.map(item => item.url),
      ['/img/quota-old-c.png', '/img/quota-large.png'],
      'quota recovery should evict only as many oldest entries as the backend requires',
    );
    resetImageBlobMemoryCacheForTests();
    fetchCalls = 0;
    await warmImageBlob('/img/quota-large.png');
    assert.equal(fetchCalls, 0, 'the retried new entry should survive after multiple LRU evictions');
  }, { cacheStorage, localStorage: storage });
});

test('image-blob-cache: permanent quota failure keeps the newest old entry readable', async () => {
  resetImageBlobCache();
  const storage = createMemoryLocalStorage();
  let failNewWrites = false;
  const cacheStorage = createMemoryCacheStorage({
    shouldFailPut: url => failNewWrites && url === '/img/quota-never.png',
  });
  let fetchCalls = 0;
  await withPersistEnv(async () => {
    fetchCalls += 1;
    return imageResponse(4);
  }, async () => {
    await warmImageBlob('/img/quota-keep-a.png');
    await warmImageBlob('/img/quota-keep-b.png');
    await warmImageBlob('/img/quota-keep-c.png');
    await flushImageBlobPersistForTests();
    failNewWrites = true;
    await warmImageBlob('/img/quota-never.png');
    await flushImageBlobPersistForTests();

    const index = readPersistIndex(storage);
    assert.deepEqual(index.items.map(item => item.url), ['/img/quota-keep-c.png']);
    resetImageBlobMemoryCacheForTests();
    fetchCalls = 0;
    await warmImageBlob('/img/quota-keep-c.png');
    assert.equal(fetchCalls, 0, 'permanent quota failure must retain at least the newest old cache entry');
    await warmImageBlob('/img/quota-never.png');
    assert.equal(fetchCalls, 1, 'the failed new entry should fall back to network after restart');
  }, { cacheStorage, localStorage: storage });
});

test('image-blob-cache: budget pre-eviction also keeps one old entry before a failed put', async () => {
  resetImageBlobCache();
  __setImageBlobCacheLimitsForTests(undefined, undefined, 12);
  const storage = createMemoryLocalStorage();
  let failNewWrites = false;
  const cacheStorage = createMemoryCacheStorage({
    shouldFailPut: url => failNewWrites && url === '/img/budget-never.png',
  });
  let fetchCalls = 0;
  try {
    await withPersistEnv(async (url) => {
      fetchCalls += 1;
      return imageResponse(url === '/img/budget-never.png' ? 8 : 4);
    }, async () => {
      await warmImageBlob('/img/budget-old-a.png');
      await warmImageBlob('/img/budget-old-b.png');
      await warmImageBlob('/img/budget-old-c.png');
      await flushImageBlobPersistForTests();
      const originalNow = Date.now;
      Date.now = () => originalNow() + 31_000;
      __setImageBlobCacheLimitsForTests(undefined, undefined, 8);
      failNewWrites = true;
      try {
        await warmImageBlob('/img/budget-never.png');
        await flushImageBlobPersistForTests();
      } finally {
        Date.now = originalNow;
      }

      const index = readPersistIndex(storage);
      assert.deepEqual(index.items.map(item => item.url), ['/img/budget-old-c.png']);
      resetImageBlobMemoryCacheForTests();
      fetchCalls = 0;
      await warmImageBlob('/img/budget-old-c.png');
      assert.equal(fetchCalls, 0, 'budget pre-eviction must retain the newest old cache entry');
    }, { cacheStorage, localStorage: storage });
  } finally {
    __setImageBlobCacheLimitsForTests();
  }
});

test('image-blob-cache: a failed Cache API delete leaves a tombstone that blocks stale reads', async () => {
  resetImageBlobCache();
  const cacheStorage = createMemoryCacheStorage({
    shouldFailDelete: url => url === '/img/delete-error.png',
  });
  let fetchCalls = 0;
  await withPersistEnv(async () => {
    fetchCalls += 1;
    return imageResponse(8);
  }, async () => {
    await warmImageBlob('/img/delete-error.png');
    await flushImageBlobPersistForTests();
    await forgetImageBlobs(['/img/delete-error.png']);
    resetImageBlobMemoryCacheForTests();

    fetchCalls = 0;
    await warmImageBlob('/img/delete-error.png');
    assert.equal(fetchCalls, 1, 'a tombstoned stale response must not be served after delete fails');
  }, { cacheStorage });
});

test('image-blob-cache: forget rejects when neither its tombstone nor Cache delete is durable', async () => {
  resetImageBlobCache();
  let failWrites = false;
  const storage = createMemoryLocalStorage();
  const failingStorage = {
    getItem: storage.getItem,
    removeItem: storage.removeItem,
    setItem(key, value) {
    if (failWrites) throw new Error('QuotaExceededError');
      storage.setItem(key, value);
    },
  };
  const cacheStorage = createMemoryCacheStorage({
    shouldFailDelete: url => failWrites && url === '/img/double-delete-failure.png',
  });
  await withPersistEnv(async () => imageResponse(8), async () => {
    await warmImageBlob('/img/double-delete-failure.png');
    await flushImageBlobPersistForTests();
    failWrites = true;
    await assert.rejects(
      forgetImageBlobs(['/img/double-delete-failure.png']),
      /Storage I\/O failure|安全删除|持久化/,
    );
    assert.equal(peekImageBlobUrl('/img/double-delete-failure.png'), undefined);
  }, { cacheStorage, localStorage: failingStorage });
});
