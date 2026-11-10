#!/data/data/com.termux/files/usr/bin/bash
# dsh 守护：前台等子进程退出，记下退出码再拉起
# 用途：先分清是自杀（自己崩）还是他杀（被信号打死），否则永远查不出死因
# so: 之前只用 & 丢在后台，退出码全丢了，26 次无声死亡一个线索都没留下

cd "$(dirname "$0")/.." || exit 1

LOG="$HOME/.local/share/dsh/serve.log"
LOGMAX=$((5 * 1024 * 1024))
PORT=25715
# 优先用编译好的单文件二进制：它的 cmdline 里只有自身路径
# 源代码跑法 cmdline 含脚本名，别的会话 pkill -f 撞子串就会被连带打死
# so: 历史上 dshboot.js 被 pkill -f "boot[.]js" 误杀过多次，改名躲不掉子串重叠
# so: PREFIX 在 setsid 环境里可能没导出，这里给个硬兜底，别让守护静默降级回源码跑法
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
SVC="$PREFIX/bin/dshsvc"
if [ ! -x "$SVC" ]; then
  SVC=""
fi

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
  START=$(date '+%m-%d %H:%M:%S')
  # 二进制缺失时退回源码跑法，至少还能起来，只是没免疫 pkill
  if [ -n "$SVC" ]; then
    echo "[keep] $START 启动 $SVC" >> "$LOG"
    # -w 等子进程退出并透传退出码，这是唯一能区分他杀与自杀的办法
    DSHROOT="$PWD" setsid -w "$SVC" >> "$LOG" 2>&1 < /dev/null
  else
    echo "[keep] $START 启动 bun dshboot.js（未编译，pkill 不免疫）" >> "$LOG"
    setsid -w bun dshboot.js >> "$LOG" 2>&1 < /dev/null
  fi
  RC=$?
  echo "[keep] $(date '+%m-%d %H:%M:%S') 退出码 $RC：$(desc $RC)，2 秒后重启" >> "$LOG"
  sleep 2
done
