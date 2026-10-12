import { listDir, cadViewerUrl, cadOpenUrl, officeUrl, fileViewerUrl, fileViewerOpenUrl, fileUrl, readText } from "./api";
import { KIND, kindOfName, baseNameOf, rendererOf, RENDERER, externalUrlOf } from "./kinds";
import {
  ICON_REFRESH, ICON_DOWNLOAD, ICON_EXTERNAL, ICON_COPY, ICON_TAB, ICON_UP, ICON_COLLAPSE,
  iconForKind,
} from "./icons";
import { purifyFileViewer, purifyCadViewer, purifyOffice, repin } from "./purify";

/* ==========================================================================
 * 嵌入块：把「跑着思源的那台机器」上的文件/目录，以**自定义块**的形式放进笔记
 * --------------------------------------------------------------------------
 * ★ 用哪种块 ★
 *   思源插件的自定义块 = 正文里一段 `;;;<插件名>/<块类型>` 围栏 + 块内 JSON，
 *   内核把它编译成 `type=custom`（NodeCustomBlock，data-info 含一个斜杠），
 *   再由本插件注册的渲染器画出来。
 *   ⇒ 纯文本，随笔记一起同步、手机/网页/桌面都能渲染，不依赖任何沙箱 iframe。
 *
 * ★ 为什么不用思源 widget ★
 *   widget 是独立 iframe 沙箱，拿不到会话、也跨不了设备；自定义块由插件进程
 *   直接渲染，且正文里就是一行 JSON。
 *
 * ★ 四个插入入口，一条插入通道 ★
 *   斜杠菜单 / 文件树拖拽 / 右键菜单 / 预览工具栏 —— 全部调 insertEmbedIntoDoc。
 *   历史上网盘插件分头写过，结果修了两处漏了一处、用户点的正好是漏的那处；
 *   所以这里**只留一条通道**，新增入口必须调它。
 * ========================================================================== */






/** 自定义块的「块类型」标识（data-info 斜杠后面的部分） */
export const BLOCK_TYPE = "localfs";

/** 内核把「插件名/块类型」里的两段都当查找键，所以两个都注册（见 registerEmbed） */
const LEGACY_BLOCK_TYPES = ["localfs"];

/**
 * 拖拽时写在 dataTransfer 里的私有 MIME（只有本插件的拖拽才有）。
 *
 * ★★ 名字里带版本号，这是"让残留旧监听变哑"的开关 ★★
 *
 *   2026-10-10 桌面端实测的坑：思源「重载 / 升级插件」是**重新 import 本模块**，
 *   而**旧版本代码挂在 document 上的 drop 监听不会自己消失**。旧代码不认识下面
 *   那个 `__lfsEmbedDropReg` 注册表，我们也没法 `removeEventListener`
 *   （拿不到它的函数引用）⇒ 结果就是用户亲历的：
 *
 *     升级一次 → 拖一次插 2 个块 → 再升级 → 3 个块（每重载一次 +1）。
 *     只有**重启思源**（整页重载）才清得掉 —— 用户当时就是靠重启好的。
 *
 *   「重启一下」是绕过，不是根治。根治办法就是**给 MIME 改名**：
 *     · 旧监听的 isOurs() 查的是**旧名字** "…-embed"
 *     · 新拖拽写进去的 types 里只有**新名字** "…-embed-v2"
 *     ⇒ 旧监听命中不了、第一行就 return，连 getData 都拿不到 payload。
 *   ⇒ 残留监听变成"哑的"，下次升级**不再需要重启思源**。
 *
 *   ⚠️ 规矩：以后但凡改动拖拽协议（换 payload 结构 / 换落点判据），
 *      就把这里的版本号 +1。只要 +1，历史残留监听就自动失效。
 *      （新代码自己的重复绑定由「先摘后绑」+ 下面的全局插入闸门兜住，
 *        不依赖这个版本号。）
 */
export const DND_MIME = "application/x-localfs-embed-v2";

/** 容器类块：它们不能直接当「兄弟锚点」，要上移到父层（见 locateInsertPoint） */
const BOXED_TYPES = ["i", "l", "b", "s", "callout", "blockquote", "sb", "h", "t"];

/* -------------------------------------------------------------------------
 * 0) 「已展开的块」登记簿
 * --------------------------------------------------------------------------
 * 为什么要有它：
 *   嵌入块是**懒加载**的 —— 打开笔记时一个都不加载（第 1 层节流）。
 *   用户点开的那些会真的挂上 iframe / 解码图片 / 读文本，都是要占内存的。
 *   于是需要一个地方记住"现在有哪些块是展开的"，好在这些时刻统一收掉：
 *     · 插件 onunload（思源要卸载插件了）
 *     · 用户主动「收起所有嵌入块」
 *
 * ★ 每个块各记各的，不做"展开新的就自动收旧的" ★
 *   网盘插件那边试过自动互斥，用户明确否掉了 ——
 *   「左边文档、右边表格对照着看」是常态，自动收起第一个很烦。
 *   省资源这件事交给用户点「收起」，或需要时的「全部收起」。
 *
 * ★ 集合里可能有已经脱离 DOM 的孤儿 ★
 *   思源切页签 / 重渲染块时会直接丢掉 DOM，**不会回调我们**。
 *   所以 collapseAll 里必须跳过 `!isConnected` 的项，
 *   否则对孤儿调 collapse 会抛错，把后面的清理一起带崩。
 * ---------------------------------------------------------------------- */
const openEmbeds = new Set();

function registerOpenEmbed(wrap, collapse) {
  unregisterOpenEmbed(wrap);          // 同一块重复登记（展开→收起→再展开）先清旧的
  openEmbeds.add({ wrap: wrap, collapse: collapse });
}

function unregisterOpenEmbed(wrap) {
  for (const rec of Array.from(openEmbeds)) {
    if (rec.wrap === wrap) openEmbeds.delete(rec);
  }
}

/** 收起**全部**已展开的嵌入块（插件 onunload / 「收起所有嵌入块」命令用） */
export function collapseAllOpenEmbeds() {
  let n = 0;
  for (const rec of Array.from(openEmbeds)) {
    try {
      if (!rec.wrap || !rec.wrap.isConnected) { openEmbeds.delete(rec); continue; }
      if (rec.collapse) { rec.collapse(); n++; }
    } catch (e) {
      /* 单个块收起失败不该影响其它块 */
      console.warn("[localfs] 收起嵌入块失败（忽略）：", e);
    }
  }
  openEmbeds.clear();
  return n;
}

/** 当前展开着的块数（给测试与诊断用） */
export function openEmbedCount() {
  return openEmbeds.size;
}

/* -------------------------------------------------------------------------
 * 1) 块内容（JSON）的读写
 * ---------------------------------------------------------------------- */

/**
 * 解析块内容。
 *
 * 容错两种写法：
 *   · 标准：一行 JSON（stringifyEmbed 的输出）
 *   · 手改过：`key=value` 多行
 *
 * ★ `path` 必填 ★ 拿不到就是坏块，渲染器会显示一条可读的提示而不是空白。
 */
export function parseEmbed(content) {
  const raw = String(content || "").trim();
  if (!raw) return null;
  let obj = null;
  if (raw.startsWith("{")) {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return null;
    }
  } else {
    obj = {};
    raw.split(/\r?\n/).forEach((line) => {
      const i = line.indexOf("=");
      if (i > 0) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
  }
  if (!obj) return null;
  let p = String(obj.path || "");
  if (!p) return null;
  if (!p.startsWith("/")) p = "/" + p;   // 容错：补前导斜杠（NAS 上的路径都是绝对的）
  return {
    kind: obj.kind === "tree" ? "tree" : "file",
    path: p,
    name: obj.name ? String(obj.name) : "",
    height: Number(obj.height) || 0,
  };
}

/** 序列化。`kind:"file"` 时带 name（显示用），height 只在非 0 时写。 */
export function stringifyEmbed(spec) {
  const o = { kind: spec.kind === "tree" ? "tree" : "file", path: spec.path || "" };
  if (o.kind === "file" && spec.name) o.name = String(spec.name);
  if (spec.height) o.height = Number(spec.height);
  return JSON.stringify(o);
}

/** data-info 里那一段：`<插件名>/<块类型>`（斜杠必须**恰好一个**） */
export function embedLang(pluginName) {
  return `${pluginName || "siyuan-localfs"}/${BLOCK_TYPE}`;
}

/**
 * 生成要写进正文的 markdown（`;;;` 围栏）。
 *
 * ★★ 两条必须守住的规矩（都是实测踩出来的）★★
 *   ① 只能用 `;;;` 围栏，**不能**用反引号 ```：反引号只会生成普通代码块
 *      （type=c），自定义块渲染器永远不会被调用，笔记里就是一坨裸 JSON。
 *   ② 围栏必须**顶格**。实测前面多任何一个字符（例如 `[;;;…`）都会退化成
 *      普通段落 type=p，同样渲染不出来。
 *   这里断言一下，将来谁改歪了会立刻抛错而不是静默变丑。
 */
export function buildEmbedMarkdown(pluginName, spec) {
  const md = `;;;${embedLang(pluginName)}\n${stringifyEmbed(spec)}\n;;;\n`;
  if (!md.startsWith(";;;")) {
    throw new Error("嵌入块 markdown 非法（围栏未顶格）：" + JSON.stringify(md.slice(0, 40)));
  }
  return md;
}

/** 从 buildEmbedMarkdown 的输出里取回 JSON 文本（第 2 行到收尾围栏） */
export function extractJson(md) {
  const lines = String(md || "").split("\n");
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === ";;;") break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

/* -------------------------------------------------------------------------
 * 2) 内核 API（薄封装）
 * ---------------------------------------------------------------------- */

async function kb(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + path);
  return res.json();
}

/* -------------------------------------------------------------------------
 * 3) 正文渲染
 * ---------------------------------------------------------------------- */

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtSize(n) {
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

/**
 * 「只创建一个块」的共享逻辑（文件块 / 目录块都用它）。
 *
 * ★ 装 iframe 的盒子**只能 append 一次** ★
 *   Chrome 里 iframe 只要被移出 DOM 再插回来就会**重新加载**。若在 load 回调里
 *   清空再挂回，就成了自循环：load → 摘盒子 → 挂盒子 → 又 load → …
 *   真机上表现成"一直闪、内容出不来"（同一个地址在新标签页打开却完全正常）。
 *   ⇒ 加载动画做成**兄弟节点**，加载完只删它，绝不碰 iframe 所在容器。
 *   （预览浮层 src/preview.js 里踩过同一个坑，见那里的长注释。）
 */
function makeEmbedShell(spec, plugin) {
  const wrap = h("div", "lfs-embed lfs-embed-" + (spec.kind === "tree" ? "tree" : "file"));
  wrap.setAttribute("contenteditable", "false");
  wrap.setAttribute("data-lfs-embed", spec.kind);

  const head = h("div", "lfs-embed-head");
  const title = h("span", "lfs-embed-title");
  const ico = h("span", "lfs-embed-ico");
  ico.innerHTML = iconForKind(spec.kind === "tree" ? KIND.DIR : kindOfName(spec.path), spec.kind === "tree", true);
  const pathEl = h("span", "lfs-embed-path");
  pathEl.textContent = spec.path;
  pathEl.title = spec.path;
  title.appendChild(ico);
  title.appendChild(pathEl);

  const tools = h("span", "lfs-embed-tools");
  head.appendChild(title);
  head.appendChild(tools);

  const box = h("div", "lfs-embed-box");
  wrap.appendChild(head);
  wrap.appendChild(box);

  return { wrap, head, tools, box, pathEl };
}

/**
 * 嵌入块头部的一个工具按钮。
 *
 * ★ 2026-10-10：从「文字按钮」改成「图标按钮」（用户要求）★
 *   原来这一排是文字（"收起 / 在页签中打开 / 下载 / 复制路径"）。加上新增的
 *   「在网页打开」就是 5 个，一行放不下、还会把路径挤没；而且页签工具条
 *   本来就是图标，同一套动作两处长得不一样。现在统一成 24px 图标按钮
 *   （样式见 index.css 的 .lfs-embed-btn，与 .lfs-tab-btn 同款）。
 *
 * ⚠️ 参数顺序也改了：(label, onClick, cls) → (icon, label, onClick) ★
 *   刻意与 tabview.js 里的 mk(icon, label, fn) 对齐 —— 新增按钮时
 *   别再把 label 放在第一个参数上。
 *
 * ★ title / aria-label 必须都挂 ★
 *   图标按钮没有可见文字，悬停提示与无障碍标签就是它唯一的"说明"，
 *   漏掉就等于给用户一个没有名字的方块。
 */
function makeTool(icon, label, onClick) {
  const b = h("button", "lfs-embed-btn");
  b.type = "button";
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick(b);
  });
  return b;
}

/** 占位符：默认不加载内容，点一下才加载（笔记里有十几个文件块时才不会一起炸） */
function renderPlaceholder(ctx, text) {
  const { box, tools } = ctx;
  ctx.state = "idle";
  // 回到占位 = 内容已经不在 DOM 里了 ⇒ 从"已展开"登记簿里摘掉自己
  unregisterOpenEmbed(ctx.wrap);
  clearBareTimers(ctx);
  if (ctx.collapseBtn) ctx.collapseBtn.style.display = "none";
  box.innerHTML = "";
  box.classList.remove("is-loaded");

  const holder = h("div", "lfs-embed-placeholder");
  const btn = h("button", "lfs-embed-play");
  btn.type = "button";
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg><span></span>';
  btn.querySelector("span").textContent = text || "点击预览";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ctx.load();
  });
  const hint = h("div", "lfs-embed-hint", "打开笔记时不加载；点一下才加载");
  holder.appendChild(btn);
  holder.appendChild(hint);
  box.appendChild(holder);
}

function renderError(ctx, msg) {
  ctx.state = "error";
  unregisterOpenEmbed(ctx.wrap);
  clearBareTimers(ctx);
  if (ctx.collapseBtn) ctx.collapseBtn.style.display = "none";
  ctx.box.innerHTML = "";
  ctx.box.appendChild(h("div", "lfs-embed-error", msg));
}

/**
 * 清掉块上未执行的「净化重钉」定时器。
 * 块被收起 / 重渲染 / 出错时都要调 —— 否则定时器会在脱离 DOM 的 iframe 上继续跑。
 */
function clearBareTimers(ctx) {
  if (!ctx || !ctx.bareTimers || !ctx.bareTimers.length) return;
  ctx.bareTimers.forEach((t) => { try { clearTimeout(t); } catch (e) { /* 忽略 */ } });
  ctx.bareTimers = [];
}

/**
 * 用 iframe 承载（三条链路都走它：内置 CAD 查看器 / OnlyOffice / 文件预览）。
 *
 * ★ 需求 #3/#4/#5：块里只留内容，查看器自带的外壳一律藏掉 ★
 *   · CAD / 文件预览 —— 同源，load 后往 contentDocument 注入 CSS；
 *   · Office         —— 跨源，注不了；靠 URL 上的 bare=1（见 resolveUrl）。
 *   净化的具体做法与坐标都写在 src/purify.js 里（页签视图复用同一份）。
 *
 * ★ 定时器挂在 ctx.bareTimers 上 ★
 *   块被收起 / 重渲染时这些"重钉"定时器必须一起清掉，
 *   否则它们会在已经脱离 DOM 的 iframe 上继续跑（拿 contentDocument 会抛）。
 */
function renderIframe(ctx, url, kind) {
  ctx.box.innerHTML = "";
  ctx.box.classList.add("is-loaded");
  const f = document.createElement("iframe");
  f.className = "lfs-embed-frame";
  f.loading = "lazy";
  f.src = url;
  f.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");
  f.setAttribute("allowfullscreen", "true");

  // 清掉上一轮的重钉定时器（同一条链路上可能反复 load / 收起）
  clearBareTimers(ctx);

  // ★ 用 rendererOf 而不是裸 kind 判断 ★
  //   PDF 归 OFFICE（现在走飞牛官方那套），拿 kind === KIND.OFFICE 判会漏掉 PDF。
  //   按 renderer 判才对得上实际链路。
  const renderer = rendererOf(kind);

  f.addEventListener("load", () => {
    // ★ 2026-10-10：三条链路**全是同源**，所以全都要净化 ★
    //   CAD / 文件预览 / Office（飞牛官方 trim.docs）都经 6806 同源通道。
    //   ⚠️ 旧版 Office 走 /localfs/oo-srv（跨源），那会儿这里直接 return；
    //     换主之后那条捷径作废 —— 不净化的话嵌入块里会挂一整条 OO 工具栏。
    const apply = renderer === RENDERER.CAD ? purifyCadViewer
      : (renderer === RENDERER.OFFICE ? purifyOffice : purifyFileViewer);
    const run = () => {
      let doc;
      try { doc = f.contentDocument; } catch (e) { return; }
      if (!doc || !doc.head) return;
      apply(doc);
    };
    repin(run, [300, 1000, 2500], ctx.bareTimers);
  });

  ctx.box.appendChild(f);
}

/** 文件块 */
function renderFileEmbed(spec, plugin) {
  const ctx = makeEmbedShell(spec, plugin);
  const kind = kindOfName(spec.path);

  ctx.spec = spec;
  ctx.state = "idle";

  /** 内容真的进 DOM 之后调：登记进"已展开"集合，好让「全部收起」找得到它 */
  const markLoaded = () => {
    ctx.state = "loaded";
    registerOpenEmbed(ctx.wrap, ctx.collapse);
  };

  // 工具：收起 / 在页签中打开 / 在网页打开 / 下载 / 复制路径
  //   ★ 2026-10-10 起全是图标按钮（makeTool 的第一个参数是图标）★
  //   ★ 文案一律走 plugin.t（有 en_US 词条），取不到再回落中文 ★
  ctx.collapse = () => renderPlaceholder(ctx, "点击预览");
  ctx.collapseBtn = makeTool(ICON_COLLAPSE, plugin.t("collapseBlock") || "收起", () => ctx.collapse());
  ctx.collapseBtn.style.display = "none";
  ctx.tools.appendChild(ctx.collapseBtn);
  // 在**思源自己的页签**里打开（不是浏览器新窗口）。
  // ★ 为什么不用 window.open ★
  //   在飞牛 App 的 iframe 里会被弹窗拦截，在手机上也直接跳出去、回不来。
  //   页签是同一套 UI 里的，三种形态（桌面 / 网页 / 手机）都成立，
  //   还能并排看、能持久。（与网盘插件的嵌入块行为对齐；
  //   plugin.openFileInTab 内部会复用同文件的既有页签，不重复开。）
  ctx.tools.appendChild(makeTool(ICON_TAB, plugin.t("openInTab") || "在页签中打开", () => {
    plugin.openFileInTab({ path: spec.path, name: spec.name || baseNameOf(spec.path) });
  }));
  // ★ 「在网页打开」= 甩到浏览器新窗口（2026-10-10 用户要求新增）★
  //   与页签那条动作刻意分开：这里是**离开思源**、拿浏览器的完整能力
  //   （打印 / 另存 / 装插件），走的是 kinds.js 那条统一路由。
  //   ★ 2026-10-10 整理：不再有"编辑模式" ★ —— Office / PDF 由飞牛官方应用
  //     按文件的写权限自己决定可读可写，插件传的 mode 它不看。
  ctx.tools.appendChild(makeTool(ICON_EXTERNAL, plugin.t("openInWeb") || "在网页打开", () => {
    // ★ 这是「新标签打开」⇒ 用直连端口版（CAD :8020 / 文件预览 :8030）★
    //   内嵌 iframe 走的是 cadViewerUrl / fileViewerUrl（同源通道，保净化）
    const url = externalUrlOf(spec.path,
      { cadViewerUrl: cadOpenUrl, officeUrl, fileViewerUrl: fileViewerOpenUrl, fileUrl },
      {
        layout: plugin.isMobileUi() ? "mobile" : "desktop",
      });
    window.open(url, "_blank", "noopener");
  }));
  ctx.tools.appendChild(makeTool(ICON_DOWNLOAD, plugin.t("download") || "下载", () => {
    // 走下插件的统一下载路径：它会先体检"存在 / 权限"，失败弹对话框而不是吞掉
    plugin.downloadNode({ path: spec.path, name: spec.name || baseNameOf(spec.path) });
  }));
  ctx.tools.appendChild(makeTool(ICON_COPY, plugin.t("copyPath") || "复制路径",
    () => plugin.copyText(spec.path)));

  ctx.load = async () => {
    ctx.state = "loading";
    if (ctx.collapseBtn) ctx.collapseBtn.style.display = "";
    ctx.box.innerHTML = "";
    ctx.box.classList.remove("is-loaded");
    ctx.box.appendChild(h("div", "lfs-embed-loading", "加载中…"));

    const url = resolveUrl(spec.path, kind, plugin, false);
    try {
      await plugin.ensureBase();
    } catch (e) {
      renderError(ctx, "连不上本机存储服务：" + (e && e.message ? e.message : e));
      return;
    }
    if (!ctx.wrap.isConnected) return;

    // ★ 四条链路（2026-10-09 第二次调整）★
    //   · url === null  ⇒ 原生链路（图片/音视频/文本），没有 iframe 可嵌
    //   · 其余          ⇒ CAD / Office / 文件预览，全是 iframe
    //   对齐 src/fileview.js 的 render()：两处路由**必须一致**，
    //   否则同一个文件在页签和嵌入块里长相不同（之前就踩过）。
    if (!url) {
      renderNativeInto(ctx, spec, kind);
      markLoaded();
      return;
    }
    renderIframe(ctx, url, kind);
    markLoaded();
  };

  renderPlaceholder(ctx, "点击预览");
  return ctx.wrap;
}

/**
 * 嵌入块里的**原生**渲染（图片 / 音频 / 视频 / 文本）。
 *
 * ★ 与 fileview.js 的 _native 是一套口径，但**不共用代码** ★
 *   差异只有一处：这里的盒子是 `ctx.box`（嵌入块自己的 div），
 *   那边是 FileView 的 container。为了不让两处再各写一遍
 *   "怎么画标签"的细节，这里复用同一批类名（.lfs-native-*），
 *   CSS 只写一份（index.css）。
 */
function renderNativeInto(ctx, spec, kind) {
  ctx.box.innerHTML = "";
  ctx.box.classList.add("is-loaded");

  const url = fileUrl(spec.path);
  const body = h("div", "lfs-native-body");

  if (kind === KIND.IMAGE) {
    const img = document.createElement("img");
    img.className = "lfs-native-img";
    img.alt = spec.name || "";
    img.loading = "lazy";
    img.src = url;
    body.appendChild(img);
    ctx.box.appendChild(body);
    return;
  }
  if (kind === KIND.AUDIO) {
    const a = document.createElement("audio");
    a.className = "lfs-native-audio";
    a.controls = true;
    a.preload = "metadata";
    a.src = url;
    body.appendChild(a);
    ctx.box.appendChild(body);
    return;
  }
  if (kind === KIND.VIDEO) {
    const v = document.createElement("video");
    v.className = "lfs-native-video";
    v.controls = true;
    v.preload = "metadata";
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.src = url;
    body.appendChild(v);
    ctx.box.appendChild(body);
    return;
  }

  // 文本 / Markdown：等宽只读，取前 512 KB
  const pre = h("pre", "lfs-native-text-pre", "加载中…");
  body.appendChild(pre);
  ctx.box.appendChild(body);
  readText(spec.path, 512 * 1024).then((r) => {
    if (!ctx.box.isConnected || !pre.parentNode) return;
    pre.textContent = (r && r.text) || "";
    if (r && r.truncated) {
      pre.parentNode.insertBefore(
        h("div", "lfs-native-trunc", "（只显示前 512 KB，点上方「下载」取完整文件）"), pre);
    }
  }).catch((e) => {
    if (!ctx.box.isConnected || !pre.parentNode) return;
    pre.textContent = "读不出这个文件：" + String((e && e.message) || e);
  });
}

/**
 * 目录块：一个**紧凑**的文件清单（不是把整棵文件树搬进块里）。
 * 点文件 → 走插件自己的预览；点目录 → 进下一层；顶部有「上级」。
 */
function renderTreeEmbed(spec, plugin) {
  const ctx = makeEmbedShell(spec, plugin);
  const state = { dir: spec.path, stack: [] };

  const list = h("div", "lfs-embed-treelist");
  ctx.box.appendChild(list);

  const renderList = async () => {
    list.innerHTML = "";
    list.appendChild(h("div", "lfs-embed-loading", "读取目录…"));
    let data;
    try {
      await plugin.ensureBase();
      data = await listDir(state.dir);
    } catch (e) {
      list.innerHTML = "";
      list.appendChild(h("div", "lfs-embed-error", "读不到这个目录：" + (e && e.message ? e.message : e)));
      return;
    }
    if (!ctx.wrap.isConnected) return;
    list.innerHTML = "";

    const bar = h("div", "lfs-embed-treepath");
    if (state.stack.length) {
      const up = makeTool(ICON_UP, plugin.t("goUp") || "上级", () => {
        state.dir = state.stack.pop();
        renderList();
      });
      bar.appendChild(up);
    }
    const crumb = h("span", "lfs-embed-crumb", state.dir);
    crumb.title = state.dir;
    bar.appendChild(crumb);
    list.appendChild(bar);

    const items = (data && data.items) || [];
    if (!items.length) {
      list.appendChild(h("div", "lfs-embed-hint", "（空目录）"));
      return;
    }
    items.forEach((it) => {
      const row = h("div", "lfs-embed-treerow");
      const ico = h("span", "lfs-embed-treerow-ico");
      ico.innerHTML = iconForKind(it.isDir ? KIND.DIR : kindOfName(it.path), it.isDir, false);
      row.appendChild(ico);
      const nm = h("span", "lfs-embed-treerow-name", it.name);
      nm.title = it.path;
      row.appendChild(nm);
      if (!it.isDir && it.size != null) row.appendChild(h("span", "lfs-embed-treerow-size", fmtSize(it.size)));
      row.addEventListener("click", () => {
        if (it.isDir) {
          state.stack.push(state.dir);
          state.dir = it.path;
          renderList();
        } else {
          plugin.openPreview({ path: it.path, name: it.name, size: it.size });
        }
      });
      list.appendChild(row);
    });
  };

  ctx.tools.appendChild(makeTool(ICON_REFRESH, plugin.t("refresh") || "刷新", () => renderList()));
  renderList();
  return ctx.wrap;
}

/**
 * 嵌入块**内联**预览的地址（块里嵌 iframe / 直链）。
 *
 * ★ 嵌入块一律 bare ★
 *   需求 #3/#4/#5：块里只显示**文件内容**，查看器自带的工具栏 / 菜单栏 / 文件树
 *   全部不显示（块本来就窄，工具栏会把内容挤成一条缝，还容易误点）。
 *   · CAD    → URL 不带额外参数；由 renderIframe 注入 CSS 藏 header/footer
 *   · Office → URL 带 bare=1，宿主页关掉 toolbar/header（跨源，注不了样式）
 *   · 其余   → renderIframe 注入 CSS 藏 file-viewer 的 #sidebar/#topbar
 *
 * ★ 不再有 `tab` 参数 ★
 *   以前「在页签中打开」按钮复用了这个函数（tab=true ⇒ Office 走 view 模式）。
 *   现在那个按钮改成开**思源页签**了（走 tabview.js 的渲染核），
 *   于是 tab 分支再没人调用 —— 删掉，免得留下"看起来还能用"的死代码。
 */
function resolveUrl(path, kind, plugin) {
  const renderer = rendererOf(kind);
  if (renderer === RENDERER.CAD) return cadViewerUrl(path);
  if (renderer === RENDERER.OFFICE) {
    // ★ 嵌入块里的 Office 一律只读 view + bare=1（藏工具栏）★
    //   块里不该出现编辑入口（改了文件却看不到保存状态最危险），
    //   而且工具栏会占掉块里本就有限的高度。
    const layout = plugin.isMobileUi() ? "mobile" : "desktop";
    return officeUrl(path, "view", layout, true);
  }
  // ★ 原生链路返回 null ★ —— 它不是 iframe，调用方要走 renderNative 分支。
  if (renderer === RENDERER.NATIVE) return null;
  // 其余（压缩包 / 3D / OFD / 邮件…）交给「文件预览」应用兜底
  return fileViewerUrl(path);
}

/* -------------------------------------------------------------------------
 * 4) 注册（思源内核按 data-info 的「块类型」来查渲染器）
 * ---------------------------------------------------------------------- */

export function registerEmbed(plugin) {
  const renderer = {
    /** @param {{element:HTMLElement, content:string}} arg */
    render: ({ element, content }) => {
      const spec = parseEmbed(content);
      element.innerHTML = "";
      element.classList.add("lfs-embed-host");
      if (!spec) {
        element.appendChild(h("div", "lfs-embed-error",
          '本机存储嵌入块的内容读不出来（应为一行 JSON，例如 {"kind":"file","path":"/vol1/a.pdf"}）'));
        return;
      }
      const ready = () => {
        try {
          return typeof plugin.channelReady === "function" ? Boolean(plugin.channelReady()) : true;
        } catch (e) {
          return true;
        }
      };
      const body = () => {
        element.innerHTML = "";
        element.classList.add("lfs-embed-host");
        try {
          element.appendChild(spec.kind === "tree" ? renderTreeEmbed(spec, plugin) : renderFileEmbed(spec, plugin));
        } catch (e) {
          element.appendChild(h("div", "lfs-embed-error", "渲染嵌入块失败：" + (e && e.message ? e.message : e)));
        }
      };
      if (ready()) {
        body();
        return;
      }
      // 通道还没就绪：先占位，等引导结束再决定渲染还是提示（避免开笔记瞬间闪一句"未就绪"）
      const pending = plugin.bootReady;
      const box = h("div", "lfs-embed-loading", "正在连接本机存储…");
      element.appendChild(box);
      if (pending && typeof pending.then === "function") {
        Promise.resolve(pending).then(() => {
          if (!element.isConnected) return;
          if (ready()) body();
          else {
            element.innerHTML = "";
            element.appendChild(h("div", "lfs-embed-error", "本机存储服务不可用，请检查应用是否在运行。"));
          }
        }).catch(() => {
          if (element.isConnected) {
            element.innerHTML = "";
            element.appendChild(h("div", "lfs-embed-error", "本机存储通道初始化失败。"));
          }
        });
      }
    },
  };

  plugin.customBlockRenders = plugin.customBlockRenders || {};
  // ★ 主键：内核真正会查的那个（data-info 斜杠后的块类型）★
  plugin.customBlockRenders[BLOCK_TYPE] = renderer;
  for (const k of LEGACY_BLOCK_TYPES) plugin.customBlockRenders[k] = renderer;
  plugin.customBlockRenders[plugin.name] = renderer;
}

/* -------------------------------------------------------------------------
 * 5) 插入通道（唯一一条）
 * ---------------------------------------------------------------------- */

const lastLocateTrace = { text: "" };

/**
 * 文档**最后一个直接子块**的 id（把它当 `previousID` 才能真的追加到末尾）。
 *
 * ★★★ 为什么不能"什么都不传"来当追加 ★★★
 *   真机实测（思源 3.8.6，逐字核对过顺序）：
 *
 *     createDocWithMd → P1, P2, P3
 *     insertBlock { parentID, data:"X" }                    ⇒ X, P1, P2, P3   ← 插到**最前面**
 *     insertBlock { parentID, data:"Y", nextID: P2 }         ⇒ P1, Y, P2, P3   ← 插到 P2 **之前**
 *     insertBlock { parentID, data:"Z", previousID: P1 }     ⇒ P1, Z, P2, P3   ← 插到 P1 **之后**
 *
 *   也就是说：不给 previousID/nextID 时是**前插**，不是追加。
 *   所以「没有光标锚点 ⇒ 插到文档末尾」这句话，必须先把最后一个子块查出来。
 *   （`/api/block/getChildBlocks` 回的是**按文档顺序**的子块，取最后一个。）
 */
async function lastChildId(docId) {
  if (!docId) return "";
  try {
    const r = await kb("/api/block/getChildBlocks", { id: docId });
    const list = (r && r.data) || [];
    return list.length ? (list[list.length - 1].id || "") : "";
  } catch (e) {
    return "";
  }
}

/**
 * 把"落在容器块上的落点"上溯到**直接挂在文档下**的那一层。
 *
 * ★ 为什么不直接用容器块自己的 parent_id ★
 *   落点是个列表项 / 引用块 / 超级块时，它的 parent_id 指向**容器自己**
 *   （列表项挂在列表上、段落挂在引用块里）。拿它当 parentID 插新块，
 *   等于把自定义块塞进列表/引用块内部 —— 内核对嵌套容器的校验会拒绝，
 *   或者产出一个结构很怪的东西。
 *   一路往上走到"父就是文档"的那一层，然后把新块插在**它之前**，
 *   语义正好是用户看到的"插在我点的这块上面"。
 */
async function topLevelAncestor(row, docId, note) {
  let cur = row;
  for (let i = 0; i < 6; i++) {
    if (!cur) return null;
    if (!cur.parent_id || cur.parent_id === docId) return cur;
    try {
      const q = await kb("/api/query/sql", {
        stmt: "SELECT id, parent_id, type FROM blocks WHERE id='" + cur.parent_id + "'",
      });
      const up = q && q.data && q.data[0];
      if (!up) return cur;
      cur = up;
    } catch (e) {
      return cur;
    }
  }
  if (note) note("上溯超过 6 层，用当前层");
  return cur;
}

/**
 * 找一个"把新块插进去"的落点。
 *
 * 返回 `{ parentID, nextID, previousID, anchorBlockId, src }`：
 *   · `parentID`  必填 —— 新块的父（通常是文档）
 *   · `nextID`    非空时 = 插到它**之前**（上面实测确认过的语义）
 *   · `previousID`非空时 = 插到它**之后**
 *   · 两者都空 = 插到父容器的**最前面**（这是内核的默认行为，别指望它是"追加"）
 *
 * ★ 文档级的 `protyle.block.id === rootID`，**不能**当锚点用 ★
 *   拿它当锚点会被判成"容器块"，于是既没有 nextID 也没有 previousID，
 *   用户点了"插在光标处"却跑到文档最开头。
 */
async function locateInsertPoint(protyle, anchorEl) {
  const trace = [];
  const note = (m) => {
    trace.push(m);
    lastLocateTrace.text = trace.join(" → ");
  };

  let blockId = "";
  let docId = "";

  // 策略 1：锚点元素自己（拖拽落点 / 斜杠菜单给的 el 最准）
  try {
    if (anchorEl) {
      const el = anchorEl.closest ? (anchorEl.closest("[data-node-id]") || anchorEl) : anchorEl;
      blockId = el && el.getAttribute ? (el.getAttribute("data-node-id") || "") : "";
      if (blockId) note("anchorEl=" + blockId);
    }
  } catch (e) { /* 忽略 */ }

  // 策略 2：protyle.block
  if (!blockId && protyle && protyle.block) {
    const b = protyle.block;
    docId = b.rootID || b.id || "";
    if (b.id && b.id !== (b.rootID || b.id)) {
      blockId = b.id;
      note("protyle.block=" + blockId);
    } else {
      note("protyle.block 是文档级，只取 docId");
    }
  }

  // 策略 3：当前活动编辑器的 dataset.nodeId
  try {
    if (!blockId) {
      const host = document.querySelector(".protyle[data-node-id]");
      const rid = host && host.dataset ? (host.dataset.nodeId || "") : "";
      if (!docId) docId = rid;
      note("dataset.nodeId=" + (rid || "-"));
    }
  } catch (e) { /* 忽略 */ }

  // 策略 4：选区
  if (!blockId) {
    try {
      const sel = window.getSelection();
      const node = sel && sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const hit = el && el.closest ? el.closest(".protyle-wysiwyg [data-node-id]") : null;
      if (hit) {
        blockId = hit.getAttribute("data-node-id") || "";
        note("selection=" + blockId);
      }
    } catch (e) { /* 忽略 */ }
  }

  if (!docId) {
    try {
      const host = document.querySelector(".protyle[data-node-id]");
      docId = host && host.dataset ? (host.dataset.nodeId || "") : "";
    } catch (e) { /* 忽略 */ }
  }

  if (!blockId) {
    note("没有块级锚点 ⇒ 追加到文档末尾");
    const last = await lastChildId(docId);
    if (!last) note("文档是空的，直接插进去");
    return { parentID: docId, nextID: "", previousID: last, anchorBlockId: "", src: trace.join(" → ") };
  }

  // 查这个块是什么类型：容器块要上溯到文档层，普通块直接当 nextID
  try {
    const info = await kb("/api/query/sql", {
      stmt: "SELECT id, parent_id, type, root_id FROM blocks WHERE id='" + blockId + "'",
    });
    const row = info && info.data && info.data[0];
    if (row) {
      const doc = docId || row.root_id || "";
      if (BOXED_TYPES.indexOf(row.type) >= 0) {
        note("块类型 " + row.type + " 是容器块，上溯到文档层");
        const top = await topLevelAncestor(row, doc, note);
        if (top && top.id && top.id !== doc) {
          return {
            parentID: doc, nextID: top.id, previousID: "",
            anchorBlockId: blockId, src: trace.join(" → "),
          };
        }
        note("上溯不到可用的兄弟层 ⇒ 追加到文档末尾");
        return {
          parentID: doc, nextID: "", previousID: await lastChildId(doc),
          anchorBlockId: blockId, src: trace.join(" → "),
        };
      }
      // 普通块：插在它**上方**（nextID 的语义 = 插到它之前）。
      // ★ parentID 用 row.parent_id，不要用 root_id ★
      //   块可能嵌在列表项里，那时 parent_id ≠ root_id；两者必须配套，
      //   否则内核会认为 nextID 不在 parentID 名下而落回默认（插到最前面）。
      return {
        parentID: row.parent_id || doc, nextID: blockId, previousID: "",
        anchorBlockId: blockId, src: trace.join(" → "),
      };
    }
    note("SQL 查不到该块 ⇒ 追加到文档末尾");
  } catch (e) {
    note("SQL 查询异常：" + (e && e.message ? e.message : e));
  }
  return {
    parentID: docId, nextID: "", previousID: await lastChildId(docId),
    anchorBlockId: "", src: trace.join(" → "),
  };
}

/**
 * 清掉斜杠菜单留在正文里的 `/过滤词`。
 *
 * ★ 为什么必须插件自己清 ★
 *   思源斜杠菜单的 **plugin 分支是唯一不执行 `He.deleteContents()` 的分支**，
 *   触发文本留给插件处理。
 * ★ 为什么必须走内核 ★
 *   只改 DOM + 派发 input 事件**一个字节都存不进去**，刷新后 `/xxx` 又回来了。
 * ★ 为什么要找内层 `[contenteditable=true]` ★
 *   `anchorEl` 是外层 `.p`，它的 textContent 里含 `protyle-attr` 的零宽空格
 *   `\u200b`，直接匹配 `/^\s*[/、]/` 永远不成立。
 *
 * 导出它是给「斜杠菜单里点了取消」用的：那些场景没有插入动作，
 * insertEmbedIntoDoc 里的清理不会跑，触发文本得由调用方自己收尾。
 */
export async function cleanupSlashText(anchorEl) {
  if (!anchorEl) return false;
  const el = anchorEl.closest ? (anchorEl.closest("[data-node-id]") || anchorEl) : anchorEl;
  const blockId = el && el.getAttribute ? (el.getAttribute("data-node-id") || "") : "";
  if (!blockId) return false;

  const editEl = el.querySelector('[contenteditable="true"]') || el;
  const raw = editEl.textContent || "";
  if (!raw) return false;
  if (raw.indexOf("/") < 0 && raw.indexOf("、") < 0) return false;

  let next = null;
  let deleteBlock = false;
  if (/^\s*[/、]\S*\s*$/.test(raw)) {
    // 整块只有 /xxx ⇒ 整块删掉（换成空格会留一个空行，用户还得手删）
    if ((raw.match(/\//g) || []).length > 1) return false;   // 像路径，保守跳过
    deleteBlock = true;
    next = "";
  } else {
    // ★ m[1] 不允许出现斜杠 ★ 否则回溯会把 /usr/local 的第二个斜杠吃进 m[1]，守卫失效
    const m = raw.match(/^([^/、]*?)\s*[/、]([^\s/、]*)\s*$/);
    if (m && m[2].length > 0) next = m[1];
  }
  if (next === null) return false;

  try {
    if (deleteBlock) {
      const d = await kb("/api/block/deleteBlock", { id: blockId });
      if (d && d.code === 0) return true;
    }
    const cur = (raw || "").replace(/\u200b/g, "").trim();
    if (cur === String(next).trim()) return false;
    const r = await kb("/api/block/updateBlock", { id: blockId, dataType: "markdown", data: next });
    return !!(r && r.code === 0);
  } catch (e) {
    return false;
  }
}

/**
 * 三态校验：内核到底生成的是不是自定义块。
 *
 * ★ 为什么不能只查一次 SQL ★
 *   刚 insert 完 SQL 索引还没跟上，经常查不到；把"查不到"当成"不是 custom"
 *   就会去删一个本来正常的块。所以先问 DOM（不受索引影响），再问 SQL，
 *   最后才承认 unknown。
 */
async function verifyCustomBlock(id) {
  if (!id) return "unknown";
  try {
    for (let i = 0; i < 12; i++) {
      const el = document.querySelector('[data-node-id="' + id + '"]');
      if (el) {
        const t = el.getAttribute("data-type") || "";
        if (t === "NodeCustomBlock") return "custom";
        if (t) return "not-custom";
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  } catch (e) { /* 忽略 */ }
  for (let i = 0; i < 6; i++) {
    try {
      const chk = await kb("/api/query/sql", { stmt: "SELECT type FROM blocks WHERE id='" + id + "'" });
      const t = chk && chk.data && chk.data[0] && chk.data[0].type;
      if (t) return t === "custom" ? "custom" : "not-custom";
    } catch (e) { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return "unknown";
}

/** 某个父容器里，`blockId` 的**前一个兄弟**的 id（没有就返回 ""） */
async function siblingBefore(parentID, blockId) {
  if (!parentID) return "";
  try {
    const r = await kb("/api/block/getChildBlocks", { id: parentID });
    const list = (r && r.data) || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === blockId) return i > 0 ? (list[i - 1].id || "") : "";
    }
  } catch (e) { /* 忽略 */ }
  return "";
}

/** 内核没把围栏编译成 custom 块时就地重建（删掉重插，仍走内核 API） */
async function repairFenceBlock(blockId, json, pluginName) {
  const info = await kb("/api/query/sql", {
    stmt: "SELECT parent_id, root_id FROM blocks WHERE id='" + blockId + "'",
  });
  const row = info && info.data && info.data[0];
  if (!row) return false;
  const parentID = row.parent_id || row.root_id;
  // ★ 先记下"它前面是谁" ★
  //   删掉再插时如果不给 previousID，新块会跑到父容器**最前面**
  //   —— "修好"的代价变成"顺手挪到了文首"，用户会以为插件在乱动文档。
  const prevId = await siblingBefore(parentID, blockId);
  await kb("/api/block/deleteBlock", { id: blockId });
  const md = buildEmbedMarkdown(pluginName, JSON.parse(json));
  const insBody = { dataType: "markdown", data: md, parentID: parentID };
  if (prevId) insBody.previousID = prevId;
  const ins = await kb("/api/block/insertBlock", insBody);
  return !!(ins && ins.code === 0);
}

/**
 * 从 insertBlock 的返回里抠出**新区块的 id**。
 *
 * 正常路径是 `data[0].doOperations[0].id` ——
 *   实测（思源 3.8.6）：插入 op 的 `id` 就是新块 id，且与
 *   `data` 那段 HTML 里的 `data-node-id` **完全一致**（同一份实测里比对过）。
 *   所以下面第一轮循环就能拿到，后面的分支只是兜底。
 *
 * 兜底为什么留着：
 *   ① 一次插入**多个块**时（`data` 里有多个块、doOperations 有多条），
 *      先挑"data 里含 NodeCustomBlock 的那一条"，避免拿到同批里的普通段落；
 *   ② 思源的返回结构历史上变过（字段名/层级都动过），
 *      只认一个字段的写法在某次升级后会静默失效 —— 而这里的失效后果是
 *      **校验与自动修复一起哑掉**（拿不到 id ⇒ verifyCustomBlock 返回 unknown）。
 */
function extractNewId(ins) {
  const ops = (ins && ins.data && ins.data[0] && ins.data[0].doOperations) || [];
  const custom = ops.filter((o) => o && /NodeCustomBlock/.test(o.data || ""));
  const list = custom.concat(ops);
  for (const op of list) {
    if (op && op.id) return op.id;
  }
  for (const op of list) {
    const m = /data-node-id="([^"]+)"/.exec((op && op.data) || "");
    if (m) return m[1];
  }
  return "";
}

/* -------------------------------------------------------------------------
 * 4.5) 全局插入闸门（一次拖拽只允许落一个块）
 * --------------------------------------------------------------------------
 * ★ 为什么需要它（第二道防线）★
 *   一次拖拽 → 所有挂在 document 上的 drop 监听**按注册顺序各跑一遍**
 *   （`stopPropagation` 拦不住同一个节点上的其它监听，只有
 *    `stopImmediatePropagation` 才拦得住，而那会把思源内核自己的监听一起干掉）。
 *   正常情况 document 上只有我们**一份**监听（先摘后绑 + MIME 版本化保证），
 *   但"万一"（历史残留、装了副本、将来有人手滑在别处又绑一次）不该让用户
 *   得到两个一模一样的嵌入块。
 *
 * ★ 为什么挂在 window 上、而不是模块作用域 ★
 *   模块作用域的同名变量在思源重载插件后会**各是各的**，就起不到跨实例拦截
 *   的作用了。放 window 上 ⇒ 同一页面里所有模块实例共用同一个闸门。
 *
 * ★ 窗口为什么是 600ms ★
 *   一次拖拽触发的多次调用几乎是**同一时刻**（同一个事件对象、相差几毫秒），
 *   600ms 绰绰有余；而人手要连拖两次同一个文件，间隔一定 > 600ms，
 *   所以不会误伤"我就想嵌两份"。
 * ---------------------------------------------------------------------- */
const INSERT_GUARD_KEY = "__lfsEmbedInsertGuard";
const INSERT_GUARD_MS = 600;

/** 这个 spec 是不是刚刚（< INSERT_GUARD_MS）插过的同一份？是 ⇒ 判定为重复，跳过。 */
function isDuplicateInsert(spec) {
  try {
    if (typeof window === "undefined" || !window) return false;
    const g = window[INSERT_GUARD_KEY] || (window[INSERT_GUARD_KEY] = { t: 0, key: "" });
    const key = (spec && spec.kind === "tree" ? "tree" : "file") + "|" + ((spec && spec.path) || "");
    const now = Date.now();
    if (g.key === key && now - g.t < INSERT_GUARD_MS) return true;
    g.key = key;
    g.t = now;
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * ★ 唯一插入通道 ★
 *
 * ★ 为什么不能用 `protyle.insert(md)` ★
 *   前端 insert 会把 `;;;` 围栏存成**普通段落 type=p**，内核永远不会把它编译成
 *   自定义块 —— 症状是"笔记里显示一坨裸 JSON"，而且桌面端偶发正常、网页端必坏。
 *   ⇒ 一律走 `/api/block/insertBlock {dataType:"markdown"}`，让内核用 lute 完整解析。
 *
 * ★ 也**不做** "protyle.insert 兜底" ★
 *   那种兜底会静默产出坏块，用户只看到"插入了但是 JSON"，完全不知道失败。
 *   这里失败就抛，并带上定位轨迹。
 *
 * @param {object} plugin
 * @param {object} protyle 当前编辑器（可为 null，定位会自行回退）
 * @param {{kind:string,path:string,name?:string}} spec
 * @param {{anchorEl?:HTMLElement, fromSlash?:boolean}} [opts]
 */
export async function insertEmbedIntoDoc(plugin, protyle, spec, opts) {
  const o = opts || {};
  // ★ 第二道防线：一次拖拽如果被不止一个监听各跑了一遍，这里只放行第一个 ★
  //   返回 true 而不是抛错 —— 调用方（drop / 斜杠菜单 / 工具栏）会照常提示成功，
  //   不会因为"被拦了一次"而弹一个莫名其妙的失败 toast。
  if (isDuplicateInsert(spec)) return true;
  const md = buildEmbedMarkdown(plugin && plugin.name, spec);

  let located;
  try {
    located = await locateInsertPoint(protyle, o.anchorEl || null);
  } catch (e) {
    located = { parentID: "", nextID: "", previousID: "" };
  }
  if (!located.parentID) {
    const err = new Error("找不到要插入的文档。定位轨迹：" + (located.src || "(无)"));
    err.trace = located.src;
    throw err;
  }

  const body = { dataType: "markdown", data: md, parentID: located.parentID };
  // 需求：插在**光标所在块的上方**。内核语义 nextID = 插到它之前。
  if (located.nextID) {
    body.nextID = located.nextID;
  } else if (located.previousID) {
    // 没有光标锚点时**追加到文档末尾**：必须显式给 previousID，
    // 因为 insertBlock 不给这两者时是**前插**（实测，见 lastChildId 的说明）。
    body.previousID = located.previousID;
  }

  const ins = await kb("/api/block/insertBlock", body);
  if (!ins || ins.code !== 0) throw new Error((ins && ins.msg) || "insertBlock 失败");

  const newId = extractNewId(ins);

  let verdict = await verifyCustomBlock(newId);
  if (verdict === "not-custom" && newId) {
    try {
      await repairFenceBlock(newId, extractJson(md), plugin && plugin.name);
      verdict = await verifyCustomBlock(newId);
    } catch (e) {
      verdict = "not-custom";
    }
  }
  if (o.fromSlash) await cleanupSlashText(o.anchorEl);
  // ★ 拿不到 id 时**不能**算失败 ★
  //   内核确实回 code:0 了，块也已经插进去；只是我们没能从返回里解析出 id
  //   （思源的返回结构随版本变过）。这种情况按"信内核"处理，返回成功；
  //   真要判定成失败会把一次成功的插入说成失败，用户会重复插好几次。
  if (!newId) return true;
  return verdict !== "not-custom";
}

/* -------------------------------------------------------------------------
 * 6) 从文件树拖到正文（document 级，只绑一次）
 * ---------------------------------------------------------------------- */

/** 光标/落点是否在"真正文"里 */
function inRealWysiwyg(el) {
  try {
    const body = el && el.closest ? el.closest(".protyle-wysiwyg") : null;
    if (!body) return null;
    const host = body.closest ? body.closest(".protyle[data-node-id]") : null;
    return host ? body : null;
  } catch (e) {
    return null;
  }
}

/** 从落点坐标上溯到最近的块元素（必须在真正文内） */
function dropBlockAt(x, y) {
  try {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !inRealWysiwyg(hit)) return null;
    return hit.closest("[data-node-id]");
  } catch (e) {
    return null;
  }
}

function clearDropMarks() {
  document.querySelectorAll(".lfs-drop-target").forEach((el) => el.classList.remove("lfs-drop-target"));
}

/**
 * ★★ 监听注册表挂在 window 上，**不能**放模块作用域 ★★
 *
 * 思源「重载插件 / 升级插件」时会重新 import 本模块 —— 模块作用域里的变量
 * 会重置成新的一份，但**上一次挂在 document 上的监听不会自己消失**。
 * 后果就是用户实测到的这条：
 *
 *   Windows 桌面端升级过插件之后，从文件树拖一个文件到正文，
 *   会插出**两个一模一样的嵌入块**。
 *
 * （一次拖拽 → 两颗 handler 各调一次 insertEmbedIntoDoc → 两个块。）
 *
 * 注册表放 window 上 ⇒ 同一页面里所有模块实例共享同一份，
 * 新实例绑之前就能把旧的摘干净，重载多少次 document 上也只有一份。
 */
const DND_REG_KEY = "__lfsEmbedDropReg";

function dndReg() {
  try {
    if (typeof window === "undefined" || !window) return null;
    if (!window[DND_REG_KEY] || typeof window[DND_REG_KEY] !== "object") {
      window[DND_REG_KEY] = { off: [] };
    }
    return window[DND_REG_KEY];
  } catch (e) {
    return null;
  }
}

/**
 * 摘掉挂在 document 上的拖拽监听（不管是谁绑的）。
 *
 * ★ onunload 里必须调 ★ 否则"重载一次 ⇒ 多一份监听"，
 *   拖一次就插两个块。这也是本函数存在的唯一理由。
 */
export function unbindEmbedDrop() {
  const reg = dndReg();
  if (!reg || !reg.off || !reg.off.length) return;
  for (let i = 0; i < reg.off.length; i++) {
    try {
      document.removeEventListener(reg.off[i][0], reg.off[i][1], reg.off[i][2]);
    } catch (e) { /* 忽略 */ }
  }
  reg.off = [];
}

/**
 * 绑定拖拽落点。index.js 的 onload 里调。
 *
 * ★ 必须先摘后绑（幂等）★
 *   早先写法是 `if (plugin._lfsDropBound) return;` —— 只挡住了**同一个实例**
 *   的重复调用；思源重载插件给的是**新实例**，新实例上那个字段是 undefined，
 *   于是又绑一份，旧的还在 ⇒ 一次拖拽插两个嵌入块（Windows 桌面端实测）。
 *   现在改成"不论谁绑的，先摘干净再绑"，重复调用永远只有一份。
 * ★ 必须挂 document 的**捕获阶段** ★
 *   文件树与正文是两个互不包含的子树，挂在任一子树上都收不到对方的事件。
 * ★ dragover 里必须 preventDefault() ★ 否则浏览器根本不会触发 drop。
 * ★ 用 `dataTransfer.types` 判"是不是我们的拖拽" ★
 *   dragover 阶段读不到 getData（只有 drop 阶段能读），但 types 是有的。
 */
export function bindEmbedDrop(plugin) {
  unbindEmbedDrop();
  const reg = dndReg();
  plugin._lfsDropBound = true;

  const on = (type, fn) => {
    document.addEventListener(type, fn, true);
    if (reg) reg.off.push([type, fn, true]);
  };

  const isOurs = (ev) => {
    try {
      const t = ev.dataTransfer && ev.dataTransfer.types;
      return t ? Array.prototype.indexOf.call(t, DND_MIME) >= 0 : false;
    } catch (e) {
      return false;
    }
  };

  on("dragover", (ev) => {
    if (!isOurs(ev)) return;
    if (!inRealWysiwyg(ev.target)) return;
    ev.preventDefault();
    try {
      ev.dataTransfer.dropEffect = "copy";
    } catch (e) { /* 忽略 */ }
    clearDropMarks();
    const blk = dropBlockAt(ev.clientX, ev.clientY);
    if (blk) blk.classList.add("lfs-drop-target");
  });

  on("dragleave", (ev) => {
    if (!isOurs(ev)) return;
    clearDropMarks();
  });

  on("drop", async (ev) => {
    if (!isOurs(ev)) return;
    if (!inRealWysiwyg(ev.target)) return;
    // ★ 一次拖拽只插一个块 ★
    //   兜底防线：即便 document 上还残留着别的监听（历史版本没摘干净、
    //   或者用户装了两个副本），同一颗事件对象会被**逐个**派发 ——
    //   在事件对象上打个标记就挡住了。
    //   （摘监听那条是根治，这条是"确诊不了来源也保证用户只得到一个块"。）
    if (ev.__lfsDropDone) return;
    ev.__lfsDropDone = true;
    ev.preventDefault();
    ev.stopPropagation();
    const blk = dropBlockAt(ev.clientX, ev.clientY);
    clearDropMarks();

    let spec = null;
    try {
      const raw = ev.dataTransfer.getData(DND_MIME);
      if (raw) spec = JSON.parse(raw);
    } catch (e) { /* 忽略 */ }
    if (!spec || !spec.path) return;

    try {
      const ok = await insertEmbedIntoDoc(plugin, plugin.activeProtyle(), {
        kind: spec.kind === "tree" ? "tree" : "file",
        path: spec.path,
        name: spec.name,
      }, { anchorEl: blk || null, fromSlash: false });
      plugin.toast(ok ? "已插入本机存储嵌入块" : "插入失败：内核没有生成自定义块", !ok);
    } catch (e) {
      plugin.toast("插入失败：" + (e && e.message ? e.message : e), true);
    }
  });
}
