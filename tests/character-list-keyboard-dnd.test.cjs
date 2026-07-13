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

const { cleanup, render, waitFor } = require('@testing-library/react');
const userEvent = require('@testing-library/user-event').default;

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

function loadCharacterList() {
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
      return { useTranslation: () => ({ t: key => key }) };
    }
    if (request === '@/components/ui/icons') {
      return new Proxy({}, { get: () => icon });
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    // 清组件与列表缓存模块，避免模块级 character-list-cache 串测
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
    return require('../src/components/sidebar/CharacterList.tsx').default;
  } finally {
    Module._load = originalLoad;
  }
}

const characters = [
  { id: 'alice', name: 'Alice', avatar_url: null },
  { id: 'bob', name: 'Bob', avatar_url: null },
];

function renderList(onSelect) {
  global.fetch = async () => new Response(JSON.stringify(characters), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const CharacterList = loadCharacterList();
  return render(React.createElement(CharacterList, { selectedId: null, onSelect }));
}

test.afterEach(() => {
  cleanup();
  delete global.fetch;
});

test.after(async () => {
  // dnd-kit defers listener/focus cleanup; keep the DOM alive until those timers drain.
  await new Promise(resolve => setTimeout(resolve, 75));
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('Enter selects a character without starting keyboard drag', async () => {
  const selections = [];
  const user = userEvent.setup({ document });
  const view = renderList((id, character) => selections.push([id, character.name]));
  const card = await view.findByRole('button', { name: /Alice/ });

  card.focus();
  await user.keyboard('{Enter}');

  assert.deepEqual(selections, [['alice', 'Alice']]);
  assert.notEqual(card.getAttribute('aria-pressed'), 'true');
});

test('Space starts and completes keyboard drag without selecting the character', async () => {
  const selections = [];
  const user = userEvent.setup({ document });
  const view = renderList((id, character) => selections.push([id, character.name]));
  const card = await view.findByRole('button', { name: /Alice/ });

  card.focus();
  await user.keyboard(' ');
  await waitFor(() => assert.equal(card.getAttribute('aria-pressed'), 'true'));

  await user.keyboard(' ');
  await waitFor(() => assert.notEqual(card.getAttribute('aria-pressed'), 'true'));
  assert.deepEqual(selections, []);
});

test('screen-reader instructions describe the Space-only drag workflow', async () => {
  const view = renderList(() => {});
  const card = await view.findByRole('button', { name: /Alice/ });
  const instructions = document.getElementById(card.getAttribute('aria-describedby'));

  assert.ok(instructions, 'sortable card should reference dnd-kit instructions');
  assert.match(instructions.textContent, /press the space bar/i);
  assert.match(instructions.textContent, /press space again to drop/i);
  assert.doesNotMatch(instructions.textContent, /press enter/i);
});
