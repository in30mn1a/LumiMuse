const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

const restoreDom = installDomTestEnvironment();
global.IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, fireEvent, render } = require('@testing-library/react');

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

require.extensions['.ts'] = loadTypeScript;
require.extensions['.tsx'] = loadTypeScript;

function icon() {
  return React.createElement('span', { 'aria-hidden': 'true' });
}

// t 必须引用稳定：CharacterList 的加载 effect 依赖 [t]，每次渲染换新函数会无限重拉列表
const t = key => key;

/** 每个用例重新加载模块，保证模块级滚动位置与列表缓存都从零开始 */
function loadModules() {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === 'next/link') {
      return {
        __esModule: true,
        default: ({ children, href, ...props }) => React.createElement('a', { href, ...props }, children),
      };
    }
    if (request === 'next/navigation') {
      return { useRouter: () => ({ push() {} }) };
    }
    if (request === '@/lib/i18n-context') {
      return { useTranslation: () => ({ t }) };
    }
    if (request === '@/components/ui/icons') {
      return new Proxy({}, { get: () => icon });
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    for (const rel of [
      '../src/components/sidebar/CharacterList.tsx',
      '../src/lib/character-list-cache.ts',
    ]) {
      try {
        delete require.cache[require.resolve(rel)];
      } catch {
        /* not loaded yet */
      }
    }
    return {
      CharacterList: require('../src/components/sidebar/CharacterList.tsx').default,
      cache: require('../src/lib/character-list-cache.ts'),
    };
  } finally {
    Module._load = originalLoad;
  }
}

const characters = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, name: `Char ${i}`, avatar_url: null }));

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function scroller(container) {
  const el = container.querySelector('[data-sidebar-scroll]');
  assert.ok(el, 'character list scroller should exist');
  return el;
}

test.afterEach(() => {
  cleanup();
  delete global.fetch;
});

test.after(async () => {
  // dnd-kit defers listener cleanup; keep the DOM alive until those timers drain.
  await new Promise(resolve => setTimeout(resolve, 75));
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('remounted list restores the last scroll position instead of jumping to top', async () => {
  global.fetch = async () => jsonResponse(characters);
  const { CharacterList, cache } = loadModules();
  // 与移动端抽屉重开一致：第二次挂载时列表已在模块缓存里
  cache.setCharacterListCache(characters);

  const first = render(React.createElement(CharacterList, { selectedId: null, onSelect() {} }));
  const firstScroller = scroller(first.container);
  firstScroller.scrollTop = 640;
  fireEvent.scroll(firstScroller);
  first.unmount();

  const second = render(React.createElement(CharacterList, { selectedId: null, onSelect() {} }));
  assert.equal(scroller(second.container).scrollTop, 640);
});

test('creating a character resets the remembered position so the new one is visible', async () => {
  const created = { id: 'new', name: 'char.newCharacterName', avatar_url: null };
  global.fetch = async (_url, init) => jsonResponse(init?.method === 'POST' ? created : characters);
  const { CharacterList, cache } = loadModules();
  cache.setCharacterListCache(characters);

  const first = render(React.createElement(CharacterList, { selectedId: null, onSelect() {} }));
  const firstScroller = scroller(first.container);
  firstScroller.scrollTop = 640;
  fireEvent.scroll(firstScroller);
  await act(async () => {
    fireEvent.click(first.getByText('sidebar.create'));
  });
  first.unmount();

  const second = render(React.createElement(CharacterList, { selectedId: null, onSelect() {} }));
  assert.equal(scroller(second.container).scrollTop, 0);
});
