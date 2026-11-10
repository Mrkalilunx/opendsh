#!/usr/bin/env bash
# dsh 守护：前台等子进程退出，记下退出码再拉起
# 用途：先分清是自杀（自己崩）还是他杀（被信号打死），否则永远查不出死因
# so: 之前只用 & 丢在后台，退出码全丢了，26 次无声死亡一个线索都没留下
#
# 启动方式由外部决定，脚本本身不认识任何具体产物：
#   DSHSTART="命令"   要守护的完整启动命令，默认 bun dshboot.js
#   DSHPORT=端口      探活用，默认 25715
# 想用编译成单文件的形式，自己编译完这样起：
#   DSHSTART=/你的路径/产物名 DSHROOT="$PWD" bash srv/keeplive.sh
# so: 二进制叫什么、放哪儿是每台机器自己的事，写进仓库就等于把私有约定强加给别人

cd "$(dirname "$0")/.." || exit 1

LOG="$HOME/.local/share/dsh/serve.log"
LOGMAX=$((5 * 1024 * 1024))
PORT="${DSHPORT:-25715}"
STARTUP="${DSHSTART:-bun dshboot.js}"

# 日志只留最近 5MB：追加写久了会无限涨，反过来拖慢启动
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$LOGMAX" ]; then
  tail -c $((LOGMAX / 2)) "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# 退出码翻译成人话：128+N 是信号 N，其余是进程自己返回
desc() {
  case "$1" in
    137) echo "SIGKILL 9（外部强杀，不可拦截）" ;;
    143) echo "SIGTERM 15（正常终止请求）" ;;
    130) echo "SIGINT 2（Ctrl+C）" ;;
    129) echo "SIGHUP 1（终端挂断）" ;;
    139) echo "SIGSEGV 11（段错误，自己崩）" ;;
    134) echo "SIGABRT 6（abort）" ;;
    0)   echo "正常退出" ;;
    *)   echo "返回码 $1" ;;
  esac
}

while true; do
  # 先探活再启动：端口已有人服务就去睡，否则会和已有实例抢端口
  # so: 少了这一步，只要端口上有实例，就会 EADDRINUSE 退出再拉起，每 2 秒空转一次
  if curl -s -m 3 -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; then
    sleep 15
    continue
  fi
  echo "[keep] $(date '+%m-%d %H:%M:%S') 启动 $STARTUP" >> "$LOG"
  # -w 等子进程退出并透传退出码，这是唯一能区分他杀与自杀的办法
  # 用 sh -c 包一层，启动命令里带引号、带变量都能原样传下去
  setsid -w sh -c "$STARTUP" >> "$LOG" 2>&1 < /dev/null
  RC=$?
  echo "[keep] $(date '+%m-%d %H:%M:%S') 退出码 $RC：$(desc "$RC")，2 秒后重启" >> "$LOG"
  sleep 2
done
