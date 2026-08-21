#!/bin/bash
# ============================================================
# qmlpars 一键安装脚本（自适配 Debian / Ubuntu / CentOS / RHEL 等）
# QianMing License Plate Automatic Recognition System
# 参考：https://linuxmirrors.cn/main.sh 的发行版自适应思路
# 用法：
#   wget -O install.sh <下载地址>/install.sh && bash install.sh
#   （脚本会自动从同目录下载 qmlpars.tar.gz 并安装）
# 可覆盖环境变量：
#   QMLPARS_PKG_URL  tar 包地址(不含文件名)，默认取 install.sh 同目录
# ============================================================
set -e

PKG_NAME="qmlpars.tar.gz"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------- 系统信息收集与包管理器适配（参考 linuxmirrors 思路） ----------
SYSTEM_NAME=""
PKG_MGR=""
PKG_UPDATE=""
PKG_INSTALL=""
NEED_EPEL=0

collect_system_info() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    SYSTEM_NAME="${PRETTY_NAME:-$NAME}"
    case "$ID" in
      debian|ubuntu|raspbian|linuxmint|kali)
        PKG_MGR="apt"
        PKG_UPDATE="apt-get update -y"
        PKG_INSTALL="apt-get install -y"
        ;;
      centos|rhel|fedora|rocky|almalinux|anolis|openEuler|opencloudos|tencentos)
        if command -v dnf >/dev/null 2>&1; then
          PKG_MGR="dnf"
          PKG_UPDATE="dnf makecache"
          PKG_INSTALL="dnf install -y"
        else
          PKG_MGR="yum"
          PKG_UPDATE="yum makecache"
          PKG_INSTALL="yum install -y"
        fi
        NEED_EPEL=1
        ;;
      opensuse*|sles)
        PKG_MGR="zypper"
        PKG_UPDATE="zypper refresh"
        PKG_INSTALL="zypper install -y"
        ;;
      arch|manjaro)
        PKG_MGR="pacman"
        PKG_UPDATE="pacman -Sy"
        PKG_INSTALL="pacman -S --noconfirm"
        ;;
      alpine)
        PKG_MGR="apk"
        PKG_UPDATE="apk update"
        PKG_INSTALL="apk add"
        ;;
      *)
        PKG_MGR=""
        ;;
    esac
  fi
  # 兜底：用派系发布文件二次判定（参考 linuxmirrors 的 release 文件检测）
  if [ -z "$PKG_MGR" ]; then
    if [ -f /etc/debian_version ]; then
      PKG_MGR="apt"; PKG_UPDATE="apt-get update -y"; PKG_INSTALL="apt-get install -y"
    elif [ -f /etc/redhat-release ]; then
      if command -v dnf >/dev/null 2>&1; then
        PKG_MGR="dnf"; PKG_UPDATE="dnf makecache"; PKG_INSTALL="dnf install -y"
      else
        PKG_MGR="yum"; PKG_UPDATE="yum makecache"; PKG_INSTALL="yum install -y"
      fi
      NEED_EPEL=1
    fi
  fi
}

collect_system_info

# 不支持的系统明确报错退出
if [ -z "$PKG_MGR" ]; then
  echo "!! 未能识别当前系统的包管理器（apt/dnf/yum/zypper/pacman/apk）。"
  echo "   当前系统：${SYSTEM_NAME:-未知}"
  echo "   请在本脚本支持的发行版（Debian/Ubuntu/CentOS/RHEL 等）上运行，或手动安装依赖后重试。"
  exit 1
fi

echo "==> 当前系统：${SYSTEM_NAME:-未知}"
echo "==> 包管理器：$PKG_MGR"

# ---------- 交互：域名/IP 与安装目录 ----------
read -rp "请输入访问域名或服务器IP（不要带端口，如 qmlpars.example.com 或 1.2.3.4）： " DOMAIN
while [ -z "$DOMAIN" ]; do
  read -rp "域名/IP 不能为空，请重新输入： " DOMAIN
done

DEFAULT_HOME="/opt/qmlpars"
read -rp "请输入安装目录 [默认 $DEFAULT_HOME]： " HOME_DIR
HOME_DIR="${HOME_DIR:-$DEFAULT_HOME}"

PORT=7081
echo "==> 安装目录：$HOME_DIR"
echo "==> 访问地址标识：$DOMAIN"
echo "==> 内部监听端口：$PORT"

# ---------- 0. 获取 tar 包（优先级：本地 tar 包 > 同目录含源码 > 联网下载） ----------
if [ -f "$SCRIPT_DIR/$PKG_NAME" ]; then
  echo "==> 检测到本地安装包 $PKG_NAME，解压到 $HOME_DIR"
  rm -rf "$HOME_DIR"
  mkdir -p "$HOME_DIR"
  tar xzf "$SCRIPT_DIR/$PKG_NAME" -C "$HOME_DIR"
  SRC_DIR="$HOME_DIR"
elif [ -f "$SCRIPT_DIR/index.js" ]; then
  echo "==> 本目录已含源码，直接使用"
  SRC_DIR="$SCRIPT_DIR"
else
  PKG_URL="${QMLPARS_PKG_URL:-https://github.com/djrolin2023/qmlpars/releases/latest/download/$PKG_NAME}"
  echo "==> 下载安装包： $PKG_URL"
  TMP_PKG="/tmp/$PKG_NAME"
  if command -v wget >/dev/null 2>&1; then
    wget -O "$TMP_PKG" "$PKG_URL"
  else
    curl -L -o "$TMP_PKG" "$PKG_URL"
  fi
  rm -rf "$HOME_DIR"
  mkdir -p "$HOME_DIR"
  tar xzf "$TMP_PKG" -C "$HOME_DIR"
  SRC_DIR="$HOME_DIR"
  rm -f "$TMP_PKG"
fi

# 修正从 root 打包带来的权限（部分文件可能是 000，导致非 root 用户读不到）
chmod 755 "$SRC_DIR" 2>/dev/null || true
chmod 600 "$SRC_DIR/.env" 2>/dev/null || true
chmod 644 "$SRC_DIR/.env.example" 2>/dev/null || true
chmod -R u+rwX,g+rX,o+rX "$SRC_DIR/data" "$SRC_DIR/uploads" "$SRC_DIR/cpsb/Images/uploads" 2>/dev/null || true
chmod -R u+rwX,g+rX,o+rX "$SRC_DIR"/*.js "$SRC_DIR"/*.json "$SRC_DIR"/start.sh "$SRC_DIR"/install.sh 2>/dev/null || true

# 把域名写入 .env 的 BASE_URL（供拼接图片完整地址）
if grep -q '^BASE_URL=' "$SRC_DIR/.env" 2>/dev/null; then
  sed -i "s#^BASE_URL=.*#BASE_URL=https://$DOMAIN#" "$SRC_DIR/.env"
else
  echo "BASE_URL=https://$DOMAIN" >> "$SRC_DIR/.env"
fi

# ---------- 1. 安装 Node.js (>=22) ----------
need_node=0
if ! command -v node >/dev/null 2>&1; then need_node=1
else
  NODE_VER="$(node -v | sed 's/v//;s/\..*//')"
  [ "$NODE_VER" -lt 22 ] && need_node=1
fi
if [ "$need_node" -eq 1 ]; then
  echo "==> 安装 Node.js 22 ..."
  case "$PKG_MGR" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      $PKG_UPDATE
      $PKG_INSTALL curl ca-certificates gnupg
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      $PKG_INSTALL nodejs
      ;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
      $PKG_INSTALL nodejs
      ;;
    zypper)
      $PKG_INSTALL nodejs22 npm22
      ;;
    pacman)
      $PKG_INSTALL nodejs npm
      ;;
    apk)
      $PKG_INSTALL nodejs npm
      ;;
  esac
fi
echo "==> Node 版本: $(node -v)，npm $(npm -v)"

# ---------- 2. npm 依赖 ----------
echo "==> 安装 npm 依赖 ..."
cd "$SRC_DIR"
npm install --omit=dev

# ---------- 3. systemd 服务 ----------
SERVICE_NAME="qmlpars"
if [ ! -d /run/systemd/system ] && ! command -v systemctl >/dev/null 2>&1; then
  echo "!! 未检测到 systemd，无法注册系统服务。"
  echo "   请手动运行启动脚本： bash $SRC_DIR/start.sh"
else
  echo "==> 写入 /etc/systemd/system/${SERVICE_NAME}.service"
  cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=QianMing License Plate Automatic Recognition System
After=network.target

[Service]
Type=simple
WorkingDirectory=${SRC_DIR}
ExecStart=/usr/bin/node ${SRC_DIR}/index.js
Restart=always
RestartSec=3
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable ${SERVICE_NAME}
  systemctl restart ${SERVICE_NAME}
  sleep 3
  if ! systemctl is-active --quiet ${SERVICE_NAME}; then
    echo "!! 后端服务启动失败，查看： journalctl -u ${SERVICE_NAME} -n 50"
    exit 1
  fi
  echo "==> 后端服务已启动 ✓"
fi

# ---------- 4. nginx + HTTPS ----------
echo "==> 安装 nginx / certbot ..."
case "$PKG_MGR" in
  apt)
    export DEBIAN_FRONTEND=noninteractive
    $PKG_UPDATE
    $PKG_INSTALL nginx certbot python3-certbot-nginx
    ;;
  dnf|yum)
    if [ "$NEED_EPEL" -eq 1 ]; then
      $PKG_INSTALL epel-release
      $PKG_UPDATE 2>/dev/null || true
    fi
    $PKG_INSTALL nginx certbot python3-certbot-nginx
    ;;
  zypper)
    $PKG_INSTALL nginx certbot
    ;;
  pacman)
    $PKG_INSTALL nginx certbot
    ;;
  apk)
    $PKG_INSTALL nginx certbot
    ;;
esac

# 判断是域名还是 IP
if echo "$DOMAIN" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
  IS_IP=1
else
  IS_IP=0
fi

NGINX_CONF="/etc/nginx/conf.d/${SERVICE_NAME}.conf"

cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 15m;
    }
}
EOF

if [ "$IS_IP" -eq 1 ]; then
  echo "==> 检测到 IP 模式：仅 HTTP 反代，不申请证书"
  echo "    如需 HTTPS，可将证书放到 /etc/ssl/qmlpars/ 后手动修改 $NGINX_CONF"
else
  echo "==> 域名模式：尝试自动申请 Let's Encrypt 证书"
  echo "    若已有证书，可放到 /etc/ssl/qmlpars/fullchain.pem 与 privkey.pem，脚本将改用自定义证书"
  CUSTOM_CRT="/etc/ssl/qmlpars/fullchain.pem"
  CUSTOM_KEY="/etc/ssl/qmlpars/privkey.pem"
  if [ -f "$CUSTOM_CRT" ] && [ -f "$CUSTOM_KEY" ]; then
    echo "==> 检测到自定义证书，使用自定义证书配置 HTTPS"
    USE_CUSTOM=1
  else
    USE_CUSTOM=0
  fi

  if [ "$USE_CUSTOM" -eq 1 ]; then
    cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    server_name ${DOMAIN};
    ssl_certificate $CUSTOM_CRT;
    ssl_certificate_key $CUSTOM_KEY;
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 15m;
    }
}
EOF
  else
    # 先以 http 配置测试 nginx，再 certbot 申请
    nginx -t && systemctl reload nginx
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@${DOMAIN} --redirect; then
      echo "==> Let's Encrypt 证书申请成功 ✓"
    else
      echo "!! 自动申请失败（可能域名未解析到本机 / 80端口未开放）。已保留 HTTP 反代，可稍后手动执行："
      echo "   certbot --nginx -d $DOMAIN"
    fi
  fi
fi

nginx -t && systemctl reload nginx

# ---------- 5. 完成 ----------
echo ""
echo "=================================================="
echo " QianMing License Plate Automatic Recognition System 安装完成"
echo " 管理后台： http://${DOMAIN}/admin   (或 https://${DOMAIN}/admin)"
echo " 查看后端日志： journalctl -u ${SERVICE_NAME} -f"
echo " 查看 nginx 日志： tail -f /var/log/nginx/access.log"
echo "=================================================="
