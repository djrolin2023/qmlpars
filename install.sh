#!/bin/bash
# ============================================================
# qmlpars 一键安装脚本（自适配 Debian / Ubuntu / CentOS / RHEL / 等）
# QianMing License Plate Automatic Recognition System
# 参考：https://linuxmirrors.cn/main.sh 的发行版自适应思路
# 用法（一行命令安装，类似宝塔面板）：
#   bash <(curl -sSL https://raw.githubusercontent.com/djrolin2023/qmlpars/main/install.sh)
#   或
#   wget -O install.sh https://raw.githubusercontent.com/djrolin2023/qmlpars/main/install.sh && bash install.sh
# 可覆盖环境变量：
#   QMLPARS_PKG_URL   tar 包地址(不含文件名)，默认取 GitHub Release / Gitee
#   QMLPARS_PKG_NAME   tar 包文件名，默认 qmlpars.tar.gz
#   QMLPARS_HOME      安装目录，默认 /wwwroot/qmlpars
# ============================================================
set -e

# 隔离可能由 IDE/终端注入的 LD_LIBRARY_PATH（如 CodeBuddy CN 携带的 libstdc++ 会导致 node 崩溃）
unset LD_LIBRARY_PATH
unset LD_PRELOAD

# ---------- 命令行参数解析 ----------
#   --no-android-sdk   跳过 Android SDK / JDK 构建链安装（该机仅运行服务，不打包 APP）
#   --android-only     仅安装安卓构建链（不重装服务/重置密码），用于构建机就绪验证
SKIP_ANDROID_SDK=0
ANDROID_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-android-sdk) SKIP_ANDROID_SDK=1 ;;
    --android-only) ANDROID_ONLY=1 ;;
  esac
done

# ---------- 阶段式进度指示（全中文） ----------
TOTAL_STEPS=11
CUR_STEP=0
step_start() {
  CUR_STEP=$((CUR_STEP+1))
  printf "\n[%d/%d] %s ...\n" "$CUR_STEP" "$TOTAL_STEPS" "$1"
}
step_done() {
  printf "[%d/%d] %s ... 完成 ✓\n" "$CUR_STEP" "$TOTAL_STEPS" "$1"
}

# 包名与模式：install_data.sh 会设置 QMLPARS_PKG_NAME=qmlpars_data.tar.gz + QMLPARS_DATA_MODE=1
PKG_NAME="${QMLPARS_PKG_NAME:-qmlpars.tar.gz}"
DATA_MODE="${QMLPARS_DATA_MODE:-0}"
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

###########################################################
# 函数：install_android_chain —— 安卓构建链（Node≥18 + JDK17 + Android SDK）
# 用于管理后台「APP 打包」离线生成 APK。
#   硬性要求：
#     - Node.js ≥ 18（Capacitor 6 要求）
#     - JDK 17（Gradle 8 / Android Gradle Plugin 要求）
#     - Android SDK（cmdline-tools + platform-tools + build-tools + platforms）
# 出错排查：SDK 下载需访问 dl.google.com；群晖套件版 JDK 需手动启用
#   构建时所需环境变量 ANDROID_SDK_ROOT / JAVA_HOME 会写入
#   /etc/profile.d/qmlpars-android.sh，并在后端构建时自动注入
###########################################################
install_android_chain() {
  if [ "$SKIP_ANDROID_SDK" = "1" ]; then
    step_start "安装安卓构建链"
    echo "==> 已通过 --no-android-sdk 跳过（本机不用于打包 APP）"
    step_done "安装安卓构建链"
    return 0
  fi
  step_start "安装安卓构建链（Node≥18 + JDK17 + Android SDK）"

  # Node.js ≥18 校验（Capacitor 6 要求）
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -v | sed 's/v//;s/\..*//')"
    if [ "$NODE_MAJOR" -ge 18 ]; then
      echo "==> Node.js $(node -v) 满足 ≥18 要求 ✓"
    else
      echo "WARN: Node.js $(node -v) 版本过低，APP 打包需 ≥18，请先升级 Node"
    fi
  else
    echo "WARN: 未检测到 node，请先确保阶段 4 安装成功"
  fi

  # JDK 17（Gradle / Android Gradle Plugin 要求）
  NEED_JDK17=1
  if command -v java >/dev/null 2>&1; then
    JAVA_VER="$(java -version 2>&1 | head -1 | grep -oE '"[0-9]+' | tr -d '"' | head -1)"
    if [ -z "$JAVA_VER" ]; then
      JAVA_VER="$(java -version 2>&1 | head -1 | grep -oE '1\.[0-9]+' | sed 's/1\.//' | head -1)"
    fi
    if [ "$JAVA_VER" = "17" ]; then
      echo "==> JDK17 已存在（$JAVA_VER），跳过安装"
      NEED_JDK17=0
    else
      echo "==> 检测到 JDK $JAVA_VER，非 17，将安装 JDK17"
    fi
  fi
  if [ "$NEED_JDK17" = "1" ]; then
    echo "==> 安装 JDK17 ..."
    case "$PKG_MGR" in
      apt) $PKG_INSTALL openjdk-17-jdk-headless && echo "openjdk-17 安装完成" || echo "WARN: JDK17 安装失败，请手动安装" ;;
      dnf|yum) $PKG_INSTALL java-17-openjdk-devel && echo "JDK17 安装完成" || echo "WARN: JDK17 安装失败，请手动安装" ;;
      zypper) $PKG_INSTALL java-17-openjdk-devel && echo "JDK17 安装完成" || echo "WARN: JDK17 安装失败，请手动安装" ;;
      *) echo "WARN: 未知包管理器，请手动安装 JDK17" ;;
    esac
  fi
  if [ -z "$JAVA_HOME" ] && command -v java >/dev/null 2>&1; then
    JAVA_BIN="$(readlink -f "$(command -v java)")"
    export JAVA_HOME="$(dirname "$(dirname "$JAVA_BIN")")"
  fi
  [ -n "$JAVA_HOME" ] && echo "==> JAVA_HOME=$JAVA_HOME"

  # Android SDK 命令行工具
  ANDROID_SDK_ROOT=/opt/android-sdk
  if [ -d "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin" ]; then
    echo "Android SDK 已存在，跳过下载"
  else
    echo "==> 下载 Android SDK command-line tools ..."
    mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"
    TMP_SDK=$(mktemp -d)
    if curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o "$TMP_SDK/sdk.zip"; then
      cd "$TMP_SDK" && unzip -q sdk.zip && mv cmdline-tools "$ANDROID_SDK_ROOT/cmdline-tools/latest" && cd "$SRC_DIR"
      echo "Android SDK 下载完成"
    else
      echo "WARN: Android SDK 下载失败（需访问 dl.google.com），APP 打包功能将不可用"
    fi
    rm -rf "$TMP_SDK"
  fi
  if [ -d "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin" ] && [ -x "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
    export ANDROID_SDK_ROOT
    export ANDROID_HOME=$ANDROID_SDK_ROOT
    # sdkmanager 依赖 java，确保 JAVA_HOME/bin 在 PATH 中
    [ -n "$JAVA_HOME" ] && export PATH="$JAVA_HOME/bin:$PATH"
    yes | "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
    if "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null 2>&1; then
      echo "SDK 组件安装完成"
    else
      echo "WARN: SDK 组件安装失败（APP 打包将不可用，但服务不受影响）"
    fi
  else
    echo "WARN: 未找到 sdkmanager，跳过 SDK 组件安装（APP 打包将不可用）"
  fi

  # 固化构建环境变量（兼容群晖：/etc/profile.d 可能不存在）
  PROFILE_DIR=/etc/profile.d
  [ -d "$PROFILE_DIR" ] || mkdir -p "$PROFILE_DIR" 2>/dev/null || PROFILE_DIR=""
  if [ -n "$PROFILE_DIR" ]; then
    cat > "$PROFILE_DIR/qmlpars-android.sh" <<EOF
export ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT
export ANDROID_HOME=$ANDROID_SDK_ROOT
export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/default-java}
export PATH=\$JAVA_HOME/bin:\$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:\$ANDROID_SDK_ROOT/platform-tools:\$PATH
EOF
    echo "==> 构建环境变量已写入 $PROFILE_DIR/qmlpars-android.sh"
  else
    echo "WARN: 无法写入 $PROFILE_DIR，请在构建前手动 export JAVA_HOME/ANDROID_SDK_ROOT"
  fi

  # 安装 android-app 工程依赖并补全原生工程
  if [ -d "$SRC_DIR/android-app" ]; then
    echo "==> 安装 android-app 工程依赖（Capacitor 6）..."
    ( cd "$SRC_DIR/android-app" && npm install ) \
      && echo "android-app 依赖安装完成" \
      || echo "WARN: android-app 依赖安装失败（APP 打包将不可用）"
    if [ ! -f "$SRC_DIR/android-app/android/gradlew" ]; then
      echo "==> android 原生工程不完整，重新生成（cap add android）..."
      mkdir -p "$SRC_DIR/android-app/www"
      [ ! -f "$SRC_DIR/android-app/www/index.html" ] && echo '<!DOCTYPE html><html><body>placeholder</body></html>' > "$SRC_DIR/android-app/www/index.html"
      rm -rf "$SRC_DIR/android-app/android"
      ( cd "$SRC_DIR/android-app" && ./node_modules/.bin/cap add android ) \
        && echo "android 原生工程生成完成" \
        || echo "WARN: cap add android 失败，APP 打包将不可用"
    fi
    [ -f "$SRC_DIR/android-app/android/gradlew" ] && chmod +x "$SRC_DIR/android-app/android/gradlew"
  else
    echo "WARN: 未找到 android-app 工程目录，APP 打包功能不可用"
  fi

  step_done "安装安卓构建链（Node≥18 + JDK17 + Android SDK）"
}

# 仅安装安卓构建链（不影响现有服务/密码）
if [ "$ANDROID_ONLY" = "1" ]; then
  SRC_DIR="$SCRIPT_DIR"
  TOTAL_STEPS=1
  CUR_STEP=0
  install_android_chain
  echo ""
  echo "==> 安卓构建链安装完成（--android-only）。现有服务未改动。"
  exit 0
fi

if [ -z "$PKG_MGR" ]; then
  echo "!! 未能识别当前系统的包管理器（apt/dnf/yum/zypper/pacman/apk）。"
  echo "   当前系统：${SYSTEM_NAME:-未知}"
  echo "   请在本脚本支持的发行版（Debian/Ubuntu/CentOS/RHEL 等）上运行，或手动安装依赖后重试。"
  exit 1
fi

echo "==> 当前系统：${SYSTEM_NAME:-未知}"
echo "==> 包管理器：$PKG_MGR"

# ---------- 1. 配置国内镜像源（清华 / 阿里云），加速依赖下载 ----------
configure_mirror() {
  echo "==> 配置国内软件源（清华 / 阿里云）..."
  case "$PKG_MGR" in
    apt)
      # 备份原 sources（仅首次）
      if [ ! -f /etc/apt/sources.list.bak ]; then
        cp /etc/apt/sources.list /etc/apt/sources.list.bak 2>/dev/null || true
      fi
      # 清华源（Ubuntu/Debian 通用）
      if [ -f /etc/os-release ]; then . /etc/os-release; fi
      case "$ID" in
        ubuntu)
          cat > /etc/apt/sources.list <<EOF
deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu/ ${VERSION_CODENAME:-$(. /etc/os-release; echo $VERSION_CODENAME)} main restricted universe multiverse
deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu/ ${VERSION_CODENAME:-$(. /etc/os-release; echo $VERSION_CODENAME)}-updates main restricted universe multiverse
deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu/ ${VERSION_CODENAME:-$(. /etc/os-release; echo $VERSION_CODENAME)}-backports main restricted universe multiverse
deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu/ ${VERSION_CODENAME:-$(. /etc/os-release; echo $VERSION_CODENAME)}-security main restricted universe multiverse
EOF
          ;;
        *)
          # debian 系列
          DEB_VER="$(. /etc/os-release; echo $VERSION_CODENAME)"
          [ -z "$DEB_VER" ] && DEB_VER="bookworm"
          cat > /etc/apt/sources.list <<EOF
deb https://mirrors.tuna.tsinghua.edu.cn/debian/ ${DEB_VER} main contrib non-free non-free-firmware
deb https://mirrors.tuna.tsinghua.edu.cn/debian/ ${DEB_VER}-updates main contrib non-free non-free-firmware
deb https://mirrors.tuna.tsinghua.edu.cn/debian/ ${DEB_VER}-backports main contrib non-free non-free-firmware
EOF
          ;;
      esac
      $PKG_UPDATE
      ;;
    dnf|yum)
      if [ "$PKG_MGR" = "dnf" ]; then
        dnf config-manager --set-enabled powertools 2>/dev/null || dnf config-manager --set-enabled crb 2>/dev/null || true
        sed -i 's#^baseurl=.*mirrorlist.*#baseurl=https://mirrors.aliyun.com/centos-stream/$stream/BaseOS/$basearch/os/#g' /etc/yum.repos.d/*.repo 2>/dev/null || true
        # 阿里云镜像（CentOS/RHEL 通用写法）
        if [ -f /etc/yum.repos.d/CentOS-Linux-*.repo ] || [ -f /etc/yum.repos.d/centos*.repo ]; then
          for f in /etc/yum.repos.d/CentOS-Linux-*.repo /etc/yum.repos.d/centos*.repo; do
            [ -e "$f" ] || continue
            sed -i 's|^mirrorlist=|#mirrorlist=|g; s|^#baseurl=http://mirror.centos.org|baseurl=https://mirrors.aliyun.com/centos|g' "$f"
          done
        fi
        $PKG_UPDATE
      else
        sed -i 's|^mirrorlist=|#mirrorlist=|g; s|^#baseurl=http://mirror.centos.org|baseurl=https://mirrors.aliyun.com/centos|g' /etc/yum.repos.d/CentOS-*.repo 2>/dev/null || true
        $PKG_UPDATE
      fi
      ;;
    *)
      # zypper/pacman/apk 等：跳过换源，直接用默认
      echo "    （当前发行版使用默认源）"
      ;;
  esac
}
step_start "配置国内软件源（清华 / 阿里云）"
configure_mirror
step_done "配置国内软件源（清华 / 阿里云）"

###########################################################
# 阶段 2/11：交互设置（域名 / 安装目录 / 端口 / 管理员密码）
# 功能    ：安装前收集部署参数，密码以 * 号回显、二次确认；
#           迁移模式（install_data.sh）会从包内 .env 读取原配置作为默认值
# 出错排查：输入值会立即校验；密码至少 6 位且两次一致
###########################################################
step_start "交互设置（域名 / 安装目录 / 端口 / 管理员密码）"

# 迁移模式：从数据包内 .env 读取旧配置，作为交互默认值（回车沿用）
OLD_DOMAIN=""
OLD_PORT=""
if [ "$DATA_MODE" = "1" ] && [ -f "$SCRIPT_DIR/$PKG_NAME" ]; then
  TMP_ENV="/tmp/qmlpars_env_check"
  rm -rf "$TMP_ENV"; mkdir -p "$TMP_ENV"
  tar xzf "$SCRIPT_DIR/$PKG_NAME" -C "$TMP_ENV" ./.env 2>/dev/null || true
  if [ -f "$TMP_ENV/.env" ]; then
    OLD_PORT="$(grep '^PORT=' "$TMP_ENV/.env" | tail -1 | sed 's/^PORT=//' | tr -d '\r\n ')"
    OLD_BASE="$(grep '^BASE_URL=' "$TMP_ENV/.env" | tail -1 | sed 's/^BASE_URL=//' | tr -d '\r\n ')"
    OLD_DOMAIN="$(echo "$OLD_BASE" | sed 's#^https\?://##; s#/.*##; s#\r##g')"
    echo "==> 迁移模式：检测到原配置 域名=${OLD_DOMAIN:-无}  端口=${OLD_PORT:-无}"
  fi
  rm -rf "$TMP_ENV"
fi

# 交互终端判断：非 TTY（面板/管道执行）时全部使用默认值，避免卡死
TTY_OUT=/dev/tty
[ -w /dev/tty ] || TTY_OUT=/dev/stderr

if [ ! -t 0 ]; then
  echo
  echo "==> 检测到非交互终端，将使用默认配置（如需自定义请用 SSH 终端执行）"
  DOMAIN="${OLD_DOMAIN:-qmlpars.local}"
  HOME_DIR="/wwwroot/qmlpars"
  PORT="${OLD_PORT:-7081}"
  ADMIN_PWD="admin123456"
else
  echo
  if [ "$DATA_MODE" = "1" ] && [ -n "$OLD_DOMAIN" ]; then
    read -rp "请输入访问域名或服务器IP（回车沿用原配置：${OLD_DOMAIN}）： " DOMAIN
    DOMAIN="${DOMAIN:-$OLD_DOMAIN}"
  else
    read -rp "请输入访问域名或服务器IP（不要带端口，如 qmlpars.example.com 或 1.2.3.4）： " DOMAIN
    while [ -z "$DOMAIN" ]; do
      read -rp "域名/IP 不能为空，请重新输入： " DOMAIN
    done
  fi
  echo "==> 访问域名/IP：$DOMAIN"

  DEFAULT_HOME="/wwwroot/qmlpars"
  read -rp "请输入安装目录 [默认 $DEFAULT_HOME]： " HOME_DIR
  HOME_DIR="${HOME_DIR:-$DEFAULT_HOME}"
  echo "==> 安装目录：$HOME_DIR"

  PORT_DEF="${OLD_PORT:-7081}"
  PORT=""
  read -rp "请输入内部监听端口 [默认 $PORT_DEF]： " PORT
  PORT="${PORT:-$PORT_DEF}"
  while ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; do
    PORT_DEF="${OLD_PORT:-7081}"
    read -rp "端口必须是 1-65535 的数字，请重新输入 [默认 $PORT_DEF]： " PORT
    PORT="${PORT:-$PORT_DEF}"
  done
  echo "==> 内部监听端口：$PORT"

  # 交互式设置管理员初始密码（* 号回显；提示/星号直写终端，避免被命令替换吞掉）
  read_admin_password() {
    local prompt="$1" char pass=""
    while true; do
      pass=""
      printf '%s' "$prompt" >"$TTY_OUT"
      while IFS= read -r -s -n1 char; do
        if [ -z "$char" ]; then
          break
        elif [ "$char" = $'\177' ] || [ "$char" = $'\b' ]; then
          if [ -n "$pass" ]; then pass="${pass%?}"; printf '\b \b' >"$TTY_OUT"; fi
        else
          pass+="$char"; printf '*' >"$TTY_OUT"
        fi
      done
      echo >"$TTY_OUT"
      if [ ${#pass} -lt 6 ]; then
        echo "!! 密码至少 6 位，请重新输入" >"$TTY_OUT"
        continue
      fi
      ADMIN_PWD="$pass"
      return 0
    done
  }
  read_admin_password '请设置管理员登录密码（至少6位，输入以 * 代替）： '
  ADMIN_PWD1="$ADMIN_PWD"
  read_admin_password '再次确认密码： '
  ADMIN_PWD2="$ADMIN_PWD"
  while [ "$ADMIN_PWD1" != "$ADMIN_PWD2" ]; do
    echo "!! 两次输入不一致，请重新输入" >"$TTY_OUT"
    read_admin_password '请设置管理员登录密码（至少6位）： '
    ADMIN_PWD1="$ADMIN_PWD"
    read_admin_password '再次确认密码： '
    ADMIN_PWD2="$ADMIN_PWD"
  done
fi
step_done "交互设置（域名 / 安装目录 / 端口 / 管理员密码）"

echo "==> 安装目录：$HOME_DIR"
echo "==> 访问地址标识：$DOMAIN"
echo "==> 内部监听端口：$PORT"

###########################################################
# 阶段 3/11：解压安装包到安装目录
# 功能    ：优先用同目录 qmlpars.tar.gz（本地），其次同目录源码，最后联网下载
# 出错排查：tar 包缺失/损坏 -> 检查同目录是否有 qmlpars.tar.gz
#           权限不足 -> 用 root 执行本脚本
###########################################################
step_start "解压安装包到 $HOME_DIR"
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
  # github 为主，gitee 为辅：依次尝试下载，任一成功即止
  PKG_URL_GITHUB="${QMLPARS_PKG_URL:-https://github.com/djrolin2023/qmlpars/releases/latest/download/$PKG_NAME}"
  PKG_URL_GITEE="https://gitee.com/dj_rolin/qmlpars/releases/download/latest/$PKG_NAME"
  TMP_PKG="/tmp/$PKG_NAME"
  DL_OK=0
  for PKG_URL in "$PKG_URL_GITHUB" "$PKG_URL_GITEE"; do
    echo "==> 尝试下载安装包： $PKG_URL"
    if command -v wget >/dev/null 2>&1; then
      wget -q -O "$TMP_PKG" "$PKG_URL" && DL_OK=1 && break
    else
      curl -fsSL -o "$TMP_PKG" "$PKG_URL" && DL_OK=1 && break
    fi
    echo "    !! 该源下载失败，尝试下一个源..."
  done
  if [ "$DL_OK" -ne 1 ]; then
    echo "!! 安装包（Release tar）下载失败，自动回退到 git clone 源码..."
    # 回退：直接从 GitHub / Gitee 克隆源码到安装目录（无需预打包 tar）
    GIT_OK=0
    rm -rf "$HOME_DIR"
    mkdir -p "$HOME_DIR"
    for GIT_URL in "https://github.com/djrolin2023/qmlpars.git" "https://gitee.com/dj_rolin/qmlpars.git"; do
      echo "==> 尝试 git clone 源码： $GIT_URL"
      if command -v git >/dev/null 2>&1; then
        if git clone --depth 1 "$GIT_URL" "$HOME_DIR" 2>/dev/null; then
          GIT_OK=1
          # 把 clone 下来的仓库内容作为源码根（仓库根即项目根）
          SRC_DIR="$HOME_DIR"
          break
        fi
      else
        echo "    !! 未检测到 git 命令，无法 clone 源码"
      fi
      echo "    !! 该源克隆失败，尝试下一个源..."
    done
    if [ "$GIT_OK" -ne 1 ]; then
      echo "!! 安装包下载与 git clone 均失败（github / gitee 均不可达），请检查网络后重试。"
      echo "   也可手动 clone 后进入目录执行： bash install.sh"
      exit 1
    fi
    echo "==> 已从源码仓库克隆成功，跳过 tar 解压"
  else
    rm -rf "$HOME_DIR"
    mkdir -p "$HOME_DIR"
    tar xzf "$TMP_PKG" -C "$HOME_DIR"
    SRC_DIR="$HOME_DIR"
    rm -f "$TMP_PKG"
  fi
fi
step_done "解压安装包到 $HOME_DIR"

# 修正权限
chmod 755 "$SRC_DIR" 2>/dev/null || true
chmod 644 "$SRC_DIR/.env.example" 2>/dev/null || true
# 确保运行时目录存在（git clone 的仓库不含 data/ uploads/）
mkdir -p "$SRC_DIR/data" "$SRC_DIR/uploads/assets" 2>/dev/null || true
chmod -R u+rwX,g+rX,o+rX "$SRC_DIR/data" "$SRC_DIR/uploads" "$SRC_DIR/uploads/assets" 2>/dev/null || true
chmod -R u+rwX,g+rX,o+rX "$SRC_DIR"/*.js "$SRC_DIR"/*.json "$SRC_DIR"/start.sh "$SRC_DIR"/install.sh "$SRC_DIR"/qm 2>/dev/null || true

# 生成 .env（若不存在则用 .env.example 复制）
if [ ! -f "$SRC_DIR/.env" ]; then
  if [ -f "$SRC_DIR/.env.example" ]; then
    cp "$SRC_DIR/.env.example" "$SRC_DIR/.env"
  else
    touch "$SRC_DIR/.env"
  fi
fi
chmod 600 "$SRC_DIR/.env" 2>/dev/null || true

# 把域名、端口写入 .env
set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$SRC_DIR/.env" 2>/dev/null; then
    sed -i "s#^${key}=.*#${key}=${val}#" "$SRC_DIR/.env"
  else
    echo "${key}=${val}" >> "$SRC_DIR/.env"
  fi
}
set_env BASE_URL "https://$DOMAIN"
set_env PORT "$PORT"
set_env ADMIN_USERNAME "admin"

###########################################################
# 阶段 4/11：安装 Node.js（≥ 18，脚本内置 22）
# 功能    ：系统无 node 或版本 <18 时自动安装（nodesource 官方源）
# 安卓 APP 打包硬性要求：Node.js ≥ 18（Capacitor 6 要求）
# 出错排查：安装失败 -> 检查网络是否能访问 nodesource.com
###########################################################
step_start "安装 Node.js（≥ 18，脚本内置 22）"
need_node=0
if ! command -v node >/dev/null 2>&1; then need_node=1
else
  NODE_VER="$(node -v | sed 's/v//;s/\..*//')"
  [ "$NODE_VER" -lt 18 ] && need_node=1
fi
if [ "$need_node" -eq 1 ]; then
  echo "==> 安装 Node.js 22 ..."
  case "$PKG_MGR" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
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
step_done "安装 Node.js 22"

# 探测 node 绝对路径（供 systemd ExecStart 使用，兼容 /usr/bin 与 /usr/local/bin）
NODE_BIN="$(command -v node)"
[ -z "$NODE_BIN" ] && NODE_BIN="/usr/local/bin/node"

###########################################################
# 阶段 5/11：安装 npm 依赖（务必在生成密码哈希之前）
# 功能    ：先装编译工具（better-sqlite3 需本地编译），再 npm install
# 出错排查：npm install 失败 -> 看上方错误，检查网络 / 编译环境（g++/make/python3）
###########################################################
step_start "安装编译依赖与 npm 依赖"
# better-sqlite3 在新机器上可能需要本地编译，先装编译工具
echo "==> 安装编译依赖（better-sqlite3 可能需要本地编译）..."
case "$PKG_MGR" in
  apt) $PKG_INSTALL -y python3 make g++ build-essential >/dev/null 2>&1 || true ;;
  dnf|yum) $PKG_INSTALL -y python3 make gcc-c++ >/dev/null 2>&1 || true ;;
  zypper) $PKG_INSTALL -y python3 make gcc-c++ >/dev/null 2>&1 || true ;;
  pacman) $PKG_INSTALL -y python make gcc >/dev/null 2>&1 || true ;;
  apk) $PKG_INSTALL -y python3 make g++ >/dev/null 2>&1 || true ;;
esac

echo "==> 安装 npm 依赖 ..."
cd "$SRC_DIR"
npm install --omit=dev || { echo "!! npm install 失败，请检查网络或编译环境"; exit 1; }
step_done "安装编译依赖与 npm 依赖"

###########################################################
# 阶段 6/11：设置管理员密码（生成哈希写入 .env）
# 功能    ：用 auth.js 的 hashPassword 生成哈希，防空校验 + 最多重试 3 次
# 出错排查：提示"无法生成密码哈希" -> 检查 node 可执行、auth.js 存在
###########################################################
step_start "设置管理员密码"
echo "==> 生成管理员密码哈希并写入 .env ..."
for i in 1 2 3; do
  ADMIN_HASH="$($NODE_BIN -e "const {hashPassword}=require('./auth'); process.stdout.write(hashPassword(process.argv[1]))" "$ADMIN_PWD" 2>/dev/null || true)"
  if [ -n "$ADMIN_HASH" ] && echo "$ADMIN_HASH" | grep -q ':'; then break; fi
  echo "!! 第 $i 次生成哈希失败，重试..."
  sleep 1
done
if [ -z "$ADMIN_HASH" ] || ! echo "$ADMIN_HASH" | grep -q ':'; then
  echo "!! 无法生成密码哈希（auth 模块异常），安装中止。"
  exit 1
fi
# 清空明文（若有），写入哈希
sed -i '/^ADMIN_PASSWORD=/d' "$SRC_DIR/.env" 2>/dev/null || true
set_env ADMIN_PASSWORD_HASH "$ADMIN_HASH"
echo "==> 管理员密码已设置（登录 /admin 使用你刚才输入的密码）"
step_done "设置管理员密码"

###########################################################
# 阶段 7/11：安装 qm 命令行控制面板
# 功能    ：把 qm 脚本装到 /usr/local/bin/qm，注入安装目录
# 出错排查：提示"未找到 qm 脚本" -> 检查 tar 包内是否含 qm 文件
###########################################################
step_start "安装 qm 命令行控制面板"
echo "==> 安装 qm 命令行控制面板 ..."
if [ -f "$SRC_DIR/qm" ]; then
  install -m 755 "$SRC_DIR/qm" /usr/local/bin/qm
  # 让 qm 知道安装目录
  sed -i "s#^QMLPARS_HOME=.*#QMLPARS_HOME=\"$SRC_DIR\"#" /usr/local/bin/qm 2>/dev/null || true
  echo "==> qm 命令已安装，终端输入 qm 即可管理本系统"
else
  echo "!! 未找到 qm 脚本，跳过（不影响服务运行）"
fi
step_done "安装 qm 命令行控制面板"

###########################################################
# 阶段 8/11：注册 systemd 服务并启动后端
# 功能    ：写入 qmlpars.service，设置开机自启，用 env -i 隔离环境启动
# 出错排查：启动失败 -> journalctl -u qmlpars -n 50 查看日志
#           确认 node 路径正确、node_modules 已装
###########################################################
step_start "注册系统服务并启动后端"
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
ExecStart=/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root ${NODE_BIN} ${SRC_DIR}/index.js
Restart=always
RestartSec=3
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
step_done "注册系统服务并启动后端"

# 阶段 8.5/11：安卓构建链（函数定义见下方「install_android_chain」）
install_android_chain

###########################################################
# 阶段 9/11：安装 nginx 并配置 HTTPS / 证书自动续期
# 功能    ：配置反向代理；域名模式自动申请 Let's Encrypt 证书，
#           启用 certbot.timer + 每日 cron 兜底续期；IP 模式仅 HTTP
# 出错排查：证书申请失败 -> 域名需先解析到本机、80 端口需对外开放
#           nginx 配置错误 -> nginx -t 查看，配置在 /etc/nginx/conf.d/qmlpars.conf
###########################################################
step_start "安装 nginx 并配置 HTTPS / 证书续期"
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

if echo "$DOMAIN" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
  IS_IP=1
else
  IS_IP=0
fi

NGINX_CONF="/etc/nginx/conf.d/${SERVICE_NAME}.conf"

# 先写 http 反代配置（证书申请依赖 80 端口可达）
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

nginx -t && systemctl reload nginx || systemctl restart nginx

if [ "$IS_IP" -eq 1 ]; then
  echo "==> 检测到 IP 模式：仅 HTTP 反代，不申请证书"
  echo "    如需 HTTPS，可将证书放到 /etc/ssl/qmlpars/ 后手动修改 $NGINX_CONF"
else
  echo "==> 域名模式：尝试自动申请 Let's Encrypt 证书"
  CUSTOM_CRT="/etc/ssl/qmlpars/fullchain.pem"
  CUSTOM_KEY="/etc/ssl/qmlpars/privkey.pem"
  if [ -f "$CUSTOM_CRT" ] && [ -f "$CUSTOM_KEY" ]; then
    echo "==> 检测到自定义证书，使用自定义证书配置 HTTPS"
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
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@${DOMAIN} --redirect; then
      echo "==> Let's Encrypt 证书申请成功 ✓"
    else
      echo "!! 自动申请失败（可能域名未解析到本机 / 80端口未开放）。已保留 HTTP 反代，可稍后手动执行："
      echo "   certbot --nginx -d $DOMAIN"
    fi
  fi

  # 配置证书自动续期（certbot 自带 timer，这里再显式确保并加入兜底 cron）
  echo "==> 配置证书自动续期 ..."
  systemctl enable certbot.timer 2>/dev/null || true
  systemctl start certbot.timer 2>/dev/null || true
  # 兜底：crontab 每日尝试续期（certbot 仅在临近到期时才真正更新）
  ( crontab -l 2>/dev/null | grep -v 'certbot renew' ; echo "0 3 * * * certbot renew --quiet --nginx && systemctl reload nginx" ) | crontab -
  echo "==> 证书续期已配置（certbot.timer + 每日 3:00 cron 兜底）"
fi

nginx -t && systemctl reload nginx || systemctl restart nginx
step_done "安装 nginx 并配置 HTTPS / 证书续期"

# 探测最终访问协议（有证书则为 https）
PROTO="http"
if [ "$IS_IP" -eq 0 ] && [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  PROTO="https"
fi

###########################################################
# 阶段 10/11：生成安装信息中文面板
# 功能    ：汇总显示访问地址 / 账号 / 端口 / 目录等关键信息
###########################################################
step_start "生成安装信息面板"
echo ""
echo "============================================================"
echo "  QianMing 车牌识别系统 安装完成"
if [ "$DATA_MODE" = "1" ]; then
  echo "  （迁移模式：原有数据与配置已导入）"
fi
echo "============================================================"
echo "  引导页     : ${PROTO}://${DOMAIN}/"
echo "  前台识别页 : ${PROTO}://${DOMAIN}/cpsb"
echo "  后台管理   : ${PROTO}://${DOMAIN}/admin"
echo "  管理员账号 : admin"
echo "  管理员密码 : (你安装时设置的密码，本处不显示)"
echo "  监听端口   : ${PORT}"
echo "  安装目录   : ${SRC_DIR}"
echo "  数据目录   : ${SRC_DIR}/data"
echo ""
echo "  后端日志   : journalctl -u ${SERVICE_NAME} -f"
echo "  nginx 日志 : tail -f /var/log/nginx/access.log"
echo "  管理命令   : 终端输入 qm 打开控制面板"
echo "              （改密码 / 改端口 / 重启服务等）"
echo "============================================================"
echo " 提示：车牌识别需在后台「系统设置」填写百度或腾讯 OCR 密钥后方可使用。"
echo ""
step_done "生成安装信息面板"
echo "所有步骤已完成，系统可正常使用。"
