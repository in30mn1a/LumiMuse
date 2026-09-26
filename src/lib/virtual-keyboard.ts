/**
 * 软键盘高度下限：用来区分「键盘弹着」和 iOS 收起键盘后残留的 ~24px 视口差
 * （iOS 26+ WebKit bug：键盘收起后 visualViewport.height 没完全复位）。
 */
const KEYBOARD_MIN_HEIGHT = 100;
/** 键盘收起后再等一小段，让 iOS 把视口滚动/定位复位完 */
const KEYBOARD_SETTLE_MS = 150;
/** 兜底上限：拿不到 resize 事件时也不能把跳转卡住 */
const KEYBOARD_DISMISS_TIMEOUT_MS = 1000;

function isKeyboardOpen(viewport: VisualViewport): boolean {
  // iOS 弹键盘不缩布局视口（innerHeight 不变），只缩可视视口
  return window.innerHeight - viewport.height > KEYBOARD_MIN_HEIGHT;
}

/**
 * 软键盘弹着时先收起它，等可视视口恢复后再 resolve；没弹键盘则立即 resolve。
 *
 * 用于「离开页面前」：iOS 带着键盘直接切页，键盘在新页面挂载过程中收起，
 * 会留下视口/触摸区域错位；新页面若锁了文档滚动（首页抽屉），用户无法靠拖整页纠正。
 */
export function dismissVirtualKeyboard(): Promise<void> {
  const viewport = window.visualViewport;
  if (!viewport || !isKeyboardOpen(viewport)) return Promise.resolve();
  return waitForKeyboardClose(viewport);
}

function waitForKeyboardClose(viewport: VisualViewport): Promise<void> {
  return new Promise(resolve => {
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(finish, KEYBOARD_DISMISS_TIMEOUT_MS);

    function onResize() {
      if (settleTimer === undefined && !isKeyboardOpen(viewport)) {
        settleTimer = setTimeout(finish, KEYBOARD_SETTLE_MS);
      }
    }

    function finish() {
      clearTimeout(settleTimer);
      clearTimeout(timeoutTimer);
      viewport.removeEventListener('resize', onResize);
      resolve();
    }

    viewport.addEventListener('resize', onResize);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}
