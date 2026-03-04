#!/bin/bash
# 单实例守护启动脚本
LOCKFILE="/tmp/antigravity-trading.lock"
PIDFILE="/tmp/antigravity-trading.pid"
LOGFILE="/home/botdrop/data/antigravity.log"

# 检查是否已有实例
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "已有实例运行中 (PID=$OLD_PID)，不重复启动"
        exit 0
    fi
fi

# 杀掉所有旧进程（防残留）
pkill -f "antigravity-trading.js" 2>/dev/null
sleep 1

# 启动新进程
cd /home/botdrop
nohup node --max-old-space-size=256 antigravity-trading.js >> "$LOGFILE" 2>&1 &
NEW_PID=$!
echo $NEW_PID > "$PIDFILE"
echo "✅ 已启动 (PID=$NEW_PID)"
