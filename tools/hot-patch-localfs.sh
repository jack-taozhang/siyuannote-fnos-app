#!/bin/bash
#
# 只热补 siyuannote 应用的 app/local-fs.py，并**只重启本机文件服务进程**
# ---------------------------------------------------------------------------
# 与 hot-patch-proxy.sh 同一套路：备份 → 传 //tmp → sudo cp → md5 双向核对 →
# 才按 cmd/main 的原样环境变量把那个进程换掉。内核、反向代理一动不动
# （重启整个应用会连带重启思源内核，正在用的人会掉线）。
#
# 环境变量照抄 /proc/<pid>/environ 里那份（cmd/main 的 start_local_fs）：
#   LOCAL_FS_PORT=8021
#   LOCAL_FS_OO_URL / LOCAL_FS_OO_SECRET
#   LOCAL_FS_OO_SAME_ORIGIN（OnlyOffice 同源通道，见 cmd/main / reverse-proxy.py）
#   ★ 不再有 LOCAL_FS_STATIC —— 内置图纸查看器（app/local-fs-dist/）已删除，
#     本服务现在只提供 /api/*，根路径一律 404；CAD 预览改走飞牛原生「CAD 看图」
#     应用（反代的 /localfs/cad/* 通道）。
#
# 用法：bash tools/hot-patch-localfs.sh
set -u

# ★ 口令只从环境变量读，不写默认值（公开仓库不能带明文口令）★
if [ -z "${NAS_PW:-}" ]; then
  echo "缺少环境变量 NAS_PW。请这样跑：NAS_PW='你的口令' bash $0" >&2
  exit 2
fi
export NAS_PW

TOOLS="D:/Docker/siyuan-nebuladisk/tools"
PY="C:/Users/HP/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
SRC="C:/Users/HP/WorkBuddy/2026-10-08-07-43-01/siyuannote/fnos-package/app/local-fs.py"

APPROOT="/vol1/@appcenter/siyuannote"
PKGVAR="/vol1/@appdata/siyuannote"
LOCAL_FS_PORT=8021
OO_URL="http://127.0.0.1:8082"
OO_SECRET="nebula-oo-secret-change-me"

say() { echo "── $1"; }
md5local() { md5sum "$1" | awk '{print $1}'; }

cd "$TOOLS" || exit 1

# ── 0. 备份 ────────────────────────────────────────────────────
say "0. 备份远端 local-fs.py"
"$PY" nbssh.py --sudo 'B=/tmp/sylocalfs-bak-$(date +%Y%m%d-%H%M%S); mkdir -p "$B"
cp -a '"$APPROOT"'/local-fs.py "$B/" 2>/dev/null || true
echo "备份：$B"; ls -la "$B"' 2>&1 | tail -4

# ── 1. 上传 ────────────────────────────────────────────────────
say "1. 上传到 //tmp/"
"$PY" nbssh.py --put "$SRC" "//tmp/nb-local-fs.py" 644 >/dev/null 2>&1 \
  || { echo "✗ 上传失败"; exit 1; }
echo "   ↑ nb-local-fs.py ($(md5local "$SRC"))"

# ── 2. 落位 ────────────────────────────────────────────────────
say "2. 安装到应用目录"
"$PY" nbssh.py --sudo 'set -e
cp /tmp/nb-local-fs.py '"$APPROOT"'/local-fs.py
chown root:root '"$APPROOT"'/local-fs.py
chmod 755 '"$APPROOT"'/local-fs.py
rm -f /tmp/nb-local-fs.py
echo 已落位' 2>&1 | tail -3

# ── 3. md5 双向核对（不一致就**不重启**）───────────────────────
say "3. md5 双向核对"
L="$(md5local "$SRC")"
R="$("$PY" nbssh.py --sudo "md5sum '$APPROOT/local-fs.py' | awk '{print \$1}'" 2>/dev/null | tr -d '\r\n ')"
if [ "$L" != "$R" ]; then
  echo "   ✗ 本地=$L 远端=$R —— 不一致，停止，不重启"
  exit 1
fi
echo "   ✓ local-fs.py  $L"

# ── 3.5 语法自检（远端解释器编译一遍，别拿语法错去换进程）──────
say "3.5 远端语法自检"
"$PY" nbssh.py --sudo "/usr/bin/python3 -m py_compile '$APPROOT/local-fs.py' && echo '   ✓ py_compile 通过'" 2>&1 | tail -3

# ── 4. 只重启文件服务进程（内核/代理不动）─────────────────────
say "4. 重启本机文件服务进程"
"$PY" nbssh.py --sudo 'set -u
PIDF='"$PKGVAR"'/local-fs.pid
P="$(head -n 1 "$PIDF" 2>/dev/null | tr -d "[:space:]")"
if [ -n "$P" ] && [ -r "/proc/$P/cmdline" ] && grep -qa "local-fs" "/proc/$P/cmdline"; then
  echo "   停止旧进程 pid=$P"
  kill -TERM "$P" 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ] && kill -0 "$P" 2>/dev/null; do sleep 0.5; i=$((i+1)); done
  kill -0 "$P" 2>/dev/null && kill -KILL "$P" 2>/dev/null || true
else
  echo "   （PID 文件无效，按 cmdline 兜底找残留）"
  for q in $(pgrep -f "[l]ocal-fs.py" 2>/dev/null); do kill -TERM "$q" 2>/dev/null || true; done
  sleep 1
fi
rm -f "$PIDF"
# 等端口真的空出来，否则新进程会 bind 失败
i=0
while [ "$i" -lt 20 ] && (ss -ltn 2>/dev/null | grep -q ":8021 "); do sleep 0.5; i=$((i+1)); done

export LOCAL_FS_PORT="'"$LOCAL_FS_PORT"'"
export LOCAL_FS_OO_URL="'"$OO_URL"'"
export LOCAL_FS_OO_SECRET="'"$OO_SECRET"'"
export LOCAL_FS_OO_SAME_ORIGIN="/localfs/oo-srv"
# 仅用于联调同源通道：LOCAL_FS_OO_SAME_ORIGIN_ALWAYS=1 bash tools/hot-patch-localfs.sh
export LOCAL_FS_OO_SAME_ORIGIN_ALWAYS="'"${LOCAL_FS_OO_SAME_ORIGIN_ALWAYS:-0}"'"

cd /
nohup setsid /usr/bin/python3 '"$APPROOT"'/local-fs.py "$PIDF" \
  >> '"$PKGVAR"'/app.log 2>&1 < /dev/null &
i=0
while [ "$i" -lt 30 ] && [ ! -s "$PIDF" ]; do sleep 0.5; i=$((i+1)); done
sleep 0.4
NP="$(head -n 1 "$PIDF" 2>/dev/null | tr -d "[:space:]")"
echo "   新进程 pid=${NP:-<没有写 pid 文件>}"' 2>&1 | tail -8

# ── 5. 自检 ────────────────────────────────────────────────────
say "5. 自检"
sleep 1
"$PY" nbssh.py --sudo 'set -u
echo -n "   8021 监听："; (ss -ltn 2>/dev/null | grep -q ":8021 " && echo 是) || echo "否（注意检查）"
echo -n "   直连 /api/health -> "; curl -s -m 5 http://127.0.0.1:8021/api/health; echo
echo -n "   同源 /localfs/api/health -> "; curl -s -m 5 http://127.0.0.1:6806/localfs/api/health; echo
echo -n "   ★ 根路径 / 必须是 404 NO_PAGE（本服务只提供 API，没有页面）-> "
curl -s -m 5 -o /tmp/_root -w "code=%{http_code} " http://127.0.0.1:8021/
grep -o "NO_PAGE" /tmp/_root || echo "✗ 没看到 NO_PAGE"; rm -f /tmp/_root
echo -n "   ★ 数据面 /api/list 仍在（应 200）-> "
curl -s -m 8 -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8021/api/list?path=/"
echo -n "   ★ 内置查看器产物已删（local-fs-dist 应 ABSENT）-> "
[ -e /vol1/@appcenter/siyuannote/local-fs-dist ] && echo "✗ 还在" || echo "ABSENT ✓"
echo "   末尾日志："; tail -n 2 '"$PKGVAR"'/app.log' 2>&1 | tail -14
