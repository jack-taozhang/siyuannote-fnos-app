#!/bin/bash
#
# 把 siyuan-localfs 插件部署到 NAS 上跑着的思源
#   · 先本机构建（build）
#   · 传 //tmp → sudo cp → **md5 双向核对**
#   · 目录不存在就建（首次安装）
#
# 纪律（沿用本工作区已经固化下来的那套）：
#   SMB 不可靠、scp 到一半也可能"看起来成功"⇒ 每次都必须回读 md5 比一遍，
#   不一致就停下，绝不让半截部署混过去。
#
# 用法：bash tools/deploy-nas.sh
set -u

# ★ 部署口令一律从环境变量读，**不写默认值** ★
#   这份脚本要进公开仓库，硬编码口令等于把 NAS 密码公开。
#   用法：NAS_PW='你的口令' bash tools/deploy-nas.sh
if [ -z "${NAS_PW:-}" ]; then
  echo "缺少环境变量 NAS_PW。请这样跑：NAS_PW='你的口令' bash $0" >&2
  exit 2
fi
export NAS_PW

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PY="C:/Users/HP/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
BUILT="D:/Software/SiYuan/data/plugins/siyuan-localfs"

PLUGDIR="/vol1/docker/project/dk_app/siyuan/siyuan_E4Xr/data/data/plugins/siyuan-localfs"
TMPDIR_REMOTE="/tmp/sy-localfs"

md5local() { md5sum "$1" | awk '{print $1}'; }
say() { echo "── $1"; }

cd "$HERE" || exit 1

# ── 0. 本机构建 ────────────────────────────────────────────────
say "0. 本机构建"
node "$HERE/build.js" || { echo "✗ 构建失败"; exit 1; }

# ── 1. 上传到 //tmp ───────────────────────────────────────────
say "1. 上传到 ${TMPDIR_REMOTE}/"
"$PY" nbssh.py --sudo "rm -rf $TMPDIR_REMOTE; mkdir -p $TMPDIR_REMOTE; chmod 777 $TMPDIR_REMOTE" >/dev/null 2>&1

up() {  # $1 本地文件  $2 远端文件名
  "$PY" nbssh.py --put "$1" "//${TMPDIR_REMOTE}/$2" 644 >/dev/null 2>&1 \
    || { echo "✗ 上传失败 $1"; exit 1; }
  echo "   ↑ $2  ($(md5local "$1"))"
}
up "$BUILT/index.js"  index.js
up "$BUILT/index.css" index.css
up "$ROOT/plugin.json" plugin.json
up "$ROOT/icon.png"   icon.png
up "$ROOT/i18n/zh_CN.json" zh_CN.json
up "$ROOT/i18n/en_US.json" en_US.json
# ★ plugin.json 的 readme 指向这两个文件，缺了内核会一直刷
#   "open …/README.md: no such file or directory"（实测过）
up "$ROOT/README.md"       README.md
up "$ROOT/README.zh_CN.md" README.zh_CN.md

# ── 2. 落位 ───────────────────────────────────────────────────
say "2. 安装到思源插件目录"
"$PY" nbssh.py --sudo "set -e
mkdir -p '$PLUGDIR/i18n'
install_one() { cp $TMPDIR_REMOTE/\$1 '$PLUGDIR'/\$2; chmod \$3 '$PLUGDIR'/\$2; }
install_one index.js  index.js  644
install_one index.css index.css 644
install_one plugin.json plugin.json 644
install_one icon.png  icon.png  644
install_one zh_CN.json i18n/zh_CN.json 644
install_one en_US.json i18n/en_US.json 644
install_one README.md       README.md 644
install_one README.zh_CN.md README.zh_CN.md 644
# 属主：与邻近插件保持一致（思源以 root 跑，但目录归属别搞乱）
OWN=\$(stat -c '%u:%g' /vol1/docker/project/dk_app/siyuan/siyuan_E4Xr/data/data/plugins 2>/dev/null || echo '')
[ -n \"\$OWN\" ] && chown -R \"\$OWN\" '$PLUGDIR' || true
rm -rf $TMPDIR_REMOTE
echo '已落位：'
ls -la '$PLUGDIR'" 2>&1 | tail -14

# ── 3. md5 双向核对 ───────────────────────────────────────────
say "3. md5 双向核对"
FAIL=0
check() {
  local l r
  l="$(md5local "$1")"
  r="$("$PY" nbssh.py --sudo "md5sum '$PLUGDIR/$2' | awk '{print \$1}'" 2>/dev/null | tr -d '\r\n ')"
  if [ "$l" = "$r" ]; then echo "   ✓ $2  $l"
  else echo "   ✗ $2  本地=$l 远端=$r"; FAIL=1; fi
}
check "$BUILT/index.js"     index.js
check "$BUILT/index.css"    index.css
check "$ROOT/plugin.json"   plugin.json
check "$ROOT/icon.png"      icon.png
check "$ROOT/i18n/zh_CN.json" i18n/zh_CN.json
check "$ROOT/i18n/en_US.json" i18n/en_US.json
check "$ROOT/README.md"       README.md
check "$ROOT/README.zh_CN.md" README.zh_CN.md

if [ "$FAIL" != "0" ]; then
  echo "✗ md5 不一致，停止"
  exit 1
fi
echo "✓ 全部一致"
echo
echo "版本：$(grep -o '"version"[^,]*' "$ROOT/plugin.json")"
echo "⚠️ 内核会缓存插件 JS —— 改了 index.js 之后如果界面没变化，"
echo "   唯一有效的办法是**升 plugin.json 的 version**（reload ignoreCache 无效）。"
