'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from '@/lib/i18n-context';

interface Props {
  children: ReactNode;
  /** 自定义降级 UI，不传则使用默认 */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/** 默认降级 UI（函数组件，便于使用 i18n hook） */
function DefaultFallback({ message, onReset, onReload }: { message: string; onReset: () => void; onReload: () => void }) {
  const { t } = useTranslation();
  const displayMessage = message || t('errorBoundary.unknown');
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-8">
      <div className="surface-panel w-full max-w-md p-6 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[1.4rem] bg-gradient-to-br from-accent/15 to-accent-light/25 text-accent-dark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-text-primary">{t('errorBoundary.title')}</h2>
        <p className="mt-2 text-sm text-text-muted">{t('errorBoundary.body')}</p>
        <pre className="mt-3 max-h-32 overflow-auto rounded-xl border border-border-light bg-warm-50 px-3 py-2 text-left text-[11px] leading-relaxed text-text-secondary">
          {displayMessage}
        </pre>
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={onReset} className="soft-button soft-button-secondary px-4 py-2 text-sm">
            {t('errorBoundary.recover')}
          </button>
          <button onClick={onReload} className="soft-button soft-button-primary px-4 py-2 text-sm">
            {t('errorBoundary.reload')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 全局错误边界（仅 class 组件支持）
 * 捕获子树渲染期、生命周期和构造函数中的错误，避免整页白屏。
 * 不捕获事件回调、setTimeout/Promise 中的异步错误（这些由 try/catch 处理）。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 输出到控制台便于排查；生产环境可接入 Sentry 等
    console.error('[ErrorBoundary] 渲染崩溃：', error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    // 翻译文案在 fallback 中通过 hook 读取；此处只传入错误消息
    const message = this.state.error?.message || '';
    return <DefaultFallback message={message} onReset={this.handleReset} onReload={this.handleReload} />;
  }
}
