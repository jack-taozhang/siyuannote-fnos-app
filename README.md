# 思源笔记 · 飞牛 fnOS 原生应用（siyuannote）

把飞牛上**已经在跑的思源笔记**，从「Docker 容器的桌面图标」升级成**真原生应用**：
应用自带思源内核，由飞牛应用中心托管进程与启停、随系统自启，**不再需要 Docker**。

**数据不动** —— 工作区仍是你原来的路径，卸载本应用也不会碰它。

## 和原来的 siyuannote 有什么区别

飞牛上原来那个 `siyuannote` 是个**空壳**（它的 manifest 里自己写着「本应用不托管任何进程」）：

| | 原来 1.0.0（空壳） | 现在 2.0.0（原生） |
|---|---|---|
| 进程 | 不托管，只注册图标 + 端口 | 自带思源内核 3.8.7，应用中心启停 |
| 依赖 | 必须有一个在跑的 Docker 容器 | **零依赖**（内核自带全部依赖） |
| 权限 | `run-as: package` | `run-as: root`（脚本），**内核降权到数据属主** |
| 开机自启 | 靠容器 restart 策略 | 飞牛应用中心负责 |
| 源码 | 已丢失，只剩装好的包 | 本工程 |

## 目录

```
siyuannote-fnos-app/
├── fnos-package/                ← 应用包源
│   ├── manifest                 应用清单（service_port=6806 / checkport / ctl_stop）
│   ├── config/privilege         run-as: root
│   ├── config/resource          {}（声明 data-share 会在授权列表里留一条删不掉的灰项）
│   ├── cmd/                     9 个生命周期脚本
│   │   └── main                 ★ 主控：解析应用目录 → 起反代(6806) / 内核(16806) / 文件服务(8021)
│   ├── wizard/install           安装向导文案
│   ├── app/
│   │   ├── launch-kernel.sh     ★ 启动包装：落 PID → 降权 → exec 内核
│   │   ├── reverse-proxy.py     ★ 对外唯一入口（0.0.0.0:6806）：Origin↔Host 对齐
│   │   │                           + 三条同源通道 /localfs/{cad,fv,docs} + 登录页正文改写
│   │   ├── local-fs.py          ★ 本机文件服务（:8021）：/api/* + 飞牛凭据中转
│   │   ├── ui/config            桌面图标
│   │   └── kernel-dist/         ← 打包时从容器提取（不在版本库里）
│   └── ICON.PNG / ICON_256.PNG
└── scripts/build-fpk.sh         ★ 在飞牛上就地提取内核 + 打包
```

## 进程与端口拓扑

```
                    ┌─────────────────────────────────────────────┐
   浏览器/手机 ────►│ reverse-proxy.py   0.0.0.0:6806（唯一入口）  │
                    │  · Origin↔Host 对齐（内核 3.8.4+ 同源校验）    │
                    │  · /localfs/cad/*   → CAD 看图      :8020     │
                    │  · /localfs/fv/*    → 文件预览      :8030     │
                    │  · /localfs/docs/*  → 官方 Office   :5666     │
                    └───┬───────────────┬──────────────┬───────────┘
                        │               │              │
              kernel :16806      local-fs :8021   （两条通道的目标）
              （仅本机回环，          （/api/*，root 直读全部存储空间）
               防火墙挡住外部）
```

★ 内核**故意**只绑回环 + 加防火墙规则：穿透层会绕过反代直连内核端口，
那时 Origin 与 Host 对不上，内核会以 `invalid request origin` 拒掉。
★ 三条「借用飞牛应用」的通道**全部挂 6806**，不直连各自端口 ——
手机经 FN Connect 穿透时只映射 6806 一个端口；而且同源才能往 iframe 注入样式
把查看器自带的外壳藏掉（跨源会静默失效）。

## 打包

**在飞牛宿主上执行**（内核 132MB 就在那台机器的容器里，不来回搬）：

```bash
cd /vol1/1000/Docker/siyuannote
sudo bash scripts/build-fpk.sh            # 加 --refresh 可强制重新提取内核
# → release/siyuannote-2.0.0.fpk（约 95MB）
```

`build-fpk.sh` 会在打包前拦下这几类错误（装到 NAS 上才发现代价太高）：

- 缺 `cmd/` 下任一生命周期脚本（fnOS 会判「应用包不符合系统要求」而拒绝安装）
- `config/privilege` 的 `run-as` 不是 `root`
- `manifest` 的值里出现 `;` 或 `#`（INI 会当注释截断，`changelog` 最容易踩）
- `display_name` 带了括号后缀
- 缺 `kernel-dist/kernel`、`kernel-dist/stage` 等关键文件

## 安装

1. **先停掉旧的思源容器** —— 端口 6806 被占着时，安装会被判「端口冲突」而拒绝：

   ```bash
   docker stop siyuan-siyuan_E4Xr-1
   ```

2. 应用中心 → 右上角「设置」→「手动安装应用」→ 选 `siyuannote-2.0.0.fpk`
3. 装完点桌面图标即可（应用中心也会自动把它拉起来）

## 可配置

改完在应用中心把应用**停一下再启动**才生效（配置是进程启动时读的）。
文件都在应用数据目录下，一行一个值：

| 文件 | 默认 | 说明 |
|---|---|---|
| `workspace.path` | `/vol1/docker/project/dk_app/siyuan/siyuan_E4Xr/data` | 思源工作区绝对路径 |
| `authcode` | 空 | 访问鉴权码（与原来的容器行为一致） |
| `run-as` | `owner` | `owner` = 内核降权到工作区属主；`root` = 直接以 root 跑 |

> 应用数据目录形如 `/usr/local/apps/@appdata/siyuannote`（`TRIM_PKGVAR`）。
> 日志在同目录的 `app.log`。

## 回滚

```bash
# 1. 应用中心卸载「思源笔记」
# 2. 把容器拉回来
docker start siyuan-siyuan_E4Xr-1
```

工作区文件属主始终是 `tao_zhang:Administrators`（1000:1001）—— 因为内核是降权跑的，
所以切回以 1000 跑的容器**不会**出现「能读不能写」。两边可以随时来回切。

## 两个实现要点（改代码前先看）

**① 为什么要带 musl loader。**
镜像基于 Alpine（musl），内核的 ELF 头写着 `interpreter /lib/ld-musl-x86_64.so.1`；
飞牛是 Debian（glibc），没有这个文件。直接跑会报 `No such file or directory` ——
**是 loader 不在，不是文件不在**。所以包里随带 `ld-musl-x86_64.so.1` 与
`libc.musl-x86_64.so.1`，启动时用 `loader --library-path <dir> kernel` 显式调起。
`ldd` 只报 libc 一项 ⇒ 其余是纯静态链接，带这两个文件就够。

**② 为什么要多一层 `launch-kernel.sh`。**
思源内核是官方程序，**不会像自家 Node 服务那样在 listen 成功后写 PID 文件**；
而 `nohup setsid ... &` 的 `$!` 不可靠（setsid 会 fork）。所以包装脚本先
`echo $$ > PID` 再 `exec` 成内核 —— `exec` 保留 PID，写进文件的就是最终进程。
降权也在这一层做：`setpriv --reuid=<工作区属主> --clear-groups`。

## 已知事项

- **pandoc 不在包里**，容器里也没有 ⇒ 导出 `.docx` / `.odt` 不可用。这与现状一致，
  不是本次改造引入的；需要的话得单独把 pandoc 放进 `kernel-dist/pandoc/`。
- 包体积较大（95MB / 解包 240MB），因为思源自带前端构建产物与全部外观资源。
- 应用只监听 `0.0.0.0:6806` 且默认**无鉴权码** —— 与原来的容器配置完全相同。
  要收紧就在 `authcode` 文件里填一个值再重启应用。
