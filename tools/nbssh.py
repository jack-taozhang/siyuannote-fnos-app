#!/usr/bin/env python3
"""
用 paramiko 通过 SSH 在 NAS(192.168.193.70) 上执行命令。

为什么不用 Windows 原生 ssh：
  - spawnSync/execSync 在本机沙箱里一律 EBUSY（子进程起不来）
  - 直接用 ssh.exe 走 askpass 会报 `ssh_askpass: pipe: Unknown error`
    （沙箱内外都一样，与本机 ssh 的 askpass 管道机制有关）
  paramiko 是纯 Python 实现，自己建 socket + SSH 通道，不经 Windows 管道，
  因此绕开以上两个坑。

用法：
  python nbssh.py "远端命令"               # 执行并打印 stdout
  python nbssh.py --getlocal "远端路径" [本地路径]  # 省略本地 = 原始字节写 stdout（走 SFTP，二进制安全）
  python nbssh.py --put <本地> <远端>       # 上传（base64 分块）
  python nbssh.py --sudo "远端命令"         # 以 root 执行（密码经 stdin 喂给 sudo -S）

★ 为什么要有 --sudo（2026-09-30 加）★
  本机没有 tty，`sudo docker ...` 直接报
      "sudo: a terminal is required to read the password"
  而 NAS 上 tao_zhang 不在 docker 组 ⇒ 免 sudo 访问 docker.sock 被拒。
  所以必须 `echo <pass> | sudo -S -p '' <cmd>`：-S 让 sudo 从 stdin 读密码，
  -p '' 去掉提示串（否则提示串会混进 stderr 被误当成错误）。
  注意远端命令整体要再包一层 sh -c，否则 sudo 只对第一个词生效。
"""
import sys
import os
import re
import json
import base64
import shlex

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, "C:/temp-paramiko")

import paramiko  # noqa: E402


def load_conf():
    """配置来源：环境变量 > tools/.nb-local.json

    ★ 2026-09-28 起 host/user/pass **全部**从 .nb-local.json 读，单一改动点 ★
      之前 HOST 是写死的默认值，NAS 一换 IP（192.168.193.70 → 192.168.193.70）
      就得改脚本 —— 已改成读配置，以后只改 .nb-local.json 一处。
    环境变量优先级：NB_HOST / NB_USER / NB_PASS。
    """
    conf = {"host": "", "user": "", "pass": ""}
    cands = [
        os.path.join(HERE, ".nb-local.json"),
        os.path.join(HERE, "tools", ".nb-local.json"),
        "D:/Docker/Siyuan/data/plugins/siyuan-nebuladisk/tools/.nb-local.json",
    ]
    for c in cands:
        try:
            with open(c, "r", encoding="utf-8") as f:
                d = json.load(f)
            conf["host"] = conf["host"] or (d.get("host") or "")
            conf["user"] = conf["user"] or (d.get("user") or "")
            conf["pass"] = conf["pass"] or (d.get("pass") or "")
            if conf["host"] and conf["pass"]:
                break
        except Exception:
            pass
    conf["host"] = os.environ.get("NB_HOST") or conf["host"]
    conf["user"] = os.environ.get("NB_USER") or conf["user"] or "tao_zhang"
    conf["pass"] = os.environ.get("NB_PASS") or conf["pass"]
    if not conf["host"]:
        raise SystemExit("缺少 SSH 主机（NB_HOST 或 .nb-local.json 的 host）")
    if not conf["pass"]:
        raise SystemExit("缺少 SSH 口令（NB_PASS 或 .nb-local.json 的 pass）")
    return conf


# 兼容旧引用：load_pass() 仍可用
def load_pass():
    return load_conf()["pass"]


_CONF = load_conf()
HOST = _CONF["host"]
USER = _CONF["user"]
PASS = _CONF["pass"]


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        hostname=HOST,
        username=USER,
        password=PASS,
        port=22,
        timeout=15,
        allow_agent=False,
        look_for_keys=False,
    )
    return c


def run(cmd, timeout=600):
    c = connect()
    try:
        stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        return out, err, code
    finally:
        c.close()


def put(local, remote, mode=None):
    """上传本地文件到远端（base64 分块，避免命令行长度限制）。"""
    remote = unmangle_remote(remote)
    with open(local, "rb") as f:
        data = f.read()
    b64 = base64.b64encode(data).decode("ascii")
    tmp = "/tmp/nbput-%d-%s" % (os.getpid(), os.path.basename(local).replace("/", "_"))
    CHUNK = 65536
    c = connect()
    try:
        sftp = c.open_sftp()
        # 用 /tmp 中转：分块写入
        with sftp.open(tmp, "wb") as fh:
            for i in range(0, len(b64), CHUNK):
                fh.write(b64[i:i + CHUNK].encode("ascii"))
        # 远端解码落盘
        cmd = "base64 -d %s > %s" % (tmp, remote)
        if mode:
            cmd += " && chmod %s %s" % (mode, remote)
        cmd += " && rm -f %s && wc -c < %s" % (tmp, remote)
        stdin, stdout, stderr = c.exec_command(cmd, timeout=300)
        out = stdout.read().decode("utf-8", "replace").strip()
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        sftp.close()
        written = int(out) if out.isdigit() else -1
        return written, len(data), err, code
    finally:
        c.close()


def unmangle_remote(path):
    """还原 MSYS 对**绝对路径参数**的改写。

    ★ 这是本机最容易白跑一趟的坑 ★
      Git Bash 会把看起来像绝对 POSIX 路径的**参数**改写成
      `<MSYS 根>/<原路径>`，再传给原生 Windows 程序。例如
          --getlocal /vol1/docker/xxx/index.css
      到了 Python 手里变成
          C:/Users/HP/.../PortableGit/versions/1.2.0/vol1/docker/xxx/index.css
      ⇒ 远端报 "No such file"。

    ★★ 极易误判 ★★
      当天先看到 SFTP 报 `FileNotFoundError`，差点得出
      "飞牛上 SFTP 子系统不可用"的**错误结论**；其实把路径写对之后
      SFTP 一次就成（38291B，md5 与预期一致）。
      现象是"文件不存在"，真因是"参数被本机改写" —— 别去查远端。

    规避方式有两种，这里同时支持：
      · 命令行用 `//vol1/...`（双斜杠前缀，MSYS 不动它）
      · 直接写 `/vol1/...`，由本函数把混进来的 MSYS 前缀剥掉
    """
    if not path:
        return path
    p = path.replace("\\", "/")
    # 双斜杠前缀是给 MSYS 看的，远端只认单斜杠
    if p.startswith("//"):
        p = p[1:]
    # 剥掉误被拼上的 MSYS 根（.../PortableGit/versions/<ver>/... 或 .../Git/...）
    m = re.match(r"^[A-Za-z]:/.*?(?:PortableGit/versions/[^/]+|Git)/(?=.*)", p)
    if m:
        rest = p[m.end():]
        if rest and not rest.startswith("/"):
            rest = "/" + rest
        # 只在剥完确实像远端路径时才采用，避免误伤合法的 Windows 路径
        if re.match(r"^/(vol\d+|tmp|home|var|mnt|opt|usr|data|etc)(/|$)", rest):
            p = rest
    return p


def get(remote, local=None):
    """从远端拉文件。

    ★ 2026-10-08 补实现 ★
      这个子命令**文档里一直写着、但 main() 里从来没有实现过** ——
      调用 `--getlocal /path` 会掉进最后的「当命令执行」分支，
      远端 shell 把 `--getlocal` 当成一个命令名，报错进 stderr、
      stdout 为空 ⇒ 表现是**静默产出 0 字节文件**，很难查。
      （当天踩到：拉 NAS 的 index.css 拿到 0 字节，还以为是权限问题。）

    走 SFTP（二进制安全）；若 SFTP 不可用则回退 `base64 -w0` + 本地解码。
    传进来的远端路径会先过 unmangle_remote()（见那里的说明）。
    local 为 None 时把原始字节写到 stdout。
    """
    remote = unmangle_remote(remote)
    if local:
        try:
            c = connect()
            try:
                sftp = c.open_sftp()
                sftp.get(remote, local)
                sftp.close()
                return os.path.getsize(local)
            finally:
                c.close()
        except Exception as e:
            sys.stderr.write("[nbssh] SFTP 取文件失败，回退 base64 通道：%s\n" % e)
    # 回退（也是 local 为 None 时的唯一路径）：远端 base64 → 本地解码
    out, err, code = run("base64 -w0 %s" % shlex.quote(remote))
    if code != 0:
        raise SystemExit("[nbssh] 远端读取失败(%d)：%s" % (code, err.strip() or out.strip()))
    data = base64.b64decode("".join(out.split()), validate=False)
    if local:
        with open(local, "wb") as f:
            f.write(data)
        return len(data)
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    return len(data)


def sudo_run(cmd, timeout=600):
    """以 root 执行远端命令。

    ★ 为什么是 `echo PASS | sudo -S -p '' sh -c '<cmd>'` ★
      · `-S`     让 sudo 从 stdin 读口令（无 tty 时唯一可行的办法）
      · `-p ''`  清掉提示串，否则 "[sudo] password for x:" 会混进 stderr
      · `sh -c`  把整条命令交给一个 shell，避免 sudo 只把第一个词提权、
                 后面的重定向/管道仍在普通用户下执行
      ★ 口令用 shlex.quote 包住 ★ —— NAS 口令含 `@` 等字符，
        不加引号会被 shell 当成重定向/特殊字符。
    """
    inner = "echo %s | sudo -S -p '' sh -c %s" % (
        shlex.quote(PASS), shlex.quote(cmd),
    )
    return run(inner, timeout=timeout)


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit(
            "用法: python nbssh.py \"远端命令\"\n"
            "      python nbssh.py --put <本地> <远端> [mode]\n"
            "      python nbssh.py --getlocal <远端> [本地]   # 省略本地 = 写 stdout\n"
            "      python nbssh.py --sudo \"远端命令\""
        )
    if args[0] == "--getlocal":
        if len(args) < 2:
            raise SystemExit("用法: python nbssh.py --getlocal <远端> [本地]")
        remote = args[1]
        local = args[2] if len(args) > 2 else None
        n = get(remote, local)
        if local:
            print("OK  %s -> %s  %dB" % (remote, local, n))
        else:
            sys.stderr.write("OK  %s  %dB\n" % (remote, n))
        sys.exit(0)
    if args[0] == "--sudo":
        out, err, code = sudo_run(" ".join(args[1:]))
        sys.stdout.write(out)
        if err.strip():
            sys.stderr.write(err)
        sys.exit(code)
    if args[0] == "--put":
        local, remote = args[1], args[2]
        mode = args[3] if len(args) > 3 else None
        written, total, err, code = put(local, remote, mode)
        ok = written == total
        print("%s %s  %dB written / %dB total" % ("OK " if ok else "BAD", remote, written, total))
        if err.strip():
            sys.stderr.write(err)
        sys.exit(0 if ok else 1)
    cmd = " ".join(args)
    out, err, code = run(cmd)
    sys.stdout.write(out)
    if err.strip():
        sys.stderr.write(err)
    sys.exit(code)


if __name__ == "__main__":
    main()
