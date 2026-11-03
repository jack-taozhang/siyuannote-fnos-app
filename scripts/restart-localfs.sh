#!/bin/sh
# 只重启 local-fs 子进程（不动思源内核与反代）—— 用于热更新 local-fs.py 后生效。
# 环境变量照抄 /var/apps/siyuannote/cmd/main 的 start_local_fs()。
set -u
APP=/vol1/@appcenter/siyuannote
VAR=/vol1/@appdata/siyuannote
PIDF=$VAR/local-fs.pid
LOG=$VAR/app.log

PID=$(cat "$PIDF" 2>/dev/null || echo "")
if [ -n "$PID" ]; then
  kill -TERM "$PID" 2>/dev/null || true
  i=0
  while [ $i -lt 12 ] && kill -0 "$PID" 2>/dev/null; do sleep 0.5; i=$((i+1)); done
  kill -0 "$PID" 2>/dev/null && kill -KILL "$PID" 2>/dev/null || true
fi
rm -f "$PIDF"

cd /
export LOCAL_FS_PORT=8021
export LOCAL_FS_OO_URL=http://127.0.0.1:8082
export LOCAL_FS_OO_SECRET=
export LOCAL_FS_OO_SAME_ORIGIN=/localfs/oo-srv

nohup setsid /usr/bin/python3 "$APP/local-fs.py" "$PIDF" >> "$LOG" 2>&1 < /dev/null &

i=0
while [ $i -lt 40 ]; do
  if [ -s "$PIDF" ] && ss -lnt 2>/dev/null | grep -q ':8021 '; then break; fi
  sleep 0.5
  i=$((i+1))
done
echo "pid=$(cat "$PIDF" 2>/dev/null)"
ss -lnt | grep ':8021 ' || echo "NOT LISTENING"
