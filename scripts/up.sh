#!/usr/bin/env bash
# ====== 乾明车牌识别 · Docker 版一行安装脚本 ======
#   bash <(curl -sSL https://gitee.com/dj_rolin/qmlpars/raw/main/scripts/up.sh)
set -eo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info(){  printf "${GREEN}[qm-install]${NC} %s\n" "$*"; }
warn(){  printf "${YELLOW}[qm-install]${NC} %s\n" "$*"; }
fail(){  printf "${RED}[qm-install]${NC} %s\n"    "$*"; exit 1; }

[ "$(id -u)" -ne 0 ] && fail "请用 root 执行（sudo -i 或 sudo bash ...）"

# ---------- Step 1: 没装 Docker 就装（官方 get-docker 脚本 + 国内镜像）----------
if ! command -v docker >/dev/null 2>&1; then
  info "检测到未安装 Docker Engine，开始安装..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun \
      || curl -fsSL https://get.docker.com | bash
  else
    apt-get update -y >/dev/null && apt-get install -y curl >/dev/null \
      && curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun
  fi
  systemctl enable --now docker || true
fi
if ! docker compose version >/dev/null 2>&1; then
  # docker 24+ 自带 compose plugin；如果缺就补装
  apt-get install -y docker-compose-plugin >/dev/null 2>&1 \
    || curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
          -o /usr/libexec/docker/cli-plugins/docker-compose && chmod +x /usr/libexec/docker/cli-plugins/docker-compose
fi
info "Docker $(docker -v) / $(docker compose version)"

# ---------- Step 2: 拉源码 & 进入目录 ----------
HOME_DIR="${QMLPARS_HOME:-/opt/qmlpars}"
mkdir -p "$HOME_DIR" && cd "$HOME_DIR"
if [ -d "$HOME_DIR/.git" ]; then
  info "检测到已有部署目录，拉取最新 compose 文件..."
  git -C "$HOME_DIR" fetch --depth 1 && git -C "$HOME_DIR" reset --hard origin/main || true
else
  git clone --depth 1 https://gitee.com/dj_rolin/qmlpars.git "$HOME_DIR"
fi

# ---------- Step 3: 首次启动生成 .env（交互询问） ----------
cd "$HOME_DIR"
if [ ! -f .env ]; then
  info "首次启动，生成 .env 配置..."
  mkdir -p data/env data/nginx/conf.d data/ssl data/certbot/www
  [ -t 0 ] && read -rp "请输入访问域名或公网IP: " _DOMAIN
  : "${_DOMAIN:=$(hostname -I | awk '{print $1}')}"
  [ -t 0 ] && read -s -rp "请设置管理员密码（至少6位）: " _PWD; echo
  : "${_PWD:=admin$(head -c 6 /dev/urandom | base64 | tr -dc A-Za-z0-9)}"
  cat > .env <<EOF
DOMAIN=${_DOMAIN}
QMLPARS_ADMIN_PASSWORD=${_PWD}
INTERNAL_PORT=7081
APP_TAG=v1.1.15
NPM_REGISTRY=https://registry.npmmirror.com
EOF
  chmod 600 .env
  info "已生成 .env（可手动编辑后重跑）"
fi

# ---------- Step 4: 渲染 nginx 站点配置（注入 DOMAIN）----------
bash scripts/render-nginx.sh || warn "nginx 配置渲染失败，请检查 data/nginx/conf.d/qmlpars.conf.template"

# ---------- Step 5: 选择 profile（是否打 APP）----------
PROFILE="runtime"
if [ -t 0 ]; then
  echo
  read -rp "本机需要支持【在线打包 APP APK】吗？(y/N，默认否): " yn
  [[ "$yn" =~ ^[Yy]$ ]] && PROFILE="builder"
fi

# ---------- Step 6: 启动 ----------
info "启动服务（profile=${PROFILE}）..."
mkdir -p data/env && touch data/env/.env   # 宿主机 .env 不存在时保证挂载不报错
docker compose --profile "$PROFILE" pull
docker compose --profile "$PROFILE" up -d --remove-orphans

# ---------- Step 7: 等健康检查 + 打印结果 ----------
echo
info "等待容器就绪（最多 90 秒）..."
for i in $(seq 1 30); do
  sleep 3
  if docker inspect -f '{{.State.Health.Status}}' qmlpars 2>/dev/null | grep -q healthy; then break; fi
  printf '.'
done
echo
PROTO=http
grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' <(grep '^DOMAIN=' .env | cut -d= -f2) || PROTO=https
ADDR="${PROTO}://$(grep '^DOMAIN=' .env | cut -d= -f2)/"

echo
echo "============================================================"
echo " 🎉 乾明车牌识别 · Docker 版部署完成"
echo "============================================================"
echo "   引导页     : ${ADDR}"
echo "   后台管理   : ${ADDR}admin  （用户名: $(grep '^QMLPARS_ADMIN_USER' .env | cut -d= -f2)）"
echo "   日常管理   : docker exec -it qmlpars qm"
echo "   升级       : docker compose pull && docker compose up -d"
echo "============================================================"
