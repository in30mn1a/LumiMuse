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
const { cleanup, fireEvent, render } = require('@testing-library/react');

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

function loadChatInput() {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/lib/i18n-context') return { useTranslation: () => ({ t: key => key }) };
    if (request === '@/components/ui/icons') return new Proxy({}, { get: () => icon });
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const resolved = require.resolve('../src/components/chat/ChatInput.tsx');
    delete require.cache[resolved];
    return require(resolved).default;
  } finally {
    Module._load = originalLoad;
  }
}

const { sanitizePinnedModels, sortModelsByPinned, togglePinnedModel } = require('../src/lib/pinned-models.ts');

test.afterEach(() => cleanup());
test.after(() => {
  delete global.IS_REACT_ACT_ENVIRONMENT;
  restoreDom();
});

test('置顶排序：置顶组与其余组都保持上游原顺序，不在列表里的置顶项不出现', () => {
  assert.deepEqual(sortModelsByPinned(['a', 'b', 'c', 'd'], ['d', 'b', 'gone']), ['b', 'd', 'a', 'c']);
  assert.deepEqual(sortModelsByPinned(['a', 'b'], []), ['a', 'b']);
  assert.deepEqual(togglePinnedModel(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(togglePinnedModel(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(sanitizePinnedModels(['a', 'a', '', '  ', 3, null, 'b']), ['a', 'b']);
  assert.deepEqual(sanitizePinnedModels('a,b'), []);
});

function renderPicker(props = {}) {
  const ChatInput = loadChatInput();
  const calls = { selected: [], toggled: [] };
  const element = extra => React.createElement(ChatInput, {
    onSend() {},
    disabled: false,
    currentModel: 'model-a',
    onModelChange: model => calls.selected.push(model),
    modelList: ['model-a', 'model-b', 'model-c'],
    pinnedModels: [],
    onTogglePinnedModel: model => calls.toggled.push(model),
    ...props,
    ...extra,
  });
  const view = render(element());
  fireEvent.click(view.getByRole('button', { name: 'model-a' }));
  const optionNames = () => view.getAllByRole('option').map(option => option.firstChild.textContent);
  return { view, calls, optionNames, rerender: extra => view.rerender(element(extra)) };
}

// jsdom 没有 PointerEvent，fireEvent.pointerDown 带不上 pointerType；手动补上，React 会从原生事件读取
function pointerDown(element, pointerType) {
  const event = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(element, event);
}

const starFor = (view, model) => {
  const option = view.getAllByRole('option').find(item => item.firstChild.textContent === model);
  return option.querySelector('button');
};

test('置顶模型排在列表最前，星标常亮；未置顶星标默认隐藏、悬停才显示', () => {
  const { view, optionNames } = renderPicker({ pinnedModels: ['model-c'] });
  assert.deepEqual(optionNames(), ['model-c', 'model-a', 'model-b']);
  const pinnedStar = starFor(view, 'model-c');
  assert.equal(pinnedStar.getAttribute('aria-pressed'), 'true');
  assert.doesNotMatch(pinnedStar.className, /opacity-0/);
  const hiddenStar = starFor(view, 'model-a');
  assert.equal(hiddenStar.getAttribute('aria-pressed'), 'false');
  assert.match(hiddenStar.className, /opacity-0 group-hover:opacity-100/);
  assert.match(hiddenStar.className, /focus-visible:opacity-100/);
});

test('鼠标点星标只切换置顶，不选中模型也不关闭列表', () => {
  const { view, calls } = renderPicker();
  const star = starFor(view, 'model-b');
  pointerDown(star, 'mouse');
  fireEvent.click(star);
  assert.deepEqual(calls.toggled, ['model-b']);
  assert.deepEqual(calls.selected, []);
  assert.ok(view.getByRole('listbox'));
});

test('键盘在星标上按回车/空格不会当成选中模型', () => {
  const { view, calls } = renderPicker();
  const star = starFor(view, 'model-b');
  for (const key of ['Enter', ' ']) {
    const event = fireEvent.keyDown(star, { key });
    assert.equal(event, true, `${JSON.stringify(key)} 不应被选项吞掉默认行为，让按钮自己触发 click`);
  }
  assert.deepEqual(calls.selected, []);
  fireEvent.keyDown(view.getAllByRole('option')[1], { key: 'Enter' });
  assert.deepEqual(calls.selected, ['model-b']);
});

test('触屏第一次点星标位置只显示星标，第二次才置顶；已置顶的一次点击即可取消', () => {
  const { view, calls, rerender } = renderPicker();
  const tap = model => {
    const star = starFor(view, model);
    pointerDown(star, 'touch');
    fireEvent.click(star);
  };
  tap('model-b');
  assert.deepEqual(calls.toggled, []);
  assert.doesNotMatch(starFor(view, 'model-b').className, /opacity-0/);
  assert.match(starFor(view, 'model-a').className, /opacity-0/, '只显示被点的那一颗');
  tap('model-b');
  assert.deepEqual(calls.toggled, ['model-b']);
  assert.deepEqual(calls.selected, []);

  rerender({ pinnedModels: ['model-b'] });
  tap('model-b');
  assert.deepEqual(calls.toggled, ['model-b', 'model-b']);
});

test('没有置顶回调时不渲染星标', () => {
  const { view } = renderPicker({ onTogglePinnedModel: undefined });
  assert.equal(view.getByRole('listbox').querySelector('button'), null);
});
