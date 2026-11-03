# 升级指南

本应用（`siyuannote`）**不自带**思源内核 —— 内核在打包时从别处提取进包里。
升级分三条线：思源内核版本、本仓库代码版本、上游依赖。

---

## 1. 上游：思源内核

- **当前锁定：`3.8.9`**（Linux x86_64 Go 二进制，约 151 MB）
- 上游：<https://github.com/siyuan-note/siyuan>
- 许可：AGPL-3.0（**分发时必须保留其许可声明**）

内核**不在版本库里** —— `fnos-package/app/kernel-dist/` 是打包时生成的，
已列入 `.gitignore`。clone 之后直接 build 是跑不起来的，先按下面提取。

### 提取内核

`scripts/build-fpk.sh` 会在飞牛宿主上就地提取（推荐，内核不来回搬）：

```bash
cd /vol1/1000/Docker/siyuannote
sudo bash scripts/build-fpk.sh              # 增量
sudo bash scripts/build-fpk.sh --refresh    # 强制重新提取
```

### 换内核版本

1. 换掉容器里的思源镜像/tag，或直接放一份新的 `kernel-dist/`。
2. `kernel-dist/` 里必须有以下几项，缺一项应用会报「内核不存在或不可执行」：
   - `kernel`（可执行文件）
   - `stage/`（前端构建产物）
   - `appearance/`、`stage/build/` 等资源目录
   - `ld-musl-x86_64.so.1` 与 `libc.musl-x86_64.so.1`（见下）
3. 重新 `bash scripts/build-fpk.sh --refresh` 出包。

### ★ 换内核版本后必须回归的三件事

思源内核这几年改过几次行为，本应用是为**具体版本行为**写的适配：

| 事项 | 触发版本 | 本应用的对策 |
|---|---|---|
| WebSocket 升级时比对 Origin 的 host 与 Host | 3.8.4+ | `reverse-proxy.py` 把 Origin 的 host 对齐到 Host（**只动这一个头**，其余字节不改） |
| 同源校验加强，通报 `Auth failed: invalid request origin` | 3.8.4+ | 内核退到 `16806` 仅绑回环 + 防火墙挡住外部来源；穿透层绕过反代直连也会被丢包 |
| 手机按 UA 切移动版界面 | 一直如此 | 应用挂载入口固定 `/stage/build/desktop`；登录页里 `to` 为空或 `/` 时兜底也走桌面版 |
| 插件 API `savePluginData` / `getFile` 返回 200 空体 | 3.8.x | 插件侧已改用 `/api/file/putFile` + `/api/file/getFile`（见 siyuan-localfs） |

**内核默认走「Local HTTPS + HTTP/2」**。本应用的反代与三条同源通道都是纯 HTTP，
所以同一个端口上 HTTP 与 HTTPS 双模可用 —— 这条实测成立，不要因为「内核是 HTTPS 的」
就以为通道也要上 TLS。

---

## 2. 为什么必须带 musl loader

思源官方镜像基于 Alpine（musl），内核 ELF 头写着
`interpreter /lib/ld-musl-x86_64.so.1`；飞牛是 Debian（glibc），**没有这个文件**。

直接跑会报 `No such file or directory` —— **是 loader 不在，不是内核不在**。
所以包里随带 `ld-musl-x86_64.so.1` 与 `libc.musl-x86_64.so.1`，
启动时显式调起：

```bash
loader --library-path <dir> kernel
```

`ldd` 只报 libc 一项 ⇒ 其余是纯静态链接，带这两个文件就够。
**换内核版本后请重新跑一次 `ldd`确认这个结论仍成立**（若上游改成静态链接，就可以不带）。

---

## 3. 本仓库代码版本

版本号在三处，必须同步：

| 文件 | 字段 | 当前 |
|---|---|---|
| `fnos-package/manifest` | `version` | 3.8.9 |
| `fnos-package/manifest` | `changelog` | 见文件 |
| （若已发版）GitHub Release tag | `v3.8.9` | |

★ **应用版本号 = 上游内核版本号**（与 `fnos-dwg-viewer` / `fnos-file-viewer` 同一约定）。
`2.2.3` 是旧的自定编号，从内核 3.8.8 起改成跟内核走 —— 以前看「应用版本 2.2.3」
还得在脑子里换算成「内核几点几」，出问题时对不上号。`changelog` 里保留了
全部 2.x 的历史条目，不要删。

★ `manifest` 是 **INI 格式，值里不能出现 `;` 或 `#`**，会被当注释截断
（`changelog` 最容易踩）。`build-fpk.sh` 会在打包前拦下这类错误。

### 桌面入口 / 打开方式（`app/ui/config` + `cmd/fix-open-type`）

```json
{ ".url": { "siyuannote.main": {
    "type": "url", "port": "6806", "url": "/stage/build/desktop" } } }
```

**要的行为：桌面图标点一下用浏览器新标签页打开，不嵌在飞牛桌面窗口里。**

★ **`type` 对第三方包无效**（2026-11-03 实测）：应用中心给第三方包建服务时
`type` 只认 `iframe`，**完全不读**这里写的 `"url"`。证据——

- 文件里写着 `"type": "url"` 时，查库仍是 `iframe`；
- `/usr/trim/bin/trim_app_center` 全二进制里没有 `"url"` 这个类型常量，
  `iframe` 只作为与 hidden/kernel/docker 并列的字面量出现。

⇒ 所以真正生效的是 **`cmd/fix-open-type`**（照抄 `fnos-dwg-viewer` 的同名脚本），
它改两张库：

| 库 | 表 / 字段 | 作用 |
|---|---|---|
| `appcenter` | `app_service.type` | 应用中心的「服务」类型 |
| `trim_sac` | `entry.open_type` | 飞牛前端入口分发（桌面图标读这个） |

前端逻辑（`/usr/trim/www/assets/index-*.js`）：`url` ⇒ `window.open(…,'_blank')`，
不占桌面窗口；`iframe` ⇒ 嵌在桌面窗口里。

★ **每次重装/升级都会退回 iframe**（应用中心重建服务行），所以该脚本挂在
`install_callback` / `upgrade_callback` / `config_callback` 三处，幂等、失败不阻断安装。

★ 与 `fnos-dwg-viewer` 版本的差别：那边顺手删了桌面图标（它是给文件关联用的）；
思源**保留图标**，只改打开方式 —— 所以不 `DELETE entry`、不动 `is_deleted`。

`port` / `url` 仍然有效：它决定应用中心建服务时指向哪个端口和路径。

### `build-fpk.sh` 会预检的错误

装到 NAS 上才发现代价太高，所以打包前先拦：

- 缺 `cmd/` 下任一生命周期脚本（fnOS 判「应用包不符合系统要求」直接拒装）
- `config/privilege` 的 `run-as` 不是 `root`
- `manifest` 值里有 `;` 或 `#`
- `display_name` 带了括号后缀
- 缺 `kernel-dist/kernel`、`kernel-dist/stage` 等关键文件

---

## 4. 上游依赖关系

本应用**借用**三个飞牛原生应用，三条链路全部挂在 6806 同源通道上：

| 通道前缀 | 目标应用 | 端口 | 用途 |
|---|---|---|---|
| `/localfs/cad/*` | 「CAD 看图」 | 8020 | DWG / DXF 预览 |
| `/localfs/fv/*` | 「文件预览」 | 8030 | 其余全部格式 |
| `/localfs/docs/*` | 官方「Office文档」(`trim.docs`) | 5666 | Office / PDF |

> ★ 为什么不直连各自端口：手机经 FN Connect 穿透时**只映射 6806** 一个端口。
> ★ 为什么要同源：思源插件要靠同源 iframe 注入样式，把查看器自带的外壳藏掉；
> 跨源会静默失效，工具栏/命令行/文件树会全部冒回来。

三个应用各有自己的仓库与发版节奏：[fnos-dwg-viewer](https://github.com/jack-taozhang/fnos-dwg-viewer)、
[fnos-file-viewer](https://github.com/jack-taozhang/fnos-file-viewer)。
**它们的 DOM 类名/id 被本应用的净化逻辑依赖，改结构时要互相通知。**

⚠️ 反代对 `/localfs/docs/*` 的请求：**没带飞牛凭据时会自动补上**
（凭据由插件在同源侧 POST `/localfs/api/fnos-cred` 落到 `$TRIM_PKGVAR/fnos-cred.json`，权限 600，
只挑 `ost` / `osrt` / `fnos-token` / `fnos-long-token` 四个 cookie）。
客户端自带凭据时**绝不覆盖**。接口永不回显凭据内容。

---

## 5. 可配置项

改完要在应用中心把应用**停一下再启动**才生效（配置是进程启动时读的）。
文件都在应用数据目录 `TRIM_PKGVAR`（形如 `/usr/local/apps/@appdata/siyuannote`）下：

| 文件 | 默认 | 说明 |
|---|---|---|
| `workspace.path` | `/vol1/docker/project/dk_app/siyuan/siyuan_E4Xr/data` | 思源工作区绝对路径 |
| `authcode` | 空 | 访问鉴权码 |
| `run-as` | `owner` | `owner` = 内核降权到工作区属主；`root` = 直接以 root 跑 |
| `oo-secret` | `nebula-oo-secret-change-me` | OnlyOffice JWT 密钥，**部署后请改掉** |

日志：同目录 `app.log`，应用侧输出带 `[local-fs]` / `[proxy]` 前缀。
内核日志在 `/usr/local/apps/@appcenter/siyuannote/*.log`。

---

## 6. 排查入口

| 现象 | 先看哪 |
|---|---|
| 应用起不来 / `TRIM_APPDEST` 指向不存在的目录 | `cmd/main` 的应用目录自愈逻辑（按「哪个目录里真有 kernel-dist/kernel」定，不盲信环境变量） |
| 手机上提示 `invalid request origin` | 反代的 Origin↔Host 对齐是否生效；内核防火墙规则是否在位 |
| 嵌入块里 Office / CAD 工具栏冒出来 | 是不是跨源了（同源通道是否走通）；净化类名是否还对得上 |
| 反代在 `Connection: close` 的请求上收不到内容 | 反代对该请求的处理分支 |

---

## 7. 许可

本仓库自身的代码 MIT。**随包的思源内核是 AGPL-3.0**，
再分发时必须附带其许可声明与源码获取途径（指向 <https://github.com/siyuan-note/siyuan>）。
`manifest` 里 `source=thirdparty` 就是这个意思。