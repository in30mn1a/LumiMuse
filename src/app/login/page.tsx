'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import Image from 'next/image';
import { useTranslation } from '@/lib/i18n-context';

// 限制登录后跳转地址只能是站内相对路径，避免开放重定向
function safeReturnTo(from: string | null): string {
  if (!from) return '/';
  // 必须以 `/` 开头；不允许 `//xxx`（协议相对 URL）或 `/\xxx`（反斜杠绕过）
  if (!from.startsWith('/')) return '/';
  if (from.startsWith('//') || from.startsWith('/\\')) return '/';
  return from;
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
    <div className="app-shell flex h-dvh items-center justify-center px-4">
      {/* 背景光晕 */}
      <div
        className="pointer-events-none fixed"
        style={{
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 480,
          height: 480,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(155,124,240,0.16) 0%, transparent 70%)',
          animation: 'glowPulse 4s ease-in-out infinite',
        }}
      />

      <div className="relative z-10 w-full max-w-sm">
        {/* 卡片 */}
        <div className="surface-hero px-8 py-10">
          {/* Logo 区域 */}
          <div className="mb-8 flex flex-col items-center gap-3">
            <Image
              src="/icons/icon-180x180.png"
              alt="LumiMuse Logo"
              width={56}
              height={56}
              unoptimized
              className="h-14 w-14 rounded-2xl object-cover shadow-lg"
            />
            <div className="text-center">
              <h1
                className="section-title text-2xl"
                style={{
                  background: 'linear-gradient(135deg, var(--color-accent-dark) 0%, var(--color-accent) 50%, var(--color-accent-light) 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
              >
                LumiMuse
              </h1>
              <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
                {t('login.passwordPrompt')}
              </p>
            </div>
          </div>

          {/* 表单 */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <input
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
                disabled={loading}
              />
              {/* 错误提示 */}
              <div
                className="min-h-[1.4rem] text-center text-sm transition-opacity duration-200"
                style={{
                  color: '#a33375',
                  opacity: error ? 1 : 0,
                }}
              >
                {error || '　'}
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !password.trim()}
              className="soft-button soft-button-primary w-full"
              style={{ opacity: loading || !password.trim() ? 0.6 : 1 }}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                  <span className="typing-dot" style={{ animationDelay: '160ms' }} />
                  <span className="typing-dot" style={{ animationDelay: '320ms' }} />
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
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
