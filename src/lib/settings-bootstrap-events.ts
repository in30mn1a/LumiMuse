/**
 * 主题/语言 bootstrap 在 ToastProvider 之外，失败时通过浏览器事件
 * 通知树内监听器弹出轻量提示（避免 provider 层级大重构）。
 */
export const SETTINGS_BOOTSTRAP_FAILED_EVENT = 'lumimuse:settings-bootstrap-failed';

export type SettingsBootstrapSource = 'i18n' | 'theme';

export function notifySettingsBootstrapFailed(source: SettingsBootstrapSource): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(SETTINGS_BOOTSTRAP_FAILED_EVENT, { detail: { source } }),
  );
}
