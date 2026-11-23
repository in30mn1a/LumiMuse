/**
 * 复制文本到剪贴板。
 *
 * 用 http://局域网IP 访问时页面不是安全上下文（非 HTTPS / localhost），浏览器不提供
 * navigator.clipboard；授权被拒时 writeText 也会失败。两种情况都退回隐藏 textarea +
 * execCommand('copy')。都失败时抛错，由调用方提示主人手动复制。
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 退回 execCommand
    }
  }

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  // fixed 定位避免 select() 时页面滚动；透明但仍在视口内，部分浏览器拒绝复制屏幕外元素
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('copy command was rejected');
  } finally {
    textarea.remove();
    previousFocus?.focus();
  }
}
