#!/bin/bash
# 启动/守护 jyedu Node 服务（解决 LD_LIBRARY_PATH 被 CodeBuddy 等工具污染导致 node 启动崩溃的问题）
# 使用：在群晖 DSM 任务计划里设置为每 5 分钟运行一次：
#   bash /volume1/web/jyedu/start.sh
# 也可手动运行。

APP_DIR="/volume1/web/jyedu"
PORT="7081"
LOG_FILE="$APP_DIR/nohup.out"

# 检查是否已在监听指定端口
is_running() {
  (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -q ":$PORT "
}

# 杀掉已有的 node index.js 进程（避免重复启动）
stop_existing() {
  pkill -f "node $APP_DIR/index.js" 2>/dev/null
  sleep 1
}

if is_running; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 服务已在 $PORT 端口运行，无需启动。"
  exit 0
fi

stop_existing

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 未检测到服务，正在启动..."

# 关键：用 env -i 清空环境变量，只保留最小 PATH，避免 LD_LIBRARY_PATH 污染导致 libstdc++ 不兼容
env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="/root" \
  bash -lc "cd $APP_DIR && nohup node index.js > $LOG_FILE 2>&1 & disown"

sleep 3
if is_running; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动成功。"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动失败，请查看 $LOG_FILE。"
  exit 1
fi
