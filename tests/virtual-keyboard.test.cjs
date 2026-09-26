const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { installDomTestEnvironment } = require('./helpers/dom-test-environment.cjs');

const restoreDom = installDomTestEnvironment();

require.extensions['.ts'] = function loadTypeScript(module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { dismissVirtualKeyboard } = require(path.join(__dirname, '../src/lib/virtual-keyboard.ts'));

const LAYOUT_HEIGHT = 844;
let viewport;

/** 模拟 iOS：布局视口 innerHeight 固定，弹键盘只缩 visualViewport.height */
function installViewport(height) {
  viewport = new window.EventTarget();
  viewport.height = height;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: LAYOUT_HEIGHT });
}

function resizeViewport(height) {
  viewport.height = height;
  viewport.dispatchEvent(new window.Event('resize'));
}

function focusTextarea() {
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  textarea.focus();
  assert.equal(document.activeElement, textarea);
  return textarea;
}

async function isSettled(promise) {
  let settled = false;
  promise.then(() => { settled = true; });
  // 让 then 回调有机会跑完
  await Promise.resolve();
  await Promise.resolve();
  return settled;
}

test.beforeEach(() => {
  document.body.innerHTML = '';
});

test.afterEach(() => {
  test.mock.timers.reset();
});

test.after(() => {
  restoreDom();
});

test('resolves immediately without blurring when no keyboard is shown', async () => {
  // 24px 是 iOS 收起键盘后可视视口残留的差值，不能被当成键盘
  installViewport(LAYOUT_HEIGHT - 24);
  const textarea = focusTextarea();
  test.mock.timers.enable({ apis: ['setTimeout'] });

  assert.equal(await isSettled(dismissVirtualKeyboard()), true);
  assert.equal(document.activeElement, textarea);
});

test('blurs the focused field and waits for the keyboard to close before resolving', async () => {
  installViewport(LAYOUT_HEIGHT - 320);
  focusTextarea();
  test.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = dismissVirtualKeyboard();
  assert.equal(document.activeElement, document.body, 'focused field should be blurred to dismiss the keyboard');
  assert.equal(await isSettled(pending), false);

  // 键盘收起动画中间的 resize 不算收起
  resizeViewport(LAYOUT_HEIGHT - 160);
  test.mock.timers.tick(500);
  assert.equal(await isSettled(pending), false);

  resizeViewport(LAYOUT_HEIGHT - 24);
  test.mock.timers.tick(149);
  assert.equal(await isSettled(pending), false, 'should wait for the viewport to settle after the keyboard closes');
  test.mock.timers.tick(1);
  assert.equal(await isSettled(pending), true);
});

test('gives up waiting after the timeout when no resize event arrives', async () => {
  installViewport(LAYOUT_HEIGHT - 320);
  focusTextarea();
  test.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = dismissVirtualKeyboard();
  test.mock.timers.tick(999);
  assert.equal(await isSettled(pending), false);
  test.mock.timers.tick(1);
  assert.equal(await isSettled(pending), true);
});
