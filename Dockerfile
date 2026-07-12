# ── 阶段一：安装依赖 ──────────────────────────────────────────
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS deps

# better-sqlite3 需要编译原生模块，安装必要的构建工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ── 阶段二：构建 ──────────────────────────────────────────────
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder

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
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runner

WORKDIR /app

ARG LUMIMUSE_BUILD_SHA=local
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV LUMIMUSE_BUILD_SHA=$LUMIMUSE_BUILD_SHA

# 创建非 root 用户，提升安全性。
# UID/GID 固定为 1001，便于 docker-compose 通过 `user: "1001:1001"` 对齐挂载卷。
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# 复制构建产物，并立即移交给 nextjs 用户
# 改为以 nextjs 启动后无需 gosu，移除了对应 apt 安装步骤
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# 创建数据目录并设置权限
RUN mkdir -p /app/data /app/public/generated /app/public/avatars /app/public/attachments \
    && chown -R nextjs:nodejs /app/data /app/public

COPY --chown=nextjs:nodejs docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# 直接以非 root 用户运行：消除容器内提权攻击面，无需运行时 gosu 降权。
# 旧方案 (USER root + gosu) 的迁移成本：
#   - 宿主机挂载目录必须由 UID 1001 拥有，否则写入会失败；
#     docker-compose.yml 可通过 `user: "1001:1001"` 显式声明，
#     或使用 named volume 让 Docker 按镜像内 USER 自动创建。
USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health?ready=1').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "server.js"]
