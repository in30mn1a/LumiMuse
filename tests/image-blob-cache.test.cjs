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
  warmImageBlob,
  getImageBlobCacheSizeForTests,
  getImageBlobCacheBytesForTests,
  __setImageBlobCacheLimitsForTests,
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
  return {
    ok: true,
    blob: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
  };
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
