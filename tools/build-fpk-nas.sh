#!/bin/bash
#
# 把工程同步到 NAS 上的打包工作区，然后打出 siyuannote 的 .fpk
# （版本号取自本地 manifest，不写死）
# ---------------------------------------------------------------------------
# ★ 为什么在 NAS 上打 ★
#   包里要塞思源内核（解压后 239MB，从正在跑的容器里提取）。就地打省掉 260MB
#   的来回搬运，而且包里的内核与正在用的那个**完全同源**，不会出现"打包用的
#   版本和你实际在跑的不是一个"。⇒ NAS 上的 kernel-dist 已经在了，所以这里
#   **不传**它、也不加 --refresh。
#
# ★ 为什么要传 local-fs.py / 反向代理 / cmd ★
#   NAS 那个工作区停留在 2.0.1：没有文件服务（local-fs.py），
#   reverse-proxy.py 与 cmd/main 也是旧的。直接打就会打出一个"没有本机存储能力"
#   的包 —— 而且因为版本号升了，装上去反而会把能用的功能覆盖掉。
#
# ★★ 2026-10-10：内置图纸查看器（local-fs-dist，22MB）已删除 ★★
#   CAD 预览改为**借用飞牛原生「CAD 看图」应用**（fnos-dwg-viewer :8020），
#   经反代的 /localfs/cad/* 同源通道 —— 与「文件预览」借 :8030 完全同构。
#   ⇒ 本脚本不再上传 local-fs-dist，而且**必须显式删掉 NAS 工作区里那份旧产物**：
#     否则 build-fpk.sh 会把残留的 22MB 一起打进包（版本号升了，没人会察觉）。
#     第 4 步有一条**反向断言**专门盯这个。
#
# 纪律：上传 //tmp → sudo 落位 → md5 双向核对 → 一致才开打。
#
# 用法：bash tools/build-fpk-nas.sh
set -u

# ★ 口令只从环境变量读，不写默认值（公开仓库不能带明文口令）★
#   用法：NAS_PW='你的口令' bash tools/build-fpk-nas.sh
if [ -z "${NAS_PW:-}" ]; then
  echo "缺少环境变量 NAS_PW。请这样跑：NAS_PW='你的口令' bash $0" >&2
  exit 2
fi
export NAS_PW

TOOLS="D:/Docker/siyuan-nebuladisk/tools"
PY="C:/Users/HP/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
SRC="C:/Users/HP/WorkBuddy/2026-10-08-07-43-01/siyuannote"
REMOTE="/vol1/1000/Docker/siyuannote"
STAGE="/tmp/sy-fpk"

say() { echo "── $1"; }
md5local() { md5sum "$1" | awk '{print $1}'; }
nb() { "$PY" "$TOOLS/nbssh.py" "$@"; }

cd "$TOOLS" || exit 1

echo "工程：$SRC"
echo "远端：$REMOTE"

# ── 0. 远端现状 ────────────────────────────────────────────────
say "0. 远端现状"
nb --sudo "grep -E '^(appname|version)=' '$REMOTE/fnos-package/manifest'; \
  ls -la '$REMOTE/release/' 2>/dev/null | tail -4; \
  echo -n 'kernel-dist: '; du -sh '$REMOTE/fnos-package/app/kernel-dist' 2>/dev/null | cut -f1" 2>&1 | tail -10

# ── 1. 上传 ────────────────────────────────────────────────────
say "1. 上传到 //tmp/$STAGE/"
nb --sudo "rm -rf $STAGE; mkdir -p $STAGE; chmod 777 $STAGE" >/dev/null 2>&1

up() {  # $1 本地文件  $2 远端名
  nb --put "$1" "//$STAGE/$2" 644 >/dev/null 2>&1 || { echo "✗ 上传失败 $1"; exit 1; }
  echo "   ↑ $2  ($(md5local "$1"))"
}
up "$SRC/fnos-package/manifest"             manifest
up "$SRC/fnos-package/app/reverse-proxy.py" reverse-proxy.py
up "$SRC/fnos-package/app/local-fs.py"      local-fs.py
up "$SRC/fnos-package/app/launch-kernel.sh" launch-kernel.sh
# ★ ui/config：飞牛客户端（含手机）打开哪个入口就靠这里的 .url["siyuannote.main"].url ★
#   手机要被修成桌面版 ⇒ 必须是 /stage/build/desktop（原值 "/" 会让手机 UA 被 302 到 mobile）
up "$SRC/fnos-package/app/ui/config"        ui_config
for f in main config_init config_callback install_init install_callback \
         uninstall_init uninstall_callback upgrade_init upgrade_callback; do
  up "$SRC/fnos-package/cmd/$f" "cmd_$f"
done
up "$SRC/scripts/build-fpk.sh"              build-fpk.sh

# ── 2. 落位 ────────────────────────────────────────────────────
say "2. 落到打包工作区"
nb --sudo "set -e
OWN=\$(stat -c '%u:%g' '$REMOTE/fnos-package/cmd')
put() { cp $STAGE/\$1 '$REMOTE'/\$2; chown \$OWN '$REMOTE'/\$2; chmod \$3 '$REMOTE'/\$2; }
put manifest             fnos-package/manifest                644
put reverse-proxy.py     fnos-package/app/reverse-proxy.py    755
put local-fs.py          fnos-package/app/local-fs.py         755
put launch-kernel.sh     fnos-package/app/launch-kernel.sh    755
put ui_config            fnos-package/app/ui/config           644
for f in main config_init config_callback install_init install_callback uninstall_init uninstall_callback upgrade_init upgrade_callback; do
  put cmd_\$f fnos-package/cmd/\$f 755
done
put build-fpk.sh         scripts/build-fpk.sh                 755
# ★★ 内置图纸查看器已删除 ⇒ 必须把 NAS 工作区里那份旧产物也清掉 ★★
#   否则它会跟着打进 FPK（22MB 死重量，而且没人会察觉 —— 版本号已经升了）。
#   第 3 步有一条反向断言盯着"它确实不在了"。
rm -rf '$REMOTE/fnos-package/app/local-fs-dist'
rm -rf $STAGE
echo '已落位：'
ls -la '$REMOTE/fnos-package/app/' | grep -E 'local-fs|reverse|launch'
grep -E '^version=' '$REMOTE/fnos-package/manifest'
echo -n 'local-fs-dist（应已不存在）: '
[ -e '$REMOTE/fnos-package/app/local-fs-dist' ] && du -sh '$REMOTE/fnos-package/app/local-fs-dist' || echo '已清理 ✓'" 2>&1 | tail -12

# ── 3. md5 双向核对（不一致就**不打包**）─────────────────────
say "3. md5 双向核对"
FAIL=0
check() {
  local l r
  l="$(md5local "$1")"
  r="$(nb --sudo "md5sum $2 | awk '{print \$1}'" 2>/dev/null | tr -d '\r\n ')"
  if [ "$l" = "$r" ]; then echo "   ✓ $(basename "$2")  $l"
  else echo "   ✗ $(basename "$2")  本地=$l 远端=$r"; FAIL=1; fi
}
check "$SRC/fnos-package/manifest"             "$REMOTE/fnos-package/manifest"
check "$SRC/fnos-package/app/reverse-proxy.py" "$REMOTE/fnos-package/app/reverse-proxy.py"
check "$SRC/fnos-package/app/local-fs.py"      "$REMOTE/fnos-package/app/local-fs.py"
check "$SRC/fnos-package/app/launch-kernel.sh" "$REMOTE/fnos-package/app/launch-kernel.sh"
check "$SRC/fnos-package/app/ui/config"        "$REMOTE/fnos-package/app/ui/config"
check "$SRC/scripts/build-fpk.sh"              "$REMOTE/scripts/build-fpk.sh"
check "$SRC/fnos-package/cmd/main"             "$REMOTE/fnos-package/cmd/main"

# ★ 反向断言：内置图纸查看器必须**不在**打包工作区里 ★
#   删了一个功能却只做正向核对，残留产物会静默跟着进包（正是这类"删干净了没"
#   最容易漏的地方）。这条断言是本脚本里唯一"期望它不存在"的检查。
if nb --sudo "[ -e '$REMOTE/fnos-package/app/local-fs-dist' ] && echo PRESENT || echo ABSENT" 2>/dev/null | grep -q ABSENT; then
  echo "   ✓ local-fs-dist 已不在工作区（内置查看器已删除）"
else
  echo "   ✗ local-fs-dist 仍在 $REMOTE/fnos-package/app/ —— 会跟着打进包，先删掉它"
  FAIL=1
fi

if [ "$FAIL" != "0" ]; then
  echo "✗ md5 不一致，停止，不打包"
  exit 1
fi
echo "✓ 全部一致"

# ── 4. 打包 ────────────────────────────────────────────────────
say "4. 在 NAS 上执行 build-fpk.sh（复制 239MB 内核到 stage，请稍候）"
nb --sudo "cd '$REMOTE' && bash scripts/build-fpk.sh" 2>&1 | tail -25

# ── 5. 断言产物 ────────────────────────────────────────────────
say "5. 产物"
VER="$(sed -n 's/^version=//p' "$SRC/fnos-package/manifest" | head -1 | tr -d '\r\n')"
echo "   本次版本：$VER"
nb --sudo "ls -la '$REMOTE/release/' | tail -5; \
  F='$REMOTE/release/siyuannote-$VER.fpk'; \
  if [ -f \"\$F\" ]; then echo \"✓ \$F  \$(du -h \"\$F\" | cut -f1)\"; else echo '✗ 没有 $VER 的 fpk'; fi" 2>&1 | tail -10
