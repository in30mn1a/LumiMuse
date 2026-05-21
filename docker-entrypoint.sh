#!/bin/sh
# 容器启动前的最小化准备：仅确保数据目录存在。
#
# 方案变更说明：
#   早期版本以 root 启动 + gosu 降权到 nextjs，目的是修正挂载卷的 ownership。
#   改为直接以 nextjs 用户启动（见 Dockerfile USER nextjs）后，本脚本不再需要
#   chown，也不再 exec gosu。这样可以彻底消除容器内 root 攻击面。
#
#   代价：宿主机挂载的 volume 必须由对齐 UID 1001:1001 的用户拥有。
#   docker-compose.yml 可通过 `user: "1001:1001"` 指定，也可在 named volume 模式下
#   由 Docker 自动以镜像内 USER 创建（默认对齐）。
#
# 这里仍保留 mkdir 是为了应对 named volume 首次挂载为空的情况。
set -e

mkdir -p /app/data /app/public/generated /app/public/avatars /app/public/attachments

exec "$@"
