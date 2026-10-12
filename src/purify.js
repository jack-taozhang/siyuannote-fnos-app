/* ==========================================================================
 * iframe 内容「净化」—— 把第三方查看器自带的外壳（工具栏 / 文件树 / 菜单栏）藏掉
 * --------------------------------------------------------------------------
 * ★ 为什么需要它 ★
 *   我们的预览链路全是 iframe：
 *     · CAD    → 飞牛原生「CAD 看图」应用（同源 /localfs/cad/）
 *     · Office → 飞牛官方「Office 文档」（同源通道 /localfs/docs ⇒ 注入得进去）
 *     · 其余   → 「文件预览」应用（fnos-file-viewer，同源 /localfs/fv/）
 *   每个查看器都带一整套自己的 UI（顶部工具栏、左侧文件树、菜单栏、状态栏）。
 *
 *   在**页内浮层预览**里，那套 UI 是有用的（用户能直接在里面切文件、缩放）。
 *   但在两个场景里它只是噪音、还占地方：
 *     · **嵌入块**（正文里的小预览）：用户要的是"内容本身"，
 *       工具栏会把它挤成一条缝，还容易误点；
 *     · **页签**（需求 #6/#7）：页签自己就是"主视图"，再叠一层查看器外壳
 *       会形成「盒子套盒子」，视觉上非常重。
 *   ⇒ 这两处只保留**内容区**。
 *
 * ★ 三家的净化手段不一样（都是实测出来的）★
 *
 *   ① 文件预览（fnos-file-viewer）—— 同源，注入 CSS
 *      DOM： #app ├─ aside#sidebar（左文件树/面包屑/过滤）
 *                  └─ main#main ├─ header#topbar（文件名/下载/重载/主题）
 *                               └─ section#stage ← 预览本体
 *      藏 #sidebar + #topbar，#app/#main/#stage 拉满。
 *
 *   ② CAD 查看器（fnos-dwg-viewer，与内置那份同一套 cad-viewer 内核）
 *      —— 同源通道下可注入 CSS + 改 CSS 变量
 *      DOM： .ml-cad-container
 *              ├─ .ml-cad-layout
 *              │    ├─ .ml-cad-header        顶部工具区
 *              │    ├─ .ml-cad-main          画布（top: var(--ml-header-height)）
 *              │    └─ .ml-cad-footer        底部状态栏
 *              └─ .ml-cad-viewer-container   画布本体（left: 面板宽）
 *      ★ 关键 ★ 它的布局是绝对定位 + **CSS 变量**驱动的：
 *        .ml-cad-main 的 top 用 var(--ml-header-height)、bottom 用
 *        var(--ml-status-bar-height)。所以不能只 display:none ——
 *        还要把两个变量归零，画布才会真的铺满（否则上面留一条空白）。
 *
 *   ③ Office 文档（飞牛官方 trim.docs，同源通道 /localfs/docs/）
 *      —— **同源，但要穿透两层**
 *      我们建的 iframe → `editor.html`（同源）→ 它内部又嵌了 OO 的
 *      `iframe[name="frameEditor"]`（**也同源**：`/onlyoffice/*` 被反代收编到
 *      同一个 6806 端口）⇒ 工具栏/左侧菜单都在**内层**，只给外层文档注入样式
 *      是看不到任何效果的。
 *      ★ 内层的 id 不是猜的 ★ —— 从官方 `editor.html` 自己的代码里读出来的：
 *        它自己就在操作 `iframe.contentWindow.document` 的
 *        `#viewport` / `#left-menu` / `#statusbar` / `#area_id_parent`。
 *      ⚠️ 因此在"嵌入块"里 Office 也会走**注入样式**这条路，不再靠
 *        URL 上的 `bare=1`（那是自研那套 OO 宿主的开关，官方这套没有）。
 *
 * ★ 为什么不是改查看器本身 ★
 *   那三个都是独立产品，正常使用时需要它们完整的 UI。
 *   为「在思源里显示得干净点」去动它们，会把它们自己的页面也改坏。
 *   所以一律"从外面盖样式" / "用官方开关"，随时可撤。
 * ========================================================================== */

/** 注入到同源 iframe 里的样式：文件预览 */
const FV_CSS = [
  // 左侧文件树、面包屑、过滤框整体不显示
  "#sidebar{display:none !important;}",
  // 顶部条（文件名 / 下载 / 新窗口 / 重载 / 主题）不显示
  "#topbar{display:none !important;}",
  // 布局从"两栏"拉成"单栏铺满"
  "#app{display:block !important;}",
  "#main{width:100% !important;height:100% !important;max-width:none !important;}",
  "#stage{height:100% !important;}",
  // 内容铺满，去掉可能存在的内边距
  "html,body{height:100% !important;margin:0 !important;padding:0 !important;overflow:hidden !important;}",
].join("");

/**
 * 注入到同源 iframe 里的样式：CAD 查看器。
 * ★ 两个自定义属性必须归零 ★ —— 否则 .ml-cad-main 仍按原 header 高度让位，
 *   藏了 header 反而在顶部留一条空白。
 */
// ── CAD 查看器「只留图纸」的净化样式 ─────────────────────────────
//
// ★ 类名全部来自真机实测枚举，不是猜的 ★（脚本 .verify/_diag-cad-dom.mjs）
//   2026-10-09 实测（@mlightcad/cad-viewer，1658×902 视口）拿到的可见容器：
//
//     ml-cad-viewer-container  1658x902 @(0,0)     根
//     ml-cad-layout            1658x902 @(0,0)
//     ml-cad-main              1658x749 @(0,123)   ← 顶部让位 123px
//     ml-cad-container         1658x749 @(0,123)
//     ml-cad-header            1658x123 @(0,0)     顶部 ribbon 工具区
//       └ ml-ribbon-toolbar-container / ml-ribbon / ml-ribbon__panel / ml-ribbon-group…
//     ml-vertical-toolbar-host 1658x749 @(0,123) ★「右侧工具条」的宿主（全幅）★
//       └ ml-ex-ui-toolbar-host
//         └ ml-ex-ui-toolbar    46x323 @(1600,336)  ← 真正可见的那根竖条
//     ml-ui-shortcut-toolbar-shell 131x42 @(1515,135) ★「右侧顶部工具条」★
//     ml-cli-container         1094x30 @(282,832)  ★「命令行」★
//       └ ml-cli-wrapper / ml-cli-bar / ml-cli-center / ml-cli-text
//     ml-status-bar            1658x30 @(0,872)    底部状态栏（含 ml-layout-tabs）
//
//   ⇒ 用户报的「命令行 / 右侧工具条 / 右侧顶部工具条」三个，就是
//     ml-cli-container、ml-ex-ui-toolbar、ml-ui-shortcut-toolbar-shell。
//   ⇒ 另外注意：**没有 `.ml-cad-footer` 这个类**，底部其实叫 `ml-status-bar`
//     （之前那条 CSS 是空打 —— 靠 `--ml-status-bar-height:0` 侥幸遮住了）。
const CAD_CSS = [
  // ── 顶部 ribbon 工具区 + 底部状态栏 ──
  ".ml-cad-header{display:none !important;}",
  ".ml-cad-footer{display:none !important;}",          // 旧版可能叫这个，留着无害
  ".ml-status-bar{display:none !important;}",          // ★ 实测真名 ★
  ".ml-ribbon-toolbar-container{display:none !important;}",

  // ── 命令行（用户：「CAD 嵌入块上面还显示命令行」）──
  ".ml-cli-container{display:none !important;}",
  ".ml-cli-wrapper{display:none !important;}",
  ".ml-cli-bar{display:none !important;}",

  // ── 右侧工具条（竖条）+ 它的宿主 ──
  //   ★ 宿主是"全幅 749px 高"的透明层：只藏里面的 ml-ex-ui-toolbar 不够，
  //     它自己不占视觉但会吃掉右侧点击；两个都收掉。
  ".ml-vertical-toolbar-host{display:none !important;}",
  ".ml-ex-ui-toolbar-host{display:none !important;}",
  ".ml-ex-ui-toolbar{display:none !important;}",

  // ── 右侧顶部工具条（浮动快捷键条）──
  ".ml-ui-shortcut-toolbar-shell{display:none !important;}",
  ".ml-ui-shortcut-toolbar{display:none !important;}",

  // ── 其它会挡图纸的浮层（有就藏，没有不报错）──
  ".ml-entity-properties-wrapper{display:none !important;}",
  ".ml-layer-manager-panel{display:none !important;}",
  ".ml-layer-list-wrapper{display:none !important;}",
  ".ml-character-map-magnifier{display:none !important;}",
  ".ml-ui-notification-center{display:none !important;}",

  // ── 画布铺满：让位的两个变量归零 ──
  ":root{--ml-header-height:0px !important;--ml-status-bar-height:0px !important;}",
  // ★ 实测 ml-cad-main 是 absolute + top:123px（由 --ml-header-height 驱动），
  //   但保险起见把四条边都钉死，别指望变量一定生效。
  ".ml-cad-main{top:0 !important;bottom:0 !important;left:0 !important;right:0 !important;}",
  ".ml-cad-container{top:0 !important;bottom:0 !important;left:0 !important;right:0 !important;}",
  ".ml-cad-viewer-container{left:0 !important;right:0 !important;top:0 !important;bottom:0 !important;}",
  "html,body,#app{height:100% !important;margin:0 !important;padding:0 !important;overflow:hidden !important;}",
].join("");

/** 环境标识（注入 style 时用 id 做单例判断） */
export const BARE_ID_FV = "lfs-bare-fv";
export const BARE_ID_CAD = "lfs-bare-cad";
export const BARE_ID_DOCS = "lfs-bare-docs";
export const BARE_ID_DOCS_INNER = "lfs-bare-docs-inner";

// ── Office 文档「只留文档」的净化样式 ─────────────────────────────
//
// ★ 分两层：外层是我们 iframe 直接拿到的 editor.html，内层是 OO 的
//   frameEditor。两层都要注，缺一层都等于没做。
// ★ 外层要处理的"外壳"是从官方 editor.html 的 HTML 里读出来的：
//     #loading（它自己的转圈）、#editor（挂 OO 的容器）、
//     #write-permission-notice + #download-copy-button + #reload-source-button
//     （只读/权限提示与两个浮标按钮）。
const DOCS_CSS = [
  "html,body{height:100% !important;margin:0 !important;padding:0 !important;overflow:hidden !important;}",
  // #editor 是 absolute 定位的容器，尺寸由它自己的脚本按视口算 ⇒ 这里钉死铺满
  "#editor{position:absolute !important;top:0 !important;left:0 !important;right:0 !important;"
    + "bottom:0 !important;width:100% !important;height:100% !important;margin:0 !important;}",
  "#editor>iframe,#editor iframe{width:100% !important;height:100% !important;}",
  // 它自己的浮层：权限提示与两个浮标按钮（"下载副本" / "重新载入源文件"）
  "#write-permission-notice{display:none !important;}",
  "#download-copy-button,#reload-source-button{display:none !important;}",
].join("");

// ★ 内层 OO 的 id 全部来自官方 editor.html 自己的 JS（见文件头 ③）★
//   `#toolbar` 与 `#header` 是 OO 的标准命名，用它自己的类名兜底；
//   找不到就是空打 —— 不会报错，但**也不能算净化成功**（要实机截图确认）。
const DOCS_INNER_CSS = [
  "#toolbar{display:none !important;}",
  ".toolbar{display:none !important;}",
  "#header{display:none !important;}",
  "#left-menu{display:none !important;}",
  "#statusbar{display:none !important;}",
  // 工具栏藏掉后 OO 不会自动把视口上移 ⇒ 自己钉住
  "#viewport{top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;}",
  "html,body{overflow:hidden !important;}",
].join("");

/** 构造一段带单例 id 的 <style> 注入器（给同源 iframe 用） */
function injector(styleId, css, extra) {
  return (doc) => {
    if (!doc || !doc.head) return;
    if (!doc.getElementById(styleId)) {
      const st = doc.createElement("style");
      st.id = styleId;
      st.textContent = css;
      doc.head.appendChild(st);
    }
    if (extra) {
      try { extra(doc); } catch (e) { /* 忽略 */ }
    }
  };
}

/** 文件预览的净化：注入 FV_CSS + 内联兜底 */
export const purifyFileViewer = injector(BARE_ID_FV, FV_CSS, (doc) => {
  // 兜底：有些版本给 #sidebar / #topbar 设了 inline display，内联样式优先级更高，
  // 所以这里也用 !important 的内联写法盖回去。
  const sb = doc.getElementById("sidebar");
  if (sb) sb.style.setProperty("display", "none", "important");
  const tb = doc.getElementById("topbar");
  if (tb) tb.style.setProperty("display", "none", "important");
});

/** CAD 查看器的净化 */
export const purifyCadViewer = injector(BARE_ID_CAD, CAD_CSS);

/**
 * Office 文档的净化 —— **两层都要注**。
 *
 * ★ 为什么不能只用 injector ★
 *   injector 只会给传进来的那个 document 加一段 style。而 Office 的内层
 *   （真正带工具栏的那一层）是 `editor.html` **自己**再套的一个 iframe，
 *   得顺着 `contentDocument` 往里走一层。
 * ★ 为什么第 1 层也要注 ★
 *   藏掉它自己的 loading 转圈与两个浮标按钮，并把 #editor 钉成铺满
 *   （它原本是按脚本算出来的像素高度，嵌在小块里会出现滚动条）。
 */
export const purifyOffice = injector(BARE_ID_DOCS, DOCS_CSS, (doc) => {
  // ── 第 2 层：OO 的 frameEditor（同源，能直接拿它的 document）──
  let inner = null;
  try {
    inner = doc.querySelector('iframe[name="frameEditor"]') ||
            doc.querySelector("#editor iframe") ||
            doc.querySelector("iframe");
  } catch (e) { inner = null; }
  let idoc = null;
  try { idoc = inner && inner.contentDocument; } catch (e) { idoc = null; }
  if (!idoc || !idoc.head) return;                 // 还没建好 ⇒ 交给下一轮重钉
  if (idoc.getElementById(BARE_ID_DOCS_INNER)) return;
  const st = idoc.createElement("style");
  st.id = BARE_ID_DOCS_INNER;
  st.textContent = DOCS_INNER_CSS;
  idoc.head.appendChild(st);
});

/**
 * 挂「异步重钉」定时器。
 *
 * ★ 为什么不能只注入一次 ★
 *   两个查看器都是**异步渲染**的：先 await 配置，再决定布局、
 *   甚至中途把侧栏又展开一次。load 事件那一刻 DOM 可能还没稳定，
 *   注进去的样式会被后到的内联样式盖掉。
 *   ⇒ 头几秒内多钉几次；之后就不管了（用户手动展开侧栏也不该被强行收回）。
 *
 * @param {() => void} apply 每次重钉要执行的函数
 * @param {number[]} stamps  毫秒时间点
 * @param {Array} bucket     定时器句柄收集处（destroy 时清）
 */
export function repin(apply, stamps, bucket) {
  apply();
  (stamps || [300, 1000, 2500]).forEach((ms) => {
    bucket.push(setTimeout(apply, ms));
  });
}
