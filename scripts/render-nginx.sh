#!/usr/bin/env bash
# 用 .env 中的 DOMAIN 渲染 nginx 站点模板（envsubst）
# 用法：bash scripts/render-nginx.sh
set -eo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "!! 未找到 .env，请先运行 scripts/up.sh 或手动 cp .env.docker.example .env"
  exit 1
fi
# 载入 DOMAIN（仅取需要的变量，避免把整份 .env 注入模板）
set -a; . ./.env; set +a

TEMPLATE="data/nginx/conf.d/qmlpars.conf.template"
OUT="data/nginx/conf.d/qmlpars.conf"
mkdir -p "$(dirname "$OUT")"
if [ ! -f "$TEMPLATE" ]; then
  echo "!! 模板不存在: $TEMPLATE"
  exit 1
fi
# 仅替换 ${DOMAIN}，其余 $ 变量保留（如 $host/$proxy_... 是 nginx 自己的）
envsubst '$DOMAIN' < "$TEMPLATE" > "$OUT"
echo "[render-nginx] 已生成 $OUT (DOMAIN=$DOMAIN)"
