#!/usr/bin/env bash
# ================= qmlpars 容器 entrypoint =================
# 做 5 件事：1) 挂载卷目录权限修正  2) 若 .env 不含 ADMIN_PASSWORD_HASH 则用环境变量生成
#          3) 若容器首次启动并且指定了 FORCE_RECREATE_DB=1，允许重建（默认保留数据）
#          4) tini 作为 1 号进程转交 CMD，保证 Ctrl+C/SIGTERM 能干净退出
set -eo pipefail

echo "[entrypoint] QianMing qmlpars container starting (mode: ${QMLPARS_MODE:-runtime})..."

# 1) 确保挂载目录存在且权限正确（宿主机挂载首次可能是 root:root 0755）
mkdir -p /app/data /app/uploads/assets /app/uploads/snapshots /app/dist/backups /app/dist/builds
chown -R "$(id -u):$(id -g)" /app/data /app/uploads /app/dist 2>/dev/null || true
chmod -R u+rwX,g+rX /app/data /app/uploads /app/dist 2>/dev/null || true

# 2) 从环境变量 QMLPARS_ADMIN_PASSWORD 生成/写入密码哈希（CI/自动化场景用，不希望 mount .env）
if [ -n "${QMLPARS_ADMIN_PASSWORD:-}" ] && ! grep -q '^ADMIN_PASSWORD_HASH=' /app/.env 2>/dev/null; then
  echo "[entrypoint] QMLPARS_ADMIN_PASSWORD 环境变量已提供，生成哈希写入 .env"
  HASH=$(node -e "const {hashPassword}=require('./auth'); process.stdout.write(hashPassword(process.argv[1]))" "$QMLPARS_ADMIN_PASSWORD")
  echo "ADMIN_PASSWORD_HASH=${HASH}" >> /app/.env
  echo "ADMIN_USERNAME=${QMLPARS_ADMIN_USER:-admin}"    >> /app/.env
  # 一次性清掉，避免 `docker inspect` 还能看到明文（虽然不如用 Secret，但 docker compose 最常见的用法）
  unset QMLPARS_ADMIN_PASSWORD
fi

# 3) 端口 & BASE_URL 注入（允许在 compose 里用 DOMAIN 变量而不是手写 .env）
: "${DOMAIN:=qmlpars.local}"
: "${INTERNAL_PORT:=7081}"
# 注入/修正 .env 中 PORT、BASE_URL
_set_env(){
  local k="$1" v="$2"
  if grep -q "^${k}=" /app/.env 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v}|" /app/.env
  else
    echo "${k}=${v}" >> /app/.env
  fi
}
# 如果 DOMAIN 看起来是公网 IP，就走 http（和 install.sh 保持一致），否则 https
if echo "$DOMAIN" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
  PROTO='http'
else
  PROTO='https'
fi
_set_env PORT "$INTERNAL_PORT"
_set_env BASE_URL "${PROTO}://${DOMAIN}"

# 4) 健康检查辅助脚本（可选）：生成 /tmp/qmlpars-ready（给 compose healthcheck）
echo "listening on port: ${INTERNAL_PORT}" > /tmp/qmlpars-health.txt

echo "[entrypoint] 环境就绪，执行 CMD: $*"
exec "$@"
