import type { Metadata, Viewport } from 'next';
import { I18nProvider } from '@/lib/i18n-context';
import { ThemeProvider } from '@/lib/theme-provider';
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
  return (
    <html lang="zh" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Quicksand 英文字体 */}
        <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&display=swap" rel="stylesheet" />
        {/* 霞鹜文楷屏幕版（简体 GB），来自 cdnjs，支持完整简体汉字 */}
        <link rel="preconnect" href="https://cdnjs.cloudflare.com" />
        <link href="https://cdnjs.cloudflare.com/ajax/libs/lxgw-wenkai-screen-webfont/1.7.0/lxgwwenkaigbscreen.css" rel="stylesheet" />
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
          <I18nProvider>{children}</I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
