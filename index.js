/* ==========================================================================
 * siyuan-localfs —— 本机存储（思源插件入口）
 * ==========================================================================
 *
 * ★ 这个插件解决什么 ★
 *   思源笔记的「本机存储」指的是**跑着思源内核的那台机器**上的存储空间
 *   （NAS 上的 /vol1、/vol00、/vol2…）。
 *
 *   为什么以前做不到：思源以 Docker 跑的时候，容器只挂了三个目录，其余一概
 *   看不见。以前的绕法是借第三方应用（fnos-dwg-viewer）当数据面 ——
 *   那意味着"装了思源还不够，还得让那个 CAD 应用一直跑着"。
 *
 *   现在这条数据面被收回到了思源自己的飞牛应用里（`app/local-fs.py`，:8021），
 *   它随思源一起起停，并且通过**同源通道** `/localfs/*` 暴露出去 ——
 *   手机经外网穿透访问时（穿透只映射了思源那一个端口）也能用。
 *
 *   这个插件就是它的前端：浏览 + 预览 + 下载。
 *
 * ★ 预览分派 ★
 *   CAD(.dwg/.dxf)  → 飞牛原生「CAD 看图」应用（fnos-dwg-viewer :8020）
 *                      经反代同源通道 /localfs/cad/* —— 与「文件预览」借 :8030
 *                      完全同构。（2026-10-10 之前是随包内置的 cad-viewer 产物，
 *                      那份 22MB 的复制品已删除。）
 *   Office/PDF      → 飞牛官方「Office 文档」应用（trim.docs :5666），
 *                      经反代同源通道 /localfs/docs/* —— 与前两条同样是"借用
 *                      飞牛原生应用 + 6806 同源通道"的形态，不自建容器。
 *   图片/PDF/音视频  → 浏览器原生
 *   文本/代码       → 直接读前 512 KB 显示
 *   其它            → 下载 / 在浏览器中打开
 *
 * ★ 几个刻意的选择 ★
 *   · 地址**探测**而不是写死：网页/手机走同源 `/localfs`，思源桌面客户端
 *     走 `http://<nas>:8021`，设置里可手填（见 src/api.js 的说明）。
 *   · 预览用**自绘浮层**而不是思源 Dialog：要铺满整屏看图纸，且这个插件会在
 *     飞牛 App 的 iframe 里跑，新开窗口会被拦（见 src/preview.js 的说明）。
 *   · 面板做成"能挂任意容器"的组件：桌面挂 dock，手机由命令拉全屏浮层
 *     （移动端没有 dock）。
 * ========================================================================== */

import { Plugin, showMessage, getFrontend, openTab } from "siyuan";

import {
  detectBase, getBase, getHealth, apiGet, fileUrl, cadViewerUrl, officeUrl, fileViewerUrl,
  downloadFile, resetDetection, validateOpen,
} from "./src/api.js";
import { Explorer } from "./src/explorer.js";
import { Preview } from "./src/preview.js";
import { TabView, TAB_TYPE, tabTypeFull, tryReuseViewerTab } from "./src/tabview.js";
import { openSettings } from "./src/settings.js";
import { installExternal } from "./src/external.js";
import { showDialog, showValidateError } from "./src/dialog.js";
import { kindOfName, KIND, baseNameOf, externalUrlOf } from "./src/kinds.js";
import { SYMBOLS_ALL, DOCK_ICON_ID } from "./src/icons.js";
import {
  registerEmbed, bindEmbedDrop, unbindEmbedDrop, insertEmbedIntoDoc, cleanupSlashText, collapseAllOpenEmbeds,
} from "./src/embed.js";

const DOCK_TYPE = "localfsExplorer";
const STORAGE_KEY = "settings";

/**
 * dock 期望落在哪一格。
 *
 * ★ 为什么不是 `addDock({config:{position}})` 就够 ★
 *   实测（见 `_ensureDockSide` 的长注释）：思源以**运行时 DOM**为准，
 *   已安装过的用户那边按钮早就在别处了，addDock 只会原位复用。
 *   真正的位置搬运靠 `_ensureDockSide()` 搬 DOM + `saveLocalPlugin` 固化。
 *   这个常量有两个用途：① 首次安装时 addDock 的声明值；
 *                        ② 搬运后写回 storage 的值。
 *
 * 取值：`RightTop` / `RightBottom` / `LeftTop` / `LeftBottom`。
 *
 * ★ 用 RightTop（2026-10-10 按用户要求）★
 *   用户原话：「插件按钮放到**全局关系图**下边」。
 *   思源右侧停靠栏分上下两格（RightTop / RightBottom），「全局关系图」
 *   本身就是注册在 **RightTop** 的一个停靠项 —— 我们的按钮要显示在它
 *   **下面**，就得进同一格（RightTop），并让它排在关系图之后。
 *   排序由 `_ensureDockSide()` 里的"插到关系图后面"那一步保证。
 */
const DOCK_POSITION = "RightTop";

/**
 * 我们要排在它**下面**的那个停靠项。
 *
 * ★ 实测（真机 dump `#dockRight` 的 `.dock__item`）★
 *   思源内置停靠项的 `data-type` 与中文名对照：
 *     file 文档 / outline 大纲 / inbox 收集箱 / bookmark 书签 / tag 标签
 *     **graph 关系图（局部）** / **globalGraph 全局关系图** / backlink 反向链接
 *     agentChat 智能体
 *   用户要的是「放到**全局关系图**下边」⇒ 目标 type = **`globalGraph`**。
 *   ⚠️ 别写成 `graph` —— 那是"关系图"（局部图），不是用户说的那个。
 *   找不到它时退回"append 到该格末尾"，不影响主流程。
 */
const DOCK_AFTER_TYPE = "globalGraph";

const DEFAULT_SETTINGS = {
  /** 手填的服务地址；空 = 自动探测 */
  baseUrl: "",
  /** 上次探测成功的地址（省一轮往返用，不作为权威） */
  lastBase: "",
  /**
   * 「常用文件夹」（需求 #1）。
   *   数组，元素是**绝对路径**（如 /vol1/1000/文档）。
   *   · 为空/未设置 ⇒ 浏览面板显示本机**全部**存储空间（默认行为）；
   *   · 有值       ⇒ 只显示这几个文件夹，其余一律不出现。
   *   刻意存**路径数组**而不是"带标签的对象"：标签能随时从路径算出来，
   *   存两份就会有不一致的那一天（改过名、换过挂载点）。
   */
  favorites: [],
};

export default class LocalFsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    try {
      const saved = await this.loadData(STORAGE_KEY);
      if (saved && typeof saved === "object") this.settings = Object.assign(this.settings, saved);
    } catch (e) {
      /* 第一次装没有数据，正常 */
    }

    this.base = "";
    this.health = null;
    this._lastPersistAt = 0;   // persist() 的速率限制用（见其说明）

    // ── 一次性迁移：清掉已经删掉的旧设置字段 ──────────────────────────
    //   ★ 为什么必须显式删 ★
    //     删掉 DEFAULT_SETTINGS 里的字段只对"新装"的用户生效；老用户的存档
    //     里还留着那个键，`loadData` 会把它原样合并回来 —— 真机实测：面板上
    //     已经没有那一项了，但 `plugin.settings` 里 mobileEditor 仍在。
    //     留着本身无害（代码里已无任何读取点），但会让排查的人误以为"开关
    //     还在"，也会一直白占存档 ⇒ 启动时顺手清一次并写回。
    //   ★ 2026-10-10 ★ 用户要求删掉「手机上用移动版编辑器」开关：编辑器界面
    //     已改为两端恒用桌面版（见 isMobileUi() 恒 false + 服务端恒 desktop）。
    //   ★ 2026-10-10 第二轮整理 ★ 再清三项：
    //     · allowEdit      —— Office 改用飞牛官方应用后，它按文件自身的写权限
    //                          决定可读可写，**不吃任何 URL 参数** ⇒ 这个开关
    //                          已经空转，勾不勾都一样。
    //     · rememberBase   —— 默认开着最省事，不该让用户看见这个选择。
    //     · expandedPaths  —— 文件树改为"每次打开都收拢"，不再记忆展开状态。
    {
      let dirty = false;
      for (const k of ["mobileEditor", "allowEdit", "rememberBase", "expandedPaths"]) {
        if (Object.prototype.hasOwnProperty.call(this.settings, k)) {
          delete this.settings[k];
          dirty = true;
        }
      }
      if (dirty) this.persist();
    }

    this.preview = new Preview(this);

    // 图标符号表：**页签标题**与**侧栏停靠项**的图标都只认符号 id
    //   （内核用 <svg><use xlink:href="#id"> 渲染，见 icons.js 的长注释）。
    //   ★ 参考网盘插件（siyuan-nebuladisk）：addIcons(CUSTOM_ICONS) 注册
    //     <symbol id="iconNebulaDisk">，addDock 的 icon 直接传这个 id。
    //     先前我们给 dock 传的是一整段内联 <svg> 字符串 ⇒ 内核当 id 查不到
    //     ⇒ 停靠项图标空白/乱码，这就是"图标不对"的根因。
    try {
      this.addIcons(SYMBOLS_ALL);
    } catch (e) {
      console.warn("[localfs] addIcons 失败（页签/停靠图标会退化成默认图标）：", e);
    }
    this._explorers = [];
    this._overlay = null;
    /**
     * 「本机存储通道是否可用」的启动 Promise。
     *
     * 谁在等它：正文里的**嵌入块**渲染器（src/embed.js 的 registerEmbed）。
     * 文档可能比探测更早渲染，那时先摆占位，等这个 Promise 落定再决定
     * 「画真内容」还是「给一条可读的提示」——避免开笔记瞬间闪一句报错。
     */
    this.bootReady = null;

    // 前端类型：mobile / browser-mobile 下没有 dock，只能靠命令拉浮层
    let frontend = "";
    try {
      frontend = getFrontend();
    } catch (e) {
      frontend = "";
    }
    this.frontend = frontend;
    this.mobileOnly = frontend === "mobile" || frontend === "browser-mobile";

    // ── 侧边栏停靠（桌面/网页版）──────────────────────────────────
    //
    //   ★ 位置：右侧 ★（2026-10-09 按用户要求从 LeftBottom 改到 RightBottom）
    //     用户要求「网盘侧边栏放到右边」。
    //
    //   ★★ 为什么"只改 addDock 的 position"完全不起作用（两轮排查的结论）★★
    //
    //   先看思源的实现（从真机 dump 出来的源码）：
    //
    //     getPluginDockPlacements() {
    //       const out = [];
    //       [0,1].forEach(i => {
    //         const pos = this.position === "Bottom"
    //                   ? (i===0 ? "BottomLeft" : "BottomRight")
    //                   : this.position + (i===0 ? "Top" : "Bottom");
    //         … this.elements[i].querySelectorAll(".dock__item") …   ← 读的是 **DOM**
    //       });
    //       return out;
    //     }
    //
    //     saveLocalPlugin(type, cfg) {
    //       window.siyuan.storage["local-plugin-docks"][plugin][type] = cfg;
    //       … 持久化 …
    //     }
    //
    //   ⇒ 位置由**三处**共同决定，而且互相不同步：
    //       ① `local-plugin-docks`（服务端 storage，键是连字符形式）
    //          实测内容：{ "siyuan-localfslocalfsExplorer":
    //            { position:"LeftBottom", size:{…}, index:1000, show:false } }
    //       ② `conf.json` 的 `uiLayout.left/right/bottom`（dock **面板**的布局）
    //       ③ 运行时的 **DOM**（`.dock__item` 实际插在哪一侧的 `.dock__items` 里）
    //
    //   实测结论（.verify/_verify-dock-migrate.mjs、_probe-*.mjs）：
    //     · 只改 ① 的 position + 整页刷新 ⇒ **无效**，仍 LeftBottom。
    //     · 只改 ② 的 uiLayout + setUILayout + reloadLayout ⇒ 数据变了、
    //       **DOM 不重排**，实测 itemX 还是 7（左侧）。
    //     · ①② 都能被内核**覆盖回去**：addDock 会拿 storage 里的旧 config 复用。
    //
    //   ⇒ 唯一可靠的做法：**removeDock 抹掉 → 改 storage → addDock 重插**。
    //     removeDock 把 `.dock__item` 从 DOM 摘掉，同时清掉 storage 里那一条；
    //     紧接着 addDock 按新的 position 重新插入，并把新 config 写回 storage。
    //     这样 ①②③ 三处一次性对齐。
    //
    //   ★ 代价与幂等 ★
    //     removeDock+addDock 会重置这个 dock 的宽度/展开态（一次性）。
    //     所以**只在"当前不在目标位置"时才做** —— 用 getPluginDockPlacements()
    //     （它读 DOM，正是最准的判据）判断；位置已经对了就一个字都不动。
    //     这也让内核把 uiLayout 改回来时，下一次 onload 能自动纠回去。
    //   ★ 调用时机：**addDock 之后**，且延迟一点 ★
    //     · 首次安装：addDock 才把按钮建出来，才谈得上"搬"；
    //       而 addDock 的 config.position 已经是 DOCK_POSITION，
    //       所以搬运那一步会直接幂等返回。
    //     · 已安装过的用户：按钮在 addDock 复用旧 config 后出现在**左侧**，
    //       此时搬到右侧。
    //     · 用 setTimeout(0) 让按钮先落进 DOM 再判，
    //       否则 querySelector 拿不到。
    if (!this.mobileOnly) {
      const ensure = () => this._ensureDockSide();
      setTimeout(ensure, 0);
      // 布局恢复可能比插件 onload 晚（页签/面板还在建）⇒ 再补一次
      setTimeout(ensure, 1200);
    }
    try {
      this.addDock({
        type: DOCK_TYPE,
        config: {
          position: DOCK_POSITION,
          size: { width: 300, height: 0 },
          // ★ icon 必须是**符号 id**，不是内联 SVG 字符串 ★
          //   与网盘插件同款（那边传 "iconNebulaDisk"）。传内联 <svg>…</svg>
          //   会被内核当 id 查符号 ⇒ 查不到 ⇒ 图标空白。
          icon: DOCK_ICON_ID,
          title: this.t("dockTitle") || "本机存储",
          hotkey: "",
          // ★ show:false 必须显式给 ★
          //   照网盘插件的写法：不给 false，思源不认为这个面板"还没被打开"，
          //   侧栏图标可能挂不上去（那边注释原话：「这是之前看不到入口的直接原因」）。
          show: false,
        },
        data: {},
        init: (dock) => {
          const ex = new Explorer(this, dock.element);
          this._explorers.push(ex);
          ex.start().catch((e) => this.toast(String(e && e.message ? e.message : e), true));
          return {
            update: () => { /* 主题切换时思源会调，这里不需要额外动作 */ },
            destroy: () => {
              const i = this._explorers.indexOf(ex);
              if (i >= 0) this._explorers.splice(i, 1);
              ex.destroy();
            },
          };
        },
      });
    } catch (e) {
      console.warn("[localfs] addDock 失败（移动端可能不支持）：", e);
    }

    // ── 页签（预览 / 编辑）────────────────────────────────────────
    //
    //   ★ 与网盘插件同款写法 ★
    //     addTab 注册类型 → openTab({custom}) 打开。init 时思源把
    //     容器塞进 `this.element`、把 openTab 时带的 `custom.data`
    //     塞进 `this.data`，Viewer 就靠这两个把内容画出来。
    //
    //   ★ 为什么必须 try/catch ★
    //     早期内核没有 addTab（或移动端阉割），抛出来会把整个 onload
    //     带崩 —— 那样连侧边栏都没了，代价远大于"少一个页签"。
    //
    //   ⚠️ init()/destroy() 里的 `this` 是**页签对象**（思源注入 element/data），
    //      不是插件实例。所以插件引用要用闭包捕获，别写成 this.plugin。
    const pluginSelf = this;
    try {
      this.addTab({
        type: TAB_TYPE,
        init() {
          // this.element / this.data 由思源注入
          this._lfsView = new TabView(this.element, this.data, pluginSelf);
        },
        beforeDestroy() {
          if (this._lfsView) { this._lfsView.destroy(); this._lfsView = null; }
        },
        destroy() {
          if (this._lfsView) { this._lfsView.destroy(); this._lfsView = null; }
        },
      });
    } catch (e) {
      console.warn("[localfs] addTab 失败（内核过旧或移动端阉割）：", e);
    }

    // ── 顶栏图标 ──────────────────────────────────────────────────
    //
    //   ★ 已按用户要求**去掉**（2026-10-09）★
    //     原来这里 addTopBar 挂了一个「本机存储」按钮，位置在顶栏右侧、
    //     紧挨着「盘绘」按钮。用户明确要求去掉它 —— 顶栏已经够挤了，
    //     而这个插件的入口本来就有两个更顺手的：
    //       · 左侧停靠栏的「本机存储」图标（addDock，见上）
    //       · 命令面板 / 快捷键的「打开本机存储」（addCommand，见下）
    //     所以直接不再注册顶栏按钮，而不是"注册了再想办法藏"。
    //     保留这段注释是为了记下**为什么没了**，免得日后被当成漏写补回来。

    // ── 命令：手机/键盘都能到 ─────────────────────────────────────
    this.addCommand({
      langKey: "openLocalStorage",
      hotkey: "",
      callback: () => this.openExplorer(),
    });

    // 一键收起所有已展开的嵌入块（长笔记里嵌了十几个重型预览时用）
    this.addCommand({
      langKey: "collapseAllEmbeds",
      hotkey: "",
      callback: () => this.collapseAllEmbeds(),
    });

    // ── 嵌入块（正文里的自定义块）────────────────────────────────
    //
    //   两件事，各一次：
    //     · registerEmbed  —— 把渲染器挂到 plugin.customBlockRenders，
    //                          内核按 data-info 的块类型来查它
    //     · bindEmbedDrop  —— 把「从文件树拖到正文」的落点监听挂到 document
    //                          （挂一次就够，内部有 _lfsDropBound 闸）
    try {
      registerEmbed(this);
      bindEmbedDrop(this);
    } catch (e) {
      console.warn("[localfs] 注册嵌入块失败（不影响浏览/预览）：", e);
    }

    // ── 斜杠菜单：/本机 → 嵌入本机文件到文档 ─────────────────────
    //
    //   ★ 为什么 filter 要同时给中英文和拼音 ★
    //     思源是用**用户敲进去的原文**去匹配 filter 的。用户可能敲
    //     `/本机`、`/lenovo`（不会）、`/文件`、`/embed`……
    //     多给几个别名几乎没有成本，匹配不到才是真麻烦。
    //   ★ callback 必须接住第二个参数 `el` ★
    //     它是「用户敲斜杠时所在的块元素」，插好之后要拿它清理 `/本机`
    //     这串残留（思源的 plugin 分支**不会**替插件删触发文本）。
    try {
      this.protyleSlash = [{
        filter: ["localfs", "benji", "本机", "本机存储", "wenjian", "文件", "embed"],
        html: '<div class="b3-list-item__first">' +
          '<span class="b3-list-item__text">' +
          (this.t("embedFileToDoc") || "嵌入本机文件到文档") +
          "</span></div>",
        id: "localfsEmbedFile",
        callback: (protyle, el) => {
          this.pickAndEmbed(protyle, el).catch((e) => {
            this.toast(String(e && e.message ? e.message : e), true);
          });
        },
      }];
    } catch (e) {
      console.warn("[localfs] 注册斜杠菜单失败（不影响其它入口）：", e);
    }

    // ── 设置入口只有一个：文件树顶部的齿轮（自绘面板）────────────────
    //   ★ 2026-10-10 整理：删掉了这里原来那套「思源原生设置」（new Setting
    //     + addItem）。它注册的项（服务地址、编辑开关）与自绘面板完全重复，
    //     两处都能改、两处各写各的盘 —— 用户看到两个"设置"入口只会困惑。
    //     现在只保留自绘面板（src/settings.js），入口是文件树的齿轮按钮。
    //   ★ 为什么不是反过来保留原生面板 ★
    //     原生面板只能放"一行一项"，撑不下「飞牛登录态」的同步/清除与
    //     「常用文件夹」的多选清单；而且它不跟随插件自己的 t() 文案。
    // -----------------------------------------------------------------

    // ── 对外契约：让别的插件能复用「本机存储」的能力 ────────────────
    //
    //   ★ 形状：`window.__localfsPlugin = { name, external }` ★
    //     与兄弟插件 siyuan-nebuladisk 的 `window.__nebuladiskPlugin` 同款，
    //     消费方（「盘绘」画布）那侧已经有一套成熟的消费写法，直接照搬即可。
    //     暴露的是"列目录 / 拿地址 / 打开文件 / 目录选择器"，**不含任何 UI**，
    //     也不认识具体是谁在用（详见 src/external.js 头的边界纪律）。
    //
    //   ★ 为什么要拿住卸载器 ★
    //     插件重载时新旧实例的 onload/onunload 可能交错，直接 delete 会把
    //     别人刚装上去的那个删掉；卸载器只删"确实是自己装的那个"。
    try {
      this._uninstallExternal = installExternal(this);
    } catch (e) {
      console.warn("[localfs] 对外契约挂载失败（只影响外部复用，不影响本插件）：", e);
    }

    // 首次后台探测（不挡启动）
    //
    //   ★ 把 Promise 留在 this.bootReady 上 ★
    //     嵌入块渲染器要等它：探测没落定之前先摆占位，落定后再决定渲染内容
    //     还是给提示。这里给它挂上 catch 是必须的 —— 不然会变成
    //     「未捕获的 Promise 异常」。
    this.bootReady = this.detect().then(() => true, () => false);
  }

  onLayoutReady() {
    // 面板可能比探测先就绪；这里再推一次，保证状态条是对的
    this.detect().then(() => {
      this._explorers.forEach((ex) => {
        if (!ex.cfg || !ex.treeEl || ex.treeEl.querySelector("." + "lfs-offline")) {
          ex.restart();
        }
      });
    }).catch(() => { /* 忽略 */ });
  }

  /**
   * 把「本机存储」dock 迁到右侧（幂等）。
   *
   * ★★ 为什么是"搬 DOM"，而不是改某个配置（两轮排查的最终结论）★★
   *
   *   思源前端 main.js 里的相关实现（真机 dump 出来的）：
   *
   *     class Tn {                              // 一个 dock 容器（左/右/底各一个实例）
   *       constructor(ye) {
   *         switch (ye.position) {
   *           case "Left":  this.elements = [...document.querySelectorAll(`#dockLeft  .dock__items`)]; break;
   *           case "Right": this.elements = [...document.querySelectorAll(`#dockRight .dock__items`)]; break;
   *         }
   *       }
   *       genButton(item, i) { … this.elements[i].appendChild(按钮) … }   // 按钮插进 DOM
   *       getPluginDockPlacements() { … this.elements[i].querySelectorAll(".dock__item") … }  // 从 DOM 读
   *       saveLocalPlugin(type, cfg) { storage[LOCAL_PLUGIN_DOCKS][插件][type] = cfg; XI(…) }  // 写 storage
   *     }
   *
   *     Ii(placements, plugins, stored) {        // 同步器
   *       placements.forEach(wt => {             // placements 来自 getPluginDockPlacements()，即 **DOM**
   *         const cfg = Co(wt.type, plugins, stored);
   *         if (cfg.config.position !== wt.position) cfg.config.position = wt.position;  // DOM → config
   *       });
   *     }
   *
   *   ⇒ **DOM 是唯一权威，storage / uiLayout 都是它的下游**。
   *     实测三次（.verify/_verify-dock-migrate.mjs / -dom-move / -save）：
   *       · 改 local-plugin-docks 的 position + 整页刷新 ⇒ 无效（被 DOM 反写回去）
   *       · 改 conf.json 的 uiLayout + setUILayout + reloadLayout ⇒ 数据变了，
   *         但 DOM **不重排**（实测 itemX 仍是 7）
   *       · 只搬 DOM ⇒ 位置立刻对，但刷新后又回左边（没持久化）
   *       · **搬 DOM + saveLocalPlugin() ⇒ 刷新后保持**（4/0 通过）★ 本函数采用
   *
   * ★ 做法 ★
   *   ① 找到我们的 `.dock__item[data-type$="localfsExplorer"]`；
   *   ② 若已经挂在 `#dockRight` 里 ⇒ 幂等返回（不动它，免得打断用户拖动）；
   *   ③ 否则把它 appendChild 到 `#dockRight .dock__items`（优先非空容器，
   *      否则落最后一个 —— 空的那格通常是"折叠区"，塞进去看不见）；
   *   ④ 调 `rightDock.saveLocalPlugin(FULL_TYPE, { position: DOCK_POSITION })`
   *      把结果固化到 `local-plugin-docks`。
   *      （`saveLocalPlugin` 会去 `app.plugins` 里按 type 找到我们的插件，
   *        把 config 写进 storage 并 XI() 持久化。）
   *
   * ★ 失败不致命 ★
   *   任何一步抛错都只 warn；dock 仍在（只是可能还在左侧，用户也能自己拖）。
   *   绝不能因此让整个 onload 挂掉。
   *
   * ★ 时机 ★
   *   调用点在 addDock **之前**：首次安装时页面上还没我们的按钮，找不到就
   *   直接 return；此时 addDock 会按 config.position 正确落到右侧。
   *   已经安装过的用户，按钮已在左侧 ⇒ 本函数把它搬过去。
   */
  _ensureDockSide() {
    const FULL_TYPE = "siyuan-localfs" + DOCK_TYPE;   // 思源把 pluginDir + type 拼起来
    try {
      const w = window;
      if (!w.siyuan || !w.siyuan.layout) return;

      // ── ① 我们的按钮在不在？──
      const sel = '[data-type$="' + DOCK_TYPE + '"]';
      const item = document.querySelector(sel);
      if (!item) return;                                 // 首次安装：按钮还不存在

      const rightRoot = document.getElementById("dockRight");
      if (!rightRoot) return;

      // ── ② 找到「RightTop 那一格」（上半格）──
      //   思源的右侧停靠栏 = 两个 .dock__items（上=RightTop / 下=RightBottom）。
      //   关系图(graph) 在上半格；我们要排它后面 ⇒ 目标就是关系图所在的那一格。
      const lists = [...rightRoot.querySelectorAll(".dock__items")];
      if (!lists.length) return;
      const graphItem = rightRoot.querySelector('[data-type="' + DOCK_AFTER_TYPE + '"]');
      // 关系图在哪一格，我们就去哪一格；找不到关系图就退回"有内容的那一格"
      let target = graphItem ? graphItem.closest(".dock__items") : null;
      if (!target) target = lists.find((c) => c.children.length > 0) || lists[0];
      if (!target) return;

      const alreadyHere = target.contains(item);
      const rightAfterGraph = graphItem && graphItem.nextElementSibling === item;
      if (alreadyHere && rightAfterGraph) return;         // 已在关系图正下方 ⇒ 幂等

      // ── ③ 落位：插到关系图**后面**；没有关系图就 append 到该格末尾 ──
      if (graphItem && target.contains(graphItem)) {
        graphItem.after(item);          // ★ 紧挨着关系图下面 ★（move，不是 copy）
      } else {
        target.appendChild(item);
      }

      // ── ④ 固化到 local-plugin-docks ──
      //   右 dock 实例上有 saveLocalPlugin（思源自己的方法）。
      //   它内部：按 type 在 app.plugins 里找到我们的插件 → 写 storage → XI() 持久化。
      try {
        const rd = w.siyuan.layout.rightDock;
        if (rd && typeof rd.saveLocalPlugin === "function") {
          rd.saveLocalPlugin(FULL_TYPE, { position: DOCK_POSITION });
        }
      } catch (e) {
        console.warn("[localfs] saveLocalPlugin 失败（位置可能不持久）：", e);
      }
    } catch (e) {
      console.warn("[localfs] _ensureDockSide 异常：", e);
    }
  }

  onunload() {
    // ★ 先摘掉挂在 document 上的拖拽监听 ★
    //   不摘的后果（用户实测，Windows 桌面端）：思源每次「重载 / 升级插件」
    //   都会重新 onload 一遍，而**旧监听不会自己消失** —— 一次拖拽被两个
    //   监听各处理一遍，正文里就插出**两个一模一样的嵌入块**。
    //   卸载器与之配套：bindEmbedDrop 里是"先摘后绑"，两边都不会攒。
    try {
      unbindEmbedDrop();
    } catch (e) { /* 摘不掉不致命 */ }
    // 摘掉对外契约（只摘自己装的那个，见 installExternal 的说明）
    try {
      if (this._uninstallExternal) this._uninstallExternal();
    } catch (e) { /* 摘不掉不致命 */ }
    this._uninstallExternal = null;
    // 先把展开着的嵌入块收掉：每个展开的块都挂着 iframe / 图片与 worker，
    // 直接卸插件会把这些渲染上下文一起丢掉（不致命，但没必要留着）。
    this.collapseAllEmbeds(true);
    if (this.preview) this.preview.close();
    this.closeExplorer();
    (this._explorers || []).forEach((ex) => ex.destroy());
    this._explorers = [];
  }

  // ------------------------------------------------------------------
  // 基础
  // ------------------------------------------------------------------

  /** 取一条 i18n；没有就走调用方给的兜底 */
  t(key) {
    try {
      const v = this.i18n && this.i18n[key];
      return v || "";
    } catch (e) {
      return "";
    }
  }

  toast(msg, isError) {
    try {
      showMessage(String(msg), isError ? 7000 : 3000, isError ? "error" : "info");
    } catch (e) {
      console.warn("[localfs]", msg);
    }
  }

  /**
   * OnlyOffice 用不用「移动版编辑器」（`documenteditor/mobile/`）。
   *
   * ★★ 2026-10-10 用户明确要求：**手机上也永不开启移动版** ⇒ 这里恒 false ★★
   *
   *   移动版是 OO 的另一套界面，缺掉完整的「文件 / 开始 / 插入 / 布局 / 引用 /
   *   协作 / 保护 / 视图 / 插件」菜单 —— 而用户要的恰恰就是那套完整菜单，
   *   之前为「页签里的 OO 显示完整编辑菜单」专门改过一次 customization。
   *   手机经**飞牛 App**打开思源时，内核给的本来就是**桌面版**前端，
   *   更没有必要把编辑器降成残缺的移动版。
   *
   *   为什么连判定都不留：先前两次都试过"按条件判手机"（`isMobile()` 与
   *   `innerWidth < 640`；后来再加按 UA），但在飞牛 App 里这两套都会失效
   *   ——`isMobile()` 恒 false，而"强制桌面模式"的 webview 宽度常 ≥ 640。
   *   判定的结果本来就不可靠，既然结论永远是 desktop，就不要留判定的余地。
   *
   *   注① 这个方法的**唯一用途**就是给 OO 传 layout —— 5 个调用点
   *       （`linkOf` / `embed.js`×2 / `preview.js` / `tabview.js` / `fileview.js`）
   *       全部是 `isMobileUi() ? "mobile" : "desktop"` 这一个形态。
   *       CAD / file-viewer / 图片等链路各有自己的移动端适配，不受这里影响。
   *   注② 服务端另有一道兜底（`local-fs.py` 的 `effective_layout`），也是恒 desktop
   *       —— 即使有别的客户端传 `layout=mobile` 进来，最终也不会走移动版。
   */
  isMobileUi() {
    return false;
  }

  // ★ 2026-10-10 整理：allowEdit() 已删除 ★
  //   Office / PDF 改用飞牛官方「Office 文档」后，可读可写由**文件自身的写权限**
  //   决定，插件传什么参数它都不看 ⇒ 这个开关和它的读取点一起下线。
  //   预览一律按只读态打开；要改文件，官方页面里本来就有的编辑能力照用。

  persist() {
    // ★ 速率限制 ★
    //   写盘会引来内核"插件数据已变"的推送 → 前端重载插件 → onload 再跑一遍。
    //   一旦哪里在热路径上写盘，就会变成每秒两次的**重载风暴**（真机实测过：
    //   静置 6 秒被重载 13 次，console 全是 saveData 拒绝）。这里加一道闸，
    //   让"笔误式的高频写"最多也只能每 2.5 秒写一次，不会失控。
    const now = Date.now();
    if (now - this._lastPersistAt < 2500) {
      console.warn("[localfs] 写盘过于频繁，已跳过这次（见 index.js persist 的说明）");
      return;
    }
    this._lastPersistAt = now;
    try {
      const p = this.saveData(STORAGE_KEY, this.settings);
      // ★ saveData 返回的是 Promise，而且拒绝值是**纯对象** {code,msg,data}
      //   （410 插件已销毁 / 403 只读或发布模式）—— try/catch 抓不到它，
      //   不对它挂 catch 就会变成未捕获的 Promise 异常。
      if (p && typeof p.catch === "function") {
        p.catch((e) => {
          console.warn("[localfs] 设置没能写回内核（不影响本次使用）：",
            e && e.msg ? e.msg : e);
        });
      }
    } catch (e) {
      /* 存不上不致命 */
    }
  }

  /**
   * 把这次探测用上的地址记进设置，下次省一轮探测。
   *
   * ★ 只能在**用户动作**之后调用 ★
   *   绝不能挂在"探测成功"上：saveData 会让内核推送"插件数据已变"，
   *   前端随之重载插件，重载后的 onload 又去探测、又写盘…… 死循环。
   *   所以本方法只由设置面板的「保存」按钮调用（一次性写盘，不可能成环）。
   *   ★ 2026-10-10 整理：「记住探测到的地址」开关已删 —— 这个行为本来就该
   *     永远开着（用户感受不到它，只少一轮探测），不必做成选项。
   */
  rememberBase() {
    if (this.base && this.settings.lastBase !== this.base) {
      this.settings.lastBase = this.base;
      this.persist();
    }
  }

  /**
   * 探测服务地址。
   * ★ 统一走 api.js 的 detectBase ★
   *   早先这里是"先自己探一次 lastBase，再调 detectBase"，等于把候选顺序
   *   写死了在插件里 —— 结果就是**跨源的缓存地址被优先探测**，同源明明可用
   *   却先白等 2.5 秒、还刷一屏 CORS 报错。顺序现在只由 api.js 一处决定。
   *
   * ★ 这里**绝不写盘** ★
   *   思源的 saveData 会写 /data/storage/petal/<插件名>/，内核随后推送
   *   "插件数据已变" → 前端重载插件 → onload 又跑 detect → 又写盘 …… 死循环。
   *   真机上这直接表现成每秒两次的重载风暴（静置 6 秒被重载 13 次），
   *   被重载销毁的旧实例再调 saveData 只会拿到 410 拒绝，console 一片红。
   *   所以缓存地址只在用户点「保存」时落盘（见 rememberBase）。
   *
   * @param {boolean} [force] 丢弃缓存重探（用户在设置里改过地址时用）
   */
  async detect(force) {
    if (force) resetDetection();
    const r = await detectBase(this.settings.baseUrl, this.settings.lastBase);
    this.base = r.base;
    this.health = r.health;
    return r;
  }

  applySettings() {
    // 用户可能刚改了地址 —— 强制重探，别让负缓存把新地址也挡住
    const run = () => this._explorers.forEach((ex) => ex.restart());
    return this.detect(true).then(run, run);
  }

  apiConfig() {
    return apiGet("/api/config", null, 8000);
  }

  // ------------------------------------------------------------------
  // 动作
  // ------------------------------------------------------------------

  /**
   * 打开前的统一体检（存在 / 权限 / 是不是目录）。
   *
   * ★ 为什么要拦在"开"之前 ★
   *   四条入口（预览、页签、下载、浏览器打开）如果各自闷头去 iframe / fetch，
   *   失败形态是"白屏"或"内容与扩展名不匹配"，用户完全无从下手。
   *   先问一次 /api/probe，把结论翻译成对话框，比什么都强。
   *
   * ★ 失败时**不抛**，只弹对话框 ★
   *   调用方是 UI 事件处理器，抛出去只会变成 console 里一条没人看的报错；
   *   返回 false 让它们就此收手即可。
   *
   * @returns {Promise<boolean>} 通过返回 true
   */
  async guardOpen(item) {
    if (!item || !item.path) return false;
    try {
      await this.ensureBase();
    } catch (e) {
      showDialog({
        kind: "error",
        title: "本机存储服务不可用",
        message: "还没有连接到本机存储服务，无法打开文件。\n\n" +
          "面板里可以点「设置」填地址，或先确认 NAS 上的「思源笔记」应用在运行。",
        detail: String(e && e.message ? e.message : e),
      });
      return false;
    }
    const res = await validateOpen(item.path);
    if (!res.ok) {
      showValidateError(res, { onOk: () => this.explorer && this.explorer.reloadAll && this.explorer.reloadAll() });
      return false;
    }
    // 体检通过：顺手把最新的大小/类型补回 item，省得后面再探一次
    if (res.info) {
      if (res.info.size != null && item.size == null) item.size = res.info.size;
      if (res.info.name && !item.name) item.name = res.info.name;
    }
    return true;
  }

  /**
   * 打开预览。
   * @param {{path:string,name?:string,size?:number}} item
   * @param {"view"|"edit"} [mode]
   */
  openPreview(item, mode) {
    if (!item || !item.path) return;
    const node = {
      path: item.path,
      name: item.name || baseNameOf(item.path),
      size: item.size,
      kind: item.kind || kindOfName(item.path),
    };
    this.guardOpen(node).then((ok) => {
      if (!ok) return;
      // ★ 体检通过后重新取一次"邻居"再进预览 ★
      //   预览里的「上一个 / 下一个」要按**同一目录下的可见顺序**走，
      //   这份顺序只有列目录接口知道；提前拿好，切换时就不必再等网络。
      return this.loadSiblings(node).then((sib) => this.preview.open(node, mode, sib));
    }).catch((e) => this.toast(String(e && e.message ? e.message : e), true));
  }

  /**
   * 取"同目录下的兄弟文件"清单（供预览里的上一个/下一个）。
   * ★ 失败不当错误 ★ 拿不到就退化成"没有邻居"，导航按钮隐藏，预览照常可用。
   * @returns {Promise<{items:Array, index:number}>}
   */
  async loadSiblings(node) {
    const empty = { items: [], index: -1 };
    if (!node || !node.path) return empty;
    const dir = node.path.replace(/\/[^/]*$/, "") || "/";
    try {
      const r = await apiGet("/api/list", { source: "local", path: dir });
      const all = (r && r.items) || [];
      // 只把**文件**算作可导航对象（目录不能开进预览）
      const files = all.filter((it) => it && !it.isDir).map((it) => ({
        path: it.path, name: it.name, size: it.size,
      }));
      let idx = files.findIndex((f) => f.path === node.path);
      if (idx < 0) {
        // 体检成功但列表里没它（例如刚被过滤掉）：插到最前，至少能导航别人
        files.unshift({ path: node.path, name: node.name, size: node.size });
        idx = 0;
      }
      return { items: files, index: idx };
    } catch (e) {
      return empty;
    }
  }

  /** 有可用地址就直接用，别再探一轮（预览是高频动作） */
  async ensureBase() {
    if (this.base && getHealth()) return this.base;
    const r = await this.detect();
    return r.base;
  }

  /**
   * 在**思源页签**里打开（预览 / 编辑）—— 与网盘插件同一条链
   * （addTab 注册的类型 + openTab({custom}) 打开）。
   *
   * @param {{path:string,name?:string,size?:number}} item
   * @param {{mode?:"view"|"edit", forceNew?:boolean, skipGuard?:boolean}} [opts]
   *        mode      —— 仅对 Office 有意义（edit 走 OnlyOffice 编辑）
   *        forceNew  —— 跳过"复用已有页签"，强制开一个新的
   *        skipGuard —— 已经体检过（例如从预览里「在页签中打开」）时跳过重复体检
   * @returns {Promise<boolean>} 是否真的开了/复用了页签
   */
  async openFileInTab(item, opts) {
    if (!item || !item.path) return false;
    const o = opts || {};
    const node = {
      path: item.path,
      name: item.name || baseNameOf(item.path),
      size: item.size,
      kind: item.kind || kindOfName(item.path),
      mode: "view",
    };

    // 已开着就先激活，无需体检（内容早就在了）
    if (!o.forceNew && tryReuseViewerTab(this, node)) return true;

    if (!o.skipGuard) {
      const ok = await this.guardOpen(node);
      if (!ok) return false;
    }

    try {
      openTab({
        app: this.app,
        custom: {
          id: tabTypeFull(this),   // 必须与 addTab 的「插件名 + type」一致
          icon: "iconLocalfs",
          title: node.name,
          data: node,
        },
      });
      return true;
    } catch (e) {
      // openTab 在极老的内核上不存在 —— 退回浮层，至少让用户看得到内容
      console.warn("[localfs] openTab 失败，退回浮层预览：", e);
      this.openPreview(item, node.mode);
      return false;
    }
  }

  async downloadNode(node) {
    try {
      await this.ensureBase();
      const res = await validateOpen(node.path);
      if (!res.ok) {
        showValidateError(res, { title: "无法下载" });
        return;
      }
      await downloadFile(node.path, node.name || baseNameOf(node.path));
    } catch (e) {
      showDialog({
        kind: "error",
        title: "下载失败",
        message: String(e && e.message ? e.message : e),
      });
    }
  }

  openInBrowser(node) {
    const url = this.linkOf(node);
    window.open(url, "_blank", "noopener");
  }

  /**
   * 「在浏览器中打开」用的地址。
   * ★ 统一走 kinds.js 的 externalUrlOf ★
   *   路由规则（哪类文件走哪条链路）只在 kinds.js 写一份，
   *   免得这里、浮层、页签三处各判一遍、改一处漏两处。
   *
   * ★ 2026-10-10 起 mode 恒 "view" ★
   *   这个地址被三处共用：文件树右键「在浏览器中打开」、浮层工具条、
   *   嵌入块新增的「在网页打开」。所以改这一处就三处一起生效。
   *   Office / PDF 走飞牛官方应用，它对"可读可写"的判断完全在服务端
   *   （按文件自身权限），插件传的 mode 它不看 ⇒ 这里不再有"编辑模式"。
   *   CAD / 图片 / 文本这些链路本来就不看 mode，不受影响。
   */
  linkOf(node) {
    return externalUrlOf(node.path, { cadViewerUrl, officeUrl, fileViewerUrl, fileUrl },
      {
        mode: "view",
        layout: this.isMobileUi() ? "mobile" : "desktop",
      });
  }

  // ------------------------------------------------------------------
  // 嵌入块（正文里的自定义块）
  // ------------------------------------------------------------------

  /**
   * 「本机存储通道可用吗」。
   *
   * ★ 为什么这里**恒返回 true** ★
   *   网盘插件那版返回的是"用户填了地址没有"（它有跨源地址要配）。本插件的
   *   地址是**自动探测**出来的，没有"必须先配点什么"的前置条件，所以拿"有没有
   *   探测成功"当判据只会制造假阴性：
   *     · 桌面客户端上探测本来就该失败（服务跑在 NAS 上，得用户在设置里填地址）
   *     · 探测是异步的，文档里的嵌入块完全可能比它先渲染
   *   一旦这里返回 false，渲染器就会在**不加载内容**的前提下直接摆一句
   *   「服务不可用」——而用户点一下「点击预览」很可能就通了。
   *
   *   ⇒ 判据交给**动作**：块先画外壳 + 「点击预览」占位（本来就不加载内容），
   *     真去读的时候 `ensureBase()` 失败会给出可读原因。
   *   `bootReady` 仍然保留并赋值，供渲染器等"启动落定"再动（见 embed.js）。
   */
  channelReady() {
    return true;
  }

  /**
   * 当前活动的编辑器实例。找不到返回 null（**不要**在这里拦截调用方）。
   *
   * ★ 为什么不能"拿不到就返回" ★
   *   从预览浮层 / 侧边栏 / 斜杠菜单点「嵌入到文档」时，焦点往往在插件自己
   *   的 DOM 上，`.protyle-wysiwyg--focus` 可能不存在 —— 但文档其实开着。
   *   定位这件事由 embed.js 的 locateInsertPoint 多级回退负责（锚点元素、
   *   protyle.block、dataset.nodeId、选区、聚焦页签……），比这里靠谱得多。
   *   在这里判空直接 return 等于把那条回退链掐死，用户明明开着文档却被提示
   *   "请先打开一个文档"。
   */
  activeProtyle() {
    try {
      const el = document.querySelector(".protyle-wysiwyg--focus") ||
        document.querySelector(".protyle-wysiwyg");
      if (!el) return null;
      const host = el.closest(".protyle");
      return (host && host._protyle) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * ★ 四个插入入口的公共出口 ★
   *   文件树右键 / 预览工具栏 / 斜杠菜单选文件 / 从文件树拖进正文 ——
   *   全部落到 insertEmbedIntoDoc 这一条通道上（通道内部走内核 API + `；；；`围栏）。
   *
   * @param {{path:string,name?:string}} node
   * @param {{isDir?:boolean, anchorEl?:HTMLElement, protyle?:object}} [opts]
   *        anchorEl 只有斜杠菜单会给（用来定位 + 清理 `/本机` 残留）；
   *        protyle 相应地也是斜杠菜单给的（那时活动编辑器可能已被面板抢走焦点）
   */
  async insertNodeEmbed(node, opts) {
    const o = opts || {};
    if (!node || !node.path) return false;
    const spec = o.isDir
      ? { kind: "tree", path: node.path }
      : {
        kind: "file",
        path: node.path,
        name: node.name || baseNameOf(node.path),
      };
    try {
      const ok = await insertEmbedIntoDoc(this, o.protyle || this.activeProtyle(), spec, {
        anchorEl: o.anchorEl || null,
        fromSlash: !!o.anchorEl,
      });
      this.toast(
        ok ? (this.t("embeddedToDoc") || "已嵌入到当前文档")
          : (this.t("embedNotCustom") || "插入失败：内核没有生成自定义块"),
        !ok
      );
      return ok;
    } catch (e) {
      // ★ 失败原因要露出来 ★ 尤其是"找不到要插入的文档"这种用户能自助解决的
      try {
        if (e && e.trace) console.log("[localfs] 定位轨迹：" + e.trace);
      } catch (err) { /* 忽略 */ }
      this.toast(
        (this.t("embedFailed") || "嵌入失败") + "：" + ((e && e.message) || "未知原因"),
        true
      );
      return false;
    }
  }

  /**
   * 斜杠菜单入口：拉一个"选择文件"的全屏浏览，选中后插入。
   *
   * ★ 为什么复用浏览面板而不是另写一个文件选择器 ★
   *   面板已经把"逐层列目录 + 缓存 + 移动端布局"都做完了；另写一个选择器就是
   *   把同一套逻辑抄第二遍（网盘插件那边就抄了两份，后来必须同步改两处）。
   *   这里只给 Explorer 加一个 `pick` 模式：行点击不再开预览，改成回调。
   */
  async pickAndEmbed(protyle, anchorEl) {
    const editor = protyle || this.activeProtyle();
    this.openExplorer({
      pick: {
        title: this.t("pickFileTitle") || "选择要嵌入的文件",
        allowDir: true,
        onPick: (node) => {
          // 面板已关；插入是异步的，让它在后台跑完再提示
          this.insertNodeEmbed(node, {
            isDir: !!node.isDir,
            anchorEl: anchorEl || null,
            protyle: editor,
          }).catch(() => { /* insertNodeEmbed 内部已提示 */ });
        },
        onCancel: () => {
          // 用户放弃选择 —— `/本机` 这串触发文本还留在正文里，清掉它
          // （思源的斜杠菜单 plugin 分支不替插件删触发文本，见 embed.js 的说明）
          try {
            cleanupSlashText(anchorEl);
          } catch (e) { /* 清不掉不致命 */ }
        },
      },
    });
  }

  /**
   * 收起**所有**已展开的嵌入块（命令入口 + onunload）。
   *
   * 嵌入块是懒加载的：不点就不请求。但点开过的那些会真的挂上 iframe、
   * 解码整张图、读几百 KB 文本 —— 一篇笔记里点开七八个之后，内存全压在那儿。
   * 这个动作就是"全收回来"。
   *
   * @param {boolean} [silent] onunload 传 true：用户正在关东西，别再弹提示
   * @returns {number} 实际收起了几个
   */
  collapseAllEmbeds(silent) {
    let n = 0;
    try {
      n = collapseAllOpenEmbeds();
    } catch (e) {
      /* 单个块失败已在 embed.js 里吞掉，这里只兜底 */
    }
    if (!silent) {
      this.toast(n > 0
        ? (this.t("collapsedEmbeds") || "已收起嵌入块") + "：" + n
        : (this.t("noOpenEmbeds") || "没有展开中的嵌入块"));
    }
    return n;
  }

  copyText(text) {
    const s = String(text == null ? "" : text);
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        this.toast(this.t("copied") || "已复制");
      } catch (e) {
        this.toast(this.t("copyFailed") || "复制失败", true);
      }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(
        () => this.toast(this.t("copied") || "已复制"),
        fallback
      );
    } else {
      fallback();
    }
  }

  openSettings(onSaved) {
    openSettings(this, onSaved);
  }

  // ------------------------------------------------------------------
  // 全屏浏览（手机上这是主要入口）
  // ------------------------------------------------------------------

  /**
   * 打开全屏浏览浮层（手机上的主要入口）。
   *
   * @param {{pick?:object}} [opts]
   *        `opts.pick` 传进来就进「选择模式」：
   *          · 点文件 = 选中它（回调 onPick），不再开预览
   *          · 目录行右侧多一个「选它」，用来嵌入整个目录
   *          · 顶部显示提示语 + 「取消」
   *        斜杠菜单的 `pickAndEmbed` 走的就是这条路。
   */
  openExplorer(opts) {
    if (this._overlay) return;
    const o = opts || {};
    const mask = document.createElement("div");
    mask.className = "lfs-mask is-narrow";
    const modal = document.createElement("div");
    modal.className = "lfs-modal is-narrow";
    mask.appendChild(modal);

    // 选完/取消后要**先关浮层**再回调（否则回调里弹的提示会被浮层盖住）
    const pick = o.pick
      ? Object.assign({}, o.pick, {
        onPick: (node) => {
          const cb = o.pick.onPick;
          this.closeExplorer();   // ★ 注意：这里会清掉 this._overlay
          if (typeof cb === "function") cb(node);
        },
        onCancel: () => {
          const cb = o.pick.onCancel;
          this.closeExplorer();
          if (typeof cb === "function") cb();
        },
      })
      : null;

    const ex = new Explorer(this, modal, { pick });
    ex.start().catch((e) => this.toast(String(e && e.message ? e.message : e), true));

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (pick) pick.onCancel();
        else this.closeExplorer();
      }
    };
    document.addEventListener("keydown", onKey, true);
    mask.addEventListener("click", (e) => {
      if (e.target !== mask) return;
      // 点遮罩关：选择模式下也算"取消"（要清理斜杠残留）
      if (pick) pick.onCancel();
      else this.closeExplorer();
    });

    document.body.appendChild(mask);
    this._explorers.push(ex);
    this._overlay = { mask, ex, onKey, pick };
  }

  closeExplorer() {
    const o = this._overlay;
    if (!o) return;
    this._overlay = null;
    document.removeEventListener("keydown", o.onKey, true);
    const i = this._explorers.indexOf(o.ex);
    if (i >= 0) this._explorers.splice(i, 1);
    o.ex.destroy();
    if (o.mask.parentNode) o.mask.parentNode.removeChild(o.mask);
  }
}
