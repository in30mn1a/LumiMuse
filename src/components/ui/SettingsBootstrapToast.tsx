'use client';

import { useEffect, useRef } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useTranslation } from '@/lib/i18n-context';
import { SETTINGS_BOOTSTRAP_FAILED_EVENT } from '@/lib/settings-bootstrap-events';

/**
 * 监听主题/语言 bootstrap 最终失败事件，合并为一次非阻塞 toast。
 * 必须挂在 ToastProvider + I18nProvider 之内。
 */
export default function SettingsBootstrapToast() {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const coalesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownThisSessionRef = useRef(false);

  useEffect(() => {
    const onFailed = () => {
      // 同一会话只提示一次；i18n 与 theme 可能几乎同时失败。
      if (shownThisSessionRef.current) return;
      if (coalesceTimerRef.current) return;
      coalesceTimerRef.current = setTimeout(() => {
        coalesceTimerRef.current = null;
        if (shownThisSessionRef.current) return;
        shownThisSessionRef.current = true;
        showToast(t('settings.loadFailed'), 'error');
      }, 80);
    };

    window.addEventListener(SETTINGS_BOOTSTRAP_FAILED_EVENT, onFailed);
    return () => {
      window.removeEventListener(SETTINGS_BOOTSTRAP_FAILED_EVENT, onFailed);
      if (coalesceTimerRef.current) {
        clearTimeout(coalesceTimerRef.current);
        coalesceTimerRef.current = null;
      }
    };
  }, [showToast, t]);

  return null;
}
