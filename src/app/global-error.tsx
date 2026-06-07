'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <main className="flex min-h-screen items-center justify-center bg-[var(--background)] px-6 text-[var(--foreground)]">
          <section className="w-full max-w-md rounded-lg border border-border-light bg-white/80 px-6 py-5 shadow-sm">
            <h1 className="text-lg font-semibold text-text-primary">应用遇到错误</h1>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              页面初始化失败，请重试。若问题持续出现，请查看服务端日志。
            </p>
            {error?.message && (
              <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error.message}</p>
            )}
            <button
              type="button"
              onClick={reset}
              className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-dark"
            >
              重试
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
