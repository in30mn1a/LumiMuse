import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker 部署时使用 standalone 模式，生成最小化的独立运行包
  output: "standalone",
  // 本地使用时隐藏 Next.js 开发工具悬浮按钮
  devIndicators: false,
};

export default nextConfig;

