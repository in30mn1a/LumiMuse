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

function loadTypeScript(module, filename) {
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
  module._compile(output.outputText, filename);
}

Module._load = function load(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (resolved.endsWith('.ts') || resolved.endsWith('.tsx')) {
    const cached = require.cache[resolved];
    if (cached) return cached.exports;
    const module = new Module(resolved, parent);
    module.filename = resolved;
    module.paths = Module._nodeModulePaths(path.dirname(resolved));
    require.cache[resolved] = module;
    loadTypeScript(module, resolved);
    module.loaded = true;
    return module.exports;
  }
  return originalLoad.apply(this, arguments);
};

const {
  getCharacterListCache,
  setCharacterListCache,
  subscribeCharacterList,
  loadCharacterList,
  resetCharacterListCache,
} = require('../src/lib/character-list-cache.ts');

function sampleCharacters(ids) {
  return ids.map((id) => ({
    id,
    name: `char-${id}`,
    avatar_url: null,
  }));
}

test.afterEach(() => {
  resetCharacterListCache();
  if (global.fetch && global.fetch.mockRestore) {
    // no-op for plain stubs
  }
  delete global.fetch;
});

test.after(() => {
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;
});

test('setCharacterListCache notifies subscribers and is readable', () => {
  const seen = [];
  const unsubscribe = subscribeCharacterList((list) => seen.push(list.map((c) => c.id)));
  const next = sampleCharacters(['a', 'b']);
  setCharacterListCache(next);
  assert.deepEqual(getCharacterListCache()?.map((c) => c.id), ['a', 'b']);
  assert.deepEqual(seen, [['a', 'b']]);
  unsubscribe();
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('loadCharacterList dedupes concurrent fetches and populates cache', async () => {
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse(sampleCharacters(['x', 'y']));
  };

  const [first, second] = await Promise.all([loadCharacterList(), loadCharacterList()]);
  assert.equal(fetchCount, 1);
  assert.deepEqual(first.map((c) => c.id), ['x', 'y']);
  assert.deepEqual(second.map((c) => c.id), ['x', 'y']);
  assert.deepEqual(getCharacterListCache()?.map((c) => c.id), ['x', 'y']);
});

test('loadCharacterList after success starts a new revalidation fetch', async () => {
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return jsonResponse(sampleCharacters([`round-${fetchCount}`]));
  };

  await loadCharacterList();
  await loadCharacterList();
  assert.equal(fetchCount, 2);
  assert.deepEqual(getCharacterListCache()?.map((c) => c.id), ['round-2']);
});
