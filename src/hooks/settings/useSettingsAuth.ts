'use client';

import { useCallback, useEffect, useState } from 'react';
import { expectOkResponse, getErrorMessage } from '@/lib/http';

interface UseSettingsAuthOptions {
  t: (key: string) => string;
  showToast: (message: string, type: 'success' | 'error') => void;
  replaceRoute: (path: string) => void;
}

export function useSettingsAuth({ t, showToast, replaceRoute }: UseSettingsAuthOptions) {
  const [authEnabled, setAuthEnabled] = useState(false);

  const loadAuth = useCallback(async () => {
    try {
      const response = await fetch('/api/auth');
      if (!response.ok) return;
      const data = await response.json() as { authEnabled?: boolean };
      setAuthEnabled(data.authEnabled === true);
    } catch {
      // 鉴权状态加载失败不阻塞设置页主体。
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void loadAuth());
  }, [loadAuth]);

  const handleLogout = useCallback(async () => {
    if (!window.confirm(t('auth.logoutConfirm'))) return;
    try {
      await expectOkResponse(await fetch('/api/auth', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      }));
      replaceRoute('/login');
    } catch (err) {
      showToast(`${t('auth.logoutFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [replaceRoute, showToast, t]);

  return { authEnabled, loadAuth, handleLogout };
}
