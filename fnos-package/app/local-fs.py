#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
思源笔记（飞牛原生应用）· 本机文件服务  local-fs
==============================================================================

★ 这个进程解决什么问题 ★
  思源笔记的「本机存储」需要能浏览 NAS 上**全部**存储空间（/vol1、/vol00…），
  而思源以 Docker 跑的时候做不到这件事：容器只挂了三个目录，其余一概看不见
  （这正是"必须绕路"的根因）。

  以前文件浏览器这一层是借第三方应用 fnos-dwg-viewer（:8020）当数据面 ——
  那意味着「装了思源还不够，还得让那个 CAD 应用一直跑着」。本进程把**数据面**
  收回来，它随思源应用一起起停，浏览全盘不再依赖任何别的应用。

★ 但它**本身不渲染任何文件** ★
  各类预览一律借飞牛上已经装好的应用，由反代挂成同源通道
  （手机走外网穿透时只映射了思源这一个端口，别的端口根本够不到）：

    Office（.docx/.xlsx/.pptx…）→ 本服务提供的 /oo/editor 页面 + OnlyOffice :8082
    CAD（.dwg/.dxf）            → 飞牛原生「CAD 看图」fnos-dwg-viewer :8020
                                   经反代 /localfs/cad/*
    其余全部格式                 → 飞牛原生「文件预览」fnos-file-viewer :8030
                                   经反代 /localfs/fv/*

  ⚠️ 本服务**曾经内置**一个 DWG 查看器（cad-viewer 1.7.4 的构建产物，
     app/local-fs-dist/，22MB）。2026-10-10 已连同它的静态服务、资源前缀改写
     机制一并删除 —— CAD 预览改成与「文件预览」完全同构地借用原生应用。
     ⇒ **本服务现在只提供 /api/* 和一个同源同步页 /cred-sync，根路径一律 404。**
       别再把查看器页面挂回来（`do_GET` 的兜底分支里留了这条说明）。

★ 它与前端的历史契约（照抄 cad-viewer，现在仍被思源插件使用）★

    GET /api/config                         → {sources:[{label,path}], allowedRoots, …}
    GET /api/list?source=local&path=<abs>   → {source,path,items:[{name,path,isDir,size,mtime,ext}]}
    GET /api/file[/<名字>]?path=<abs>        → 文件字节流（名字只为让查看器按后缀判类型）
    GET /api/probe?path=<abs>               → 存在性 / 尺寸 / 后缀
    GET /api/doctor                         → 权限自检（简化版）
    GET|POST|DELETE /api/fnos-cred          → 飞牛登录凭据：状态 / 「同步当前浏览器
                                              登录态」/ 清除（供反代替桌面端补上，
                                              见 FNOS_CRED_FILE 的注释）
    GET /cred-sync                          → **飞牛登录态同步页**（同源 HTML）。
                                              桌面端拿不到 NAS 的飞牛 Cookie，
                                              由插件在系统浏览器里打开这一页，
                                              它自己发 POST，浏览器自动带上 Cookie。
                                              见 CRED_SYNC_HTML 的注释。
    GET /health                             → {ok:true}（探活用）

  ⚠️ 与 fnos-dwg-viewer 的一个实质差异：它的 /api/list 里有一句
     `if (!isDir && !CAD_EXT.has(ext)) continue`，天生只列图纸。
     本服务**列全部文件** —— 因为这里的定位是「本机存储浏览器」，不是图纸库。

★ 路径语义：**绝对路径** ★
  与 cad-viewer 一致，对外一律用 /vol1/xxx 这样的绝对路径。
  插件侧若要用"相对挂载点"的路径，转换在插件里做（见其 src 说明）。

★ 鉴权：无 ★
  和 fnos-dwg-viewer 同样的模型：进程以 root 跑、直读全盘，服务本身不做登录
  （靠"谁能连到这个端口"来界定）。所以**不要把这个端口暴露到公网**。
  飞牛上它只监听内网网卡，与思源本体（6806）一致。

★ OnlyOffice（Office 在线预览 / 编辑）★
  本服务**不自己渲染 Office**，而是复用 NAS 上已经跑着的 OnlyOffice
  DocumentServer（默认 :8082）—— 这与飞牛系统自带「office 文档」应用是同一个
  东西（那个也是 OnlyOffice）。三件事：

    1. /oo/editor?path=…  返回一个**完整的编辑器页面**（前端 iframe 直接嵌），
       页面里加载 OnlyOffice 的 api.js 并初始化 DocEditor。
    2. document.url 指向本服务 /api/file —— 注意这个地址是 **OnlyOffice 服务器**
       去 GET 的，必须是「从 OnlyOffice 容器里能连通的地址」（见 SELF_BASE）。
    3. callbackUrl 指回 /oo/callback —— 编辑完成后 OnlyOffice 主动 POST 回来，
       本服务把新文档原子写回磁盘。

  ⚠️ 关键约束（踩过）：document.url / callbackUrl 里的主机名不能用 localhost，
     因为发起方是 OnlyOffice 容器；必须用容器可达的地址（宿主内网 IP）。

★ 配置（全部走环境变量，由 cmd/main 注入；也可用同名文件覆盖）★
    LOCAL_FS_PORT        监听端口（默认 8021）
    LOCAL_FS_OO_URL      OnlyOffice 地址（默认 http://127.0.0.1:8082）
    LOCAL_FS_OO_SECRET   OnlyOffice JWT 密钥（空 = 不签名）
    LOCAL_FS_SELF        OnlyOffice 回取文件用的本服务地址（默认按宿主内网 IP 推）
    LOCAL_FS_ROOTS       显式指定浏览根（逗号分隔；默认自动探测 /vol*）
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_VERSION = "1.0.0"
APP_ID = "siyuan-local-fs"

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))

PORT = int(os.environ.get("LOCAL_FS_PORT") or "8021")
OO_URL = (os.environ.get("LOCAL_FS_OO_URL") or "http://127.0.0.1:8082").rstrip("/")
OO_SECRET = os.environ.get("LOCAL_FS_OO_SECRET") or ""
# 浏览器加载 api.js 用的地址（**必须浏览器可达**）。
# ★ 它和 OO_URL 是两个不同的东西，别混：
#     OO_URL     —— 服务端探活用（可以是容器内名/127.0.0.1）
#     OO_PUBLIC  —— 浏览器加载 api.js 用（必须是浏览器能访问的地址）
#   留空 ⇒ 按请求的 Host 推（见 browser_oo_base）。
OO_PUBLIC = (os.environ.get("LOCAL_FS_OO_PUBLIC") or "").rstrip("/")
OO_PUBLIC_PORT = os.environ.get("LOCAL_FS_OO_PUBLIC_PORT") or "8082"
# OnlyOffice 的**同源通道**路径（由前置反代转到文档服务，见 reverse-proxy.py 的
# OO_PREFIX）。手机走外网穿透（FN Connect）时只映射了思源这一个端口，:8082
# 根本不可达 —— 那时唯一能用的就是这条同源通道。
#   留空 ⇒ 域名的情形只能退回 OO_URL（页面上会给出可读提示，编辑器起不来）。
OO_SAME_ORIGIN = (os.environ.get("LOCAL_FS_OO_SAME_ORIGIN") or "/localfs/oo-srv").rstrip("/")
# 调试用：连 IP 访问也强制走同源通道（用来在内网验证那条通道真的通）
OO_SAME_ORIGIN_ALWAYS = (os.environ.get("LOCAL_FS_OO_SAME_ORIGIN_ALWAYS") or "") == "1"
SELF_BASE = (os.environ.get("LOCAL_FS_SELF") or "").rstrip("/")
EXPLICIT_ROOTS = [p for p in (os.environ.get("LOCAL_FS_ROOTS") or "").split(",") if p.strip()]

# 路径前缀。本服务有两种被访问的方式：
#   ① 直连  http://<nas>:8021/api/list
#   ② 经思源反代（同源）  http://<nas>:6806/localfs/api/list
# 两种都认：②的 /localfs 前缀在这个变量里配，请求进来时先剥掉。
# ★ 为什么要有②：手机经外网穿透（FN Connect）访问时只映射了 6806，
#   浏览器根本够不到 8021 —— 走同源通道才能用。
BASE_PREFIX = (os.environ.get("LOCAL_FS_BASE") or "/localfs").rstrip("/")

# OnlyOffice 的临时下载地址可能给的是容器内名的，取文件时要放宽校验
FETCH_TIMEOUT = float(os.environ.get("LOCAL_FS_FETCH_TIMEOUT") or "600")
MAX_WRITE_BYTES = int(os.environ.get("LOCAL_FS_MAX_WRITE") or str(4 * 1024 * 1024 * 1024))

# ---------------------------------------------------------------------------
# ★★ OnlyOffice 缓存自动清理（2026-10-10 新增）★★
#   用户报：「自动清理 oo 缓存空间」。
#
#   为什么需要：
#     OO 每打开/转换一个文档，都会在它自己的
#       /var/lib/onlyoffice/documentserver/App_Data/cache/files/data/<key>/
#     下留一份**完整副本**（源文件 + 转换后的 x2t 产物）。
#     真机实测：22 个条目就占了 1.4 GB；其中 `conv_*` 是我们调 /converter
#     留下的，`.bin` / 大 pptx 动辄几百 MB。
#     OO 官方只在**容器重启**时清（`documentserver-prepare4shutdown.sh`），
#     平时不清 ⇒ 长期跑会一直涨，最终把盘写满
#     （真机曾出现 `ENOSPC: no space left on device`，见 docservice/out.log）。
#
#   策略（保守，宁可不删也不误删）：
#     · 只删**超过 TTL（默认 24h）没被改动**的条目；
#     · 有活跃编辑时（存在 <1h 内的条目）**整体跳过**这一轮，避免删到
#       正在被 OO 读的缓存；
#     · 单轮删除量上限 MAX_ITEMS，且总量不超过 MAX_BYTES —— 削峰而不是清空；
#     · 删除走 `shutil.rmtree`，失败只记日志，绝不抛（清理不该拖垮服务）。
#
#   跑法：main() 起一个 daemon 线程，每 OO_CACHE_INTERVAL 秒扫一次。
#   环境变量（都能在 cmd/main 里覆盖）：
#     LOCAL_FS_OO_CACHE_CLEAN=0      关掉
#     LOCAL_FS_OO_CACHE_TTL=86400    条目存活秒数
#     LOCAL_FS_OO_CACHE_INTERVAL=3600 扫描间隔秒数
#     LOCAL_FS_OO_CACHE_MAX_ITEMS=200 单轮最多删几个
#     LOCAL_FS_OO_CACHE_MAX_MB=2048  单轮最多删多少 MB
#     LOCAL_FS_OO_CACHE_DIR=...      覆盖缓存根（默认走容器 inspect）
#     LOCAL_FS_OO_CONTAINER=onlyoffice  OnlyOffice 容器名（inspect 用）
# ---------------------------------------------------------------------------
OO_CACHE_CLEAN = (os.environ.get("LOCAL_FS_OO_CACHE_CLEAN") or "1") != "0"
OO_CACHE_TTL = int(os.environ.get("LOCAL_FS_OO_CACHE_TTL") or str(24 * 3600))
OO_CACHE_INTERVAL = int(os.environ.get("LOCAL_FS_OO_CACHE_INTERVAL") or "3600")
OO_CACHE_MAX_ITEMS = int(os.environ.get("LOCAL_FS_OO_CACHE_MAX_ITEMS") or "200")
OO_CACHE_MAX_BYTES = int(os.environ.get("LOCAL_FS_OO_CACHE_MAX_MB") or "2048") * 1024 * 1024
# 有"这么新"的条目就说明正在编辑 ⇒ 本轮不删任何东西
OO_CACHE_BUSY_AGE = int(os.environ.get("LOCAL_FS_OO_CACHE_BUSY_AGE") or "3600")
# 缓存目录在**容器内**的固定位置（OO 官方镜像，多年未变）
OO_CACHE_DIR_IN_CONTAINER = "/var/lib/onlyoffice/documentserver/App_Data/cache/files/data"
# 容器名（与 FPK 里 other 应用/镜像一致；不同装法可能不同名）
OO_CONTAINER = os.environ.get("LOCAL_FS_OO_CONTAINER") or "onlyoffice"

# ★★ 飞牛登录凭据的「后端持有」副本（2026-10-10）★★
#
#   为什么需要它：飞牛官方「Office文档」(trim.docs, :5666) 的 /docs/preview
#   要**飞牛登录态**，而那是浏览器 cookie —— `ost` / `osrt`
#   （飞牛 nginx 转发给应用前改名成 `fnos-token` / `fnos-long-token`，
#    规则见 /usr/trim/nginx/conf/globals/trim-cookie-v2-to-v1-map.conf）。
#
#   桌面思源客户端的内核跑在 127.0.0.1:6806 —— 那侧**没有** NAS 的 cookie
#   （飞牛登录态存在 172.16.30.128 域下）⇒ 就算走同源通道也必然
#   「未登录或登录已过期」。凭据不在通道里，在浏览器的 cookie jar 里。
#
#   ⇒ 做法：让插件在**能拿到凭据的处境**（浏览器 / 手机飞牛 App）发一个
#     同源请求，浏览器会**自动带上** cookie（HttpOnly 的 JS 读不到，
#     只能这样"借"一次），本服务挑出白名单里的几个存到本机；
#     反代（:6806）转发 Office 请求时补上。
#     于是桌面端、手机、浏览器三种走法全都能用。
#
#   ★ 只认下面这 4 个名字，别的 cookie 一概不看、不存 ★
#   ★ 这是用户凭据：文件 0600，且 /api/fnos-cred 只回**状态**、
#     永不回显凭据本身 ★
FNOS_CRED_FILE = os.environ.get("LOCAL_FS_FNOS_CRED_FILE") or os.path.join(
    os.environ.get("TRIM_PKGVAR") or "/var/apps/siyuannote/var", "fnos-cred.json")
FNOS_CRED_NAMES = ("ost", "osrt", "fnos-token", "fnos-long-token")


def _parse_cookie_header(raw: str) -> dict:
    """把 Cookie 头解析成 {名字: 值}。同名只取第一段。"""
    out = {}
    for part in (raw or "").split(";"):
        k, sep, v = part.partition("=")
        if not sep:
            continue
        k = k.strip()
        if k and k not in out:
            out[k] = v.strip()
    return out


def fnos_cred_stat() -> dict:
    """本机保存的飞牛凭据状态。**永远不回显凭据本身**（只回名字与时间）。"""
    try:
        with open(FNOS_CRED_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return {"saved": False}
    return {
        "saved": bool(data.get("cookie")),
        "names": data.get("names") or [],
        "savedAt": data.get("savedAt") or "",
        "file": FNOS_CRED_FILE,
    }


def fnos_cred_save(cookie_header: str) -> dict:
    """从请求的 Cookie 头里挑出飞牛凭据并落盘（0600）。

    一个都没挑到就**不动**原来的文件 —— 免得把一份好凭据清掉
    （桌面端也会调这个接口，它那儿本来就没有凭据）。
    """
    jar = _parse_cookie_header(cookie_header)
    picked = [n for n in FNOS_CRED_NAMES if jar.get(n)]
    if not picked:
        return {"saved": False, "reason": "NO_CRED", "names": []}
    data = {
        "cookie": "; ".join("%s=%s" % (n, jar[n]) for n in picked),
        "names": picked,
        "savedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    tmp = FNOS_CRED_FILE + ".tmp"
    # 先写 0600 的临时文件再原子替换：中途崩了也不会留下半截凭据
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, FNOS_CRED_FILE)
    return {"saved": True, "names": picked, "savedAt": data["savedAt"]}


def fnos_cred_clear() -> dict:
    try:
        os.unlink(FNOS_CRED_FILE)
        return {"saved": False, "cleared": True}
    except FileNotFoundError:
        return {"saved": False, "cleared": False}
    except Exception as e:  # noqa: BLE001
        raise ApiError(500, "CLEAR_FAILED", "清除失败：%s" % e)


# ---------------------------------------------------------------------------
# 飞牛登录态同步页（GET /cred-sync，2026-10-10 新增）
# ---------------------------------------------------------------------------
# ★ 为什么需要这一页 ★
#   飞牛的登录 Cookie 是**按主机**存的、而且是 HttpOnly：
#     · 浏览器开着 NAS 的思源（6806）时，那份登录态天然带得上（Cookie 不分端口），
#       插件在那个上下文里点「同步」直接就能存下来；
#     · 但**思源桌面客户端**的内核在本机（127.0.0.1）—— 它从没访问过 NAS，
#       Cookie 罐里自然一份都没有；跨源 fetch 也读不到（`_cors()` 没回
#       `Access-Control-Allow-Credentials`，浏览器直接拦下）。
#       ⇒ 桌面端"点一下同步"这件事**从原理上就不可能**在插件里做成。
#
# ★ 于是把「点一下」搬到浏览器里 ★
#   本服务返回一个**同源**的 HTML：浏览器打开它，它自己 POST /api/fnos-cred，
#   同源请求自动带上飞牛 Cookie ⇒ 同步成功。
#   插件在桌面端只用 `window.open` 打开这个地址（见其 fnosCredPageUrl）。
#   页面里再给一个「去登录飞牛」：跳飞牛自己的登录页（`/login?redirect_uri=`），
#   登录完自动回到本页继续同步 —— 所以没用过浏览器登过飞牛的人也是一路点下去。
#   ★ 这套做法顺带把二次验证（TOTP / 邮箱验证码）照顾到了 ★
#     那是飞牛登录页自己的流程，我们完全不碰账号密码（凭据永远不进插件、
#     不进本服务，本服务只从请求头里挑白名单里的 Cookie）。
#
# ★ 页面里没有任何凭据，也不回显凭据 ★
CRED_SYNC_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>同步飞牛登录态 · 本机存储</title>
<style>
 :root{color-scheme:light dark}
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      padding:24px;background:#f4f5f7;color:#1f2329;
      font:15px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
 .card{width:100%;max-width:520px;background:#fff;border-radius:14px;padding:28px 26px;
       box-shadow:0 6px 28px rgba(0,0,0,.08)}
 h1{margin:0 0 6px;font-size:19px}
 .sub{margin:0 0 18px;color:#6b7280;font-size:13px}
 .box{border-radius:10px;padding:14px 16px;background:#f2f3f5;border:1px solid #e5e6eb;font-size:14px}
 .box.ok{background:#e8f5ec;border-color:#b7e0c4;color:#17663a}
 .box.bad{background:#fdefef;border-color:#f5c2c2;color:#a02a2a}
 .lbl{font-weight:600}
 .btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
 button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid #d0d3d9;
        background:#fff;color:#1f2329;cursor:pointer}
 button:hover{border-color:#9aa0a6}
 button.primary{background:#2b6cf6;border-color:#2b6cf6;color:#fff}
 button.primary:hover{background:#1f5ce0}
 button.ghost{color:#6b7280}
 button[hidden]{display:none}
 .hint{margin-top:10px;font-size:12px;color:#8a8f99;word-break:break-all}
 .foot{margin:16px 0 0;color:#8a8f99;font-size:12px}
 @media (prefers-color-scheme:dark){
  body{background:#17181a;color:#e6e8eb}
  .card{background:#232427;box-shadow:none}
  .sub,.hint,.foot,button.ghost{color:#9aa1ab}
  .box{background:#2b2d31;border-color:#3a3d42;color:#cfd3d8}
  .box.ok{background:#1c2f24;border-color:#2f5c40;color:#9fdcb8}
  .box.bad{background:#332222;border-color:#6b3535;color:#f0a8a8}
  button{background:#2b2d31;border-color:#45484d;color:#e6e8eb}
  button.primary{background:#2b6cf6;border-color:#2b6cf6;color:#fff}
 }
</style>
</head>
<body>
<div class="card">
  <h1>同步飞牛登录态</h1>
  <p class="sub">思源桌面端打开 Office / PDF 时要用飞牛的登录态。这一页负责把它交给 NAS 上的「本机存储」服务。</p>
  <div id="box" class="box">正在同步…</div>
  <div class="btns">
    <button id="again" class="primary">重新同步</button>
    <button id="login" hidden>去登录飞牛</button>
    <button id="clear" class="ghost">清除已保存的登录态</button>
  </div>
  <p id="hint" class="hint"></p>
  <p class="foot">同步完成后关闭本页，回到思源即可。</p>
</div>
<script>
(function () {
  var API = "api/fnos-cred";
  var box = document.getElementById("box");
  var hint = document.getElementById("hint");
  var btnAgain = document.getElementById("again");
  var btnLogin = document.getElementById("login");
  var btnClear = document.getElementById("clear");

  function set(state, html) {
    box.className = "box" + (state ? " " + state : "");
    box.innerHTML = html;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // 飞牛自己的登录页在 NAS 的另一个端口上（6806 是思源的入口）：
  //   http -> 5666，https -> 5667（与 nginx 的两条监听对应）。
  //   带 redirect_uri，登录完自动回到本页继续同步。
  function fnosLoginUrl() {
    var p = location.protocol === "https:" ? "5667" : "5666";
    return location.protocol + "//" + location.hostname + ":" + p +
           "/login?redirect_uri=" + encodeURIComponent(location.href);
  }

  function showNoCred() {
    set("bad", '<span class="lbl">没读到飞牛的登录态</span><br>' +
      "浏览器里现在没有飞牛的登录 Cookie（多半是还没在这台机器上登录过飞牛）。<br>" +
      "点「去登录飞牛」登录一次，回来会自动继续同步。");
    btnLogin.hidden = false;
    hint.textContent = "登录页：" + fnosLoginUrl();
  }

  function sync() {
    btnLogin.hidden = true; hint.textContent = "";
    set("", "正在同步…");
    fetch(API, { method: "POST", credentials: "include", cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (j) {
        if (j && j.saved) {
          set("ok", '<span class="lbl">同步成功</span><br>已保存：' +
            esc((j.names || []).join("、")) +
            (j.savedAt ? "（" + esc(j.savedAt) + "）" : ""));
        } else {
          showNoCred();
        }
      })
      .catch(function (e) {
        set("bad", "同步失败：" + esc(e && e.message ? e.message : e) +
          "<br>请确认这个地址就是 NAS 上的思源（6806 端口）。");
      });
  }

  function clear() {
    btnLogin.hidden = true; hint.textContent = "";
    set("", "正在清除…");
    fetch(API, { method: "DELETE", credentials: "include", cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function () { set("", "已清除 NAS 上保存的飞牛登录态。"); })
      .catch(function (e) { set("bad", "清除失败：" + esc(e && e.message ? e.message : e)); });
  }

  btnAgain.addEventListener("click", sync);
  btnClear.addEventListener("click", clear);
  btnLogin.addEventListener("click", function () { location.href = fnosLoginUrl(); });

  sync();
})();
</script>
</body>
</html>
"""


def log(msg: str) -> None:
    """带时间戳写 stdout —— cmd/main 把它重定向进 app.log。"""
    sys.stdout.write("%s - [local-fs] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    sys.stdout.flush()


def current_uid() -> int:
    """当前 uid；Windows（只在开发机上出现）没有这个概念，返回 -1。

    线上飞牛是 Linux，root 跑时这里恒为 0 —— /api/config 的 runsAsRoot
    就是靠它判的。
    """
    fn = getattr(os, "geteuid", None)
    if fn is None:
        return -1
    try:
        return fn()
    except OSError:
        return -1


# ---------------------------------------------------------------------------
# ★ OnlyOffice 缓存清理 ★（策略说明见文件顶部 OO_CACHE_* 配置块）
# ---------------------------------------------------------------------------
def _run_quiet(argv: list[str], timeout: int = 60) -> tuple[int, str]:
    """跑个命令拿 (returncode, stdout+stderr)。找不到可执行文件也算"跑不成"。"""
    import subprocess
    try:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout, check=False)
        return p.returncode, p.stdout.decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, "%s: %s" % (type(e).__name__, e)


def _oo_cache_host_dir() -> str:
    """把「容器内的缓存目录」翻成**宿主机上的真实路径**。

    ★ 为什么不能直接进容器删：删缓存要和 OO 的写操作竞争，进容器还要过
      docker exec 的权限/依赖；直接对宿主目录动手最省事，也最不容易中途失败。
    ★ 为什么必须查 docker inspect：OO 缓存挂在**数据卷**里，卷名由 compose
      决定（真机是 `/vol1/docker/volumes/<hash>/_data`），猜不得。
    ★★ 2026-10-10 实测修正：容器把宿主卷挂到 **`/var/lib/onlyoffice`**
      （不是 `/var/www/onlyoffice/Data`）。所以遍历**所有** mount，对每个
      mount 试着拼 `documentserver/App_Data/cache/files/data` 并验证存在，
      哪个真实存在就用哪个 —— 比写死 destination 稳得多。
    """
    if os.environ.get("LOCAL_FS_OO_CACHE_DIR"):
        return os.environ["LOCAL_FS_OO_CACHE_DIR"]
    # ★ 用 `{{json .Mounts}}` 拿结构化输出，不要自己拼分隔符 ★
    #   实测坑：Go 模板里的 `\t` / `\n` 是**转义后的字面量**（除非写成 {{"\t"}}），
    #   拼出来是一整行 `...\t...\n...`，用 Python 按 "\t" 切永远切不开。
    #   直接吃 JSON 最稳，也不受 mount 里空格/非 ASCII 影响。
    rc, out = _run_quiet([
        "docker", "inspect", OO_CONTAINER, "--format", "{{json .Mounts}}",
    ])
    if rc != 0 or not out.strip():
        # 常见于：容器名不同、docker 不在 PATH、本服务不在宿主（开发机）
        return ""
    try:
        mounts = json.loads(out.strip())
    except Exception:  # noqa: BLE001
        return ""
    if not isinstance(mounts, list):
        return ""
    tail = os.path.join("documentserver", "App_Data", "cache", "files", "data")
    candidates = []
    for m in mounts:
        if not isinstance(m, dict):
            continue
        src = str(m.get("Source") or "").strip()
        if not src:
            continue
        cand = os.path.join(src, tail)
        # ★ 必须**真的存在**才算数（占位目录/空卷会被排除）★
        if os.path.isdir(cand):
            candidates.append(cand)
    if not candidates:
        # 兜底：有些装法把 Data 卷挂到 /var/www/onlyoffice/Data
        return ""
    # 多个卷都命中时取路径最短的（卷名最干净的那个，通常就是 OO 的数据卷）
    return sorted(candidates, key=len)[0]



def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def clean_oo_cache(force: bool = False) -> dict:
    """清一次 OnlyOffice 的文档缓存。返回统计（也直接给 /api/oo-cache 用）。

    force=True ⇒ 无视 TTL 与"正忙"判断（给用户手动点「立即清理」用）。
    """
    started = time.time()
    cache_dir = _oo_cache_host_dir()
    result = {
        "ok": False, "dir": cache_dir, "removed": 0, "freedBytes": 0,
        "totalBytes": 0, "kept": 0, "skipped": "", "force": bool(force),
    }
    if not cache_dir or not os.path.isdir(cache_dir):
        result["skipped"] = "找不到 OnlyOffice 缓存目录（容器没跑 / 卷没挂 / 名字不同）"
        return result

    try:
        entries = []
        for name in os.listdir(cache_dir):
            full = os.path.join(cache_dir, name)
            if not os.path.isdir(full):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            entries.append({"name": name, "path": full, "size": _dir_size(full),
                            "mtime": st.st_mtime})
    except OSError as e:
        result["skipped"] = "读不了缓存目录：%s" % e
        return result

    result["totalBytes"] = sum(e["size"] for e in entries)
    result["kept"] = len(entries)

    # ★ 正忙判断：有很新的条目 ⇒ 有人在编辑，本轮整体跳过（删了正在读的缓存
    #   会让 OO 编辑到一半炸掉 —— 宁可不腾空间也不破坏体验）★
    if not force:
        newest = max((e["mtime"] for e in entries), default=0)
        if newest and (time.time() - newest) < OO_CACHE_BUSY_AGE:
            result["skipped"] = "最近 %d 秒内有活动，本轮跳过" % OO_CACHE_BUSY_AGE
            return result

    # 老的排前面（先删最旧的），且单轮限量 —— 削峰不清空
    candidates = [e for e in entries
                  if force or (time.time() - e["mtime"]) > OO_CACHE_TTL]
    candidates.sort(key=lambda e: e["mtime"])

    import shutil
    freed = 0
    for e in candidates:
        if result["removed"] >= OO_CACHE_MAX_ITEMS:
            break
        if freed >= OO_CACHE_MAX_BYTES:
            break
        try:
            shutil.rmtree(e["path"])
        except OSError as ex:
            log("OO 缓存清理：删不动 %s（%s）" % (e["path"], ex))
            continue
        result["removed"] += 1
        freed += e["size"]

    result["freedBytes"] = freed
    result["kept"] = len(entries) - result["removed"]
    result["ok"] = True

    if result["removed"]:
        log("OO 缓存清理：删 %d 个、释放 %s（原 %s，剩 %d 个）耗时 %.1fs" % (
            result["removed"], _fmt_size(freed),
            _fmt_size(result["totalBytes"]), result["kept"], time.time() - started))
    elif not result["skipped"]:
        log("OO 缓存清理：没有超过 TTL 的条目（共 %d 个 / %s）" % (
            len(entries), _fmt_size(result["totalBytes"])))
    return result


def _fmt_size(n: int) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024 or unit == "TB":
            return "%.1f%s" % (f, unit) if unit != "B" else "%dB" % int(f)
        f /= 1024
    return "%.1fTB" % f


def oo_cache_stat() -> dict:
    """只读地看一眼 OO 缓存现在多大/多少条目（不删任何东西）。"""
    cache_dir = _oo_cache_host_dir()
    out = {"ok": False, "dir": cache_dir, "entries": 0, "totalBytes": 0,
           "oldestAge": 0, "newestAge": 0,
           "clean": {"enabled": OO_CACHE_CLEAN, "ttlSeconds": OO_CACHE_TTL,
                     "intervalSeconds": OO_CACHE_INTERVAL}}
    if not cache_dir or not os.path.isdir(cache_dir):
        out["reason"] = "找不到 OnlyOffice 缓存目录"
        return out
    sizes, ages = [], []
    try:
        for name in os.listdir(cache_dir):
            full = os.path.join(cache_dir, name)
            if not os.path.isdir(full):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            sizes.append(_dir_size(full))
            ages.append(time.time() - st.st_mtime)
    except OSError as e:
        out["reason"] = "读不了缓存目录：%s" % e
        return out
    out["ok"] = True
    out["entries"] = len(sizes)
    out["totalBytes"] = sum(sizes)
    if ages:
        out["oldestAge"] = int(max(ages))
        out["newestAge"] = int(min(ages))
    return out


def _oo_cache_loop() -> None:
    """后台线程：启动后先等一会儿，再周期性清缓存。"""
    # 启动后别立刻扫 —— 服务刚起来时可能正好有人在等着打开文档
    time.sleep(min(120, max(15, OO_CACHE_INTERVAL // 10)))
    while True:
        try:
            clean_oo_cache(force=False)
        except Exception as e:  # noqa: BLE001
            log("OO 缓存清理线程异常（已忽略）：%r" % e)
        try:
            time.sleep(OO_CACHE_INTERVAL)
        except Exception:
            return


def start_oo_cache_cleaner() -> None:
    if not OO_CACHE_CLEAN:
        log("OO 缓存自动清理：已按配置关闭")
        return
    t = threading.Thread(target=_oo_cache_loop, name="oo-cache-clean", daemon=True)
    t.start()
    log("OO 缓存自动清理：已启动（TTL=%dh 间隔=%dmin 单轮上限=%d个/%s）" % (
        OO_CACHE_TTL // 3600, max(1, OO_CACHE_INTERVAL // 60),
        OO_CACHE_MAX_ITEMS, _fmt_size(OO_CACHE_MAX_BYTES)))


# ---------------------------------------------------------------------------
# 存储根
# ---------------------------------------------------------------------------
def detect_storage_roots() -> list[str]:
    """探测浏览根：飞牛上是 /vol1、/vol00… （与 fnos-dwg-viewer 同一套规则）。

    不把 / 当浏览根：那样一进去就是 bin/etc/proc，既没用又容易误触。
    """
    if EXPLICIT_ROOTS:
        return sorted({os.path.realpath(p) for p in EXPLICIT_ROOTS})
    vols = []
    try:
        for name in os.listdir("/"):
            if not re.fullmatch(r"vol\d+", name):
                continue
            full = "/" + name
            try:
                if os.path.isdir(full) and not os.path.islink(full):
                    vols.append(full)
                elif os.path.isdir(full):
                    vols.append(full)
            except OSError:
                # 单个挂载点探测失败就跳过，不影响其它的
                continue
    except OSError:
        pass
    return sorted(vols)


_ROOTS_CACHE: dict = {"at": 0.0, "roots": None}
_ROOTS_TTL = 10.0


def allowed_roots() -> list[str]:
    """带 10 秒缓存的浏览根 —— 外接盘插拔后最多 10 秒就被认出来。"""
    now = time.time()
    if _ROOTS_CACHE["roots"] is None or now - _ROOTS_CACHE["at"] > _ROOTS_TTL:
        _ROOTS_CACHE["roots"] = detect_storage_roots()
        _ROOTS_CACHE["at"] = now
    return _ROOTS_CACHE["roots"]


def root_label(root: str) -> str:
    """顶层显示名：/vol1 → 「存储空间 1」（与飞牛界面的叫法一致）。"""
    p = str(root).replace("\\", "/").rstrip("/")
    m = re.search(r"(?:^|/)vol(\d+)$", p)
    if m:
        return "存储空间 %d" % int(m.group(1))
    return os.path.basename(p) or p


def browse_sources() -> list[dict]:
    """对外给的 path 一律正斜杠 —— 客户端会拿它拼 URL / 当 key，反斜杠会出乱子。"""
    return [{"label": root_label(p), "path": to_client_path(p)} for p in allowed_roots()]


def is_inside(path: str, root: str) -> bool:
    """path 是否在 root 之内。**按正斜杠比较** —— 否则在 Windows（开发机）上
    `C:\\a\\b` 与 `C:\\a/` 永远对不上，子目录一律被判成越界。"""
    p = os.path.realpath(path).replace("\\", "/")
    r = os.path.realpath(root).replace("\\", "/")
    return p == r or p.startswith(r.rstrip("/") + "/")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


def resolve_safe(raw: str) -> str:
    """客户端给的绝对路径 → 真实路径；**必须在浏览根之内**。

    ★ 安全要点：realpath 之后再比前缀，`/vol1/../../etc/passwd` 这类会被挡掉。
      浏览根本身就是全盘可见的（root 直读），但仍不能让人越到 /etc 去。
    ★ 也接受 Windows 盘符路径（`C:/...`）—— 只为让这套服务能在开发机上直接
      跑起来（LOCAL_FS_ROOTS 指向一个临时目录即可），线上飞牛是纯 / 开头。
    """
    p = str(raw or "").replace("\\", "/")
    if not (p.startswith("/") or re.match(r"^[A-Za-z]:/", p)):
        raise ApiError(400, "BAD_PATH", "路径必须是绝对路径：%s" % raw)
    # normpath 不跟符号链接；realpath 跟。两个都做：先规范化挡掉 ..
    norm = os.path.normpath(p)
    real = os.path.realpath(norm)
    for root in allowed_roots():
        if is_inside(real, root):
            return real
    raise ApiError(403, "OUT_OF_SCOPE", "路径不在可访问的存储空间内：%s" % raw)


def to_client_path(abs_path: str) -> str:
    """真实路径 → 客户端看到的绝对路径。"""
    return abs_path.replace("\\", "/")


# ---------------------------------------------------------------------------
# 目录列举
# ---------------------------------------------------------------------------
def sort_items(items: list[dict]) -> list[dict]:
    items.sort(key=lambda x: (0 if x.get("isDir") else 1, x.get("name", "").lower()))
    return items


def can_read(p: str) -> bool:
    return os.access(p, os.R_OK | os.X_OK)


def list_dir(raw_path: str, cad_only: bool = False) -> dict:
    """列目录。raw_path 为 '/' 或空 ⇒ 返回**虚拟根**（各存储空间）。

    cad_only=True 时只列图纸（`?filter=cad`，对齐 fnos-dwg-viewer 的「只要图纸」
    语义，供只想挑图纸的调用方使用）；默认列**全部文件**。
    """
    raw = str(raw_path or "/").replace("\\", "/")

    if raw in ("", "/"):
        items = []
        for src in browse_sources():
            try:
                st = os.stat(src["path"])
            except OSError:
                continue
            items.append({
                "name": src["label"],
                "path": to_client_path(src["path"]),
                "isDir": True,
                "size": st.st_size,
                "mtime": int(st.st_mtime * 1000),
                "ext": "",
                "readable": can_read(src["path"]),
            })
        return {"source": "local", "path": "/", "virtual": True, "items": sort_items(items)}

    abs_path = resolve_safe(raw)
    if not os.path.isdir(abs_path):
        raise ApiError(400, "NOT_A_DIR", "不是一个目录：%s" % raw)

    dir_client = to_client_path(abs_path).rstrip("/")
    items = []
    try:
        entries = os.scandir(abs_path)
    except OSError as e:
        raise ApiError(403, "EACCES", "读不动这个目录：%s（%s）" % (abs_path, e.strerror or e))
    with entries:
        for e in entries:
            # 隐藏两类噪音：
            #   . 开头  —— 常规隐藏文件（.@#local 之类）
            #   @ 开头  —— 飞牛自己的系统目录（@appcenter/@appdata/@appconf…），
            #              摆给用户看只会让人误点，改坏了还是应用的事
            if e.name.startswith(".") or e.name.startswith("@"):
                continue
            try:
                st = e.stat(follow_symlinks=True)
            except OSError:
                continue
            is_dir = os.path.isdir(e.path)
            ext = "" if is_dir else os.path.splitext(e.name)[1].lower()
            if cad_only and not is_dir and ext not in CAD_EXT:
                continue
            items.append({
                "name": e.name,
                "path": "%s/%s" % (dir_client, e.name),
                "isDir": is_dir,
                "size": st.st_size,
                "mtime": int(st.st_mtime * 1000),
                "ext": ext,
            })
    return {"source": "local", "path": dir_client or "/", "items": sort_items(items)}


# 算作「图纸」的后缀。用于 ?filter=cad，以及 CAD 预览链路的分流判据
# （.dwg/.dxf → 飞牛原生「CAD 看图」应用）。
CAD_EXT = {".dwg", ".dxf"}


# ---------------------------------------------------------------------------
# 文件流（支持 Range，音视频要用）
# ---------------------------------------------------------------------------
def parse_range(header: str, size: int):
    """解析 `Range: bytes=a-b`；返回 (start, end) 或 None（=整份）。"""
    if not header or not header.startswith("bytes="):
        return None
    spec = header[len("bytes="):].split(",")[0].strip()
    if spec.startswith("-"):
        # 后缀式：bytes=-500 ⇒ 最后 500 字节
        try:
            n = int(spec[1:])
        except ValueError:
            return None
        if n <= 0:
            return None
        return max(0, size - n), size - 1
    parts = spec.split("-", 1)
    try:
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if len(parts) > 1 and parts[1] else size - 1
    except ValueError:
        return None
    if start > end or start >= size:
        return None
    return start, min(end, size - 1)


# ---------------------------------------------------------------------------
# JWT（OnlyOffice 的签名算法：HS256，payload 就是整份 config）
# ---------------------------------------------------------------------------
def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def jwt_sign(payload: dict, secret: str) -> str:
    """标准 JWT HS256。

    ⚠️ 序列化必须紧凑（separators）且 ensure_ascii=False —— 否则字节不同、
       签名对不上，OnlyOffice 会直接拒掉整份配置（表现为编辑器白屏/报错）。
    """
    header = {"alg": "HS256", "typ": "JWT"}
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    signing_input = "%s.%s" % (_b64u(json.dumps(header, separators=(",", ":")).encode()), _b64u(body))
    sig = hmac.new(secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return "%s.%s" % (signing_input, _b64u(sig))


# ---------------------------------------------------------------------------
# OnlyOffice 配置
# ---------------------------------------------------------------------------
OO_WORD = {"doc", "docx", "docm", "dot", "dotx", "dotm", "odt", "fodt", "rtf", "txt", "html", "htm", "mht", "xml", "epub", "fb2", "djvu", "pdf"}
OO_CELL = {"xls", "xlsx", "xlsm", "xlt", "xltx", "xltm", "ods", "ots", "csv", "fods"}
OO_SLIDE = {"ppt", "pptx", "pptm", "pot", "potx", "potm", "odp", "otp", "fodp"}


def doc_type(ext: str) -> str:
    ext = ext.lstrip(".").lower()
    if ext in OO_CELL:
        return "cell"
    if ext in OO_SLIDE:
        return "slide"
    return "word"


def oo_supported(ext: str) -> bool:
    ext = ext.lstrip(".").lower()
    return ext in OO_WORD or ext in OO_CELL or ext in OO_SLIDE


def file_key(abs_path: str, st: os.stat_result) -> str:
    """document.key：同一文档编辑期间必须不变，内容一变就得变。

    用 路径+mtime纳秒+size 参与哈希 —— 只要文件被写过就换 key，
    否则 OnlyOffice 会拿缓存，用户看到的是编辑前的内容。
    """
    raw = "%s|%d|%d" % (abs_path, st.st_mtime_ns, st.st_size)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:32]


def self_base_for_oo() -> str:
    """OnlyOffice 服务器回取文件时该访问的地址。

    优先级：显式配的 SELF_BASE > 按宿主内网 IP 推。
    ★ 为什么不能是 localhost：请求是 OnlyOffice 容器发起的，它的 localhost
      是它自己。必须是宿主在容器网络里可达的地址。
    """
    if SELF_BASE:
        return SELF_BASE
    ip = detect_host_ip()
    return "http://%s:%d" % (ip, PORT)


def detect_host_ip() -> str:
    """探一个"容器能回来"的宿主 IP。

    做法：拿一个不会真的发包的 UDP connect，内核据此选出默认出口 IP。
    比读 /proc/net/route 稳，也不依赖某个具体网段。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def browser_oo_base(host_header: str) -> str:
    """浏览器加载 api.js 用的 OnlyOffice 地址。

    推导规则（推错会让编辑器白屏，所以宁可退回去也不乱猜）：
      ① 显式配了 LOCAL_FS_OO_PUBLIC ⇒ 用它
      ② Host 是 IP 或 localhost ⇒ 同一台机器的 :OO_PUBLIC_PORT
         （内网 / ZeroTier 两种访问方式各自都能推对）
      ③ Host 是域名（多半是外网穿透 FN Connect）⇒ 用**同源通道**（返回的是
         一个路径，浏览器按当前源解析）。穿透只映射了思源那一个端口，:8082
         够不到，唯一能用的就是经前置反代转过去的这条通道。
         没配同源通道时才退回 OO_URL（编辑器起不来，页面上有可读提示）。
    """
    if OO_PUBLIC:
        return OO_PUBLIC
    host = (host_header or "").split(":")[0].strip()
    if not host:
        return OO_URL
    is_ip = host == "localhost" or bool(re.fullmatch(r"[0-9.]+", host))
    if is_ip and not OO_SAME_ORIGIN_ALWAYS:
        return "http://%s:%s" % (host, OO_PUBLIC_PORT)
    if OO_SAME_ORIGIN:
        return OO_SAME_ORIGIN
    return OO_URL


# （手机 UA 判定已删除：手机上也永不开启移动版，见 effective_layout()）
def effective_layout(layout: str, ua: str) -> str:
    """最终让 OnlyOffice 走哪套编辑器：mobile / desktop。

    ★★ 恒返回 desktop：手机上也永不开启移动版（用户要求）★★

      OO 的移动版（`documenteditor/mobile/`）是另一套界面，缺掉完整的
      「文件 / 开始 / 插入 / 布局 / 引用 / 协作 / 保护 / 视图 / 插件」菜单，
      而用户要的正是那套完整菜单。手机经飞牛 App 打开思源时，内核给的本来
      就是**桌面版**前端（实测 `window.siyuan.isMobile === false`），
      更没必要把编辑器降级成残缺的移动版。

      历史（别走回头路）：先前曾按 UA 把手机兜成 mobile，想借此规避
      「UI 加载了但从不请求文档」那种现象 —— 方向是错的，用户要的是桌面版，
      已回退。入参 `layout` / `ua` 仍然保留，只是为了**调用方签名不变**，
      以及日志要记 UA（真机排查时那是唯一能看到的客户端标识）。
    """
    return "desktop"


def build_oo_config(abs_path: str, mode: str, layout: str, title: str, bare: bool = False) -> dict:
    """生成 DocsAPI config（含 token）。字段含义见 integrations.py 的同名实现。

    bare=False（页签 / 浮层）⇒ **完整编辑界面**：全部标签页 + 插件 + 左栏，
                              不压扁头部（2026-10-10 用户要求）。
    bare=True （嵌入块）    ⇒ 只要文档区，不要工具栏 / 菜单栏。
                              走 OnlyOffice 自己的 customization 开关，不注入任何样式 ——
                              它的编辑器是跨源 iframe，外面注不进去。
    """
    st = os.stat(abs_path)
    ext = os.path.splitext(abs_path)[1].lstrip(".").lower()
    base = self_base_for_oo()
    q = urllib.parse.quote(abs_path, safe="")
    # OnlyOffice 回取文件的地址：走本服务的 /api/file
    doc_url = "%s/api/file/%s?path=%s" % (base, urllib.parse.quote(os.path.basename(abs_path)), q)
    # 保存回调：mount/path 服务端自己回填用
    cb = "%s/oo/callback?path=%s" % (base, q)

    can_write = os.access(abs_path, os.W_OK)
    want_mode = "edit" if (mode == "edit" and can_write) else "view"

    customization = {
        "autosave": True,
        "forcesave": True,
        # ★ 默认值在下面按 bare 覆盖；这里给的是一份"完整界面"基线 ★
        #   2026-10-10：用户要求「页签里的 OO 显示完整编辑菜单」——
        #   页签（非 bare）不再压扁头部、不再关插件/左栏，拿到完整的
        #   「文件 / 开始 / 插入 / 布局 / 引用 / 协作 / 保护 / 视图 / 插件」菜单。
        "compactHeader": False,
        "hideRightMenu": False,
        "uiTheme": "theme-light",
        "plugins": True,
        "leftMenu": True,
        "about": False,
        "feedback": False,
    }

    # ★★ bare：只留文档区 —— 全部用 OnlyOffice **官方**的 customization 开关 ★★
    #
    #   ⚠️ 2026-10-09 修正过一个错误：之前这里写的是
    #        customization["toolbar"] = False
    #        customization["header"]  = False
    #      这两个**不是官方参数**，OnlyOffice 会静默忽略 ——
    #      于是用户报「OO 嵌入块没有隐藏工具栏」（需求 3.2）。
    #      官方 customization 的全部字段见：
    #        https://legacy-api.onlyoffice.com/editors/config/editor/customization
    #      里面**没有** toolbar / header，真正管"界面精简"的是下面这几个。
    #
    #   · integrationMode = "embed"
    #       官方专为「嵌进别人页面」设计的集成模式：去掉 About / 反馈 /
    #       以及一堆外部跳转入口。这是 official 文档里最贴近"只要文档"的开关。
    #   · toolbarNoTabs = True
    #       顶部工具栏不再分「开始/插入/布局…」多标签，压成一条 ——
    #       块里高度有限，多标签占两行太奢侈。
    #   · compactHeader = True
    #       头部压成一行（文件名 + 最小按钮）。
    #   · toolbarHideFileName = True
    #       连那行里的文件名也去掉（块里已经有自己的标题栏了，重复）。
    #   · hideRightMenu = True
    #       藏掉右上角那个「☰」侧边菜单（它一展开就是半个工具栏）。
    #   · hideRulers = True
    #       藏标尺 —— 标尺也算"工具栏"的一部分。
    #   · layout.toolbar.*：新版 OO 把部分入口挪到了 layout 下
    #       （见 9.0 前端定制记录：layout: { toolbar: { plugins: false } }），
    #       把工具栏上的插件入口一并关掉。
    #
    #   ⚠️ 必须在 jwt_sign 之前落进 dict（token 覆盖整份 config）。
    #
    # ★★ 2026-10-10 重大修正：**bare 里绝对不能设 toolbarNoTabs** ★★
    #
    #   用户报「OO 预览或编辑文件报错」，怀疑与"不显示 OO 工具条"有关 —— 属实。
    #   复现：宿主页打开后，内层 iframe 指向
    #       /9.4.0-…/web-apps/apps/documenteditor/main/index_loader.html
    #   而该请求 **404（nginx）**，编辑器整片白屏 —— 页面标题栏下方就是 404。
    #
    #   根因在 OnlyOffice 自己的 api.js（9.4.0）：
    #       const path_type = type==="mobile" ? "mobile"
    #                       : type==="embedded" ? "embed" : "main";
    #       var index = "/index.html";
    #       if (customization.toolbarNoTabs || (targetApp!=='desktop' && (loaderName||loaderLogo)))
    #           index = "/index_loader.html";          // ← 这里
    #       path += index;
    #   而 **index_loader.html 只存在于 `embed/` 与 `mobile/` 子目录**，
    #   `main/` 下只有 `index.html`（真机 docker exec 查过）：
    #       .../documenteditor/embed/index_loader.html     ✔ 有
    #       .../documenteditor/mobile/index_loader.html    ✔ 有
    #       .../documenteditor/main/index.html             ✔ 有
    #       .../documenteditor/main/index_loader.html      ✗ 没有  ⇒ 404
    #   我们传的是 `type:"desktop"` ⇒ 目录落在 `main/` ⇒ 一设 toolbarNoTabs 就必然 404。
    #   （这是 OO 在 "desktop + toolbarNoTabs" 这个组合下的 bug：loader 只给
    #     embed/mobile 两套皮做了，main 那套没做。）
    #
    #   ⇒ 结论：**要留在 main/ 下精简界面，就不能用 toolbarNoTabs**。
    #     精简改用这几个（都在 main 路径下有效、且不会改 loader）：
    #       integrationMode="embed"   → 去掉 About/反馈/一堆外链入口
    #       compactHeader / toolbarHideFileName / hideRightMenu / hideRulers
    #       layout.toolbar.plugins=false（关掉工具栏上的插件入口）
    #
    #   ⚠️ 另外注意：设了 `integrationMode="embed"` 后，api.js 仍按
    #      `type`（desktop）选 main 目录 —— 目录只由 type 决定，
    #      integrationMode 只影响"关掉滚动到 frame / AscEmbed 之类"，不改目录。
    #      实测确认：去掉 toolbarNoTabs 后内层 iframe 回到 `/main/index.html`，200。
    if bare:
        customization["integrationMode"] = "embed"
        customization["compactHeader"] = True
        # ★ 刻意**不设** toolbarNoTabs —— 见上面长注释：它会让 main 路径去找
        #   不存在的 index_loader.html，直接 404。想要"一条工具栏"的效果
        #   由 compactHeader + layout 来近似。
        customization["toolbarHideFileName"] = True
        customization["hideRightMenu"] = True
        customization["hideRulers"] = True
        customization["layout"] = {"toolbar": {"plugins": False}}
        # 明确的"不要聊天/不要评论按钮"（块里没人协作，那些按钮只会占位）
        customization["chat"] = False
        customization["comments"] = False

    cfg: dict = {
        "documentType": doc_type(ext),
        "document": {
            "fileType": ext,
            "key": file_key(abs_path, st),
            "title": title or os.path.basename(abs_path),
            "url": doc_url,
            "permissions": {
                "edit": want_mode == "edit",
                "download": True,
                "print": True,
                "copy": True,
            },
        },
        "editorConfig": {
            "mode": want_mode,
            "lang": "zh-CN",
            "callbackUrl": cb,
            "user": {"id": "siyuan", "name": "思源笔记"},
            "customization": customization,
        },
    }

    # ★ cfg.type 决定 OO 走哪套编辑器 ★
    #   `effective_layout()` 已恒返回 desktop（见其注释：手机上也永不开启移动版），
    #   所以这里实际等于写死 "desktop"；保留这个写法只是因为 layout 还在函数签名上。
    cfg["type"] = "mobile" if layout == "mobile" else "desktop"

    if OO_SECRET:
        cfg["token"] = jwt_sign(cfg, OO_SECRET)
    return cfg


EDITOR_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>__TITLE__</title>
<style>
  html, body { height: 100%; margin: 0; background: #f5f5f5; }
  #editor { height: 100%; }
  #msg { font: 14px/1.7 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
         color: #b3261e; padding: 24px; white-space: pre-wrap; }
</style>
<script>
/* ★ 编辑器页诊断上报 v2（2026-10-10）★
   手机经飞牛 App 打开时，页面跑在对方的 webview 里 —— 拿不到 console，
   而「下载失败」恰恰发生在浏览器侧，服务端日志一片正常，只能靠页面自己回传。

   v1 的教训（别重犯）：探针写的是 `document.querySelector("#editor iframe")`，
   而 **OO 的 api.js 建 iframe 时会先把 placeholder(#editor) 整个换掉** ⇒
   那个选择器永远找不到 iframe，上报回一堆"没有 iframe"的**假阴性**。
   ⇒ v2 一律 `document.querySelectorAll("iframe")` 全局找，并且
     **读进 iframe 内部**（同源可读）—— 真机上那句「下载失败」就写在那一层。

   每次页面加载最多上报 6 条，全部包 try/catch，绝不影响编辑器。 */
(function () {
  var T0 = Date.now();
  var DIAG = "./diag";
  var budget = 45;   /* 每次页面加载最多回传多少条，防止刷爆日志 */
  function send(tag, msg) {
    if (budget-- <= 0) return;
    try {
      var x = new XMLHttpRequest();
      x.open("POST", DIAG, true);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(JSON.stringify({
        tag: tag,
        msg: String(msg == null ? "" : msg).slice(0, 900),
        ua: navigator.userAgent,
        url: location.href,
        dt: Date.now() - T0
      }));
    } catch (e) { /* 诊断不能影响主流程 */ }
  }
  window.addEventListener("error", function (e) {
    send("js-error", (e.message || "") + " @ " + (e.filename || "") + ":" + (e.lineno || 0));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    send("js-reject", (r && r.message) || String(r));
  });

  function snapshot() {
    var fs = document.querySelectorAll("iframe"), out = [];
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i];
      var rec = "[" + i + "] " + String(f.src || "").slice(-100) + " :: ";
      try {
        var d = f.contentDocument;
        if (!d) { rec += "(跨源读不到)"; }
        else {
          var t = (d.body && d.body.innerText) || "";
          rec += t.split(String.fromCharCode(10)).join(" ");
        }
      } catch (e) { rec += "(读不到:" + e.message + ")"; }
      out.push(rec);
    }
    var me = document.getElementById("msg");
    return "iframes=" + fs.length
         + " | #msg=" + (((me && me.textContent) || "").split(String.fromCharCode(10)).join(" "))
         + " || " + out.join(" ;; ");
  }

  // 分档取样：既看"起没起来"，也看"起来之后里面写了什么"
  // ────────────────────────────────────────────────────────────────────
  // v3 新增（2026-10-10）：headless 屏蔽实验已确认，「下载失败」=
  //   OO 去取 /cache/files/data/<key>/Editor.bin 这个请求失败
  //   （把它挡掉就能**精确复现**「文件 视图 思 第1页共1页 … 错误 下载失败 确定」）。
  //   下面三段就是去真机上问清楚：这条请求到底"发没发出去、回来是什么"。
  // ────────────────────────────────────────────────────────────────────

  function short(u) { return String(u || "").replace(/^[a-z]+:\/\/[^/]+/i, "").slice(0, 160); }

  /* ★★ 2026-10-10 10:20 撤掉 iframe 内部 hook（XHR/fetch/WebSocket）★★
     实测教训：加了 hook 之后 OO 自己就报 "The interface language is not loaded"
     —— 根因是 fetch 的包装用错了 this（`of.apply(this, …)` 在严格模式下 this 为
     undefined），把编辑器的资源加载打坏了。
     ⇒ **诊断基建绝不能反过来干扰被测对象**。这里只保留两条零副作用的探针：
       · probePath()  —— 主动探测路径可达性（独立 XHR，不碰 OO）
       · perf()       —— 读 OO 自己的 performance 条目（只读，不介入）
     想知道"WebSocket 通不通"，用 OO 容器侧的 nginx access log 更靠谱（见 16.3）。 */

  // ② 主动探测：/cache 与 /localfs 两条路径在**当前源**下到底可不可达
  //    · /cache/... 是 OO 的"根绝对"路径（反代靠白名单收编给 OO）
  //      ⇒ 403 且 body 是 <center>nginx</center> = 确实打到了 OO（只是缺签名）
  //      ⇒ 200/404 且是思源页面 = 被误判给了内核
  //      ⇒ status=0 = 网络层就没成（代理拦截 / 混合内容 / DNS）
  function probePath(path, tag) {
    try {
      var x = new XMLHttpRequest();
      x.open("GET", path, true);
      x.onloadend = function () {
        send(tag, "status=" + x.status + " len=" + String(x.responseText || "").length
          + " ct=" + (x.getResponseHeader("content-type") || "-")
          + " snip=" + String(x.responseText || "").replace(/\s+/g, " ").slice(0, 90));
      };
      x.send();
    } catch (e) { send(tag + "-err", String(e && e.message)); }
  }
  setTimeout(function () {
    probePath("/cache/__oor_probe__/__oor_probe__", "probe-cache");
    probePath("/localfs/oo-srv/healthcheck", "probe-oosrv");
  }, 3000);

  // ③ iframe 内 performance：/cache/ 那条请求最终是什么结果
  setTimeout(function () {
    try {
      var fs = document.querySelectorAll("iframe");
      if (!fs.length) { send("perf", "没有 iframe"); return; }
      var w = fs[0].contentWindow;
      var es = (w && w.performance ? w.performance.getEntriesByType("resource") : []) || [];
      var hit = [];
      for (var i = 0; i < es.length; i++) { if (/\/cache\//.test(es[i].name)) hit.push(es[i]); }
      send("perf-cache", hit.length
        ? hit.slice(0, 12).map(function (e) {
            return (e.responseStatus === undefined ? "?" : e.responseStatus)
              + "/sz" + e.transferSize + "/" + Math.round(e.duration) + "ms " + short(e.name);
          }).join(" ;; ")
        : ("(iframe 内没有 /cache/ 请求；resource 总数=" + es.length + ")"));
    } catch (e) { send("perf-err", String(e && e.message)); }
  }, 26000);

  [2500, 8000, 16000, 30000, 45000].forEach(function (t) {
    setTimeout(function () { send("frames@" + t, snapshot()); }, t);
  });
})();
</script>
</head>
<body>
<div id="editor"></div>
<div id="msg"></div>
<script src="__APIJS__"></script>
<script>
(function () {
  var cfg = __CONFIG__;
  function fail(text) {
    document.getElementById("editor").style.display = "none";
    document.getElementById("msg").textContent = text;
  }
  if (typeof DocsAPI === "undefined") {
    fail("无法加载 OnlyOffice 编辑器（__APIJS__）。\\n请确认 OnlyOffice 服务在运行，且地址可从本机访问。");
    return;
  }
  try {
    new DocsAPI.DocEditor("editor", cfg);
  } catch (e) {
    fail("编辑器初始化失败：" + (e && e.message ? e.message : e));
  }
})();
</script>
</body>
</html>
"""


def oo_editor_html(abs_path: str, mode: str, layout: str, host: str = "", bare: bool = False) -> str:
    title = os.path.basename(abs_path)
    cfg = build_oo_config(abs_path, mode, layout, title, bare)
    apijs = "%s/web-apps/apps/api/documents/api.js" % browser_oo_base(host)
    html = EDITOR_HTML.replace("__TITLE__", title.replace("<", "&lt;"))
    html = html.replace("__APIJS__", apijs)
    html = html.replace("__CONFIG__", json.dumps(cfg, ensure_ascii=False))
    return html


def handle_oo_callback(abs_path: str, body: bytes) -> dict:
    """OnlyOffice 保存回调。

    只认 status=2（全部用户关闭、可保存）与 6（强制保存）。
    其余（1 编辑中 / 4 无改动 / 3 保存出错 / 7 强制保存出错）一律**不动文件**。
    """
    try:
        data = json.loads(body.decode("utf-8") or "{}")
    except Exception:
        raise ApiError(400, "BAD_BODY", "回调体不是合法 JSON")
    status = int(data.get("status") or 0)
    if status not in (2, 6):
        log("回调忽略：path=%s status=%s" % (abs_path, status))
        return {"error": 0, "message": "ignored status=%s" % status}

    url = data.get("url")
    if not url:
        raise ApiError(400, "NO_URL", "status=%s 但没有 url" % status)

    if not os.path.exists(abs_path):
        raise ApiError(404, "NOT_FOUND", "目标文件已不存在：%s" % abs_path)

    # 记下原属主：服务是 root 跑的，直接写会让属主变成 root，
    # 之后飞牛文件管理器/别的应用可能就不认了。
    st = os.stat(abs_path)
    uid, gid = st.st_uid, st.st_gid
    if not os.access(abs_path, os.W_OK):
        raise ApiError(403, "READONLY", "文件不可写：%s" % abs_path)

    tmp = abs_path + ".local-fs.part"
    total = 0
    try:
        with urllib.request.urlopen(url, timeout=FETCH_TIMEOUT) as resp, open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_WRITE_BYTES:
                    raise ApiError(413, "TOO_BIG", "回调文档超过上限")
                f.write(chunk)
        os.replace(tmp, abs_path)
    except ApiError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    except Exception as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise ApiError(502, "FETCH_FAIL", "下载编辑后的文档失败：%s" % e)

    # 还原属主（root 才能 chown；失败也不影响内容）
    try:
        os.chown(abs_path, uid, gid)
    except OSError:
        pass

    log("已保存：%s（%d 字节，status=%s）" % (abs_path, total, status))
    return {"error": 0}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "siyuan-local-fs/" + APP_VERSION
    protocol_version = "HTTP/1.1"

    # ---- 基础工具 -------------------------------------------------------
    def log_message(self, fmt, *args):  # 压掉默认的逐请求日志（太吵）
        pass

    def _cors(self):
        origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range, Authorization, X-Requested-With")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _text(self, status: int, text: str, ctype="text/plain; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _html(self, html: str):
        """编辑器页（含当次生成的 OnlyOffice config）—— **绝不能被缓存**。

        ★ 2026-10-10 实测踩到：这里原来走 `_text()`，而 `_text` **不带 Cache-Control**
          ⇒ 手机 App 的 webview 会按启发式规则缓存这个页面。后果有两层：
          ① 换了文件 / 换了 UA 之后仍拿旧 config（token 与 file key 都是当次生成的）；
          ② **部署了新的诊断探针也刷不上去** —— 排查时会造成"改了没用"的假象。
          手机上的 webview 缓存极难清（没有开发者工具），所以从服务端堵死。
        """
        body = html.encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _err(self, e: ApiError):
        payload = {"error": e.message, "code": e.code}
        payload.update(e.extra)
        self._json(e.status, payload)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return b""
        return self.rfile.read(n)

    # ---- 路由 -----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self._route()

    def do_GET(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_PUT(self):
        self._route()

    def do_DELETE(self):
        self._route()

    def _route(self):
        try:
            parsed = urllib.parse.urlsplit(self.path)
            pathname = urllib.parse.unquote(parsed.path)
            qs = urllib.parse.parse_qs(parsed.query)

            # 前缀归一（见 BASE_PREFIX 的说明）：/localfs/xxx → /xxx
            if BASE_PREFIX:
                if pathname == BASE_PREFIX:
                    pathname = "/"
                elif pathname.startswith(BASE_PREFIX + "/"):
                    pathname = pathname[len(BASE_PREFIX):]

            def q(name, default=""):
                v = qs.get(name)
                return v[0] if v else default

            if pathname in ("/health", "/api/health"):
                return self._json(200, {
                    "ok": True, "app": APP_ID, "version": APP_VERSION,
                    "oo": bool(OO_URL), "roots": allowed_roots(),
                })

            if pathname == "/api/config":
                roots = allowed_roots()
                return self._json(200, {
                    "app": APP_ID,
                    "version": APP_VERSION,
                    "port": PORT,
                    "multiRoot": True,
                    "localRoot": "",
                    "localRootName": "存储空间",
                    "allowedRoots": [to_client_path(r) for r in roots],
                    "sources": browse_sources(),
                    "defaultSource": "local",
                    "accessMode": "root" if current_uid() == 0 else "user",
                    "unrestricted": True,
                    "storageRoots": [to_client_path(r) for r in roots],
                    "runsAsRoot": current_uid() == 0,
                    "uid": current_uid(),
                    "onlyoffice": {"enabled": True, "url": OO_URL},
                    "selfBase": self_base_for_oo(),
                })

            if pathname == "/api/doctor":
                roots = allowed_roots()
                return self._json(200, {
                    "ok": True,
                    "app": APP_ID,
                    "version": APP_VERSION,
                    "uid": current_uid(),
                    "runsAsRoot": current_uid() == 0,
                    "allowedRoots": [to_client_path(r) for r in roots],
                    "rootsDetail": [
                        {"path": to_client_path(r), "label": root_label(r), "readable": can_read(r)}
                        for r in roots
                    ],
                })

            # 「有没有配 WebDAV 数据源」的探询。本服务只有本机存储，明确回
            # 「没配」—— 留着是为了兼容性（老版本内置查看器、以及任何沿用
            # 同一套接口的客户端），免得它们把 404 的 JSON 解析错。
            if pathname == "/api/session":
                return self._json(200, {
                    "configured": False, "url": "", "user": "", "remembered": False,
                })

            if pathname == "/api/list":
                cad_only = q("filter") == "cad"
                return self._json(200, list_dir(q("path") or "/", cad_only=cad_only))

            if pathname == "/api/probe":
                p = q("path")
                if not p:
                    raise ApiError(400, "BAD_PATH", "缺少 path 参数")
                abs_path = resolve_safe(p)
                st = os.stat(abs_path)
                if not os.path.isfile(abs_path):
                    raise ApiError(400, "NOT_A_FILE", "这是一个目录，不是文件")
                return self._json(200, {
                    "ok": True, "source": "local",
                    "path": to_client_path(abs_path),
                    "name": os.path.basename(abs_path),
                    "size": st.st_size,
                    "ext": os.path.splitext(abs_path)[1].lower(),
                })

            if pathname == "/api/file" or pathname.startswith("/api/file/"):
                # download=1 ⇒ 强制"另存为"。
                # ★ 为什么要服务端表态 ★ 插件有时是**跨源**调本服务
                #   （比如 http://<nas>:8021），而 HTML 的 <a download> 属性
                #   在跨源时被浏览器忽略；只有 Content-Disposition: attachment
                #   才真的会让它下载。同源时两种都能用。
                return self._serve_file(q("path"), q("download") not in ("", "0", "false"))

            if pathname == "/oo/editor":
                # bare=1 ⇒ 只要文档区，不要工具栏/菜单栏（嵌入块与页签里用）
                return self._oo_editor(q("path"), q("mode", "edit"), q("layout", "desktop"),
                                       bare=(q("bare") not in ("", "0", "false")))

            if pathname == "/oo/callback":
                return self._oo_callback(q("path"))

            # ★ 编辑器页的诊断回传（2026-10-10）★
            #   手机（飞牛 App 的 webview）上没有 console，编辑器失败时服务端
            #   一片正常 ⇒ 让页面自己把 js 错误 / iframe 状态回传到这里。
            #   只写日志，不看也删不掉（日志文件本来就会轮转）。
            if pathname == "/oo/diag":
                return self._oo_diag()

            if pathname == "/api/write":
                return self._write_file(q("path"))

            # ★ OnlyOffice 缓存：看一眼 / 立刻清一次（2026-10-10 新增）★
            if pathname == "/api/oo-cache":
                if self.command == "POST":
                    # force=1 ⇒ 无视 TTL 与"忙碌"判断（用户手动点「立即清理」）
                    return self._json(200, clean_oo_cache(
                        force=(q("force") not in ("", "0", "false"))))
                return self._json(200, oo_cache_stat())

            # ★ 飞牛登录凭据：状态 / 「同步当前浏览器登录态」/ 清除 ★
            #   见文件上方 FNOS_CRED_FILE 的注释。插件在**浏览器或手机**里点
            #   「同步」时发这个 POST —— 浏览器会自动带上 cookie，本服务把
            #   白名单里的那几个挑出来存到本机，供反代替桌面端补上。
            #   ★ 只回状态，永不回显凭据本身 ★
            if pathname == "/api/fnos-cred":
                if self.command == "POST":
                    res = fnos_cred_save(self.headers.get("Cookie") or "")
                    log("飞牛凭据同步：saved=%s names=%s" % (res.get("saved"), res.get("names")))
                    return self._json(200, res)
                if self.command == "DELETE":
                    res = fnos_cred_clear()
                    log("飞牛凭据已清除：%s" % res)
                    return self._json(200, res)
                return self._json(200, fnos_cred_stat())

            # ★ 飞牛登录态同步页（2026-10-10 新增）★
            #   桌面思源客户端拿不到 NAS 的飞牛 Cookie（见 FNOS_CRED_FILE 那段注释），
            #   而浏览器里有。⇒ 本服务出一个**同源页面**：在浏览器里打开它，它自己
            #   发 POST，浏览器自动带上飞牛 Cookie，本服务挑出白名单里的存好。
            #   插件在桌面端只负责 window.open 这个地址（见其 fnosCredPageUrl）。
            #   ★ 页面不含也不回显任何凭据 ★
            if pathname == "/cred-sync":
                return self._html(CRED_SYNC_HTML)

            # ★ 本服务只提供 API（外加一个 /cred-sync 同步页），没有别的页面 ★
            #   这里曾经是"内置 DWG 查看器前端 + SPA 兜底"。2026-10-10 起
            #   CAD 预览改为**借用飞牛原生「CAD 看图」应用**
            #   （fnos-dwg-viewer :8020，经反代的 /localfs/cad/* 同源通道，
            #    与「文件预览」借 :8030 完全同构）⇒ 内置查看器连同它的
            #   22MB 产物（app/local-fs-dist/）一起删掉了，别再把页面挂回来。
            #   留着这条 404 是为了让"误敲根路径"的人一眼看懂：
            #   服务在跑（有响应），只是这里本来就不提供页面。
            raise ApiError(404, "NO_PAGE",
                           "本服务只提供接口（/api/*）。\n"
                           "图纸预览请用飞牛原生「CAD 看图」应用，或经 /localfs/cad/ 访问。")

        except ApiError as e:
            return self._err(e)
        except BrokenPipeError:
            return
        except Exception as e:  # noqa: BLE001
            log("未捕获异常 %s: %r" % (self.path, e))
            try:
                return self._json(500, {"error": "服务内部错误：%s" % e, "code": "INTERNAL"})
            except Exception:
                return

    # ---- 文件 -----------------------------------------------------------
    def _serve_file(self, raw_path: str, as_attachment: bool = False):
        if not raw_path:
            raise ApiError(400, "BAD_PATH", "缺少 path 参数")
        abs_path = resolve_safe(raw_path)
        if not os.path.isfile(abs_path):
            raise ApiError(400, "NOT_A_FILE", "这是一个目录，不是文件")
        st = os.stat(abs_path)
        size = st.st_size

        # 保守地识别一下类型：库里没有的按扩展名补
        ctype = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"
        ext = os.path.splitext(abs_path)[1].lower()
        if ext == ".dxf":
            ctype = "application/dxf"
        elif ext == ".dwg":
            ctype = "application/acad"

        name = os.path.basename(abs_path)
        ascii_name = re.sub(r"[^\x20-\x7e]", "_", name).replace('"', "_") or "file"
        kind = "attachment" if as_attachment else "inline"
        disposition = "%s; filename=\"%s\"; filename*=UTF-8''%s" % (
            kind, ascii_name, urllib.parse.quote(name))

        rng = parse_range(self.headers.get("Range", ""), size)
        if rng is None:
            start, end = 0, size - 1
            status = 200
        else:
            start, end = rng
            status = 206

        length = max(0, end - start + 1)
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Disposition", disposition)
        self.send_header("Cache-Control", "no-store")
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        if self.command == "HEAD":
            return

        remaining = length
        with open(abs_path, "rb") as f:
            f.seek(start)
            while remaining > 0:
                chunk = f.read(min(1024 * 256, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                try:
                    self.wfile.write(chunk)
                except BrokenPipeError:
                    return

    def _write_file(self, raw_path: str):
        """PUT 覆盖写（给「下载到本机编辑后回传」用）。原子写 + 保留属主。"""
        if not raw_path:
            raise ApiError(400, "BAD_PATH", "缺少 path 参数")
        abs_path = resolve_safe(raw_path)
        body = self._body()
        if len(body) > MAX_WRITE_BYTES:
            raise ApiError(413, "TOO_BIG", "文件超过上限")
        uid = gid = None
        if os.path.exists(abs_path):
            st = os.stat(abs_path)
            uid, gid = st.st_uid, st.st_gid
        tmp = abs_path + ".local-fs.part"
        try:
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, abs_path)
        except OSError as e:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise ApiError(500, "WRITE_FAIL", "写入失败：%s" % e)
        if uid is not None:
            try:
                os.chown(abs_path, uid, gid)
            except OSError:
                pass
        return self._json(200, {"ok": True, "path": to_client_path(abs_path), "size": len(body)})

    # ---- OnlyOffice -----------------------------------------------------
    def _oo_editor(self, raw_path: str, mode: str, layout: str, bare: bool = False):
        if not raw_path:
            raise ApiError(400, "BAD_PATH", "缺少 path 参数")
        abs_path = resolve_safe(raw_path)
        if not os.path.isfile(abs_path):
            raise ApiError(400, "NOT_A_FILE", "这是一个目录，不是文件")
        ext = os.path.splitext(abs_path)[1].lower()
        if not oo_supported(ext):
            raise ApiError(400, "UNSUPPORTED", "OnlyOffice 不支持这种格式：%s" % ext)
        # ★ 一律 desktop（永不开启移动版，用户要求）；日志仍然保留 ★
        #   真机排查时日志里那一行 UA 是唯一能看到的客户端标识，
        #   能直接读出"调用方要的是什么 / 实际走了哪套 / 什么 UA"。
        ua = self.headers.get("User-Agent") or ""
        want = (layout or "").strip().lower() or "desktop"
        layout = effective_layout(layout, ua)
        if want == "mobile":
            log("编辑器 layout 固定 desktop（调用方要 mobile，已按用户要求忽略）：UA=%s path=%s"
                % (ua[:120], abs_path))
        else:
            log("编辑器：layout=%s mode=%s bare=%s host=%s xfp=%s ua=%s path=%s"
                % (layout, mode, "1" if bare else "0",
                   self.headers.get("Host") or "",
                   self.headers.get("X-Forwarded-Proto") or "-",
                   ua[:120], abs_path))
        return self._html(oo_editor_html(abs_path, mode, layout,
                                         self.headers.get("Host") or "", bare))

    def _oo_callback(self, raw_path: str):
        if not raw_path:
            raise ApiError(400, "BAD_PATH", "缺少 path 参数")
        abs_path = resolve_safe(raw_path)
        result = handle_oo_callback(abs_path, self._body())
        return self._json(200, result)

    def _oo_diag(self):
        """收下编辑器页回传的诊断事件，写一行日志（前缀固定 `[oo-diag]`）。

        为什么需要它：手机经飞牛 App 打开时页面跑在对方 webview 里，
        开发者工具接不上去；而「下载失败」发生在浏览器侧，服务端日志看不出
        任何异常 —— 唯一能取证的办法就是让页面自己把事件回传。
        只写日志、不回敏感内容；解析失败也不报错（诊断不该影响主流程）。
        """
        try:
            data = json.loads(self._body().decode("utf-8") or "{}")
        except Exception:
            data = {}
        log("[oo-diag] %s | %s | ua=%s | host=%s xfp=%s xfhost=%s origin=%s | %s" % (
            data.get("tag") or "?",
            data.get("msg") or "",
            (data.get("ua") or "")[:100],
            self.headers.get("Host") or "",
            self.headers.get("X-Forwarded-Proto") or "-",
            self.headers.get("X-Forwarded-Host") or "-",
            self.headers.get("Origin") or "-",
            data.get("url") or "",
        ))
        return self._json(200, {"error": 0})

# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------
def write_pid(pid_file: str) -> None:
    if not pid_file:
        return
    try:
        with open(pid_file, "w") as f:
            f.write(str(os.getpid()))
    except OSError as e:
        log("写 PID 文件失败 %s: %s" % (pid_file, e))


def main() -> int:
    pid_file = sys.argv[1] if len(sys.argv) > 1 else ""

    class Server(ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    try:
        srv = Server(("0.0.0.0", PORT), Handler)
    except OSError as e:
        log("无法监听 0.0.0.0:%d —— %s" % (PORT, e))
        return 1

    write_pid(pid_file)
    log("已启动：0.0.0.0:%d uid=%d 存储空间=%s" % (PORT, current_uid(), ",".join(allowed_roots()) or "(无)"))
    log("OnlyOffice=%s 回取地址=%s" % (OO_URL, self_base_for_oo()))

    def _bye(signum, _frame):
        log("收到信号 %d，退出" % signum)
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _bye)
    signal.signal(signal.SIGINT, _bye)

    # ★ 起后台缓存清理线程（用户要求「自动清理 oo 缓存空间」）★
    start_oo_cache_cleaner()

    try:
        srv.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        if pid_file:
            try:
                os.remove(pid_file)
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
