#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
思源笔记（飞牛原生应用）· 前置反向代理

═══ 为什么需要这一层 ═══════════════════════════════════════════════
思源内核（3.8.6）在 WebSocket 升级时做同源校验，不通过就直接拒连：

    serve.go:1799  handle command failed: websocket: request origin not allowed
                   by Upgrader.CheckOrigin
    session.go:316 invalid session request origin

后果是：**页面能打开、密码也能提交成功，但 WebSocket 建不起来**，
前端拿不到会话，停在 Unauthorized —— 手机端就是这样卡住的。

用 curl 逐条打 /ws 实测，规则简单得很：

    Host=127.0.0.1:6806   Origin=https://office.app.5ddd.com:38981   → 403
    Host=<任意>           Origin=<与 Host 一致>                       → 101
    Host=<任意>           不带 Origin                                 → 101

即：**只要 Origin 的 host 与请求里的 Host 相同就放行**（scheme 不参与比较）。

飞牛手机 App 打开应用用的是外网穿透域名（FN Connect）。穿透层把请求转给
本机时把 **Host 改写成了内网地址**，而 Origin 仍是穿透域名 —— 两者永远
对不上，于是每次升级都被判失败，每 3 秒重连一次，日志里刷满 CheckOrigin。

═══ 它做什么 ═════════════════════════════════════════════════════
夹在内核前面，把请求头里的 **Origin 的 host 部分**改写成与 Host 一致
（scheme 保持原样，例如 https 仍然是 https）。除此之外：

  · 不改 Host、不改路径、不改 body、不改任何其它请求头
  · 响应方向一个字节都不过手，原样透传
  · WebSocket 升级后转入纯字节双向转发（全双工，不缓冲、不改帧）
  · 正确处理 keep-alive（逐请求解析，不是"只改第一条"）
  · 万一碰到非 HTTP/1.x 的流量，退化成盲转发，绝不吞数据
  · ★ 改 Origin 只针对**发往内核**的请求；/localfs/* 那份原样保留 ★
    见下面"顺带一条同源通道"末尾的说明。

═══ 顺带一条同源通道 ═══════════════════════════════════════════
另一个后端「本机文件服务」（app/local-fs.py，默认 :8021）也挂在这个端口上，
路径前缀 /localfs/ 就是它的门牌（前缀原样转发，由它自己剥）：

    /            /ws /api/... → 内核 :16806
    /localfs/...             → 本机文件服务 :8021
    /localfs/oo-srv/...      → OnlyOffice 文档服务 :8082（剥前缀）
    /localfs/fv/...          → 文件预览 fnos-file-viewer :8030（剥前缀）
    /localfs/cad/...         → CAD 看图 fnos-dwg-viewer :8020（剥前缀；
                                ★ 正规入口是 /localfs/cad/open?path=…
                                  另外收编它的 /assets/<产物名> + 正文补前缀）
    /localfs/docs/...        → 飞牛官方「Office文档」trim.docs :5666
                                （★ 剥的是 **/localfs**，上游看到 /docs/preview）
    /docs/...、/onlyoffice/... → 同上，根绝对命名空间（不剥前缀）

为什么要这么做：飞牛手机 App 走的是**外网穿透**（FN Connect），穿透层只
映射了思源这一个端口 —— 浏览器根本够不到 8021 / 8082 / 8030 / 8020。挂到同源之后，
插件只要用 `${当前访问源}/localfs/...`，内网、ZeroTier、外网穿透三种走法全都成立。

★ CAD 那条为什么还要"正文改写" ★
  另外三条只要剥前缀就够（它们引的都是相对路径或自己的独有命名空间）。
  fnos-dwg-viewer 例外：它写死了一批**根绝对**引用，而且落在 **/assets/** 与
  **/api/** 这两个**属于思源内核**的命名空间里（笔记图片就在 /assets/<file>）。
  抢不得，所以只能把送出的 HTML/JS/CSS 正文里那几处补上 /localfs/cad 前缀。
  详见 CAD_PREFIX 那一节。

★ 分流是**逐请求**判定的，不是"一条连接定终身" ★
  浏览器对同一个源会复用 keep-alive 连接：代理自己发的 /api/... 和你插件发的
  /localfs/... 很可能是同一条 TCP 连接上的前后两个请求。所以上游是按每个请求
  的路径现挑的，路径变了就换一条上游（旧的那条由我们主动断掉，且不牵连客户端）。

★ Origin 改写只给内核，不给其它后端 ★
  文件服务要靠请求里的 Origin 回显 `Access-Control-Allow-Origin`，跨源调用
  （思源桌面客户端 → NAS 上的这个服务）才不被浏览器拦。要是把 Origin 一并
  改写成代理自己的 Host，回显出来的 ACAO 就跟页面不同源，浏览器直接拒绝，
  console 会被 CORS 报错刷屏。所以这里按上游分流：内核改、其余不改。

监听端口 = 对外服务端口（manifest 的 service_port，默认 6806）；
内核被挪到内网端口（默认 16806）只给本代理访问。

启用/停用：由 cmd/main 负责随应用一起启停；代理挂了应用中心会显示"已停用"。
"""

import json
import os
import re
import socket
import ssl
import sys
import threading
import time

# ── 配置（全部可被 cmd/main 用环境变量覆盖） ────────────────────────
LISTEN_HOST = os.environ.get('PROXY_LISTEN_HOST') or '0.0.0.0'
LISTEN_PORT = int(os.environ.get('PROXY_LISTEN_PORT') or '6806')
UPSTREAM_HOST = os.environ.get('PROXY_UPSTREAM_HOST') or '127.0.0.1'
UPSTREAM_PORT = int(os.environ.get('PROXY_UPSTREAM_PORT') or '16806')

# ── ★ HTTPS 监听（2026-10-11 加）★ ────────────────────────────────
# ★ 为什么必须有它 ★
#   思源桌面端（微软商店版）开了「网络伺服」后，**渲染页面跑在
#   `https://127.0.0.1:<随机端口>`**（本机实测：conf.json 的
#   system.networkServe=true，内核自己签了 CA「SiYuan Local CA」并把
#   服务包成 HTTPS）。
#   而插件给 Office / CAD / 文件预览拼的是**跨源到 NAS 反代**的地址，
#   一旦反代只有 HTTP ⇒ 页面是 https、iframe 是 http
#   ⇒ **Chromium 混合内容策略直接拦掉整个 iframe**，内层 OO 的 css /
#   几百个 XHR / WebSocket / **全部图标 PNG** 也被逐个拦（日志刷屏
#   "requested an insecure image … has been blocked"）。
#   用户看到的就是"Office 工具栏只剩零星几个点"，而 6806 网页版
#   （HTTP→HTTP）完全正常。
#   ⇒ 反代**同时**监听 HTTPS，插件按页面协议自适应（见 api.js 的
#     pageScheme）：https 页面拼 https、http 页面拼 http，两种都活。
#
# ★ 证书从哪来 ★
#   直接用**思源工作区 conf/ 里那套**（ca.crt/cert.pem/key.pem）——
#   内核自己生成、SAN 已覆盖 NAS 的各网卡地址（实测本机：
#   `DNS:localhost, 127.0.0.1, 172.16.30.128, 192.168.193.70, ::1`），
#   且**思源桌面端 Electron 天然信任自己的本地 CA** ⇒ 桌面端零报警。
#   路径与开关由 cmd/main 通过环境变量传入（PROXY_TLS_*）；
#   不传就是不启用（保持纯 HTTP 行为，向后兼容）。
#
# ★★ 为什么 HTTPS 与 HTTP **共用 6806 这一个端口** ★★
#   插件拼的是 `https://<nas>:6806/…`（端口号与 HTTP 一致，见 api.js 的
#   PROXY_PORT 常量，全项目只认这一个数字）。让 HTTPS 另起端口会牵动
#   插件、穿透映射、文档一大堆地方，得不偿失。
#   ⇒ 用**首字节嗅探**分流：TLS 的 ClientHello 第一条记录类型恒为
#     `0x16`（handshake），HTTP 请求行恒以字母开头（GET/POST/…）
#     ⇒ accept 之后 `recv(1, MSG_PEEK)` 一眼就能分出该走哪条路。
#     这也是业界标准做法（nginx 的 `ssl_preread`、HAProxy 的
#     `tcp-request inspect-delay` 同理），对本项目零额外成本。
TLS_CERT = os.environ.get('PROXY_TLS_CERT') or ''
TLS_KEY = os.environ.get('PROXY_TLS_KEY') or ''
# 开关：证书两个都给齐了才启用（缺一视为不启用，绝不让代理因为证书起不来）
TLS_ENABLED = bool(TLS_CERT and TLS_KEY)

# ── 本机文件服务的同源通道 ──────────────────────────────────────────
# ★ 为什么需要它 ★
#   插件要用 :8021 那个文件服务（列目录、读文件、内置图纸查看器）。而飞牛手机
#   App 是经**外网穿透**（FN Connect）访问的，穿透只映射了思源这一个端口
#   —— 浏览器根本够不到 8021，插件在手机上就是空的。
#   ⇒ 让 /localfs/* 经本代理转发到文件服务，插件只需用同源地址
#      `${当前访问源}/localfs/...`，内网、ZeroTier、外网穿透三种走法全都成立。
#
#   路径**原样转发**（不做剥前缀）：文件服务自己认这个前缀（见其 BASE_PREFIX），
#   这样它同时支持"直连 8021"和"经这里转发"两种入口。
LOCAL_FS_PREFIX = (os.environ.get('PROXY_LOCAL_FS_PREFIX') or '/localfs').encode()
LOCAL_FS_HOST = os.environ.get('PROXY_LOCAL_FS_HOST') or '127.0.0.1'
LOCAL_FS_PORT = int(os.environ.get('PROXY_LOCAL_FS_PORT') or '8021')

# ── OnlyOffice 的同源通道 ───────────────────────────────────────────
# ★ 为什么需要它 ★
#   内置的 Office 预览/编辑要浏览器去加载 OnlyOffice 的 api.js 与编辑器页面
#   （文档服务默认在 :8082）。内网 / ZeroTier 直连时用 `http://<同一个IP>:8082`
#   就行；但手机走**外网穿透（FN Connect）**时只映射了思源这一个端口，:8082
#   根本够不到 —— 页面上就是"无法加载 OnlyOffice 编辑器"（报错地址是
#   127.0.0.1:8082，因为那时推不出可用地址只能退回默认值）。
#   ⇒ 把文档服务也挂到同一个源下面：`/localfs/oo-srv/*` → 文档服务 :8082/*。
#     浏览器只需要访问思源那个端口，三种走法（内网/ZeroTier/穿透）全都成立，
#     顺带解决 https 页面加载 http 资源的混合内容问题。
#
# ★ 与 /localfs 的差别：这里要**剥掉前缀** ★
#   文件服务自己认 /localfs 前缀（见其 BASE_PREFIX），所以原样转发；
#   而 OnlyOffice 不认识任何前缀（它以为自己在站点根目录），必须把
#   /localfs/oo-srv 摘掉再给它。
#
# ★ 前缀刻意放在 /localfs 下面 ★
#   这样分流判定只要看最外层前缀，顺序简单；而且文档服务那边的相对引用
#   （resources/…、sdkjs/…）会自然落在前缀里，不需要额外规则。
#
# ★ 但只有前缀还不够（踩过）★
#   编辑器还有一批**根绝对**引用（写死以 / 开头，如 /cache/files/data/<key>/Editor.bin、
#   /<版本号>/web-apps/…）。浏览器按当前源解析 ⇒ 打到思源内核 ⇒ 返回 200 但内容不对
#   ⇒ 文档服务报"文件内容与文件扩展名不匹配"。必须在代理层把这些**根绝对**路径
#   也收编给文档服务（见 _OO_ROOT_PREFIXES / is_oo_root），
#   同时用 is_siyuan_owned 保证思源自己的路径优先、永不被抢。
OO_PREFIX = (os.environ.get('PROXY_OO_PREFIX') or '/localfs/oo-srv').encode()
OO_HOST = os.environ.get('PROXY_OO_HOST') or '127.0.0.1'
OO_PORT = int(os.environ.get('PROXY_OO_PORT') or '8082')

# ── 文件预览（file-viewer）的同源通道 ───────────────────────────────
# ★ 为什么需要它 ★
#   「文件预览」是**另一个飞牛原生应用**（fnos-file-viewer，默认 :8030），
#   插件要把非 CAD / 非 Office 的格式都交给它渲染。而手机走外网穿透
#   （FN Connect）时只映射了思源这一个端口，:8030 根本够不到 —— 又是同一个
#   老问题。⇒ 挂一条 /localfs/fv/* → :8030。
#
# ★ 这里必须**剥前缀** ★
#   file-viewer 以为自己在站点根目录（它引 /app.js、/app.css、/favicon.svg、
#   /file-viewer/dist/…、/api/…），所以前缀要摘掉再给它。
#
# ★ 但只有前缀还不够（和 OnlyOffice 是同一个坑）★
#   它同样有一批**根绝对**引用（/app.js、/app.css、/favicon.svg、
#   /file-viewer/dist/**、/api/**）。浏览器按当前源解析 ⇒ 打到思源内核
#   ⇒ 200 但内容不对（拿回一坨 HTML），预览组件自然起不来。
#   ⇒ 见 _FV_ROOT_PREFIXES / is_fv_root：把这些命名空间收编给 file-viewer。
#   ★ 唯一例外是它的 /api/<短名> 六个端点 —— 那要走 _FV_API_EXACT / is_fv_api，
#     并且在 is_siyuan_owned **之前**判（内核对这六个全部 404，不是内核的路径）。
#     这一层是 2026-10-09 真机踩出来的：漏了它，前端就会报
#     「服务返回了非 JSON 内容（HTTP 404）」。
FV_PREFIX = (os.environ.get('PROXY_FV_PREFIX') or '/localfs/fv').encode()
FV_HOST = os.environ.get('PROXY_FV_HOST') or '127.0.0.1'
FV_PORT = int(os.environ.get('PROXY_FV_PORT') or '8030')

# ★ file-viewer 自己的根绝对命名空间（实测枚举出来的，见 web/index.html 与 app.js）★
#   · /file-viewer/dist/** —— 预览组件产物（vendor / wasm / renderers 都在里面）
#   · /app.js /app.css /favicon.svg —— 它自己的页面资源
#   ⚠️ 它的 /api/**（config/doctor/list/probe/file/health）是**精确**匹配，
#      见下面的 _FV_API_EXACT —— 不能按前缀收编（会把思源的 /api/system/** 抢走）。
_FV_ROOT_PREFIXES = tuple(
    p.encode() for p in (
        os.environ.get('PROXY_FV_ROOT_PREFIXES') or
        '/file-viewer'
    ).split(',') if p
)
# 这几个是"完全相等才算"的：/api 不能按前缀收编（会把思源的接口抢走）。
_FV_ROOT_EXACT = tuple(
    p.encode() for p in (
        os.environ.get('PROXY_FV_ROOT_EXACT') or
        '/app.js,/app.css,/favicon.svg'
    ).split(',') if p
)

# ★ file-viewer 自己的 /api/** 端点 —— 必须**逐个精确**收编 ★
#   坑（2026-10-09 真机实证）：file-viewer 的前端把接口写成**根绝对**
#   （`fetch('/api/list')`、`streamUrl = '/api/file?…'`），页面被挂到
#   /localfs/fv/ 下之后，浏览器按**当前源**解析 ⇒ 打到 http://<nas>:6806/api/list
#   ⇒ 落到思源内核。内核对这些路径一律回 `404 page not found`（text/plain），
#   而前端 `api()` 里是 `await res.json()` ⇒ 抛「服务返回了非 JSON 内容（HTTP 404）」。
#   （用户看到的「HTTP 200」版本来自另一个前端分支：config/list 等在别的
#     挂载点下会命中内核的 HTML 兜底页 —— 同样是"能回 200 但内容不对"。）
#
#   为什么可以精确收编而不怕抢内核：内核自己的接口是 /api/system/**、
#   /api/filetree/**、/api/petal/** 等——**没有**下面这六个短名。实测内核
#   对 /api/config、/api/doctor、/api/list、/api/probe、/api/file 全部 404。
#   ⇒ 只在这六个**完全相等**时归 file-viewer，内核其余 /api/** 一律不动。
#   ⚠️ 顺序：这条判定必须在 is_siyuan_owned **之前**（见 pick_upstream ④′）。
_FV_API_EXACT = tuple(
    p.encode() for p in (
        os.environ.get('PROXY_FV_API_EXACT') or
        '/api/health,/api/config,/api/doctor,/api/list,/api/probe,/api/file'
    ).split(',') if p
)

# ── CAD 看图（fnos-dwg-viewer）的同源通道 ────────────────────────────
# ★ 为什么需要它 ★
#   「CAD 看图」是**另一个飞牛原生应用**（fnos-dwg-viewer，默认 :8020），
#   插件把 .dwg / .dxf 的预览交给它渲染 —— 与「文件预览」交给 :8030 完全同构。
#   手机走外网穿透（FN Connect）时只映射了思源这一个端口，:8020 根本够不到。
#   ⇒ 挂一条 /localfs/cad/* → :8020（剥前缀）。
#
# ★ 正确的入口是 `/open?path=…`，不是 `/?path=…` ★
#   它的 server 只对 `/` 做静态兜底，其余无扩展名的路径走 SPA 兜底
#   （server/index.mjs 里写着：「SPA 兜底：把 /open?path=... 之类的路径交给
#     前端路由」）。磁盘上的正规入口就是 **/open** ⇒ 插件给 /open。
#   ⚠️ 这条也提醒了改写器：**无扩展名的路径返回的也是 index.html**，
#      漏了它就会白屏（见 cad_rewritable 的说明）。
#
# ★★ 与 file-viewer 的关键差异：它的根绝对引用**会撞内核** ★★
#   index.html : <script src="/assets/index-xxx.js">
#   index.js   : fetch("/api/config")、new URL("/api/file/…")、`/assets/…worker.js`
#   /assets 是**思源内核**的资源目录（笔记里的图片就在 /assets/<file>），
#   /api 更是内核自己的接口 —— 这两个**不能按前缀收编**。
#   （file-viewer 能收编 /api/<短名>，是因为内核恰好没有那六个短名 —— 见上面
#     _FV_API_EXACT 的说明；而 CAD 应用要的是 /assets/，内核确实在用。）
#   这正是内置查看器当年不走反代、改成"送出前改写字节"的原因（见 local-fs.py
#    的历史注释）。⇒ **两道保险一起上**：
#     ① **收编**（见下面的 _CAD_ASSETS）：把它的 /assets/<产物名> **逐个精确**
#        归 :8020 —— 与 file-viewer 收编 /app.js 完全同一套路。这样连
#        「运行时才拼出来的 URL」也接得住（Vite 的 __vite__mapDeps 依赖表
#        就是这种，正则在静态文本里抓不到）。
#     ② **正文改写**（见 rewrite_cad_asset）：把文本资源里的根绝对引用补上
#        前缀。它管的是 /api/** —— 那批短名与内核**重名**（内核也有
#        /api/file/getFile 等），**不能**收编，只能在送出前改写。
#   二进制（9.5MB 的 .wasm、图纸本身）一律**原样中继、一个字节都不缓冲**。
CAD_PREFIX = (os.environ.get('PROXY_CAD_PREFIX') or '/localfs/cad').encode()
CAD_HOST = os.environ.get('PROXY_CAD_HOST') or '127.0.0.1'
CAD_PORT = int(os.environ.get('PROXY_CAD_PORT') or '8020')

# ★ 它的 /assets/<哈希名> —— **逐个精确**收编（与 _FV_ROOT_EXACT 同一套路）★
#   为什么要收编：前端在**运行时**拼出来的 URL（Vite 的 __vite__mapDeps 依赖表）
#   是静态正则在文本里抓不到的 —— 实测漏了 3 个（style-*.css 与两个
#   cad-agent-plugin-*.js），它们会落到内核的 /check-auth 兜底上，报
#   「Failed to load module script: MIME type text/html」。
#   ⚠️ 这份清单是 **Vite 产物哈希名**，随 CAD 应用升级会变 ——
#      升级后刷新办法：ls <CAD 应用>/server/dist/assets/ 再更新这里
#      （或设环境变量 PROXY_CAD_ASSETS 覆盖）。名字对不上也不会崩：
#      改写那一层兜着（只是运行时拼的 URL 会退回原样）。
#   ★ 故意**不按 /assets/ 前缀收编** —— 那是内核的笔记附件目录，抢不得。
_CAD_ASSETS = tuple(
    p.encode() for p in (
        os.environ.get('PROXY_CAD_ASSETS') or
        'cad-agent-plugin-ewBYyPo4.js,'
        'cad-agent-plugin-register-B6ardLqw.js,'
        'cad-html-plugin-CBbQESQV.js,'
        'cad-pdf-plugin-DPoz8NTj.js,'
        'cad-svg-plugin-pw4t19FE.js,'
        'index-Bu3ZRm7y.css,'
        'index-BXJilvBU.js,'
        'libredwg-parser-worker.js,'
        'libredwg-web.wasm,'
        'mtext-renderer-worker.js,'
        'style-9mXLuaXs.css'
    ).split(',') if p
)

# 根绝对引用 → 补前缀。只认这几种引号/括号形态：
#   "/assets/…"、'/assets/…'、`/assets/…`、(/assets/…
# 刻意**不动** `./assets/…` 这种相对引用 —— 页面本身就在 /localfs/cad/ 这个
# 目录下（插件给的地址带结尾斜杠），相对引用天然解析正确，连 <base> 都不用加。
_CAD_ABS_RE = re.compile(rb'(["\'(=`])/(assets|api)/')


# 只有这三类**文本**需要改写；其余（.wasm、图纸本身…）一律原样中继。
_CAD_TEXT_EXT = (b'.js', b'.mjs', b'.css', b'.html', b'.htm')

# ★★ 飞牛官方「Office文档」(trim.docs, :5666) 的同源通道 ★★
#
#   它是**直装宿主**的（不是容器）：`docs` 这个 Go 进程监听 127.0.0.1:10500（页面/接口）
#   与 10501（它自带的 OnlyOffice），外面套飞牛主 nginx 的 :5666：
#       location /docs        → 127.0.0.1:10500
#       location ^~ /onlyoffice/ → 127.0.0.1:10501/
#   （见 /usr/trim/nginx/conf/conf.d/trim_docs.conf；纯 proxy_pass，nginx 层**零鉴权**）
#
#   ★ 前端走 /localfs/docs/**，但它的页面**自己也发根绝对请求**（/docs/editing-state、
#     /onlyoffice/...）—— 因为 editor.html 是个 Go template，JSSDKUrl 由服务端注入，
#     注入出来的就是根绝对路径。所以下面**两个命名空间都要收编**。
#
#   ★★ 不需要正文改写 ★★
#     一开始以为要像 CAD 那样「收编哈希产物名 + 正则补前缀」，其实不用：
#     editor.html 里的 config / JSSDKUrl 都是服务端按 **X-Forwarded-Host**
#     （飞牛 nginx 取 $http_host ⇒ 即请求的 Host 头）**生成**的。
#     只要转发时把 Host 归一成「浏览器真实源」（复用 fix_oo_host），
#     它自己就把 OO 的地址写回 6806 —— 比 CAD 那套干净得多。
DOCS_PREFIX = (os.environ.get('PROXY_DOCS_PREFIX') or '/localfs/docs').encode()
DOCS_HOST = os.environ.get('PROXY_DOCS_HOST') or '127.0.0.1'
DOCS_PORT = int(os.environ.get('PROXY_DOCS_PORT') or '5666')

# 它的根绝对命名空间。★ 这两个名字思源内核都不用（_SIYUAN_OWNED_PREFIX 里没有），
# 所以放在 is_siyuan_owned **之后**收编即可 —— 内核优先，将来真撞了也轮不到我们抢。
_DOCS_ROOT_PREFIXES = tuple(
    p.encode() for p in (
        os.environ.get('PROXY_DOCS_ROOT_PREFIXES') or '/docs,/onlyoffice'
    ).split(',') if p
)


def is_docs_root(path):
    """path 是不是飞牛 Office 文档的**根绝对**命名空间（/docs、/onlyoffice）。"""
    for p in _DOCS_ROOT_PREFIXES:
        if path == p or path.startswith(p + b'/'):
            return True
    return False


# ★★ 飞牛登录凭据的「后端持有」副本 ★★
#
#   背景：飞牛的登录态是**浏览器 cookie**（`ost` / `osrt`）。转发给应用前，它的 nginx
#   会按 /usr/trim/nginx/conf/globals/trim-cookie-v2-to-v1-map.conf 改名成
#   `fnos-token` / `fnos-long-token`（**只改名，值不变**，其余 cookie 原样保留）。
#
#   而**桌面思源客户端**的内核跑在 127.0.0.1:6806 —— 那侧根本没有 NAS 的 cookie
#   （飞牛登录态存在 172.16.30.128 域下）⇒ 转发给 docs 必然 403「未登录或登录已过期」。
#   走通道也救不了：凭据在浏览器 cookie 里，不在通道里。
#
#   ⇒ 由本地文件服务（:8021）提供一个「同步当前浏览器登录态」的接口，把凭据落到本机；
#     这里在**请求自己没带凭据**时补上。于是桌面端、手机、浏览器三种走法全都能用。
CRED_FILE = (os.environ.get('PROXY_FNOS_CRED_FILE') or os.path.join(
    os.environ.get('TRIM_PKGVAR') or '/var/apps/siyuannote/var', 'fnos-cred.json'))

# 这 4 个名字里出现任意一个，就说明请求自带飞牛登录态（v2 或 v1 两种写法）
_CRED_COOKIE_NAMES = (b'ost=', b'osrt=', b'fnos-token=', b'fnos-long-token=')

_cred_cache = {'mtime': None, 'value': b''}


def load_cred_cookie():
    """读本机保存的飞牛凭据 cookie 串（形如 b'ost=xxx; osrt=yyy'）。

    按 mtime 缓存 —— 这个函数在**每个** docs 请求上都会被调用，
    每次 stat 一下比每次读文件便宜得多。
    任何异常都返回空：凭据读不到不该让请求失败，最多是照旧 403。
    """
    try:
        st = os.stat(CRED_FILE)
    except Exception:
        if _cred_cache['mtime'] is not None:
            _cred_cache['mtime'] = None
            _cred_cache['value'] = b''
        return b''
    if st.st_mtime == _cred_cache['mtime']:
        return _cred_cache['value']
    val = b''
    try:
        with open(CRED_FILE, 'rb') as fh:
            data = json.loads(fh.read().decode('utf-8'))
        val = (data.get('cookie') or '').encode('latin-1')
    except Exception:
        val = b''
    _cred_cache['mtime'] = st.st_mtime
    _cred_cache['value'] = val
    return val


def inject_cred_cookie(head):
    """请求自己没带飞牛登录态时，把本机保存的凭据补进 Cookie 头。

    返回 (新头, 是否注入)。

    ★ 自带凭据优先 ★
      浏览器 / 手机本来就带着它们自己的会话，**不要**用后端的副本去覆盖 ——
      那会把用户身份搞混（尤其多人各自登录时）。
    """
    cred = load_cred_cookie()
    if not cred:
        return head, False
    existing = header_get(head, 'cookie') or b''
    for n in _CRED_COOKIE_NAMES:
        if n in existing:
            return head, False

    lines = head.split(b'\r\n')
    out = []
    done = False
    for ln in lines:
        k, sep, _v = ln.partition(b':')
        if sep and k.strip().lower() == b'cookie':
            out.append(ln + b'; ' + cred)
            done = True
        else:
            out.append(ln)
    if not done:
        # 本来就没有 Cookie 头 ⇒ 追加一行。head 末尾没有空行
        # （调用方 sendall 时才补 \r\n\r\n），所以直接 append 就是头块内。
        out.append(b'Cookie: ' + cred)
    return b'\r\n'.join(out), True


def cad_rewritable(up_path):
    """这个（**已剥前缀的**）上游路径要不要做正文改写。

    ⚠️ 先按路径筛，再去连上游 —— 否则 9.5MB 的 .wasm 会被整份读进内存。
    ★ **无扩展名的路径也要改写** ★
      它的 SPA 路由（`/open`、`/`）返回的是**同一份 index.html**，里面全是
      根绝对引用 —— 漏了 `/open` 就白屏（2026-10-10 踩过：只认 `/` 与
      `/index.html`，于是 `/localfs/cad/open?path=…` 拿回来的 HTML 里
      `<script src="/assets/index-…js">` 原封不动，全打到内核）。
    """
    base = up_path.split(b'?', 1)[0]
    name = base.rsplit(b'/', 1)[-1]
    if b'.' not in name:          # /open、/ 之类 ⇒ SPA 路由 ⇒ HTML
        return True
    return name.lower().endswith(_CAD_TEXT_EXT)


def rewrite_cad_asset(head, body):
    """把 CAD 看图应用响应里的**根绝对**资源引用补上同源前缀。

    返回 (new_body, changed)；没命中就原样返回、changed=False。
    """
    if not body:
        return body, False
    ctype = (header_get(head, 'content-type') or b'').lower()
    if not (b'text/html' in ctype or b'javascript' in ctype or b'text/css' in ctype):
        return body, False
    # 压缩过的正文改不了（发请求时已经去掉 Accept-Encoding，这里只是兜底）
    if header_get(head, 'content-encoding'):
        return body, False
    new_body, n = _CAD_ABS_RE.subn(
        lambda m: m.group(1) + CAD_PREFIX + b'/' + m.group(2) + b'/', body)
    return (new_body, True) if n else (body, False)


# ★ 文档服务自己的根绝对路径 ★
#   把编辑器放到 /localfs/oo-srv/ 下之后，编辑器**相对**引用会自然落在前缀里；
#   但它还有一批**根绝对**引用（写死以 / 开头），浏览器会按当前源解析成
#   http://<思源那台>:6806/… ⇒ 打到思源内核（200 但内容不对），
#   OnlyOffice 就会报"文件内容与文件扩展名不匹配"，而状态码是 200
#   ⇒ 只看"失败请求数"会全绿，非常阴。
#   实测（跑完整一轮编辑器）文档服务用到的根命名空间只有两类：
#     · /<版本号>/…        —— 编辑器静态资源（如 /9.4.0-ecbb…/web-apps/…）
#     · /cache/…           —— 文档 blob 下载（/cache/files/data/<key>/Editor.bin）
#   其余 /web-apps、/sdkjs、/fonts、WS 等按需补上，成本很低。
#   ★ 安全性：见 SIYUAN_OWNED —— 思源内核自己的路径**永远优先**，绝不会被抢。
_OO_ROOT_PREFIXES = tuple(
    p.encode() for p in (
        os.environ.get('PROXY_OO_ROOT_PREFIXES') or
        '/cache,/web-apps,/sdkjs,/fonts,/doc,/coauthoring,/downloadfile,'
        '/healthcheck,/hosting,/spellchecker,/internal,/FileUploader,/welcome'
    ).split(',') if p
)
# 文档服务的"版本目录"，形如 /9.4.0-ecbb0e49cc1ea88a1b0d1bb8911e035d/
_OO_VERSION_DIR_RE = re.compile(rb'^/\d+\.\d+\.\d+-[0-9a-fA-F]{6,}/')

# ★ 思源内核自己的路径：**先判、优先**，上面的收编规则到此为止 ★
#   取自思源内核实际路由（/api、静态资源、导出、历史、插件、小组件…）。
#   前缀判据是"等于它"或"以 它 + / 开头"，避免把 /apis 之类误判成 /api。
_SIYUAN_OWNED_PREFIX = tuple(
    p.encode() for p in (
        os.environ.get('PROXY_SIYUAN_OWNED') or
        '/api,/assets,/stage,/appearance,/export,/history,/es,/ws,'
        '/check-auth,/snippets,/widgets,/plugins,/public,/favicon.ico,'
        '/manifest.webmanifest,/service-worker.js'
    ).split(',') if p
)
# 这两个只按**完全相等**判（/ 不能按前缀，否则什么都归内核了）。
# /index.html 两边都有意义；保持既有行为（归思源）最稳。
_SIYUAN_OWNED_EXACT = (b'/', b'/index.html')


def is_siyuan_owned(path):
    """path 是不是思源内核自己的路径（内核优先，绝不被文档服务抢走）。"""
    if path in _SIYUAN_OWNED_EXACT:
        return True
    for p in _SIYUAN_OWNED_PREFIX:
        if path == p or path.startswith(p + b'/'):
            return True
    return False


def is_oo_root(path):
    """path 是不是文档服务的**根绝对**路径（不带 /localfs/oo-srv 前缀的）。"""
    if _OO_VERSION_DIR_RE.match(path):
        return True
    for p in _OO_ROOT_PREFIXES:
        if path == p or path.startswith(p + b'/'):
            return True
    return False


def is_fv_root(path):
    """path 是不是文件预览（file-viewer）的**根绝对**路径。

    ⚠️ 调用方必须先过 `is_siyuan_owned`：file-viewer 也用 /api/**，
       而那是思源内核的路径，绝不能被抢走。

    ★ 例外：`is_fv_api()` 那六个 /api/<短名> 要在 is_siyuan_owned **之前**判
      （内核对它们全部 404，所以不算"内核的路径"）。
    """
    if path in _FV_ROOT_EXACT:
        return True
    for p in _FV_ROOT_PREFIXES:
        if path == p or path.startswith(p + b'/'):
            return True
    return False


def is_fv_api(path):
    """path 是不是 file-viewer 自己的 /api/<短名> 端点（**精确相等**才算）。

    这六个端点与思源内核**不重名**（内核是 /api/system/**、/api/filetree/**…），
    且内核对它们一律 404 ⇒ 可以安全地判给 file-viewer，即使 /api 整体归内核。
    必须**在任何 is_siyuan_owned 判定之前**调用（见 pick_upstream ④′）。
    """
    return path in _FV_API_EXACT


def is_cad_asset(path):
    """path 是不是「CAD 看图」自己的 /assets/<产物名>（**精确相等**才算）。

    ⚠️ 必须**在 is_siyuan_owned 之前**调用（见 pick_upstream ④″）：
       /assets/** 整体是思源内核的笔记附件目录，先判内核就会把它抢走。
       这里只放行 `_CAD_ASSETS` 里那几个 **Vite 哈希产物名** ——
       内核的附件名（`image-20241010….png` 之类）跟它们不可能撞名。

    为什么要这一条：CAD 前端有一批 URL 是**运行时**拼出来的（Vite 的
    `__vite__mapDeps` 依赖表），正文改写抓不到；实测漏了 3 个文件，
    落到内核 /check-auth 兜底上 ⇒ 报 MIME type text/html。
    """
    if not path.startswith(b'/assets/'):
        return False
    return path[len(b'/assets/'):] in _CAD_ASSETS

# ★ 登录页标题改写 ★
#   内核 /check-auth 的 HTML 里，大标题是**工作区目录名**：
#       <h1 style="margin-bottom: 48px;color:var(--b3-theme-on-background)">data</h1>
#   而本应用的工作区是 .../siyuan_E4Xr/data ⇒ 标题就成了「data」，
#   手机 App 里点开应用先看到「data」，完全认不出这是思源笔记。
#   内核侧改不了：conf.json 没有显示名配置项，二进制里的 HTML 模板也不是明文
#   （kprobe 三个 pattern 全 -1）。⇒ 只能在这一层改写响应正文。
#   只在**这一条精确路径**上生效，其余请求保持字节透明。
_AUTH_PATH = b'/check-auth'
_AUTH_TITLE_ORIG = b'data'                                # 要替换的标题文本
_AUTH_TITLE_NEW = (os.environ.get('PROXY_AUTH_TITLE') or '思源笔记').encode('utf-8')
# 只吃紧到 <h1 …>data</h1>：别把正文里别的 "data" 一起换了（"data" 是很常见的词）。
_AUTH_TITLE_RE = re.compile(
    rb'(<h1\b[^>]*>)' + re.escape(_AUTH_TITLE_ORIG) + rb'(</h1>)'
)

# ★ 登录后落点：把「to 为空 / to 为 /」都导向桌面版 ★
#   报障：「手机上强制思源桌面模式有时候会失灵」。
#   根因（已复现）：登录成功后内核前端执行 `window.location.href = toPath`，
#   而 `toPath` 取自登录页 URL 的 ?to= 参数，兜底是 "/"。
#     · 从 /stage/build/desktop 进来 ⇒ 302 带上 ?to=/stage/build/desktop
#       ⇒ 登录后回桌面版 ✓
#     · 从 / 进来（书签 / WebView 复用旧地址 / App 未用入口 URL）⇒ ?to=/
#       ⇒ 登录后回 "/"，内核前端**按 UA 判定** ⇒ 手机 UA 回落 mobile ✗
#   这就是"有时候失灵"——取决于打开时用的是哪个 URL。
#   修法：把兜底值改成桌面版，并把值恰为 "/" 的情况也换成桌面版；
#   显式访问 /stage/build/mobile 这种"to 是具体路径"的场景原样保留。
#   ⚠️ 替换的是内核登录页里那一行 JS：
#        toPath = url.searchParams.get("to") || "/"
#      改成对 "/"（含空）一律取桌面版。内核升级后若模板变了，这里会 miss，
#      但 miss 只是"退回原行为"，不会破坏任何东西（subn 计数为 0 即视为未改动）。
_AUTH_TO_DESKTOP = (os.environ.get('PROXY_AUTH_TO') or '/stage/build/desktop')
_AUTH_TOPATH_RE = re.compile(
    rb'toPath\s*=\s*url\.searchParams\.get\(["\']to["\']\)\s*\|\|\s*["\']/["\']'
)


def is_auth_page(path):
    """path 是不是内核登录页（要做 HTML 改写的那一条精确路径）。"""
    return path == _AUTH_PATH


def _to_path_fix(_m):
    """把 toPath 那一行换成「空或 / 一律走桌面版」。"""
    # 注意：值必须带 JS 字符串引号，否则生成 `? /stage/build/desktop : t`
    # 这种裸标识符 —— 直接是语法错误，登录页整个脚本都会挂。
    lit = ("'" + _AUTH_TO_DESKTOP.replace("\\", "\\\\").replace("'", "\\'") + "'").encode('utf-8')
    return (b'toPath = (() => { const t = url.searchParams.get("to");'
            b' return (!t || t === "/") ? ' + lit + b' : t })()')


def rewrite_auth_page(head, body):
    """改写内核登录页正文：

      ① <h1 …>data</h1> → <h1 …>思源笔记</h1>
      ② toPath 兜底 "/" → 桌面版路径（稳定"手机强制桌面模式"）

    返回 (new_body, changed)。没命中 / 不是 HTML 就原样返回。
    ★ 用 subn 的 count 判"有没有改"，不要拿替换后全文比 —— 那样连
      Content-Type 里出现 data 都会误判成"改了"。
    """
    ctype = (header_get(head, 'content-type') or b'').lower()
    if b'html' not in ctype:
        return body, False
    changed = False
    new_body, n = _AUTH_TITLE_RE.subn(rb'\g<1>' + _AUTH_TITLE_NEW + rb'\g<2>', body)
    if n:
        changed = True
    else:
        new_body = body
    new_body, n2 = _AUTH_TOPATH_RE.subn(_to_path_fix, new_body)
    if n2:
        changed = True
    return (new_body, True) if changed else (body, False)


# 可选：argv[1] 给 PID 文件路径。
# 而 setsid 在"自己就是进程组长"时会 fork，父 shell 的 $! 就不是真正的
# python pid 了，照抄会把"停止应用"打到空气上。自己写才准。
PID_FILE = sys.argv[1] if len(sys.argv) > 1 else ''

# 每条连接最多记几次 Origin 改写，避免刷爆日志
_MAX_LOG_PER_CONN = 3
_HEAD_LIMIT = 256 * 1024

REQ_LINE_RE = re.compile(rb'^[A-Za-z]{3,12}[ \t]+\S+[ \t]+HTTP/1\.[01][ \t]*$')
# 绝对形式请求行（GET http://host/path HTTP/1.1）——**只允许出现在 path 段**。
# ★ 踩过的坑：绝对形式的判定若连 query 一起看，`?parentOrigin=http://…` 这种查询串
#   会被误判成绝对形式，于是 path 被砍成空 ⇒ 选错上游（落到思源内核）⇒ 空响应。
#   OnlyOffice 的编辑器 iframe 地址里恰好就带 parentOrigin=http://…。
_SCHEME_RE = re.compile(rb'^[A-Za-z][A-Za-z0-9+.\-]*://')

_log_lock = threading.Lock()


def log(msg):
    line = '%s - [proxy] %s' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg)
    with _log_lock:
        try:
            sys.stderr.write(line + '\n')
            sys.stderr.flush()
        except Exception:
            pass


# ── 请求头处理 ────────────────────────────────────────────────────
def header_get(head, name):
    """在请求头块里取某个头的值（大小写不敏感）。返回 bytes 或 None。"""
    want = name.lower().encode()
    lines = head.split(b'\r\n')
    for ln in lines[1:]:
        k, sep, v = ln.partition(b':')
        if sep and k.strip().lower() == want:
            return v.strip()
    return None


def header_drop(head, name):
    """把某个请求头整条删掉（大小写不敏感）。返回新头。

    用于：改写登录页时要去掉 Accept-Encoding —— 内核一旦看到它就回
    gzip + chunked，改写路径读不了（见 fetch_and_rewrite 的说明）。
    """
    want = name.lower().encode()
    lines = head.split(b'\r\n')
    out = [lines[0]]
    for ln in lines[1:]:
        k, sep, _v = ln.partition(b':')
        if sep and k.strip().lower() == want:
            continue
        out.append(ln)
    return b'\r\n'.join(out)


def fix_origin(head):
    """
    把 Origin 的 host 换成与请求 Host 相同。

    返回 (新头, 是否改动, host, 原 origin)。
    Host 或 Origin 缺失时原样返回（不动比动错好）。
    """
    host = header_get(head, 'host')
    origin = header_get(head, 'origin')
    if not host or not origin:
        return head, False, host, origin

    # scheme 保留原样：思源只比对 host，但保持 https 更贴近浏览器视角
    scheme = origin.split(b'://', 1)[0] if b'://' in origin else b'http'
    new_origin = scheme + b'://' + host
    if new_origin == origin:
        return head, False, host, origin

    lines = head.split(b'\r\n')
    out = [lines[0]]                      # 请求行原样
    for ln in lines[1:]:
        k, sep, _v = ln.partition(b':')
        if sep and k.strip().lower() == b'origin':
            out.append(k + b': ' + new_origin)
        else:
            out.append(ln)
    return b'\r\n'.join(out), True, host, origin


# ★★ 2026-10-10：「手机上天 OO 预览报『下载失败』」的根因就在这一段 ★★
#
#   现象：手机经飞牛 App 打开思源里的 OO 预览，编辑器自己弹
#         「错误 / 下载失败 / 确定」；而 OO 容器的 access log 里
#         **一条 /cache/ 都没有**（请求根本没离开设备）。
#
#   根因：飞牛 App 那一跳会把 **Host 与 X-Forwarded-Host 一起改写成内网名**
#         （实测 host=siyuannote-main.alumaple.fnos.net，
#          而浏览器地址栏其实是穿透域名 office.app.5ddd.com:45943）。
#         而 OnlyOffice 的 docservice 会**按这两个头拼客户端要用的绝对 URL**：
#             urls['Editor.bin'] =
#               https://<Host|X-Forwarded-Host>/cache/files/data/<key>/Editor.bin/Editor.bin?md5=…
#         ⇒ 手机拿到的取文档地址指向一个它解析不了的内网名 ⇒ 请求在设备侧
#         就失败（net::ERR_FAILED）⇒ 编辑器报「下载失败」。
#
#   离线复现（.verify/_diag-hosthdr.mjs；只覆盖 XFH 或只覆盖 Host 都能复现）：
#         基线                 → 236 页正常、/cache/ 109 条
#         XFH/Host = 内网名     → 「错误 下载失败」、/cache/ 只剩 4 条
#
#   修法：转发给**文档服务**之前，把 Host / X-Forwarded-Host /
#         X-Forwarded-Proto 按**浏览器真实源**归一：
#           Origin（优先）→ Referer（退而求其次）→ 都不在就不动。
#         /cache/ 的 nginx secure_link 只签
#         `expires+uri+secret`，**与 Host 无关**
#         （容器内 /etc/nginx/includes/ds-docservice.conf:50），故改 Host 安全。
#
#   ★ 只对文档服务这个上游做 ★
#     内核那边 Host 必须原样：登录页正文改写、Origin↔Host 对齐那条链路
#     都依赖它（见文件头说明）。
#   ★ 取不到 Origin/Referer 时**保持原样**，不做"猜" ——
#     不动只是维持现状（不会更坏），乱猜会把好端端的会话带偏。

def browser_host(head):
    """从 Origin / Referer 里取出浏览器**真正在用的** host（含端口）。

    返回 (host_bytes, scheme_bytes)；取不到返回 (None, None)。
    只认 `scheme://host` 形态；host 里出现空白/斜杠/问号就判为不可信
    （不动比动错好）。
    """
    src = header_get(head, 'origin') or header_get(head, 'referer')
    if not src:
        return None, None
    m = re.match(rb'^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#\s]+)', src.strip())
    if not m:
        return None, None
    return m.group(2), m.group(1).lower()


def fix_oo_host(head):
    """把发往文档服务的请求头里的主机名归一到浏览器真实源。

    改写 Host / X-Forwarded-Host / X-Forwarded-Proto（缺失的 XFH 补上）。
    返回 (新头, 改前 host, 改后 host)；没得改时原样返回。
    """
    new_host, scheme = browser_host(head)
    if not new_host:
        return head, None, None

    before = header_get(head, 'host')
    lines = head.split(b'\r\n')
    out = [lines[0]]                      # 请求行原样
    saw_xfh = False
    for ln in lines[1:]:
        k, sep, _v = ln.partition(b':')
        if not sep:
            out.append(ln)
            continue
        low = k.strip().lower()
        if low == b'host':
            out.append(k + b': ' + new_host)
        elif low == b'x-forwarded-host':
            saw_xfh = True
            out.append(k + b': ' + new_host)
        elif low == b'x-forwarded-proto':
            out.append(k + b': ' + scheme)
        else:
            out.append(ln)
    if not saw_xfh:
        out.append(b'X-Forwarded-Host: ' + new_host)
    return (b'\r\n'.join(out),
            before.decode('latin-1') if before else None,
            new_host.decode('latin-1'))


# ── 带缓冲的读，保证 keep-alive 下能正确切分每个请求 ────────────────
class Reader(object):
    def __init__(self, sock):
        self.sock = sock
        self.buf = b''

    def _fill(self):
        data = self.sock.recv(65536)
        if not data:
            raise EOFError
        self.buf += data
        return len(data)

    def read_until(self, sep, limit):
        """读到 sep（含），返回 sep 之前的内容；EOF 返回 None。"""
        while True:
            i = self.buf.find(sep)
            if i >= 0:
                head = self.buf[:i]
                self.buf = self.buf[i + len(sep):]
                return head
            if len(self.buf) > limit:
                return None
            self._fill()

    def take(self, n):
        """取走最多 n 字节（可能不足）。"""
        chunk = self.buf[:n]
        self.buf = self.buf[len(chunk):]
        return chunk

    def copy_exact(self, n, out):
        """精确转发 n 字节（request body 用）。"""
        while n > 0:
            if not self.buf:
                self._fill()
            chunk = self.buf[:n]
            self.buf = self.buf[len(chunk):]
            out.sendall(chunk)
            n -= len(chunk)

    def copy_chunked(self, out):
        """按 chunked 编码转发，直到结束块（含 trailer）。"""
        while True:
            line = self.read_until(b'\r\n', _HEAD_LIMIT)
            if line is None:
                raise EOFError
            out.sendall(line + b'\r\n')
            size_field = line.split(b';', 1)[0].strip()
            try:
                size = int(size_field, 16)
            except ValueError:
                raise EOFError
            if size == 0:
                # trailer 段，直到空行
                while True:
                    t = self.read_until(b'\r\n', _HEAD_LIMIT)
                    if t is None:
                        raise EOFError
                    out.sendall(t + b'\r\n')
                    if t == b'':
                        return
            self.copy_exact(size + 2, out)   # 数据 + 结尾 CRLF

    def drain(self, out):
        """把缓冲区里剩下的（属于 body 的）全部转出去。"""
        if self.buf:
            out.sendall(self.buf)
            self.buf = b''


def copy_body(reader, upstream, head):
    """转发请求体。GET/无体请求在这里什么都不做。"""
    te = (header_get(head, 'transfer-encoding') or b'').lower()
    if b'chunked' in te:
        reader.copy_chunked(upstream)
        return
    cl = header_get(head, 'content-length')
    if cl is not None:
        try:
            n = int(cl.strip())
        except ValueError:
            n = 0
        if n > 0:
            reader.copy_exact(n, upstream)
            return
    reader.drain(upstream)


# ── 路径解析与上游选择 ────────────────────────────────────────────
def _split_target(target):
    """把请求行里的 request-target 切成 (path, query_or_empty)。

    ★ 绝对形式的判定只对 path 段做 —— query 里出现 "://"（如 `parentOrigin=http://…`）
      完全正常，不是绝对形式。混淆这两者会把路径砍成空、选错上游。
    """
    i = target.find(b'?')
    path, qs = (target[:i], target[i:]) if i >= 0 else (target, b'')
    j = path.find(b'#')
    if j >= 0:
        path = path[:j]
    m = _SCHEME_RE.match(path)
    if m:
        k = path.find(b'/', m.end())
        path = path[k:] if k >= 0 else b'/'
    return path, qs


def request_path(head):
    """从请求行里取出路径部分（不含 query）。取不到就返回 b'/'。"""
    first_line = head.split(b'\r\n', 1)[0]
    parts = first_line.split(b' ')
    if len(parts) < 2:
        return b'/'
    path, _qs = _split_target(parts[1])
    if not path.startswith(b'/'):
        path = b'/' + path
    return path


def pick_upstream(head):
    """按路径前缀选上游。

    返回 (host, port, strip_prefix)：
      strip_prefix 是要从请求行里摘掉的**前缀 bytes**（b'' = 不摘）。
      为什么要摘：OnlyOffice 与 file-viewer 都以为自己在站点根目录，
      不知道自己被挂到了 /localfs/oo-srv、/localfs/fv 下面。

    ★ 判定顺序（长前缀优先，思源自有路径最先判、绝不被抢）：
      ① 长前缀 /localfs/oo-srv（剥前缀）
      ② 长前缀 /localfs/fv（剥前缀）
      ②′ 长前缀 /localfs/cad（剥前缀）—— 排在 ③ 之前，否则会被 ③ 吃掉
      ②″ 长前缀 /localfs/docs（**剥 /localfs**，不是剥它自己）—— 同上，先于 ③
      ③ 短前缀 /localfs（文件服务，前缀原样 —— 它自己认这个前缀）
      ④′ file-viewer 的 /api/<短名> 六个端点（**精确**，先于 ④ —— 内核全 404）
      ④″ CAD 看图的 /assets/<产物名>（**精确**，先于 ④ —— /assets 整体归内核）
      ④ **思源内核自己的路径**（先判优先，这里直接归内核）
      ④‴ 飞牛 Office 文档的 /docs、/onlyoffice（根绝对，不剥前缀；
           放内核之后 —— 这两个名字内核不用，但优先权仍归内核）
      ⑤ 文档服务 / 文件预览的**根绝对**路径（/cache/…、/<版本号>/…、
         /file-viewer/dist/…、/app.js…）
      ⑥ 其它 → 思源内核

    ★ ④′ 必须排在 ④ 前面 ★
      file-viewer 的前端把接口写成根绝对（`/api/list`、`/api/file`…），
      页面挂在 /localfs/fv/ 下时这些请求会解析到站点根。若先过 is_siyuan_owned，
      /api 按前缀归内核 ⇒ 内核对这些路径 404（text/plain）⇒ 前端 `res.json()`
      抛「服务返回了非 JSON 内容」。内核没有这几个短名（实测全 404），
      所以**精确**判给 file-viewer 是安全的。

    ★ ④ 必须排在 ⑤ 前面 ★
      文档服务与 /api 之外，思源自有路径（/assets、/stage、/plugins…）优先，
      保证内核的页面与接口永远不被预览服务抢走。
    """
    path = request_path(head)
    if OO_PREFIX and (path == OO_PREFIX or path.startswith(OO_PREFIX + b'/')):
        return OO_HOST, OO_PORT, OO_PREFIX
    if FV_PREFIX and (path == FV_PREFIX or path.startswith(FV_PREFIX + b'/')):
        return FV_HOST, FV_PORT, FV_PREFIX
    # ★ 必须排在下面的 /localfs 短前缀之前 ★
    #   /localfs/cad/... 也匹配 /localfs 前缀，先判短前缀就会被文件服务吃掉。
    if CAD_PREFIX and (path == CAD_PREFIX or path.startswith(CAD_PREFIX + b'/')):
        return CAD_HOST, CAD_PORT, CAD_PREFIX
    # ★ 飞牛 Office 文档：剥 **/localfs**（不是剥 /localfs/docs）★
    #   它的页面在 /docs/... —— 剥到 /localfs 之后上游正好看到 /docs/preview，
    #   与飞牛 nginx 的 location /docs 对齐。剥短前缀比引入一个「替换前缀」
    #   的新机制简单得多（strip_request_prefix 只会摘，不会换）。
    #   同样必须先于下面的 /localfs 短前缀判。
    if DOCS_PREFIX and (path == DOCS_PREFIX or path.startswith(DOCS_PREFIX + b'/')):
        return DOCS_HOST, DOCS_PORT, b'/localfs'
    if LOCAL_FS_PREFIX and (path == LOCAL_FS_PREFIX or path.startswith(LOCAL_FS_PREFIX + b'/')):
        return LOCAL_FS_HOST, LOCAL_FS_PORT, b''
    # ④′ file-viewer 的根绝对 /api/<短名> —— 精确，且必须在 is_siyuan_owned 之前
    if _FV_API_EXACT and is_fv_api(path):
        return FV_HOST, FV_PORT, b''
    # ④″ CAD 看图自己的 /assets/<产物名> —— 精确，也必须在 is_siyuan_owned 之前
    #     （内核的 /assets/** 是笔记附件目录，所以只认这几个**哈希产物名**）
    if _CAD_ASSETS and is_cad_asset(path):
        return CAD_HOST, CAD_PORT, b''
    # 思源内核自己的路径：先判、优先（下面的根绝对收编到此为止）
    if is_siyuan_owned(path):
        return UPSTREAM_HOST, UPSTREAM_PORT, b''
    # ④‴ 飞牛 Office 文档的根绝对命名空间（/docs、/onlyoffice）
    #       页面里的 fetch('/docs/editing-state') 与 OO 的 /onlyoffice/** 都是根绝对，
    #       不加这条就会落到内核 /check-auth 兜底上（白屏 / MIME 错）。
    #       放在 is_siyuan_owned **之后**：这两个名字内核本来就不用，
    #       将来真撞了也由内核优先（原样转发，不剥前缀）。
    if _DOCS_ROOT_PREFIXES and is_docs_root(path):
        return DOCS_HOST, DOCS_PORT, b''
    if _OO_ROOT_PREFIXES and is_oo_root(path):
        return OO_HOST, OO_PORT, b''
    if is_fv_root(path):
        return FV_HOST, FV_PORT, b''
    return UPSTREAM_HOST, UPSTREAM_PORT, b''


def strip_request_prefix(head, prefix):
    """把请求行里的路径前缀摘掉（只动第一段，其余头原样）。

    返回 (新头, 是否改动)。绝对形式的请求行（代理链路里偶尔见到）也照办。
    """
    lines = head.split(b'\r\n')
    parts = lines[0].split(b' ')
    if len(parts) < 3:
        return head, False
    path, qs = _split_target(parts[1])
    if not (path == prefix or path.startswith(prefix + b'/')):
        return head, False
    parts[1] = (path[len(prefix):] or b'/') + qs
    lines[0] = b' '.join(parts)
    return b'\r\n'.join(lines), True


# ── 响应方向：原样透传（连响应头都不解析） ──────────────────────────
def relay_upstream_to_client(upstream, client, state):
    try:
        while True:
            data = upstream.recv(65536)
            if not data:
                break
            client.sendall(data)
    except Exception:
        pass
    finally:
        _shutdown(upstream)
        # 上游自己收尾了（对方发了 Connection: close），把客户端也一起结束掉。
        # 但如果这条上游是**已经被换掉的旧连接**，就不能牵连客户端 —— 那会打断
        # 正在进行的新请求。state['sock'] 是"当前在用的那条"，只认它。
        if state.get('sock') is upstream:
            _shutdown(client)
        # ★ 告诉 handle()：这条上游的响应已经搬完了 ★
        #   Connection: close 场景下 handle 会在退出前等这个事件，免得
        #   它抢在中继线程之前把客户端关掉、把响应整份丢掉（踩过：返回 0 字节）。
        ev = state.get('relay_done')
        if ev is not None:
            ev.set()


def fetch_and_rewrite(client, target, head, rewrite):
    """在一条**一次性**上游连接上取回响应、改写正文、发回客户端。

    ★ 为什么必须另开一条连接、且必须是**同步**的 ★
      常规链路是"每个请求挑一条上游 → 顺手起一个常驻中继线程把响应原样搬回来"
      （见 upstream_for）。那个中继线程**从建立连接起就一直在 recv**，
      它和连接是一对一绑定的（keep-alive 下长期存活）。
      如果这里再起第二个线程去读**同一条** socket，两个读线程会争抢同一批字节
      —— 响应会被撕成两半，谁也不知道自己拿到了什么。
      所以改写这条路径**绕开** upstream_for / 中继线程：
      自己连一条、发请求、完整读一个响应、改、发回去、关掉。
      /check-auth 是登录页，一来不频繁，二来浏览器当它是独立导航，
      每次多一条到内核的 TCP 连接，代价可以忽略。

    连接/读写失败就把 502 发给客户端（和上游不可达时同样的处理）。
    返回 True 表示"已经回完这个请求"，调用方可以继续处理下一个请求。
    """
    upstream = None
    try:
        upstream = socket.create_connection(target, timeout=15)
        upstream.settimeout(20)
        upstream.sendall(head + b'\r\n\r\n')
        resp = read_full_response(upstream)
        if resp is None:
            # 读不完整 / 形态不认识 ⇒ 不敢改，但也已经把请求发出去了。
            # 这种情况下**不能**退回常驻中继（那条连接与我们无关），
            # 只能如实告诉客户端取不到。
            client.sendall(b'HTTP/1.1 502 Bad Gateway\r\n'
                           b'Content-Type: text/plain; charset=utf-8\r\n'
                           b'Content-Length: 42\r\n'
                           b'Connection: close\r\n\r\n'
                           b'SiYuan proxy: upstream response unreadable\n')
            return True
        rhead, body, close_after = resp
        new_body, changed = rewrite(rhead, body)
        if changed:
            rhead = fix_content_length(rhead, len(new_body))
            body = new_body
        client.sendall(rhead + b'\r\n\r\n')
        if body:
            client.sendall(body)
        return True
    except Exception as exc:
        log('正文改写失败（%s）：%s' % (target, exc))
        try:
            client.sendall(b'HTTP/1.1 502 Bad Gateway\r\n'
                           b'Content-Type: text/plain; charset=utf-8\r\n'
                           b'Content-Length: 43\r\n'
                           b'Connection: close\r\n\r\n'
                           b'SiYuan proxy: upstream is not reachable\n')
        except Exception:
            pass
        return True
    finally:
        if upstream is not None:
            try:
                upstream.close()
            except Exception:
                pass


def read_full_response(sock):
    """从上游把**一个完整 HTTP 响应**读出来。读不完整就返回 None。

    返回 (head, body, close_after)。head 是响应头块（不含结尾 CRLFCRLF）。
    只支持 Content-Length 与 chunked；无长度（流式）响应一律返回 None，
    由调用方按"原样"处理。
    """
    br = Reader(sock)
    head = br.read_until(b'\r\n\r\n', _HEAD_LIMIT)
    if head is None or not head.startswith(b'HTTP/'):
        return None
    status_line = head.split(b'\r\n', 1)[0]
    parts = status_line.split(b' ', 2)
    code = parts[1] if len(parts) > 1 else b''
    # 无正文的状态码：不读 body
    if code in (b'204', b'304') or code[:1] == b'1':
        return head, b'', _resp_close(head)
    te = (header_get(head, 'transfer-encoding') or b'').lower()
    if b'chunked' in te:
        # 折中：chunked 响应**不消化**，交给调用方按原样处理（rewrite 不会命中）
        return None
    cl = header_get(head, 'content-length')
    if cl is None:
        return None                             # 无长度：不敢读，交回透明中继
    try:
        n = int(cl.strip())
    except ValueError:
        return None
    body = br.take(n)
    while len(body) < n:
        try:
            if not br._fill():
                return None
        except EOFError:
            return None
        body = body + br.take(n - len(body))
    return head, body, _resp_close(head)


def _resp_close(head):
    conn = (header_get(head, 'connection') or b'').lower()
    return b'close' in conn


def fix_content_length(head, n):
    """把响应头里的 Content-Length 改成 n（没有就补一条）。"""
    lines = head.split(b'\r\n')
    out = [lines[0]]
    found = False
    for ln in lines[1:]:
        k, sep, _v = ln.partition(b':')
        if sep and k.strip().lower() == b'content-length':
            out.append(b'Content-Length: ' + str(n).encode())
            found = True
        else:
            out.append(ln)
    if not found:
        out.append(b'Content-Length: ' + str(n).encode())
    return b'\r\n'.join(out)


def blind_relay(src, dst):
    """WebSocket 升级之后：纯字节双向转发。"""
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        _shutdown(dst)


def _shutdown(sock):
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except Exception:
        pass


# ── 单连接处理 ────────────────────────────────────────────────────
def handle(client, addr):
    client.settimeout(30)

    # 当前在用的上游。逐请求按路径选，路径换了就换连接。
    # 用 dict 是为了让响应线程能看见"现在哪条是当前这条"（见 relay 的收尾逻辑）。
    state = {'sock': None, 'target': None}

    def upstream_for(target):
        """按需切换上游连接，返回可用的 socket。失败抛异常。"""
        cur = state['sock']
        if cur is not None and state['target'] == target:
            return cur
        if cur is not None:
            # 换连接的旧上游：先把它摘掉身份，免得它的收尾线程顺手关掉客户端
            state['sock'] = None
            state['target'] = None
            _shutdown(cur)
            try:
                cur.close()
            except Exception:
                pass
        sock = socket.create_connection(target, timeout=15)
        sock.settimeout(None)
        state['sock'] = sock
        state['target'] = target
        # 每条上游配一个"中继搬完了"事件（见 relay_upstream_to_client 的 finally）。
        state['relay_done'] = threading.Event()
        threading.Thread(target=relay_upstream_to_client,
                         args=(sock, client, state), daemon=True).start()
        return sock

    reader = Reader(client)
    logged = 0
    first = True
    # ★ 退出前是否必须等中继线程搬完响应 ★
    #   只有「客户端说了 Connection: close」这一种：这条上游随后就会被收掉，
    #   响应是它的最后一批数据，不等就会丢（踩过：返回 0 字节）。
    #   keep-alive 下中继线程要等下一次请求或对端关闭才会结束，绝不能等它。
    must_drain = False
    try:
        while True:
            head = reader.read_until(b'\r\n\r\n', _HEAD_LIMIT)
            if head is None or head == b'':
                break

            first_line = head.split(b'\r\n', 1)[0]
            if not REQ_LINE_RE.match(first_line.strip()):
                # 不是 HTTP/1.x 请求行 —— 不猜，直接盲转发给内核，绝不吞数据
                try:
                    upstream = upstream_for((UPSTREAM_HOST, UPSTREAM_PORT))
                except Exception as exc:
                    log('连不上内核 %s:%d：%s' % (UPSTREAM_HOST, UPSTREAM_PORT, exc))
                    break
                upstream.sendall(head + b'\r\n\r\n')
                reader.drain(upstream)
                blind_relay(client, upstream)
                return

            if first:
                # 首条读完就撤掉握手超时：之后可能是长连接的 WebSocket 静默期，
                # 30 秒不动就断会误杀。
                client.settimeout(None)
                first = False

            up_host, up_port, strip_prefix = pick_upstream(head)
            target = (up_host, up_port)
            is_kernel = (target == (UPSTREAM_HOST, UPSTREAM_PORT))
            is_oo = (up_port == OO_PORT)
            is_cad = (target == (CAD_HOST, CAD_PORT))
            is_docs = (target == (DOCS_HOST, DOCS_PORT))

            # ★ 登录页正文改写：**必须在挑上游连接之前分流** ★
            #   upstream_for() 在给出 socket 的同时会起一个**常驻中继线程**，
            #   那个线程从连接建立起就一直 recv、把读到的东西原样写给客户端。
            #   登录页要改正文就得自己把响应整份读回来 ⇒ 两个线程抢同一条 socket
            #   ⇒ 响应被撕成两半。所以这条路径**完全不碰** upstream_for，
            #   改用一条一次性连接同步完成（见 fetch_and_rewrite）。
            if is_kernel and is_auth_page(request_path(head)):
                new_head, changed, host, origin = fix_origin(head)
                # ★ 必须去掉 Accept-Encoding ★
                #   内核只要看到它就回 `Content-Encoding: gzip` + `Transfer-Encoding: chunked`
                #   （实测：curl 带 gzip 头时确实如此），而我们的改写路径要整份读出正文
                #   才能替换标题 —— gzip 正文读出来是二进制、chunked 又没有 Content-Length，
                #   两条路都走不通（会退化成 502，真机 Chrome 必带这个头，一开就白屏）。
                #   去掉它之后内核回的是**未压缩 + Content-Length** 的明文 HTML，
                #   改写简单可靠，也不需要在代理里做解压/再压缩。
                #   代价：登录页不再走传输压缩（54KB 的 HTML，可忽略）。
                new_head = header_drop(new_head, 'accept-encoding')
                if changed and logged < _MAX_LOG_PER_CONN:
                    logged += 1
                    log('改写 Origin: %s → %s（Host=%s, 来自 %s，登录页）'
                        % (origin.decode('latin-1'),
                           (origin.split(b'://', 1)[0] + b'://' + host).decode('latin-1'),
                           host.decode('latin-1'), addr[0]))
                fetch_and_rewrite(client, target, new_head, rewrite_auth_page)
                if b'close' in (header_get(head, 'connection') or b'').lower():
                    return
                continue

            # ★ CAD 看图：文本资源要改写正文（根绝对引用补上 /localfs/cad 前缀）★
            #   与登录页同理 —— 要改正文就得自己把响应整份读回来，所以**完全不碰**
            #   upstream_for 的常驻中继线程（否则两个线程抢同一条 socket，响应被撕成
            #   两半）。二进制（9.5MB 的 .wasm、图纸本身）与 /api/* 不进这条分支：
            #   它们走正常中继，一个字节都不缓冲。
            if is_cad:
                _up_path = request_path(head)
                if strip_prefix and _up_path.startswith(strip_prefix):
                    _up_path = _up_path[len(strip_prefix):] or b'/'
                if cad_rewritable(_up_path):
                    # 去掉 Accept-Encoding：拿未压缩正文才改得动（同登录页的理由）
                    new_head = header_drop(head, 'accept-encoding')
                    if strip_prefix:
                        new_head, _ = strip_request_prefix(new_head, strip_prefix)
                    fetch_and_rewrite(client, target, new_head, rewrite_cad_asset)
                    if b'close' in (header_get(head, 'connection') or b'').lower():
                        return
                    continue

            try:
                upstream = upstream_for(target)
            except Exception as exc:
                log('连不上上游 %s:%d：%s' % (up_host, up_port, exc))
                try:
                    client.sendall(b'HTTP/1.1 502 Bad Gateway\r\n'
                                   b'Content-Type: text/plain; charset=utf-8\r\n'
                                   b'Content-Length: 43\r\n'
                                   b'Connection: close\r\n\r\n'
                                   b'SiYuan proxy: upstream is not reachable\n')
                except Exception:
                    pass
                break

            # ★ 只有发往**内核**的请求才改写 Origin ★
            #   改 Origin 是为了过内核 WebSocket 的 CheckOrigin（见文件头）。
            #   而发往本机文件服务的请求**必须原样带着浏览器给的 Origin** ——
            #   它要靠这个头回显 `Access-Control-Allow-Origin`，跨源调用
            #   （比如思源桌面客户端连 NAS 上的这个服务）才不被浏览器拦。
            #   早先不分上游一律改写，于是回显出来的 ACAO 变成了代理自己那台
            #   主机的地址，浏览器一看"跟我不是同源"就全部拒绝，console 被刷屏。
            #   （is_kernel 已在上面算出；登录页那条已提前 continue 掉了。）
            if is_kernel:
                new_head, changed, host, origin = fix_origin(head)
            else:
                host = header_get(head, 'host')
                origin = header_get(head, 'origin')
                new_head, changed = head, False

            # ★ 发往**文档服务**的请求：把被飞牛 App 改坏的主机名归一 ★
            #   （理由与复现见 fix_oo_host 的注释 —— 不修就是手机端「下载失败」）
            if is_oo:
                new_head, _oo_before, _oo_after = fix_oo_host(new_head)
                if _oo_before and _oo_after and _oo_before != _oo_after \
                        and logged < _MAX_LOG_PER_CONN:
                    logged += 1
                    try:
                        log('文档服务：主机名归一 %s → %s（来自 %s）'
                            % (_oo_before, _oo_after, addr[0]))
                    except Exception:
                        pass

            # ★ 发往**飞牛 Office 文档**的请求：两件事 ★
            #   ① 主机名归一到浏览器真实源 —— 它的 editor.html 是 Go template，
            #      OO 的地址（JSSDKUrl / ConfigJSON）由服务端按 X-Forwarded-Host
            #      （飞牛 nginx 取 $http_host）生成 ⇒ 不归一的话它会写成
            #      127.0.0.1:5666，浏览器那边（尤其手机）直接打不开。
            #   ② 请求自己没带飞牛登录态时，补上本机保存的那份 ——
            #      桌面思源客户端的内核在 127.0.0.1，那侧没有 NAS 的 cookie。
            if is_docs:
                new_head, _d_before, _d_after = fix_oo_host(new_head)
                if _d_before and _d_after and _d_before != _d_after \
                        and logged < _MAX_LOG_PER_CONN:
                    logged += 1
                    try:
                        log('Office 文档：主机名归一 %s → %s（来自 %s）'
                            % (_d_before, _d_after, addr[0]))
                    except Exception:
                        pass
                new_head, _cred_used = inject_cred_cookie(new_head)
                if _cred_used and logged < _MAX_LOG_PER_CONN:
                    logged += 1
                    try:
                        log('Office 文档：已补上本机保存的飞牛凭据（来自 %s）' % addr[0])
                    except Exception:
                        pass

            # OnlyOffice / file-viewer 不认前缀：转发前把 /localfs/oo-srv
            # 或 /localfs/fv 摘掉（strip_prefix 为空 = 不摘，前缀原样给上游）
            if strip_prefix:
                new_head, _stripped = strip_request_prefix(new_head, strip_prefix)
            upstream.sendall(new_head + b'\r\n\r\n')

            if is_kernel and changed and logged < _MAX_LOG_PER_CONN:
                logged += 1
                try:
                    log('改写 Origin: %s → %s（Host=%s, 来自 %s）'
                        % (origin.decode('latin-1'), (origin.split(b'://', 1)[0] + b'://' + host).decode('latin-1'),
                           host.decode('latin-1'), addr[0]))
                except Exception:
                    pass
            elif is_kernel and not changed and origin and logged == 0:
                logged += 1
                log('Origin 与 Host 已一致，未改动（Host=%s, 来自 %s）'
                    % (host.decode('latin-1') if host else '?', addr[0]))

            conn = (header_get(head, 'connection') or b'').lower()
            upgrade = (header_get(head, 'upgrade') or b'').lower()

            if b'upgrade' in conn and upgrade:
                # WebSocket / 其它协议升级：转发剩余字节后转纯字节双向
                reader.drain(upstream)
                blind_relay(client, upstream)
                return

            copy_body(reader, upstream, head)

            if b'close' in conn:
                must_drain = True
                break
    except EOFError:
        pass
    except Exception as exc:
        log('连接处理异常（%s）：%s' % (addr[0], exc))
    finally:
        cur = state.get('sock')
        state['sock'] = None
        # ★ 别抢在中继线程前面关客户端 ★
        #   Connection: close 时我们会走到这里，但此时的正确收尾顺序是
        #   「中继线程把响应搬完 → 再关客户端」。以前这里是**立刻**关，
        #   于是 close 请求的响应整份被丢掉、客户端收到 0 字节（真机实证）。
        #   现在等中继线程报"搬完了"（最多 5 秒，防上游卡死），再收尾。
        ev = state.get('relay_done')
        if cur is not None and must_drain and ev is not None:
            try:
                ev.wait(5)
            except Exception:
                pass
        if cur is not None:
            _shutdown(cur)
        _shutdown(client)
        try:
            client.close()
        except Exception:
            pass
        if cur is not None:
            try:
                cur.close()
            except Exception:
                pass


def _close(sock):
    try:
        sock.close()
    except Exception:
        pass


# ── TLS 支持（与 HTTP 共用 LISTEN_PORT，靠首字节嗅探分流）──────────
#
# ★ 见文件头 TLS_ENABLED 那段：桌面端页面是 https，插件拼的 iframe 也必须
#   https，否则混合内容被拦。这里把同一端口上的 TLS 握手接住。
#
# ★ 为什么用 SSLContext 而不是 ssl.wrap_socket ★
#   wrap_socket 在 Python 3.12 起已废弃；SSLContext 还能顺手设最低版本、
#   关掉压缩，属于正确做法。
_tls_ctx = None
# ★ 建失败也要记住：否则**每个**连接都重试一次 load_cert_chain 并打一行日志，
#   高并发下刷屏 + 反复做无用的文件 IO。True 表示"试过了，不行，别再试"。
_tls_failed = False


def _build_tls_context():
    """建一次 SSLContext 复用；证书读不到时返回 None（不启用 TLS，不崩）。"""
    global _tls_ctx, _tls_failed
    if _tls_ctx is not None:
        return _tls_ctx
    if not TLS_ENABLED or _tls_failed:
        return None
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        # 只留 TLS1.2+：飞牛上那个 python3.11 默认就够，显式写清意图
        try:
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        except Exception:
            pass
        ctx.load_cert_chain(certfile=TLS_CERT, keyfile=TLS_KEY)
        # 客户端不要求出示证书（本代理面向浏览器/Electron）
        ctx.verify_mode = ssl.CERT_NONE
        _tls_ctx = ctx
        log('已启用 HTTPS：证书=%s 与 HTTP 共用端口 %d（按首字节嗅探分流）'
            % (TLS_CERT, LISTEN_PORT))
        return ctx
    except Exception as exc:
        _tls_failed = True
        log('启用 HTTPS 失败（%s），保持纯 HTTP：%s' % (exc, TLS_CERT))
        return None


def _is_tls_client_hello(client):
    """首字节 0x16 = TLS handshake 记录 ⇒ 这是 HTTPS 连接。

    ★ 用 MSG_PEEK：**不消费**字节，后面 handle() 还能从头读请求行。
    ★ 拿不到就返回 False（当 HTTP 处理）—— 宁可走老路也别把连接挂死。
    """
    try:
        head = client.recv(1, socket.MSG_PEEK)
    except Exception:
        return False
    return head[:1] == b'\x16'


def serve_one(client, addr):
    """把一条 TCP 连接按协议分派给 handle()。

    ★ 这是 accept 之后唯一的分流点 ★
      · HTTPS → 先 TLS 握手，再把手握后的 socket 交给 handle（上层无需知情）
      · HTTP  → 原样交给 handle（行为与以前一字不差）
    """
    ctx = _build_tls_context() if TLS_ENABLED else None
    if ctx is not None and _is_tls_client_hello(client):
        try:
            tls = ctx.wrap_socket(client, server_side=True)
        except Exception as exc:
            # 握手失败最常见的原因是"客户端不信任自签证书直接断开"，
            # 这属于预期内，记一句就够，别刷屏
            log('TLS 握手失败（%s）：%s' % (addr[0] if addr else '?', exc))
            try:
                client.close()
            except Exception:
                pass
            return
        try:
            handle(tls, addr)
        finally:
            try:
                tls.close()
            except Exception:
                pass
        return
    handle(client, addr)


# ── 主循环 ────────────────────────────────────────────────────────
def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((LISTEN_HOST, LISTEN_PORT))
    except OSError as exc:
        log('绑定 %s:%d 失败：%s（端口被占用？）' % (LISTEN_HOST, LISTEN_PORT, exc))
        return 1
    srv.listen(128)

    # 绑定成功之后才写 PID：绑不上（端口被占）就不该留下一个假的 pid 文件，
    # 否则 cmd/main 会以为代理活着。
    if PID_FILE:
        try:
            with open(PID_FILE, 'w') as fh:
                fh.write('%d\n' % os.getpid())
        except Exception as exc:
            log('写 PID 文件 %s 失败：%s' % (PID_FILE, exc))

    log('已监听 %s:%d → 内核 %s:%d；%s/* → 本机文件服务 %s:%d；%s/* → OnlyOffice %s:%d（剥前缀）；%s/* → 文件预览 %s:%d（剥前缀）；%s/* → CAD 看图 %s:%d（剥前缀+收编 assets+正文改写）；%s/* → 飞牛 Office 文档 %s:%d（剥 /localfs + 收编 %s + 归一主机名 + 补凭据）'
        % (LISTEN_HOST, LISTEN_PORT, UPSTREAM_HOST, UPSTREAM_PORT,
           LOCAL_FS_PREFIX.decode('latin-1') if LOCAL_FS_PREFIX else '(disabled)',
           LOCAL_FS_HOST, LOCAL_FS_PORT,
           OO_PREFIX.decode('latin-1') if OO_PREFIX else '(disabled)',
           OO_HOST, OO_PORT,
           FV_PREFIX.decode('latin-1') if FV_PREFIX else '(disabled)',
           FV_HOST, FV_PORT,
           CAD_PREFIX.decode('latin-1') if CAD_PREFIX else '(disabled)',
           CAD_HOST, CAD_PORT,
           DOCS_PREFIX.decode('latin-1') if DOCS_PREFIX else '(disabled)',
           DOCS_HOST, DOCS_PORT,
           b','.join(_DOCS_ROOT_PREFIXES).decode('latin-1')))

    # ★ 提前建一次上下文：证书有问题要在这里就暴露（写进启动日志），
    #   而不是等第一个 HTTPS 请求进来才发现。
    log('协议模式：%s'
        % ('HTTP+HTTPS 共用端口（证书 %s）' % TLS_CERT
           if _build_tls_context() else '纯 HTTP（未配置 PROXY_TLS_CERT/KEY）'))

    while True:
        try:
            client, addr = srv.accept()
        except KeyboardInterrupt:
            break
        except Exception as exc:
            log('accept 异常：%s' % exc)
            time.sleep(0.2)
            continue
        # ★ 走 serve_one 而不是 handle：它按首字节嗅探把 HTTPS 与 HTTP 分流，
        #   纯 HTTP 客户端的行为与改造前完全一致（serve_one 内直接转 handle）。
        threading.Thread(target=serve_one, args=(client, addr), daemon=True).start()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
