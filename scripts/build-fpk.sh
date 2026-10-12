#!/bin/bash
#
# 打包「思源笔记」飞牛原生应用（.fpk）
#
# ── 为什么在飞牛上打而不是在开发机 ──────────────────────────────
# 思源内核 132MB，它就躺在**这台机器的**思源容器里。就地提取、就地打包，
# 省掉 260MB 的来回搬运；而且包里的内核与正在用的内核**完全同源**，
# 不会出现"打包用的版本和你实际在跑的版本不是一个"。
#
# 用法（在工程根目录，需要 root 才能 docker cp）：
#   sudo bash scripts/build-fpk.sh
#
# 幂等：kernel-dist 已存在就跳过提取（要强制重提：加 --refresh）
#
set -euo pipefail

REFRESH=0
[ "${1:-}" = "--refresh" ] && REFRESH=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="${ROOT}/fnos-package"
RUNTIME="${PKG}/app/kernel-dist"
RELEASE="${ROOT}/release"
STAGE_ROOT="${RELEASE}/stage"

CONTAINER="${SIYUAN_CONTAINER:-siyuan-siyuan_E4Xr-1}"

manifest_field() {
  sed -n "s/^$1[[:space:]]*=[[:space:]]*\(.*\)\$/\1/p" "${PKG}/manifest" | head -n1 | tr -d '\r'
}

APPNAME="$(manifest_field appname)"
VERSION="$(manifest_field version)"
[ -n "$APPNAME" ] || { echo "✗ manifest 里读不到 appname"; exit 1; }
[ -n "$VERSION" ] || { echo "✗ manifest 里读不到 version"; exit 1; }

echo "=== 思源笔记 · 飞牛原生应用打包 ==="
echo "应用 ${APPNAME} / 版本 ${VERSION} / 容器 ${CONTAINER}"

# ── 0. 前置检查 ────────────────────────────────────────────────
if ! command -v fnpack >/dev/null 2>&1; then
  echo "✗ 找不到 fnpack（应为 /usr/local/bin/fnpack）。"
  echo "  手工 tar 打的包缺 cmd/ 脚本与 app.tgz，安装时会被判「不符合系统要求」。"
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "✗ 找不到 docker"
  exit 1
fi
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "✗ 容器 ${CONTAINER} 不存在。"
  echo "  可先用 SIYUAN_CONTAINER=<名字> 指定别的容器（docker ps -a 看名字）。"
  exit 1
fi

# ── 1. 提取运行期（内核 + 前端资源 + musl） ────────────────────
# 注：容器不需要在运行状态，docker cp 对已停止的容器同样有效。
if [ "$REFRESH" = "1" ] || [ ! -f "${RUNTIME}/kernel" ]; then
  echo "[1/5] 从容器提取内核与前端资源 → app/kernel-dist/"
  rm -rf "$RUNTIME"
  mkdir -p "$RUNTIME"

  # 内核本体
  docker cp "${CONTAINER}:/opt/siyuan/kernel" "${RUNTIME}/kernel"

  # 前端资源。思源 3.8 里前端叫 stage/（老版本叫 resources/），
  # appearance/ 是主题字体语言包，guide/ 是内置用户指南。
  for d in stage appearance guide changelogs; do
    docker cp "${CONTAINER}:/opt/siyuan/${d}" "${RUNTIME}/${d}" 2>/dev/null \
      || echo "  · 容器内没有 /opt/siyuan/${d}，跳过"
  done
  for f in LICENSE THIRD_PARTY_NOTICES.md; do
    docker cp "${CONTAINER}:/opt/siyuan/${f}" "${RUNTIME}/${f}" 2>/dev/null \
      || echo "  · 容器内没有 /opt/siyuan/${f}，跳过"
  done

  # ★ musl libc ★
  #   内核的 interpreter 写死 /lib/ld-musl-x86_64.so.1（镜像基于 Alpine），
  #   而飞牛是 Debian/glibc，没有这个文件 —— 直接跑会报
  #   "No such file or directory"，看着像文件不存在，其实是 loader 找不到。
  #   把 loader 与 libc 一起带走，启动时用 loader 显式调起内核即可。
  docker cp "${CONTAINER}:/lib/ld-musl-x86_64.so.1" "${RUNTIME}/ld-musl-x86_64.so.1"
  docker cp "${CONTAINER}:/lib/libc.musl-x86_64.so.1" "${RUNTIME}/libc.musl-x86_64.so.1" 2>/dev/null \
    || cp -a "${RUNTIME}/ld-musl-x86_64.so.1" "${RUNTIME}/libc.musl-x86_64.so.1"

  chmod 755 "${RUNTIME}/kernel" "${RUNTIME}/ld-musl-x86_64.so.1"
else
  echo "[1/5] 已存在 app/kernel-dist/，跳过提取（--refresh 可强制重提）"
fi

echo "      内核 $(du -h "${RUNTIME}/kernel" | cut -f1)，运行期总计 $(du -sh "$RUNTIME" | cut -f1)"

# ── 2. 换行符规范化 ────────────────────────────────────────────
# Windows 上编辑过的脚本带 CRLF，到了飞牛的 bash 里会变成
# `\r: command not found`，而且报错信息完全不指向真正原因。
# 与其指望每个人编辑器设置正确，不如在打包这一步统一拍平。
echo "[2/5] 规范化脚本换行符（CRLF → LF）"
find "${PKG}" -type f \( -path '*/cmd/*' -o -name '*.sh' \) -print0 2>/dev/null |
  while IFS= read -r -d '' f; do
    if grep -q $'\r' "$f" 2>/dev/null; then
      sed -i 's/\r$//' "$f"
      echo "  · 修正 $f"
    fi
  done

# ── 3. 组装 stage（目录名必须等于 appname） ────────────────────
echo "[3/5] 组装 release/stage/${APPNAME}/"
rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE_ROOT"
cp -a "${PKG}" "${STAGE_ROOT}/${APPNAME}"

STAGE="${STAGE_ROOT}/${APPNAME}"
chmod 755 "${STAGE}/cmd/"* "${STAGE}/app/launch-kernel.sh" \
         "${STAGE}/app/reverse-proxy.py" "${STAGE}/app/local-fs.py" 2>/dev/null || true

# ── 4. 打包前自检 ──────────────────────────────────────────────
echo "[4/5] 自检"
REQUIRED_CMD=(main install_init install_callback uninstall_init uninstall_callback
              upgrade_init upgrade_callback config_init config_callback)
REQUIRED_ROOT=("manifest" "ICON.PNG" "ICON_256.PNG" "config/privilege" "config/resource"
               "app/ui/config" "app/ui/images/icon_64.png" "app/ui/images/icon_256.png"
               "app/launch-kernel.sh" "app/reverse-proxy.py"
               "app/local-fs.py"
               "app/kernel-dist/kernel"
               "app/kernel-dist/ld-musl-x86_64.so.1" "app/kernel-dist/stage")

missing=""
for rel in "${REQUIRED_ROOT[@]}"; do
  [ -e "${STAGE}/${rel}" ] || missing="${missing}\n  - ${rel}"
done
for name in "${REQUIRED_CMD[@]}"; do
  [ -f "${STAGE}/cmd/${name}" ] || missing="${missing}\n  - cmd/${name}"
done
if [ -n "$missing" ]; then
  echo "✗ 应用包缺少必需文件：$(printf "%b" "$missing")"
  exit 1
fi

# ★★ 反向断言：内置图纸查看器不许再出现在包里 ★★
#   2026-10-10 起 CAD 预览借用飞牛原生「CAD 看图」应用（fnos-dwg-viewer :8020），
#   经反代的 /localfs/cad/* 同源通道 —— 与「文件预览」借 :8030 完全同构。
#   那份 22MB 的 cad-viewer 产物（app/local-fs-dist/）已删除，local-fs.py 也不再
#   提供任何页面（根路径 404）。这里**主动**拦住它，是因为"删了功能但旧产物
#   被别的路径带回来"是最容易发生、也最不容易被察觉的一类回归：
#   它不会让任何东西报错，只会让包白白大 22MB、并重新出现一个没人维护的查看器。
if [ -e "${STAGE}/app/local-fs-dist" ]; then
  echo "✗ 包里又出现了 app/local-fs-dist/（内置图纸查看器）——"
  echo "  它已被 removed（CAD 预览改为借用原生「CAD 看图」应用），"
  echo "  请清理打包工作区里的这份旧产物再打。"
  exit 1
fi

# 权限声明必须是 root：写成 package 也能装、也能跑，但读不到用户文件，
# 而且现象一点也不像"权限声明被改坏了" —— 所以在这里卡死。
if ! grep -q '"run-as"[[:space:]]*:[[:space:]]*"root"' "${STAGE}/config/privilege"; then
  echo "✗ config/privilege 里 run-as 必须是 root"
  exit 1
fi

# manifest 的 INI 值里不能出现 ; 或 #（会被当注释截断，changelog 最常踩）
if grep -E '^(desc|changelog|display_name)[[:space:]]*=.*[;#]' "${STAGE}/manifest"; then
  echo "✗ manifest 的值里出现了 ; 或 # —— INI 会把它当注释截断"
  exit 1
fi

# display_name 不该带括号后缀（应用中心与桌面图标都会带上它）
if sed -n 's/^display_name[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' "${STAGE}/manifest" | grep -qE '[（(]'; then
  echo "✗ manifest 的 display_name 不要带括号后缀"
  exit 1
fi

echo "      ✓ 文件齐全 / run-as=root / manifest 合法"

# ── 5. fnpack 打包 ─────────────────────────────────────────────
# fnpack 把产物写到「当前工作目录」下、文件名固定 <appname>.fpk
echo "[5/5] fnpack 打包"
mkdir -p "$RELEASE"
cd "$RELEASE"
rm -f "${APPNAME}.fpk"
fnpack build --directory "$STAGE"

if [ ! -f "${RELEASE}/${APPNAME}.fpk" ]; then
  echo "✗ fnpack 没有产出 ${APPNAME}.fpk（fnpack 退出码是 0 也不代表成功，所以这里断言产物）"
  exit 1
fi

FPK="${RELEASE}/${APPNAME}-${VERSION}.fpk"
rm -f "$FPK"
mv "${RELEASE}/${APPNAME}.fpk" "$FPK"
rm -rf "$STAGE_ROOT"

echo
echo "✓ 完成：${FPK}（$(du -h "$FPK" | cut -f1)）"
echo "  安装：应用中心 → 右上角设置 → 手动安装应用"
echo "  装完如显示「已停用」，先 docker stop ${CONTAINER} 再点启动。"
