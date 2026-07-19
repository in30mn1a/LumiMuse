const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

function loadTypeScript(loadedModule, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  loadedModule._compile(output.outputText, filename);
}

Module._load = function load(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (resolved.endsWith('.ts') || resolved.endsWith('.tsx')) {
    const cached = require.cache[resolved];
    if (cached) return cached.exports;
    const loadedModule = new Module(resolved, parent);
    loadedModule.filename = resolved;
    loadedModule.paths = Module._nodeModulePaths(path.dirname(resolved));
    require.cache[resolved] = loadedModule;
    loadTypeScript(loadedModule, resolved);
    loadedModule.loaded = true;
    return loadedModule.exports;
  }
  return originalLoad.apply(this, arguments);
};

const {
  getCharacterImageListCache,
  setCharacterImageListCache,
  subscribeCharacterImageList,
  loadCharacterImageList,
  resetCharacterImageListCache,
} = require('../src/lib/character-image-list-cache.ts');

function sampleImages(urls) {
  return urls.map((url, index) => ({
    messageId: `msg-${index}`,
    conversationId: `conv-${index}`,
    conversationTitle: `title-${index}`,
    createdAt: `2026-01-0${index + 1}`,
    imageId: `img-${index}`,
    versionId: `ver-${index}`,
    url,
    prompt: `prompt-${index}`,
    referenceCount: 1,
    references: [],
  }));
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test.afterEach(() => {
  resetCharacterImageListCache();
  delete global.fetch;
});

test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
});

test('setCharacterImageListCache notifies subscribers and is readable', () => {
  const seen = [];
  const unsubscribe = subscribeCharacterImageList('char-a', (list) => seen.push(list.map((i) => i.url)));
  const next = sampleImages(['/a.png', '/b.png']);
  setCharacterImageListCache('char-a', next);
  assert.deepEqual(getCharacterImageListCache('char-a')?.map((i) => i.url), ['/a.png', '/b.png']);
  assert.deepEqual(seen, [['/a.png', '/b.png']]);
  unsubscribe();
});

test('loadCharacterImageList dedupes concurrent fetches and populates cache', async () => {
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse(sampleImages(['/x.png', '/y.png']));
  };

  const [first, second] = await Promise.all([
    loadCharacterImageList('char-x'),
    loadCharacterImageList('char-x'),
  ]);
  assert.equal(fetchCount, 1);
  assert.deepEqual(first.map((i) => i.url), ['/x.png', '/y.png']);
  assert.deepEqual(second.map((i) => i.url), ['/x.png', '/y.png']);
  assert.deepEqual(getCharacterImageListCache('char-x')?.map((i) => i.url), ['/x.png', '/y.png']);
});

test('loadCharacterImageList after success starts a new revalidation fetch', async () => {
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return jsonResponse(sampleImages([`/round-${fetchCount}.png`]));
  };

  await loadCharacterImageList('char-r');
  await loadCharacterImageList('char-r');
  assert.equal(fetchCount, 2);
  assert.deepEqual(getCharacterImageListCache('char-r')?.map((i) => i.url), ['/round-2.png']);
});

test('in-flight loadCharacterImageList does not overwrite optimistic setCharacterImageListCache', async () => {
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    await fetchGate;
    return jsonResponse(sampleImages(['/stale-a.png', '/stale-b.png']));
  };

  const loadPromise = loadCharacterImageList('char-opt');
  setCharacterImageListCache('char-opt', sampleImages(['/new.png', '/stale-a.png']));
  releaseFetch();
  await loadPromise;

  assert.equal(fetchCount, 1);
  assert.deepEqual(
    getCharacterImageListCache('char-opt')?.map((i) => i.url),
    ['/new.png', '/stale-a.png'],
  );
});

test('force loadCharacterImageList starts a new fetch even when one is in flight', async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let fetchCount = 0;
  global.fetch = async (url) => {
    fetchCount += 1;
    if (fetchCount === 1) {
      await firstGate;
      return jsonResponse(sampleImages(['/stale.png']));
    }
    return jsonResponse(sampleImages(['/fresh.png']));
  };

  const firstPromise = loadCharacterImageList('char-force');
  const forcedPromise = loadCharacterImageList('char-force', { force: true });
  releaseFirst();
  await firstPromise;
  const forced = await forcedPromise;

  assert.equal(fetchCount, 2);
  assert.deepEqual(forced.map((i) => i.url), ['/fresh.png']);
  assert.deepEqual(getCharacterImageListCache('char-force')?.map((i) => i.url), ['/fresh.png']);
});
