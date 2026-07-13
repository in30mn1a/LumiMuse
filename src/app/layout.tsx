import type { Metadata, Viewport } from 'next';
import { I18nProvider } from '@/lib/i18n-context';
import { ThemeProvider } from '@/lib/theme-provider';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import { ToastProvider } from '@/components/ui/Toast';
import SettingsBootstrapToast from '@/components/ui/SettingsBootstrapToast';
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
          霞鹜文楷屏幕版（简体 GB）— 自托管。
          1) 不再跨境请求 cdnjs，改用本地 /fonts/lxgw 下的样式表与 woff2 子集；
          2) 本地 CSS 的 font-display 保持 swap：先用系统字体即时渲染，各子集加载完成后
             逐一切换为文楷，最终整页统一为文楷——不会出现「部分字文楷、部分字系统字体」
             的永久混排（这正是 optional 在多子集中文字体下的缺陷，故不采用）；
          3) preload 高频子集（115-119，覆盖最常用简体汉字与中文标点），
             让首屏常用文字尽快完成切换、减小可见跳变；二次访问命中缓存即首屏直出文楷。
          注意：preload 必须带 type 与 crossOrigin，否则浏览器会重复下载字体。
        */}
        {[115, 116, 117, 118, 119].map(n => (
          <link
            key={n}
            rel="preload"
            as="font"
            type="font/woff2"
            href={`/fonts/lxgw/files/lxgwwenkaigbscreen-subset-${n}.woff2`}
            crossOrigin="anonymous"
          />
        ))}
        {/*
          此处刻意用 <link rel="stylesheet"> 引入自托管字体 CSS，而非走打包器 import：
          该 CSS 内的 @font-face 以相对路径 ./files/*.woff2 引用 97 个子集，必须由浏览器
          相对 /fonts/lxgw/ 解析；若经 import 打包，相对路径会以 globals.css 位置解析而全部失效。
          故针对本行禁用 no-css-tags 规则。
        */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
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
              <SettingsBootstrapToast />
              <ErrorBoundary>{children}</ErrorBoundary>
            </ToastProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
