'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import Image from 'next/image';
import { useTranslation } from '@/lib/i18n-context';
import ContentState from '@/components/ui/ContentState';

// 限制登录后跳转地址只能是站内相对路径，避免开放重定向
function safeReturnTo(from: string | null): string {
  if (!from) return '/';
  // URL 解析会移除制表符、换行等控制字符，必须在规范化前拒绝。
  if (/[\u0000-\u0020\u007f]/.test(from)) return '/';
  // 必须以 `/` 开头；不允许 `//xxx`（协议相对 URL）或 `/\xxx`（反斜杠绕过）
  if (!from.startsWith('/')) return '/';
  if (from.startsWith('//') || from.startsWith('/\\')) return '/';
  try {
    const destination = new URL(from, 'https://lumimuse.invalid');
    if (destination.origin !== 'https://lumimuse.invalid') return '/';
    if (destination.pathname.startsWith('//')) return '/';
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return '/';
  }
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        // 跳回原来想访问的页面，默认回首页（校验仅允许站内相对路径）
        const from = safeReturnTo(searchParams.get('from'));
        router.replace(from);
      } else {
        const data = await res.json();
        setError(data.error || t('login.passwordIncorrect'));
        setPassword('');
        inputRef.current?.focus();
      }
    } catch {
      setError(t('login.connectError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell flex min-h-dvh items-center justify-center px-4 py-6">
      <div className="relative z-10 w-full max-w-sm">
        {/* 卡片 */}
        <div className="surface-panel px-6 py-6">
          {/* Logo 区域 */}
          <div className="mb-6 flex items-center gap-3 border-b border-border-light pb-5">
            <Image
              src="/icons/icon-180x180.png"
              alt="LumiMuse Logo"
              width={48}
              height={48}
              unoptimized
              className="h-12 w-12 rounded-xl object-cover"
            />
            <h1 className="section-title text-xl">LumiMuse</h1>
          </div>

          {/* 表单 */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="login-password" className="text-sm font-medium text-text-secondary">
                {t('login.passwordPrompt')}
              </label>
              <input
                id="login-password"
                ref={inputRef}
                type="password"
                value={password}
                onChange={e => {
                  setPassword(e.target.value);
                  setError('');
                }}
                placeholder={t('login.passwordPlaceholder')}
                className="input-rich text-center tracking-widest"
                style={{ fontSize: '1.1rem', letterSpacing: '0.2em' }}
                autoComplete="current-password"
                aria-invalid={!!error}
                aria-describedby={error ? 'login-error' : undefined}
                disabled={loading}
              />
              {/* 错误提示 */}
              <div
                id="login-error"
                role={error ? 'alert' : undefined}
                aria-hidden={!error}
                className="min-h-[1.4rem] text-center text-sm text-danger"
              >
                {error || '　'}
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !password.trim()}
              aria-busy={loading}
              className="soft-button soft-button-primary w-full"
              style={{ opacity: loading || !password.trim() ? 0.6 : 1 }}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="spinner-sm" aria-hidden="true" />
                  {t('common.loading')}
                </span>
              ) : (
                t('login.submit')
              )}
            </button>
          </form>
        </div>

        {/* 底部装饰文字 */}
        <p className="mt-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {t('login.tagline')}
        </p>
      </div>
    </div>
  );
}

// useSearchParams 需要包在 Suspense 里
export default function LoginPage() {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<ContentState mode="loading" title={t('common.loading')} />}>
      <LoginForm />
    </Suspense>
  );
}
