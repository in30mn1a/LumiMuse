import type { Metadata, Viewport } from 'next';
import { I18nProvider } from '@/lib/i18n-context';
import { ThemeProvider } from '@/lib/theme-provider';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import { ToastProvider } from '@/components/ui/Toast';
import './globals.css';

export const metadata: Metadata = {
  title: 'LumiMuse',
  description: '轻量化的角色陪伴空间',
  applicationName: 'LumiMuse',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    title: 'LumiMuse',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/favicon.ico?v=2', sizes: 'any' },
      { url: '/favicon.png?v=2', type: 'image/png', sizes: '32x32' },
      { url: '/icons/icon-192x192.png', type: 'image/png', sizes: '192x192' },
      { url: '/icons/icon-512x512.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: [
      { url: '/apple-touch-icon.png' },
      { url: '/apple-touch-icon-180x180.png', sizes: '180x180' },
      { url: '/apple-touch-icon-152x152.png', sizes: '152x152' },
      { url: '/apple-touch-icon-120x120.png', sizes: '120x120' },
    ],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 内联脚本：在 React 挂载前同步读取 localStorage 决定是否加 dark class，避免首屏闪烁（FOUC）。
  // 必须用 try/catch 包住——隐私模式或部分浏览器禁用 storage 时访问会抛错，导致整页脚本崩溃。
  const themeInitScript = `(function(){try{var t=localStorage.getItem('lumimuse_theme');var d=t==='dark'||(t==='auto'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d){document.documentElement.classList.add('dark');}}catch(e){}})();`;

  return (
    <html lang="zh" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {/*
          霞鹜文楷屏幕版（简体 GB）— 自托管（方案C）。
          1) 不再跨境请求 cdnjs，改用本地 /fonts/lxgw 下的样式表与 woff2 子集；
          2) 本地 CSS 已将 font-display 改为 optional：字体未在极短阻塞期内就绪则
             本次沿用系统字体且不再中途替换，彻底消除「系统字体→文楷」的 FOUT 跳变，
             字体随后进缓存，二次访问命中缓存即可首屏直接以文楷渲染；
          3) preload 高频子集（116-119，覆盖最常用简体汉字与中文标点），
             让首屏常用文字尽量赶上 optional 的就绪窗口、直接以文楷呈现。
          注意：preload 必须带 type 与 crossOrigin，否则浏览器会重复下载字体。
        */}
        {[116, 117, 118, 119].map(n => (
          <link
            key={n}
            rel="preload"
            as="font"
            type="font/woff2"
            href={`/fonts/lxgw/files/lxgwwenkaigbscreen-subset-${n}.woff2`}
            crossOrigin="anonymous"
          />
        ))}
        <link href="/fonts/lxgw/lxgwwenkaigbscreen.css" rel="stylesheet" />
        {/* Quicksand 英文标题字体（仅标题用，量小，保留 Google Fonts swap） */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-180x180.png" />
        <link rel="apple-touch-icon" sizes="152x152" href="/apple-touch-icon-152x152.png" />
        <link rel="apple-touch-icon" sizes="120x120" href="/apple-touch-icon-120x120.png" />
        <link rel="icon" href="/favicon.ico?v=2" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon.png?v=2" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192x192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icons/icon-512x512.png" />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <I18nProvider>
            <ToastProvider>
              <ErrorBoundary>{children}</ErrorBoundary>
            </ToastProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
