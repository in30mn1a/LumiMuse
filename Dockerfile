# ── 阶段一：安装依赖 ──────────────────────────────────────────
FROM node:20-slim AS deps

# better-sqlite3 需要编译原生模块，安装必要的构建工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --frozen-lockfile

# ── 阶段二：构建 ──────────────────────────────────────────────
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# 确保 public 目录存在（.dockerignore 排除了子目录可能导致目录为空）
RUN mkdir -p /app/public

# ── 阶段三：运行时镜像（最小化） ─────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# 创建非 root 用户，提升安全性
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# 复制构建产物
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# 创建数据目录并设置权限
RUN mkdir -p /app/data /app/public/generated /app/public/avatars \
    && chown -R nextjs:nodejs /app/data /app/public/generated /app/public/avatars

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

USER root

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "server.js"]
