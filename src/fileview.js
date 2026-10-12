import { KIND, kindOfName, rendererOf, RENDERER } from "./kinds";
import { cadViewerUrl, officeUrl, fileViewerUrl, fileUrl, readText } from "./api";
import { purifyFileViewer, purifyCadViewer, purifyOffice, repin } from "./purify";

/* ==========================================================================
 * 文件内容渲染核（FileView）
 * --------------------------------------------------------------------------
 * 「按类型把文件内容渲染进**一个容器**」这件事只在这里做一遍。
 *
 *   · 页内浮层预览（src/preview.js）   → 容器 = 浮层的 body
 *   · 思源页签视图（src/tabview.js）   → 容器 = 页签的 body
 *
 * 两侧的**外壳**（浮层遮罩 / 页签工具条）各写各的，内容区共用这一份 ——
 * 免得下面这 8 条分派分支被抄成两份、改一处忘一处（网盘插件那边就踩过：
 * viewer.js 与 embed.js 各有一套 render，后来必须同步改两处）。
 *
 * ★★★ 装 iframe 的盒子在整个生命周期里只能 append 一次 ★★★
 *   细节见 _iframe 的注释：Chrome 只要看到 iframe 被移出 DOM 再插回来就会
 *   重新加载；「load → 摘盒子 → 挂盒子」会变成无限自刷新（真机实测过：
 *   12 秒内同一个地址被请求 19 次、canvas 始终是 0）。
 *   ⇒ 加载完成后**只删加载动画**（它是兄弟节点），绝不碰 iframe 所在的盒子。
 *
 * ★★★ 现在有四条链路（2026-10-09 第二次调整）★★★
 *   · CAD      → 飞牛原生「CAD 看图」应用（同源通道 /localfs/cad/，iframe）
 *   · Office/PDF → 飞牛官方「Office 文档」应用（同源通道 /localfs/docs，iframe）
 *     └ PDF    → 也走这条（OO 原生就是 PDF 阅读器）
 *   · 原生     → **图片 / 音频 / 视频 / 文本** 用浏览器原生标签自己画
 *                （<img>/<video>/<audio>/<pre>，同源读 /localfs/api/file）
 *   · 其余     → 「文件预览」应用（fnos-file-viewer，经同源通道 /localfs/fv/）
 *                兜底压缩包 / 3D / OFD / 邮件这些我们实现不了的格式
 *
 *   ★ 为什么把图片/音视频/文本从 file-viewer 收回来自己画 ★
 *     file-viewer 是个"应用"：带自己的左侧文件树、顶部条、错误卡片。
 *     把它嵌进来就得永远跟它的外壳打架（需求 3.3 报的"多了一层"
 *     就是它的 error overlay），而且多一次跨文档请求、多一层初始化等待。
 *     <img src> / <video src> / <audio src> 是浏览器原生的，**零外壳、零等待**，
 *     对这三种格式来说本来就是最优解。
 * ========================================================================== */





const CLS = "lfs";

/** 小工具：建元素（三个插件模块共用，所以从这里导出） */
export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

/** 人类可读的容量 */
export function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let x = v;
  do {
    x /= 1024;
    i++;
  } while (x >= 1024 && i < u.length - 1);
  return x.toFixed(x >= 100 ? 0 : 1) + " " + u[i];
}

/** 把本地绝对路径切成面包屑显示用的段（/vol1/a/b → ["/vol1","a","b"]） */
export function pathParts(p) {
  const s = String(p || "");
  const parts = s.split("/").filter(Boolean);
  if (!parts.length) return [];
  const head = "/" + parts.shift();
  return [head].concat(parts);
}

export class FileView {
  /**
   * @param {{plugin:object, container:HTMLElement, bare?:boolean}} opts
   *        container —— 内容渲染进哪儿（浮层的 body / 页签的 body）
   *        bare      —— 「只要内容、不要外壳」：
   *                     · 文件预览 → 藏掉它自己的左侧文件树 + 顶部条（注入 CSS）
   *                     · CAD      → 藏掉顶部工具栏 + 底部状态栏（注入 CSS）
   *                     · Office   → URL 上带 bare=1，由宿主页关掉 toolbar/header
   *                     页签里用（需求 #7）；浮层里保持完整外壳。
   */
  constructor(opts) {
    const o = opts || {};
    this.plugin = opts && o.plugin;
    this.container = o.container;
    this.bare = !!(o && o.bare);
    this.item = null;
    this.mode = "view";
    this.destroyed = false;
    /**
     * 最近一次 iframe 指向的地址。
     * 测试（.verify/*-live.mjs）靠读 `.lfs-frame` 的 src 来断言"分派到了哪条链路"，
     * 这里留一份纯粹方便调试时在控制台看。
     */
    this.lastSrc = "";
    /** 当前 iframe 上的"净化"定时器（见 _purify / destroy） */
    this._purifyTimers = [];
  }

  /**
   * 换一个文件渲染（同一个 FileView 可以反复用）。
   * @param {{path:string,name?:string,size?:number,kind?:string}} item
   * @param {"view"|"edit"} [mode] 仅对 Office 有意义；其余类型忽略
   */
  show(item, mode) {
    this.item = item;
    this.mode = mode === "edit" ? "edit" : "view";
    this.render();
    return this;
  }

  /** 只切模式（Office 的「预览 / 编辑」开关） */
  setMode(mode) {
    this.mode = mode === "edit" ? "edit" : "view";
    this.render();
    return this;
  }

  /** 「刷新」按钮 */
  rerender() {
    this.render();
    return this;
  }

  destroy() {
    this.destroyed = true;
    this.item = null;
    this._purifyTimers.forEach((t) => { try { clearTimeout(t); } catch (e) { /* 忽略 */ } });
    this._purifyTimers = [];
    if (this.container) {
      try { this.container.innerHTML = ""; } catch (e) { /* 容器已不在 */ }
    }
  }

  render() {
    const item = this.item;
    if (!item || this.destroyed) return;
    const kind = item.kind || kindOfName(item.path);
    const mobile = this.plugin.isMobileUi();

    // ★ bare 的两种语义（2026-10-09，需求 3.1）★
    //   `true`   = **嵌入块**：所有类型都只留内容（CAD 藏工具栏、file-viewer 藏外壳、
    //              Office 走 bare=1）。
    //   `"fv"`   = **页签**：只有 file-viewer 那条链路需要藏外壳（它的 #sidebar/#topbar
    //              是"应用外壳"，不是文件内容）；**CAD / Office 要完整工具栏** ——
    //              用户明确要求「页签中的 CAD 显示完整工具栏」，所以 CAD 拿到 "fv"
    //              时**不**净化。
    //   为什么页签必须藏 file-viewer 外壳：它的 #sidebar 是"本机文件浏览器"，
    //   嵌在思源页签里等于给同一台机器开了第二个文件管理器，纯噪音。
    const full = this.bare === true;          // 全净化（嵌入块）
    const fvOnly = this.bare === "fv";        // 只净化 file-viewer（页签）

    // ★ 先按"用哪条链路"分派，再看具体是哪种文件 ★
    //   （rendererOf 的映射表在 kinds.js，那里有完整的路由说明）
    const renderer = rendererOf(kind);

    switch (renderer) {
      // ── CAD：借飞牛原生「CAD 看图」应用（同源通道 /localfs/cad/?path=…）──
      case RENDERER.CAD:
        this._iframe(cadViewerUrl(item.path), this.plugin.t("loadingDrawing") || "正在加载图纸…",
          full ? "cad-bare" : "");
        return;

      // ── Office（含 PDF）：飞牛官方「Office文档」，同源通道 /localfs/docs ──
      case RENDERER.OFFICE: {
        // ★ 2026-10-10 整理：插件侧不再有"编辑模式" ★
        //   mode 一律 view —— 官方那套按文件写权限自己决定，参数它不看；
        //   设置里那个「允许在线编辑」开关也已随之删除。
        const mode = "view";
        // ★ 2026-10-10 换主 ★
        //   旧版走自研的 OO 宿主（local-fs 的 /oo/editor），它认 mode/layout/bare，
        //   靠 `bare=1` 让后端关掉工具栏。
        //   现在这条路走**飞牛官方那套**：它的编辑页按文件写权限自己决定模式，
        //   **不接受 mode/layout/bare 任何参数**（实测 editor.html 里没有
        //   location.search 的用法）⇒ 净化改成**同源注入样式**（purifyOffice）。
        this._iframe(officeUrl(item.path, mode, mobile ? "mobile" : "desktop", full),
          mode === "edit" ? (this.plugin.t("loadingEditor") || "正在打开编辑器…")
            : (this.plugin.t("loadingOffice") || "正在打开文档…"),
          full ? "office-bare" : "");
        return;
      }

      // ── 原生：图片 / 音频 / 视频 / 文本，用浏览器标签直接画 ──────────
      case RENDERER.NATIVE:
        this._native(item, kind);
        return;

      // ── 其余：交给「文件预览」（files-viewer / fnos-file-viewer）──────
      //   压缩包、3D 模型、OFD、邮件… 它内置 200 多种格式的浏览器端解析。
      //   走的是反代的同源通道 /localfs/fv/（手机穿透也能用）。
      default:
        this._iframe(fileViewerUrl(item.path), this.plugin.t("loading") || "加载中…",
          (full || fvOnly) ? "fileviewer-bare" : "");
        return;
    }
  }

  /**
   * 用 iframe 承载（CAD / Office / 文件预览都是这一路）。
   * ★ 见文件头「装 iframe 的盒子只能 append 一次」的说明 ★
   *
   * @param {string} src
   * @param {string} hint  加载动画上的文案
   * @param {string} [mode] "fileviewer-bare" / "cad-bare" / "office-bare"
   *                        ⇒ 加载后净化同源 iframe
   */
  _iframe(src, hint, mode) {
    this.lastSrc = src;

    // 先建好盒子与 iframe，但**先不设 src、也先不入 DOM**：
    // 这样它就不会在"清空容器"那一瞬间被启动。
    const box = el("div", CLS + "-frame-box");
    const f = document.createElement("iframe");
    f.className = CLS + "-frame";
    // CAD 查看器与 OnlyOffice 都需要同源下的脚本/worker
    f.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");
    f.setAttribute("allowfullscreen", "true");
    f.setAttribute("referrerpolicy", "no-referrer");
    box.appendChild(f);

    // 加载动画：**兄弟节点**，盖在盒子上；加载完只删它，不碰 iframe
    const spin = this._spinnerNode(hint || "加载中…");
    spin.classList.add(CLS + "-frame-spin");

    this.container.innerHTML = "";   // 清掉上一次的内容（一次性；此后不再动盒子里的东西）
    this.container.appendChild(box);
    this.container.appendChild(spin);

    let loaded = false;
    f.addEventListener("load", () => {
      loaded = true;
      if (spin.parentNode) spin.parentNode.removeChild(spin);
      if (mode === "fileviewer-bare") this._purify(f, purifyFileViewer);
      else if (mode === "cad-bare") this._purify(f, purifyCadViewer);
      else if (mode === "office-bare") this._purify(f, purifyOffice);
    });
    f.src = src;

    // 8 秒还没 load 出来，在加载动画里补一句可读的兜底（多半是地址不可达）
    setTimeout(() => {
      if (loaded || this.destroyed || !spin.parentNode) return;
      spin.appendChild(el("div", CLS + "-frame-tip",
        (this.plugin.t("stillLoading") || "还在加载…") +
        "　<a href=\"" + src + "\" target=\"_blank\" rel=\"noopener\">" +
        (this.plugin.t("openInBrowser") || "在浏览器中打开") + "</a>"));
    }, 8000);
  }

  /**
   * 对**同源** iframe 做净化（藏掉查看器自带的外壳）。
   *
   * ★ 为什么要重试几次 ★
   *   查看器都是异步渲染的，load 那一刻 DOM 可能还没稳定。
   *   ⇒ 交给 purify.repin() 在头几秒内多钉几次。
   *
   * ★ 为什么能读到 contentDocument ★
   *   三条链路现在**全部走同源通道**（挂在思源这个源下）：CAD、文件预览、
   *   以及 Office（飞牛官方 trim.docs）。所以这里都能注入样式。
   *   ⚠️ 更早的版本里 Office 是跨源的（/localfs/oo-srv → :8082），那时候
   *      这条路走不通、只能在 URL 上带 bare=1 —— 已作废。
   *
   * @param {HTMLIFrameElement} f
   * @param {(doc:Document)=>void} apply  注入器
   */
  _purify(f, apply) {
    const run = () => {
      if (this.destroyed) return;
      let doc;
      try { doc = f.contentDocument; } catch (e) { return; }   // 非同源（理论上不会到这儿）
      if (!doc || !doc.head) return;
      apply(doc);
    };
    repin(run, [300, 1000, 2500], this._purifyTimers);
  }

  /**
   * 原生渲染：**图片 / 音频 / 视频 / 文本**（含 Markdown）。
   *
   * ★ 为什么这条链路不用 iframe ★
   *   这三种格式浏览器本来就原生支持，`<img src>` / `<video src>` / `<audio src>`
   *   就是最干净的预览：没有外壳、没有跨文档初始化、没有额外一跳。
   *   之前把它们推给 file-viewer，反而换来一个带侧栏+顶栏的"应用"要净化。
   *
   * ★ 地址用同源 /localfs/api/file ★
   *   `fileUrl()` 给的是 `location.origin + /localfs/api/file?path=…`，
   *   内网 / ZeroTier / 外网穿透三种走法都成立；而且同源 ⇒
   *   `<video>` 的 range 请求、`<img>` 的直接加载都不会触发 CORS。
   *
   * ★ 文本为什么要先 fetch 再画 ★
   *   不能直接 `<iframe src=fileUrl>`（那又会带出浏览器的下载/渲染行为，
   *   且无法控制编码与行号）。这里 `readText()` 只取前 N KB，
   *   用 `<pre>` 高保真等宽显示 —— 大日志文件也不会把内存吃满。
   */
  _native(item, kind) {
    const url = fileUrl(item.path);
    this.container.innerHTML = "";

    const wrap = el("div", CLS + "-native");
    const body = el("div", CLS + "-native-body");
    wrap.appendChild(body);
    this.container.appendChild(wrap);

    // ── 图片 ──────────────────────────────────────────────────────────
    if (kind === KIND.IMAGE) {
      const img = document.createElement("img");
      img.className = CLS + "-native-img";
      img.alt = item.name || "";
      img.decoding = "async";
      // ★ 失败要说人话 ★ 图片解码失败（损坏 / 是不认识的子格式）时，
      //   别留一个碎图标，给一条能走的出路。
      img.addEventListener("error", () => {
        body.innerHTML = "";
        const n = el("div", CLS + "-notice");
        n.appendChild(el("div", CLS + "-notice-title",
          this.plugin.t("imgFailed") || "这张图片打不开"));
        n.appendChild(el("div", CLS + "-notice-detail", item.path));
        body.appendChild(n);
      });
      img.src = url;
      body.appendChild(img);
      // 点一下在新的浏览器页签里看原图（能缩放/另存）
      img.addEventListener("click", () => {
        try { window.open(url, "_blank", "noopener"); } catch (e) { /* 弹窗被拦就算了 */ }
      });
      return;
    }

    // ── 音频 ──────────────────────────────────────────────────────────
    if (kind === KIND.AUDIO) {
      body.appendChild(this._nativeTitle(item));
      const a = document.createElement("audio");
      a.className = CLS + "-native-audio";
      a.controls = true;
      a.preload = "metadata";
      a.src = url;
      body.appendChild(a);
      return;
    }

    // ── 视频 ──────────────────────────────────────────────────────────
    if (kind === KIND.VIDEO) {
      const v = document.createElement("video");
      v.className = CLS + "-native-video";
      v.controls = true;
      v.preload = "metadata";
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      if (kindOfName(item.path) === KIND.VIDEO) v.setAttribute("controlsList", "nodownload");
      v.src = url;
      body.appendChild(v);
      return;
    }

    // ── 文本 / Markdown ───────────────────────────────────────────────
    //   Markdown 故意**按纯文本**显示：思源的 md 渲染器绑在它自己的文档模型上，
    //   这里只是"看一眼服务器上那个文件"，源码形态反而更贴近"文件预览"的语义。
    body.appendChild(this._nativeTitle(item));
    const pre = el("pre", CLS + "-native-text-pre");
    pre.textContent = this.plugin.t("loading") || "加载中…";
    body.appendChild(pre);
    this._loadNativeText(item, pre);
  }

  /** 原生链路的小标题（音视频/文本上方一行：文件名 + 大小） */
  _nativeTitle(item) {
    const t = el("div", CLS + "-native-title");
    t.appendChild(el("span", CLS + "-native-name", item.name || ""));
    if (item.size) t.appendChild(el("span", CLS + "-native-size", fmtSize(item.size)));
    return t;
  }

  /** 拉文本内容（截断），回填进 <pre> */
  _loadNativeText(item, pre) {
    const MAX = 512 * 1024;   // 512 KB 足够看，也不会卡
    readText(item.path, MAX).then((r) => {
      if (this.destroyed || !pre.parentNode) return;
      const txt = (r && r.text) || "";
      pre.textContent = txt;
      if (r && r.truncated) {
        const tip = el("div", CLS + "-native-trunc",
          (this.plugin.t("textTruncated") || "（只显示前 512 KB，点上方「下载」取完整文件）"));
        pre.parentNode.insertBefore(tip, pre);
      }
    }).catch((e) => {
      if (this.destroyed || !pre.parentNode) return;
      pre.textContent = "";
      const n = el("div", CLS + "-notice");
      n.appendChild(el("div", CLS + "-notice-title",
        this.plugin.t("textFailed") || "读不出这个文件"));
      n.appendChild(el("div", CLS + "-notice-detail",
        String((e && e.message) || e)));
      pre.parentNode.insertBefore(n, pre);
    });
  }

  /**
   * 通用提示块（当前分派里没有直接调用，保留给链路失败时的兜底 ——
   * 比如将来某条 iframe 需要"加载不出来就给三个可点的出路"）。
   */
  _notice(title, detail, actions) {
    this.container.innerHTML = "";
    const box = el("div", CLS + "-notice");
    box.appendChild(el("div", CLS + "-notice-title", title));
    if (detail) box.appendChild(el("div", CLS + "-notice-detail", detail));
    if (actions && actions.length) {
      const row = el("div", CLS + "-notice-actions");
      actions.forEach((a) => {
        const b = el("button", CLS + "-btn-text", a.label);
        b.addEventListener("click", a.onClick);
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    this.container.appendChild(box);
  }

  _spinnerNode(text) {
    const box = el("div", CLS + "-loading");
    box.appendChild(el("div", CLS + "-spin"));
    box.appendChild(el("div", CLS + "-loading-text", text || "加载中…"));
    return box;
  }
}
