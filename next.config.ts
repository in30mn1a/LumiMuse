import type { NextConfig } from "next";

// 仅在开发模式下需要允许 'unsafe-eval' 以支持 React Refresh / Next.js HMR
const isDev = process.env.NODE_ENV !== "production";

/**
 * 全站默认 CSP（Content-Security-Policy）策略。
 *
 * 关键决策：
 * - script-src：开发模式开 'unsafe-eval'（HMR 需要），生产模式收紧
 * - script/style 都开 'unsafe-inline'：Next.js 仍会注入内联脚本与 styled-jsx；
 *   未来若全面切换到 nonce，可在此移除
 * - img-src：允许 data:/blob:（消息附件 base64、客户端预览）以及 https:
 *   （远程头像 / AI 生图回链 / 用户填入的图片 URL）
 * - connect-src：用户可配置任意 LLM / SD WebUI 供应商，允许 https:；
 *   仅开发模式允许 ws: 供 Next.js HMR 使用，生产不允许明文 websocket
 * - font-src：允许同源（自托管霞鹜文楷 /fonts/lxgw）+ data: + Google Fonts（Quicksand）
 * - style-src：除同源外允许 Google Fonts（Quicksand，layout.tsx 通过 <link> 引入）
 * - frame-ancestors 'none'：禁止被 iframe 嵌入
 */
const cspDirectives: Array<[string, string]> = [
  ["default-src", "'self'"],
  [
    "script-src",
    isDev
      ? "'self' 'unsafe-inline' 'unsafe-eval'"
      : "'self' 'unsafe-inline'",
  ],
  ["style-src", "'self' 'unsafe-inline' https://fonts.googleapis.com"],
  ["img-src", "'self' data: blob: https:"],
  ["font-src", "'self' data: https://fonts.gstatic.com"],
  ["connect-src", isDev ? "'self' https: wss: ws:" : "'self' https: wss:"],
  ["frame-ancestors", "'none'"],
  ["base-uri", "'self'"],
  ["form-action", "'self'"],
  ["object-src", "'none'"],
];

const contentSecurityPolicy = cspDirectives
  .map(([k, v]) => `${k} ${v}`)
  .join("; ");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  // Docker 部署时使用 standalone 模式，生成最小化的独立运行包
  output: "standalone",
  // 本地使用时隐藏 Next.js 开发工具悬浮按钮
  devIndicators: false,
  async headers() {
    return [
      {
        // 全站默认头
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
