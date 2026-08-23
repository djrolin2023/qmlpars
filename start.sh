#!/usr/bin/env bash
# 车牌识别系统 - 服务启动/守护脚本（跨平台，依赖 pm2）
# 用法:
#   启动 / 重启:  bash start.sh
#   停止:          pm2 stop qmlpars
#   查看:          pm2 list
#   开机自启:      bash start.sh --enable-boot   (需 root，写入 systemd)
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PM2_BIN="$(command -v pm2 || echo /usr/local/bin/pm2)"
export PM2_HOME="${PM2_HOME:-/root/.pm2}"
# 清掉可能由 IDE/远程终端注入的、与本机 node 不兼容的库路径
unset LD_LIBRARY_PATH

cd "$APP_DIR"

if [ "$1" = "--enable-boot" ]; then
  # 仅当系统是 systemd 时写入开机单元（Linux 通用，不限于群晖）
  if [ -d /etc/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    UNIT=/etc/systemd/system/qmlpars.service
    cat > "$UNIT" <<EOF
[Unit]
Description=车牌识别系统 (qmlpars)
After=network.target

[Service]
Type=forking
Environment=PM2_HOME=$PM2_HOME
ExecStart=$PM2_BIN resurrect
ExecReload=$PM2_BIN reload all
ExecStop=$PM2_BIN kill
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable qmlpars.service
    echo "已写入并启用 systemd 开机单元: $UNIT"
  else
    echo "当前系统非 systemd，未写入开机单元。请在系统自带的'开机/登录任务'中执行: bash $APP_DIR/start.sh"
  fi
  exit 0
fi

# 确保 pm2 守护在运行并启动本项目
"$PM2_BIN" start index.js --name qmlpars --cwd "$APP_DIR" || "$PM2_BIN" restart qmlpars
"$PM2_BIN" save
echo "qmlpars 已在 pm2 中运行 (PM2_HOME=$PM2_HOME)"
