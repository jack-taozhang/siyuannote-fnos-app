#!/bin/bash
#
# 思源内核启动包装（由 cmd/main 以 root 调起）
#
# ── 为什么需要这一层 ─────────────────────────────────────────────
# 思源内核是**官方程序**，它不会像自家 Node 服务那样在 listen 成功后把 pid
# 写进 PID 文件。而 `nohup setsid ... &` 的 $! 又不可靠（setsid 会 fork，
# $! 可能是个立刻退出的壳）—— 直接取 $! 会造成"应用中心显示运行中、
# 实际端口不通"或者反过来。
#
# 这里的做法是经典的两步：
#   1) 先在**真实的那个进程**里 `echo $$ > PID`（此时 $$ 就是它自己）；
#   2) 再 `exec` 成内核 —— exec 保留 PID 不变，所以 PID 文件里写的就是
#      最终内核进程的 pid，后续 kill/status 全部对得上。
#
# ── 为什么降权 ──────────────────────────────────────────────────
# 包是 root 权限版（privilege 里 run-as: root），脚本因此能读全盘、也能
# 在需要时做特权操作。但**内核本身不需要 root**：它只读写自己的工作区。
# 以 root 跑内核的代价是新建文件的属主变成 root，而工作区属主是
# 1000:1001（tao_zhang）—— 将来若切回 Docker 容器（容器以 1000:1000 跑）
# 就会遇到"能读不能写"。所以这里用 setpriv 把内核降到工作区属主运行，
# 文件属主与容器时代完全一致，两边可以随时来回切。
#
# 想改回以 root 跑内核：把 ${TRIM_PKGETC}/run-as 写成 `root` 再重启应用。
#
# ── 参数（全部由 cmd/main 传入，这里不读 TRIM_* 之外的隐式状态）──
#   $1 PID 文件   $2 工作区   $3 鉴权码   $4 root|uid:gid
#   $5 内核路径   $6 musl loader   $7 资源目录（内核同目录）
#
set -u

PID_FILE="$1"
WORKSPACE="$2"
AUTHCODE="$3"
RUNAS="$4"
KERNEL="$5"
LOADER="$6"
LIBDIR="$7"

# ── 端口：内核只跑在内网，对外端口由前置反代持有 ─────────────────
# manifest 的 service_port（默认 6806）现在归 app/reverse-proxy.py 监听，
# 内核退到 SIYUAN_INTERNAL_PORT（默认 16806），只有本机的反代能连到它。
#
# 为什么要多这一层：思源做 WebSocket 升级时会比对 Origin 的 host 与请求的
# Host，而飞牛手机 App 走外网穿透时 Host 被改写、Origin 没改写，两者对不上
# 就直接拒连（日志里刷 CheckOrigin，前端停在 Unauthorized）。反代把这一个
# 头的 host 对齐，问题即解。详见 app/reverse-proxy.py 顶部说明。
PORT="${SIYUAN_INTERNAL_PORT:-16806}"

# ① 立刻以真实身份落 PID —— 必须在 exec 之前
echo $$ > "$PID_FILE" || exit 1

# ② 内核按「可执行文件所在目录」找 stage/ 与 appearance/，所以切过去
cd "$LIBDIR" || exit 1

# ③ 让内核以「对外服务」模式启动 —— 飞牛原生部署的关键一步
#    思源内核在**非容器模式**下只 listen 127.0.0.1（只允许本机访问），
#    飞牛桌面图标、局域网 IP、ZeroTier 全都进不来 —— 表现就是浏览器里
#    「172.16.30.128 拒绝了我们的连接请求」。设 RUN_IN_CONTAINER=true
#    内核改绑 0.0.0.0。
#    但代价是：思源 3.8.6 起在容器模式下**强制要求一种鉴权方式**，
#    否则内核启动即退出，日志里是：
#        "Docker access authentication configuration is invalid:
#         remote access requires at least one authentication method"
#    所以下面必须同时把鉴权码补上。
export RUN_IN_CONTAINER=true

# 鉴权码三级回退：cmd/main 传入的 > 工作区 conf.json 里已有的 > 官方显式 bypass
if [ -z "$AUTHCODE" ] && [ -r "$WORKSPACE/conf/conf.json" ]; then
  AUTHCODE="$(sed -n 's/.*"accessAuthCode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
              "$WORKSPACE/conf/conf.json" 2>/dev/null | head -n 1)"
fi

if [ -z "$AUTHCODE" ]; then
  # 工作区从没设过密码 —— 用官方 bypass，局域网免密（与旧 Docker 版行为一致）。
  # 想加密码：往 ${TRIM_PKGETC}/authcode 写一行密码，再在应用中心重启本应用。
  export SIYUAN_ACCESS_AUTH_CODE_BYPASS=true
  echo "$(date '+%Y-%m-%d %H:%M:%S') - [launch] 工作区未设置访问密码，启用 SIYUAN_ACCESS_AUTH_CODE_BYPASS（局域网免密）" >&2
fi

# ④ 组装 musl loader 的命令行
#    内核 interpreter 写死 /lib/ld-musl-x86_64.so.1，飞牛是 Debian（glibc）
#    没有这个文件，所以必须显式用 loader 调起 + --library-path 指到同目录，
#    让 loader 在那里找到 libc.musl-x86_64.so.1。
KERNEL_CMD=("$LOADER" --library-path "$LIBDIR" "$KERNEL"
            --workspace="$WORKSPACE"
            --port="$PORT"
            serve
            --accessAuthCode="$AUTHCODE")

if [ "$RUNAS" = "root" ]; then
  # 以 root 跑（不降权）。文件属主会变成 root，切回容器时要注意。
  exec "${KERNEL_CMD[@]}"
fi

UID_PART="${RUNAS%%:*}"
GID_PART="${RUNAS##*:}"

if command -v setpriv >/dev/null 2>&1; then
  # --clear-groups：连附加组一起按目标身份重置，避免继承 root 的附加组
  exec setpriv --reuid="$UID_PART" --regid="$GID_PART" --clear-groups \
       "${KERNEL_CMD[@]}"
fi

# 兜底：没有 setpriv 就退回以 root 跑（功能优先，属主问题记进日志由用户决定）
echo "$(date '+%Y-%m-%d %H:%M:%S') - [launch] 未找到 setpriv，回退以 root 运行内核" >&2
exec "${KERNEL_CMD[@]}"
