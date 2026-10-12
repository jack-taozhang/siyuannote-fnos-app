/* ==========================================================================
 * 页签（预览 / 编辑）契约的离线回归断言
 * --------------------------------------------------------------------------
 * 为什么需要这个文件：
 *   页签这条链路上，「坏掉」的形态大多**不报错**，只是悄悄不工作：
 *     ① `addTab({type})` 与 `openTab({custom:{id}})` 的标识对不上
 *        （思源内部拼的是「插件名 + type」）⇒ 点了没反应，console 干净；
 *     ② `init()` 里的 `this` 是**页签对象**而不是插件实例，写成 `this.plugin`
 *        会在打开页签的那一刻抛异常 —— 而没人会一直在看 console；
 *     ③ 单击/双击的分工写错 ⇒ 单击本该只选中却打开了东西、
 *        或者双击没能进页签（2026-10-10 起：单击=只选中高亮，双击=在页签中打开）；
 *     ④ 嵌入块的「在页签中打开」偷偷还在 `window.open`（在飞牛 App 的 iframe
 *        里会被弹窗拦截）—— 功能"在"，但根本打不开。
 *   这些真机脚本能抓，但要 NAS + Chrome + 几分钟。契约本身该在 2 秒内挡住。
 *
 * 本文件两层：
 *   A) 纯函数单测 —— 把 src/*.js 当 ESM 载进来看 tabTypeFull
 *   B) 源码 / 构建产物 / 样式 的接线断言
 *
 * 用法：node tools/test-tab.mjs
 * ========================================================================== */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
/** 本机构建产物（deploy-nas.sh 的上传源） */
const BUILT = "D:/Software/SiYuan/data/plugins/siyuan-localfs";

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "   → " + extra : "")); }
};

/**
 * 剥掉注释再断言。
 * ★ 必须做 ★ 我们这个仓库的注释里写着大量"被删掉的旧写法"
 *   （例如 embed.js 里专门记着"以前这里是 window.open(…)"），
 *   不剥注释的话，"断言旧写法已消失"会被自己的注释刷红。
 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join("\n");

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const readNoCmt = (rel) => stripComments(read(rel));

/* ---------------------------------------------------------------------------
 * A) 把源码当 ESM 载进来（只测纯函数）
 * ------------------------------------------------------------------------ */
const TMP = join(ROOT, ".verify", "_esm-tab");
let tab = null;
let kinds = null;
try {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const SRC = join(ROOT, "src");
  for (const f of readdirSync(SRC)) {
    if (!f.endsWith(".js")) continue;
    let code = readFileSync(join(SRC, f), "utf8");
    code = code.replace(/from\s*"(\.\/[^"]+?)"/g, (_m, p) => `from "${p}.mjs"`);
    writeFileSync(join(TMP, f.replace(/\.js$/, ".mjs")), code, "utf8");
  }
  tab = await import(pathToFileURL(join(TMP, "tabview.mjs")).href);
  // ★ 顺序无关：kinds.js 是零依赖的纯模块，单独载一份用来做**行为**断言 ★
  //   （只做正则断言容易被自己的注释骗到 —— 这个仓库里吃过这个亏）
  kinds = await import(pathToFileURL(join(TMP, "kinds.mjs")).href);
} catch (e) {
  console.log("  ！tabview.js 载不进来：" + e.message);
}

console.log("\n【1】纯函数：页签标识必须是「插件名 + type」拼出来的");
if (tab) {
  ok("导出了 TAB_TYPE", typeof tab.TAB_TYPE === "string" && tab.TAB_TYPE.length > 0, String(tab.TAB_TYPE));
  const full = tab.tabTypeFull({ name: "siyuan-localfs" });
  ok("tabTypeFull 把插件名拼在前面（思源内部就是这么拼的）",
    full === "siyuan-localfs" + tab.TAB_TYPE, full);
  const full2 = tab.tabTypeFull({ name: "abc" });
  ok("换个插件名也跟着变（没有写死）", full2 === "abc" + tab.TAB_TYPE, full2);
  // 兜底：拿不到插件名时不能是 undefined/裸后缀
  const full3 = tab.tabTypeFull({});
  ok("拿不到插件名时有兜底（不能拼出 undefined）",
    typeof full3 === "string" && full3.indexOf("undefined") < 0, full3);
  ok("导出了 tryReuseViewerTab", typeof tab.tryReuseViewerTab === "function");
} else {
  ok("tabview.js 可被当 ESM 载入", false);
}

/* ---------------------------------------------------------------------------
 * B) 接线断言
 * ------------------------------------------------------------------------ */
console.log("\n【2】index.js：注册页签 + 打开页签");
const idx = readNoCmt("index.js");
ok("import 了 openTab（从 siyuan）",
  /import\s*\{[^}]*\bopenTab\b[^}]*\}\s*from\s*"siyuan"/.test(idx));
ok("import 了 TabView / TAB_TYPE / tabTypeFull / tryReuseViewerTab",
  /from\s*"\.\/src\/tabview\.js"/.test(idx) &&
  /\bTabView\b/.test(idx) && /\btabTypeFull\b/.test(idx) && /\btryReuseViewerTab\b/.test(idx));
ok("调用了 this.addTab({", /this\.addTab\(\s*\{/.test(idx));
ok("addTab 的 type 用的是 TAB_TYPE（不是裸字符串）", /type\s*:\s*TAB_TYPE/.test(idx));
ok("init() 里用闭包拿到的插件实例（不是 this.plugin —— 那里的 this 是页签对象）",
  /new\s+TabView\(\s*this\.element\s*,\s*this\.data\s*,\s*pluginSelf\s*\)/.test(idx) &&
  /const\s+pluginSelf\s*=\s*this/.test(idx));
ok("destroy 时销毁 TabView", /_lfsView\.destroy\(\)/.test(idx));
ok("addTab 外面包了 try/catch（老内核没有 addTab 不能带崩 onload）",
  /try\s*\{\s*this\.addTab/.test(idx));

ok("新增了 openFileInTab(item, opts)", /openFileInTab\s*\(\s*item\s*,\s*opts\s*\)/.test(idx));
ok("openFileInTab 里调 openTab(", /openTab\(\s*\{/.test(idx));
ok("openTab 传了 app 与 custom", /app\s*:\s*this\.app/.test(idx) && /custom\s*:\s*\{/.test(idx));
ok("custom.id 用 tabTypeFull(this)（与 addTab 对齐）", /id\s*:\s*tabTypeFull\(\s*this\s*\)/.test(idx));
ok("custom.icon 用的是注册过的符号 id", /icon\s*:\s*"iconLocalfs"/.test(idx));
ok("custom.data 带上了文件信息", /data\s*:\s*node/.test(idx));
ok("打开前先尝试复用同文件页签", /tryReuseViewerTab\(\s*this\s*,\s*node\s*\)/.test(idx));
ok("forceNew 能跳过复用", /if\s*\(\s*!\s*o\.forceNew/.test(idx));
ok("openTab 失败时退回浮层（老内核兜底）", /openTab[\s\S]{0,400}openPreview\(/.test(idx));
ok("注册了图标符号（addIcons(SYMBOLS_ALL) 含页签 + 停靠）",
  /addIcons\(\s*SYMBOLS_ALL\s*\)/.test(idx));

console.log("\n【3】explorer.js：单击只选中 / 双击页签 / 修饰键新页签（2026-10-10 定档）");
const exp = readNoCmt("src/explorer.js");
ok("文件行绑了 dblclick", /addEventListener\(\s*"dblclick"/.test(exp));
ok("dblclick 走 openFileInTab", /dblclick[\s\S]{0,400}openFileInTab\(/.test(exp));
// ★ 2026-10-10 用户要求：单击不再打开任何东西，只把那一行选中高亮 ★
//   原实现是"单击推迟 250ms 开浮层 + 双击取消它"，那套整体下线了。
//   ⚠️ 断言必须只看 click handler 那一段：右键菜单里的「预览」还合法地
//      调着 openPreview，用宽正则会把菜单那处也算进来（假红）。
const clickBlock = (exp.match(/row\.addEventListener\(\s*"click"[\s\S]*?addEventListener\(\s*"dblclick"/) || [""])[0];
ok("取到了 click handler 段（探针有效）", clickBlock.length > 80);
ok("★ 单击**不再**开浮层（openPreview 已从 click 里撤掉）",
  !/openPreview/.test(clickBlock));
ok("★ 单击只选中高亮（走 _setActiveRow）",
  /self\._setActiveRow\(row\)/.test(clickBlock));
ok("★ 延时开浮层那套已删（没有 clickTimer / setTimeout 250）",
  !/clickTimer/.test(exp) && !/cancelClick/.test(exp));
ok("★ 有 _setActiveRow 方法（唯一一行选中 + 记 activePath）",
  /_setActiveRow\s*\(row\)/.test(exp) && /this\.activePath\s*=/.test(exp));
ok("★ 行重建时按 activePath 补回高亮（展开/刷新后不掉色）",
  /activePath\s*===\s*it\.path[\s\S]{0,80}is-active/.test(exp));
ok("Ctrl/⌘+单击开新页签（forceNew）",
  /ctrlKey\s*\|\|\s*e\.metaKey/.test(exp) && /forceNew\s*:\s*true/.test(exp));
ok("右键菜单仍有「预览」（浮层没下线，只是不再占单击）",
  /this\.t\(\s*"preview"/.test(exp));
ok("右键菜单有「在页签中打开」", /this\.t\(\s*"openInTab"/.test(exp));
// ★ 2026-10-10 整理：编辑入口整体下线 ★
//   官方 docs 按文件的写权限自己决定可读可写、不吃 mode 参数 ⇒ 这个菜单项
//   点了与「在页签中打开」完全一样，属于误导。改成断言"它不在了"。
ok("★ 菜单里不再有「在页签中编辑」（编辑入口已下线）",
  !/editInTab/.test(exp) && !/mode\s*:\s*"edit"/.test(exp));
ok("菜单里不再用老的 editInOffice（避免两个编辑入口打架）", !/this\.t\(\s*"editInOffice"/.test(exp));

console.log("\n【4】preview.js：内容渲染交给共享核 + 工具条加「在页签中打开」");
const pv = readNoCmt("src/preview.js");
ok("import 了 FileView / el / fmtSize / pathParts", /from\s*"\.\/fileview"/.test(pv) && /\bFileView\b/.test(pv));
ok("import 了 ICON_TAB", /\bICON_TAB\b/.test(pv));
ok("工具条调 plugin.openFileInTab", /this\.plugin\.openFileInTab\(/.test(pv));
ok("自己**不再**实现内容渲染（_iframe / _renderText 已迁到 fileview）",
  !/^\s*_iframe\s*\(/m.test(pv) && !/^\s*_renderText\s*\(/m.test(pv));
ok("open() 里把内容交给 view.show(item, want)", /view\.show\(\s*item\s*,\s*want\s*\)/.test(pv));
ok("close() 里销毁 view（不留孤儿 iframe）", /view\.destroy\(\)/.test(pv));

console.log("\n【5】fileview.js：渲染核（浮层与页签共用）");
const fv = readNoCmt("src/fileview.js");
ok("导出了 FileView 类", /export\s+class\s+FileView/.test(fv));
ok("导出了 el / fmtSize / pathParts 三个共用小工具",
  /export\s+function\s+el\b/.test(fv) && /export\s+function\s+fmtSize\b/.test(fv) &&
  /export\s+function\s+pathParts\b/.test(fv));
ok("有 show / setMode / rerender / destroy", /show\s*\(\s*item\s*,\s*mode\s*\)/.test(fv) &&
  /setMode\s*\(/.test(fv) && /rerender\s*\(/.test(fv) && /destroy\s*\(/.test(fv));
// ★ 2026-10-09 第二次调整：四条链路 ★
//   · CAD      → cadViewerUrl（内置 DWG/DXF 查看器）
//   · Office   → officeUrl（OnlyOffice，**PDF 也归这条**）
//   · 原生     → 图片/音视频/文本，用浏览器原生标签自己画（<img>/<video>/<pre>）
//   · 其余     → fileViewerUrl（压缩包/3D/OFD 等交给 fnos-file-viewer 兜底）
//   路由表在 kinds.js 的 rendererOf()，渲染核只按 renderer 分派。
ok("渲染核按 rendererOf 分派（路由表收敛到 kinds.js）",
  /rendererOf\s*\(/.test(fv) && /RENDERER\.CAD/.test(fv) &&
  /RENDERER\.OFFICE/.test(fv) && /RENDERER\.NATIVE/.test(fv));
ok("CAD / Office / 其余分别用 cadViewerUrl / officeUrl / fileViewerUrl",
  /cadViewerUrl\s*\(\s*item\.path\s*\)/.test(fv) &&
  /officeUrl\s*\(\s*item\.path/.test(fv) &&
  /fileViewerUrl\s*\(\s*item\.path\s*\)/.test(fv));
ok("原生链路用浏览器标签自己画（_native 方法 + img/video/audio）",
  /_native\s*\(\s*item\s*,\s*kind\s*\)/.test(fv) &&
  /createElement\(\s*["']img["']\s*\)/.test(fv) &&
  /createElement\(\s*["']video["']\s*\)/.test(fv) &&
  /createElement\(\s*["']audio["']\s*\)/.test(fv));
ok("原生链路用同源 fileUrl（不是 file-viewer 页面）",
  /fileUrl\s*\(\s*item\.path\s*\)/.test(fv));
ok("文本走 readText 且只取前 512 KB（大日志不吃内存）",
  /readText\s*\(\s*item\.path\s*,\s*MAX\s*\)/.test(fv) && /MAX\s*=\s*512\s*\*\s*1024/.test(fv));
ok("三条 iframe 链路都还在（CAD / Office / 文件预览）",
  (fv.match(/this\._iframe\s*\(/g) || []).length >= 3);
ok("iframe 的盒子里只能清空容器**一次**（清空后 append 盒子+动画，不再动）",
  (fv.match(/this\.container\.innerHTML\s*=\s*""/g) || []).length >= 1 &&
  /this\.container\.appendChild\(\s*box\s*\)[\s\S]{0,200}this\.container\.appendChild\(\s*spin\s*\)/.test(fv));

console.log("\n【6】embed.js：「在页签中打开」必须开思源页签，不是浏览器新窗口");
const emb = readNoCmt("src/embed.js");
ok("按钮走 plugin.openFileInTab", /plugin\.openFileInTab\(\s*\{/.test(emb));
ok("不再用 window.open 开那个按钮", !/window\.open\(\s*resolveUrl/.test(emb));
ok("resolveUrl 的 tab 参数已移除（不留「看起来还能用」的死分支）",
  /function\s+resolveUrl\(\s*path\s*,\s*kind\s*,\s*plugin\s*\)/.test(emb));

console.log("\n【7】tabview.js：页签视图外壳");
const tv = readNoCmt("src/tabview.js");
ok("导出了 TabView 类", /export\s+class\s+TabView/.test(tv));
ok("构造签名 (element, data, plugin)", /constructor\(\s*element\s*,\s*data\s*,\s*plugin\s*\)/.test(tv));
ok("工具条 / 内容区两段结构（需求 #8 去掉了中间的信息条）",
  /-tab-bar/.test(tv) && /-tab-body/.test(tv) && !/-tab-info/.test(tv));
ok("内容区用共享渲染核 FileView", /new\s+FileView\(\s*\{/.test(tv));
// ★ 2026-10-10 整理：「预览 / 编辑」切换按钮已删 ★
//   Office / PDF 换飞牛官方应用后，模式由服务端按文件写权限决定、不看 URL 参数
//   ⇒ 按钮点了没有任何变化。改成断言"三个工具条里都没有它了"。
ok("★ 页签工具条不再有预览/编辑切换按钮",
  !/canToggleEdit/.test(tv) && !/switchToEdit/.test(tv) && !/switchToView/.test(tv));
ok("destroy 里把 FileView 也销毁", /this\.view\.destroy\(\)/.test(tv));
ok("「在浏览器中打开」统一走 externalUrlOf（不再各写一遍三分支）",
  /externalUrlOf\s*\(/.test(tv) && !/fileViewerUrl\s*\(\s*d\.path\s*\)/.test(tv));

console.log("\n【6.5】api.js：三条链路的地址都收在一个 channelUrl 里（一律走 6806 同源通道）");
const api = readNoCmt("src/api.js");
ok("导出了 fileViewerUrl", /export\s+function\s+fileViewerUrl\b/.test(api));
ok("导出了 cadViewerUrl", /export\s+function\s+cadViewerUrl\b/.test(api));
ok("同源通道路径与反代一致（/localfs/fv、/localfs/cad、/localfs/docs）",
  /FV_PREFIX\s*=\s*["']\/localfs\/fv["']/.test(api) &&
  /CAD_PREFIX\s*=\s*["']\/localfs\/cad["']/.test(api) &&
  /DOCS_PREFIX\s*=\s*["']\/localfs\/docs["']/.test(api));
ok("★ 反代端口常量 PROXY_PORT = 6806（三条通道都拼在它上面）",
  /export\s+const\s+PROXY_PORT\s*=\s*6806\b/.test(api), "PROXY_PORT");
ok("两条链路的端口常量 = 那两个原生应用的 service_port（8020 看图 / 8030 预览）",
  /CAD_PORT\s*=\s*8020\b/.test(api) && /FV_PORT\s*=\s*8030\b/.test(api));
ok("Office 链路的入口 = /preview（飞牛官方就是 /docs/preview）",
  /DOCS_OPEN_ROUTE\s*=\s*["']\/preview["']/.test(api));
ok("★ 三条链路都走同一个 channelUrl（不再各写一遍 location.origin / 直连端口）",
  (api.match(/channelUrl\(\s*(?:FV|CAD|DOCS)_PREFIX/g) || []).length === 3,
  String((api.match(/channelUrl\(\s*(?:FV|CAD|DOCS)_PREFIX/g) || []).length));

// ★ 这里验的是 2026-10-10 修掉的那个真 bug ★
//   早先 fileViewerUrl 只看 `location.protocol`，页面是 http 就直接用
//   location.origin ⇒ 思源**桌面客户端**上它指向本机内核，
//   `/localfs/fv/…` 必然 404（桌面端文件预览一直打不开）。
//   正确的判据是"_base 与页面同不同源"：同源才用页面 origin，
//   否则按主机 + **反代端口 6806** 走（不再直连各应用自己的端口）。
{
  const m = api.match(/function\s+channelUrl[\s\S]*?\n\}/);
  const body = m ? m[0] : "";
  ok("取到了 channelUrl 函数体（探针有效）", body.length > 100);
  ok("channelUrl：同源分支要求 _base 与页面同源（不是只看 location.protocol）",
    /originOf\(_base\)\s*===\s*originOf\(pageOrigin\)/.test(body));
  ok("channelUrl：非同源时按 _base 的主机 + PROXY_PORT(6806) 走",
    /hostOf\(_base\)/.test(body) && /PROXY_PORT/.test(body));
  ok("★ channelUrl 已无直连分支（port / direct / pageIsHttps 都消失）",
    !/\bport\b/.test(body) && !/direct/.test(body) && !/pageIsHttps/.test(body));
}
// ★ 关键结构性断言：CAD 不再由图省自己渲染 ★
//   2026-10-10 起 CAD 预览借飞牛原生「CAD 看图」应用（与文件预览借 :8030 同构）。
ok("cadViewerUrl 不再拿 _base 当页面根（_base + \"/?\" 那种内置查看器写法已消失）",
  !/cadViewerUrl[\s\S]{0,400}_base\s*\+\s*"\/\?"/.test(api));
ok("CAD 与 Office 的地址仍是各自那条（没被改坏）",
  /cadViewerUrl\b/.test(api) && /officeUrl\b/.test(api));

console.log("\n【8】构建清单与图标");
ok("build.js MODULES 含 src/fileview.js", /"src\/fileview\.js"/.test(readNoCmt("tools/build.js")));
ok("build.js MODULES 含 src/tabview.js", /"src\/tabview\.js"/.test(readNoCmt("tools/build.js")));
const icons = readNoCmt("src/icons.js");
ok("icons.js 有 ICON_TAB（工具条按钮用）", /export\s+const\s+ICON_TAB\b/.test(icons));
ok("icons.js 有 SYMBOL_LOCALFS（页签标题图标，addIcons 用）",
  /export\s+const\s+SYMBOL_LOCALFS\b/.test(icons) && /id="iconLocalfs"/.test(icons));

console.log("\n【9】i18n：新增 key 中英都得有，且集合一致");
const zh = JSON.parse(read("i18n/zh_CN.json"));
const en = JSON.parse(read("i18n/en_US.json"));
for (const k of ["openInTab"]) {
  ok(`zh_CN 有 ${k}`, typeof zh[k] === "string" && zh[k].length > 0);
  ok(`en_US 有 ${k}`, typeof en[k] === "string" && en[k].length > 0);
}
ok("zh/en 的 key 集合完全一致",
  JSON.stringify(Object.keys(zh).sort()) === JSON.stringify(Object.keys(en).sort()),
  Object.keys(zh).filter((k) => !(k in en)).concat(Object.keys(en).filter((k) => !(k in zh))).join(","));

console.log("\n【10】构建产物：新增模块没被 build 吞掉");
if (existsSync(BUILT)) {
  const out = readFileSync(join(BUILT, "index.js"), "utf8");
  // ★ 产物头部的生成说明里，**故意**写着 `require("./src/x.js")` 作为反面例子，
  //   所以查"相对 require"必须先剥注释，否则会被产物自己的注释刷红。
  const outNoCmt = stripComments(out);
  ok("产物含 class FileView", /class\s+FileView/.test(out));
  ok("产物含 class TabView", /class\s+TabView/.test(out));
  ok("产物含 tryReuseViewerTab", /tryReuseViewerTab/.test(out));
  ok("产物含 openFileInTab", /openFileInTab/.test(out));
  ok("产物含页签图标符号 id", /iconLocalfs/.test(out));
  ok("产物含 addTab / openTab 调用", /addTab/.test(out) && /openTab/.test(out));
  ok("产物含页签外壳类名（-tab-bar/-tab-body）", /-tab-bar/.test(out) && /-tab-body/.test(out));
  ok("产物不含相对 require（思源解析不了）", !/require\(\s*["']\.\//.test(outNoCmt));
} else {
  ok("找不到构建产物（先跑 node tools/build.js）", false, BUILT);
}

console.log("\n【11】样式：页签必须自适应思源版面（不能写死高度）");
const css = read("index.css");
const cssFlat = stripComments(css);
ok("有 .lfs-tab 规则", /\.lfs-tab\s*\{/.test(cssFlat));
ok(".lfs-tab 高度 100%（跟着页签版面走）", /\.lfs-tab\s*\{[^}]*height\s*:\s*100%/.test(cssFlat));
ok(".lfs-tab 里**没有**写死 vh 高度（写死会在手机上撑出可视区）",
  !/\.lfs-tab\s*\{[^}]*\d+vh/.test(cssFlat));
ok("内容区 .lfs-tab-body 是纵向 flex 且 min-height:0（长内容不许溢出）",
  /\.lfs-tab-body\s*\{[^}]*flex\s*:\s*1\s+1\s+auto/.test(cssFlat) &&
  /\.lfs-tab-body\s*\{[^}]*min-height\s*:\s*0/.test(cssFlat));
ok("有窄屏处理（标题让位）", /@media[^{]*max-width:\s*640px[^{]*\{[\s\S]*\.lfs-tab-title/.test(cssFlat));

console.log("\n【12】需求 #1：侧边栏在右侧 + 常用文件夹只显示选中的");
{
  const idx = readNoCmt("index.js");
  // ★ 2026-10-10 第三轮：位置改为 RightTop 并排在「全局关系图」下面（见【18】）★
  ok("停靠位置是 RightTop（与全局关系图同一格）",
    (/DOCK_POSITION\s*=\s*["']RightTop["']/.test(idx) || /position\s*:\s*["']RightTop["']/.test(idx)) &&
    !/["']LeftBottom["']/.test(idx) && !/["']RightBottom["']/.test(idx));

  // 默认设置里有 favorites 字段
  ok("DEFAULT_SETTINGS 里有 favorites（数组）", /favorites\s*:\s*\[\s*\]/.test(idx));

  const ex = readNoCmt("src/explorer.js");
  ok("explorer.roots() 读 settings.favorites 做白名单",
    /settings\s*&&\s*this\.plugin\.settings\.favorites/.test(ex) ||
    /plugin\.settings\.favorites/.test(ex));
  ok("有 favorites 时**只**用 favorites（不再 fallback 到 sources/roots）",
    /if\s*\(\s*fav\s*&&\s*fav\.length\s*\)\s*\{[\s\S]{0,200}?return\s+fav\.map/.test(ex));

  const st = readNoCmt("src/settings.js");
  ok("设置面板有「常用文件夹」区", /secFavorites/.test(st));
  ok("设置面板有目录选择器 openDirPicker", /function\s+openDirPicker/.test(st));
  ok("目录选择器用 listDir 逐层钻取", /await\s+listDir\s*\(/.test(st));
  ok("保存时写入 settings.favorites", /settings\.favorites\s*=\s*favDraft/.test(st));

  // ★★ 2026-10-10 修正：选择器必须能切到别的挂载卷 ★★
  //   旧实现从 roots[0]（/vol1）起，`parentOf("/vol1")` = "" ⇒ 「上级」在卷根就禁用
  //   ⇒ 永远上不到 "/"，也就选不了 /vol00。现在从 "/" 起、卷根可上到 "/"。
  ok("★ 目录选择器从 \"/\" 起（能列出全部挂载卷）", /let\s+cur\s*=\s*["']\/["']/.test(st));
  ok("★ 「上级」在 \"/\" 才禁用（卷根可上到 /）",
    /upBtn\.disabled\s*=\s*isTop\s*\(\s*cur\s*\)/.test(st));
  ok("★ 卷根可上到 \"/\"（parentOf 兜底回 /）", /enter\s*\(\s*p\s*\|\|\s*["']\/["']\s*\)/.test(st));
  ok("★ 顶层有「选择存储空间」引导文案（pickVolumeHint）", /pickVolumeHint/.test(st));

  // ★★ 2026-10-10 第四轮：用户报「常用文件夹不能同时选择多个」★★
  //   旧实现是「点行进目录 + 单选确认即关闭」⇒ 想加第二个必须重新点开对话框。
  //   现在每行一个复选框、跨层累计、一次提交全部。
  ok("★ 选择器有多选集合 picked 数组", /const\s+picked\s*=\s*\[\]/.test(st));
  ok("★ 选择器每行有复选框", /CLS\s*\+\s*"-picker-box"/.test(st));
  ok("★ 提交时交回的是**数组**（多选）", /finish\s*\(\s*picked\.slice\(\)\s*\)/.test(st));
  ok("★ 复选框点选不触发进目录（stopPropagation）",
    /stopPropagation\(\)[\s\S]{0,200}?picked\.(push|splice)/.test(st));
  ok("★ 顶部有「已选 N 个」状态条", /CLS\s*\+\s*"-picker-selcount"/.test(st));
  ok("★ 有「清空选择」按钮", /picker-selclear/.test(st));
  ok("★ 回调新增项按数组处理（兼容多选）", /Array\.isArray\s*\(\s*pickedList\s*\)/.test(st));
  ok("★ 未勾选任何文件夹时不可提交", /pickBtn\.disabled\s*=\s*!\s*picked\.length/.test(st));

  // i18n 新 key
  const zh = JSON.parse(read("i18n/zh_CN.json"));
  const en = JSON.parse(read("i18n/en_US.json"));
  // ★ 2026-10-10 整理：编辑与缓存的 key 已从 i18n 里删掉，见下面的反向断言 ★
  // ★ 2026-10-10 整理：pickThis（单数）实测代码里一处都没引用 —— 选择器用的是
  //   pickThese。它和另外 5 个死键（loadingText / previewFailed / imageFailed /
  //   noPreview / noPreviewHint）一起从 i18n 删掉了，列表同步去掉。
  for (const k of ["secFavorites", "favorites", "addFolder", "goUp", "pickVolumeHint",
                   "pickThese", "togglePick", "selNone", "selCount", "clearSel"]) {
    ok(`i18n 有 ${k}（中英）`, k in zh && k in en);
  }
  for (const k of ["ooCache", "ooCacheDesc", "ooCacheStat", "ooCacheNA", "ooCacheDone",
                   "cleanNow", "cleaning", "allowEdit", "allowEditDesc", "rememberBase",
                   "rememberBaseDesc", "secEdit", "secAdvanced", "editInTab",
                   "switchToEdit", "switchToView"]) {
    ok(`★ i18n 不再有 ${k}（中英）`, !(k in zh) && !(k in en));
  }
}

console.log("\n【12.9】★ 2026-10-10 整理：OnlyOffice 缓存区已从设置面板删除");
{
  const st = readNoCmt("src/settings.js");
  // 它清的是**自研 OO 容器**的缓存目录；Office 换用飞牛官方「Office 文档」之后
  // 那条链路已不再被本插件调用 ⇒ 这项点了大概率只回"找不到缓存目录"，属僵尸项。
  // 后端接口 /api/oo-cache 本身保留（不占 UI，删它得重打整包），只是没人从面板调它。
  ok("★ 设置面板不再有 oo-cache 相关 UI", !/oo-cache/.test(st) && !/ooCache/.test(st));
  ok("★ 面板里也不再出现「立即清理」", !/cleanNow/.test(st));
  ok("没有误用 baseUrl()", !/baseUrl\s*\(/.test(st));
}

console.log("\n【12.10】★ 2026-10-10 整理：文件树默认收拢（不再记忆展开状态）");
{
  const exp = readNoCmt("src/explorer.js");
  const ctor = (exp.match(/constructor\([\s\S]*?\n  \}/) || [""])[0];
  ok("取到了 Explorer 的构造函数（探针有效）", ctor.length > 100);
  ok("★ 构造函数里 expanded 从**空集**起步（不读 plugin.expandedPaths）",
    /this\.expanded\s*=\s*new\s+Set\(\s*\)/.test(ctor) && !/expandedPaths/.test(ctor),
    ctor.slice(0, 140));
  // 不写回 ⇒ 下次打开面板就是收拢的（写回的目的本来就是"下次恢复"）
  ok("★ 整个 explorer.js 里已经没有 expandedPaths 这个字段名",
    !/expandedPaths/.test(exp));
  ok("★ destroy 里不再把展开状态写回 plugin",
    !/plugin\.expandedPaths\s*=/.test(exp));
  const idx = readNoCmt("index.js");
  ok("★ index.js 也不再初始化 this.expandedPaths", !/this\.expandedPaths\s*=/.test(idx));
  // ⚠️ setExpanded 里用的是闭包捕获的 self，写成 this.expanded 会恒不匹配
  ok("★ 展开状态仍在**本次会话内**生效（expanded.add / delete 还在）",
    /self\.expanded\.add\(/.test(exp) && /self\.expanded\.delete\(/.test(exp));
  // 真机实测：只把构造函数改成空集还不够 —— 根节点渲染完会被强制展开一次
  // （`if (isRoot) setTimeout(() => setExpanded(true), 0)`），于是"打开就看到
  //  卷名 + 一层子目录"。这条断言就是防它被加回来。
  ok("★ 根节点不再自动展开（isRoot ⇒ setExpanded 的写法已删）",
    !/if\s*\(\s*isRoot\s*\)\s*setTimeout\(\s*\(\s*\)\s*=>\s*setExpanded\(/.test(exp));
  ok("★ 也没有别的「渲染后自动展开根」写法",
    !/setExpanded\(true\)\s*,\s*0\s*\)/.test(exp));
}

console.log("\n【12.11】★ 2026-10-10 整理：设置入口唯一（思源原生 Setting 已删）");
{
  const idx = readNoCmt("index.js");
  ok("★ 不再实例化思源的 Setting", !/new\s+Setting\s*\(/.test(idx) && !/this\.setting\s*=/.test(idx));
  const raw = readFileSync(join(ROOT, "index.js"), "utf8");
  ok("★ 也不再从 siyuan 导入 Setting",
    !/import\s*\{[^}]*\bSetting\b[^}]*\}\s*from\s*["']siyuan["']/.test(raw));
  // 自绘面板的入口（文件树顶部齿轮）必须还在 —— 删了原生面板不能把唯一入口也带走
  ok("★ 自绘设置面板的入口仍在（文件树齿轮 → plugin.openSettings）",
    /openSettings\(/.test(readNoCmt("src/explorer.js")) &&
    /openSettings\s*\(\s*onSaved\s*\)/.test(idx));
  ok("★ 设置面板仍保留四块里的三块（服务地址 / 飞牛登录态 / 常用文件夹）",
    /secServer/.test(readNoCmt("src/settings.js")) &&
    /secFnosCred/.test(readNoCmt("src/settings.js")) &&
    /secFavorites/.test(readNoCmt("src/settings.js")));
  ok("★ 设置面板的 toggle() 构造器已删（两个开关都没了）",
    !/function\s+toggle\s*\(/.test(readNoCmt("src/settings.js")));
  const ds = (idx.match(/const DEFAULT_SETTINGS = \{[\s\S]*?\n\};/) || [""])[0];
  ok("取到了 DEFAULT_SETTINGS 块（探针有效）", ds.length > 40);
  ok("★ DEFAULT_SETTINGS 不再有 allowEdit / rememberBase",
    !/allowEdit/.test(ds) && !/rememberBase/.test(ds));
}

console.log("\n【12.12】★ 2026-10-10：桌面端飞牛登录态改走「同源同步页」");
// 背景：桌面端的内核在 127.0.0.1，跨源 fetch 既带不到 NAS 的飞牛 Cookie，
//       又会因为 local-fs 的 _cors() 没回 Access-Control-Allow-Credentials
//       被浏览器直接拦成"连不上"（把真正的原因盖住）。
// ⇒ 后端加了一个同源页 /localfs/cred-sync，插件在桌面端只负责 window.open 它。
{
  const api = readNoCmt("src/api.js");
  const st = readNoCmt("src/settings.js");

  ok("api.js 导出 fnosCredPageUrl / fnosCredSameOrigin",
    /export function fnosCredPageUrl\(/.test(api) &&
    /export function fnosCredSameOrigin\(/.test(api));
  ok("同步页地址拼 /cred-sync（路径要与后端 local-fs.py 的路由一致）",
    /credUrl\(\s*"\/cred-sync"\s*\)/.test(api));
  ok("凭据接口仍拼 /api/fnos-cred",
    /credUrl\(\s*"\/api\/fnos-cred"\s*\)/.test(api));
  ok("★ 跨源不再硬发 credentials include（那只会被 CORS 拦成\"连不上\"）",
    /fnosCredSameOrigin\(\)\s*\?\s*"include"\s*:\s*"omit"/.test(api));

  ok("设置面板按同源分流：跨源时打开同步页",
    /fnosCredPageUrl\(\)/.test(st) && /window\.open\(\s*page\s*,/.test(st));
  ok("★ 轮询要看面板是否已被关掉（credOut.isConnected），别让死循环一直跑",
    /credOut\.isConnected/.test(st));
  // 只切出「跨源分支」那一段来断言 —— 用代码标记切，别用注释标记
  // （readNoCmt 会把注释删掉）。跨源那支是 if (!credSame) { … 到 credWaitTimeout 结束；
  //  同源那支紧跟其后，第一句就是 plugin.t("credSyncing")。）
  const cross = st.slice(st.indexOf("if (!credSame)"), st.indexOf("credWaitTimeout"));
  ok("取到了跨源分支那一段（探针有效）",
    cross.length > 200 && cross.indexOf("window.open") > 0);
  ok("★ 跨源分支里绝不直接 POST 凭据（它根本发不出去）",
    cross.indexOf("fnosCredSync()") < 0);
  ok("跨源分支里没再写 credentials include（判定统一在 api.js）",
    cross.indexOf('credentials: "include"') < 0);
  ok("★ window.open 的返回值要看（被弹窗拦截时不能只说\"已打开\"）",
    /w\s*=\s*window\.open\(/.test(cross) && /credPopupBlocked/.test(cross));
  ok("按钮文案按场景分（同步飞牛登录态 / 在浏览器中同步）",
    /syncFnosCredBrowser/.test(st));
}

console.log("\n【12.13】★ 2026-10-10：状态只占一行 + 探活不再认错人（fnos-file-viewer）");
// 背景（用户原话）：
//   「http://192.168.193.70:6806　·　fnos-file-viewer 1.0.3　·　0 个存储空间
//     这个地方填入新地址时会显示2排，看不明白，显示一排才是对的。
//     上面显示的信息应该不对吧。」
//   两件事：
//     ① 面板上原来有**两个**元素会说状态（测试结果行 + 当前状态行）⇒ 测一下就两排；
//     ② 探活只判 ok:true，而反代把根绝对的 /api/*、/health 划给了「文件预览」，
//        于是裸根上的 fnos-file-viewer 被当成了「本机存储」。
{
  const st = readNoCmt("src/settings.js");
  const api = readNoCmt("src/api.js");

  ok("★ 状态与测试结果合成一个元素（不再有 testOut / infoVal 两个）",
    !/testOut/.test(st) && !/infoVal/.test(st));
  ok("★ 服务地址那一节只有一个 is-inline 状态行",
    /const testRow = el\("div", CLS \+ "-form-row is-inline"\)/.test(st) &&
    /const stat = el\("span"/.test(st));
  // 状态行只回答"连到哪、看得到几个存储空间"，不再堆 app 名与版本号
  const rs = st.slice(st.indexOf("const renderStatus"), st.indexOf("renderStatus()"));
  ok("取到了 renderStatus 这一段（探针有效）", rs.length > 100 && rs.indexOf("getBase()") > 0);
  ok("★ 状态行不再显示 app 名 / 版本号（就是那行看不懂的来源）",
    !/h\.app/.test(rs) && !/h\.version/.test(rs) && !/\.app\b/.test(rs));

  ok("★ api.js 导出 APP_ID 且认死 siyuan-local-fs",
    /export const APP_ID = "siyuan-local-fs"/.test(api));
  ok("★ probeBase 校验身份（只判 ok 就会认错人）",
    /j\.app === APP_ID/.test(api));
  ok("probeRaw 保留（用来区分\"连不上\"与\"连上了但是别的应用\"）",
    /export async function probeRaw\(/.test(api));

  ok("★ 面板失败时报出\"那是谁\"（probeRaw + wrongApp）",
    /probeRaw\(/.test(st) && /wrongApp/.test(st));
  ok("面板不再笼统地说\"连不上\"就完事（两种失败分开说）",
    /connectFailed/.test(st) && /wrongAppHint/.test(st));

  const zh = read("i18n/zh_CN.json");
  const en = read("i18n/en_US.json");
  ok("i18n 中英都有 wrongApp / wrongAppHint",
    /"wrongApp"/.test(zh) && /"wrongAppHint"/.test(zh) &&
    /"wrongApp"/.test(en) && /"wrongAppHint"/.test(en));
}

console.log("\n【13】需求 #2：顶栏「本机存储」按钮已去除");
{
  const idx = readNoCmt("index.js");
  ok("不再调用 addTopBar", !/addTopBar\s*\(/.test(idx));
  ok("侧边栏停靠仍在（addDock 没被误删）", /addDock\s*\(/.test(idx));
  ok("命令入口仍在（addCommand openLocalStorage）", /langKey\s*:\s*"openLocalStorage"/.test(idx));
}

console.log("\n【14】需求 #3/#4/#5：嵌入块只看内容，查看器外壳全藏");
{
  const em = readNoCmt("src/embed.js");
  ok("renderIframe 接收 kind（决定藏哪一层）", /function\s+renderIframe\s*\(\s*ctx\s*,\s*url\s*,\s*kind\s*\)/.test(em));
  ok("调用处把 kind 传下去", /renderIframe\s*\(\s*ctx\s*,\s*url\s*,\s*kind\s*\)/.test(em));
  ok("CAD → 注入 purifyCadViewer", /purifyCadViewer/.test(em));
  ok("其余 → 注入 purifyFileViewer", /purifyFileViewer/.test(em));
  ok("★ Office → 也注入 purifyOffice（2026-10-10 起三条链路全同源）",
    /purifyOffice/.test(em));
  ok("块收起 / 出错时清理重钉定时器", /clearBareTimers/.test(em));

  // purify.js 的三套藏法
  const pu = readNoCmt("src/purify.js");
  ok("purify 藏 file-viewer 的 #sidebar", /#sidebar\{display:none/.test(pu));
  ok("purify 藏 file-viewer 的 #topbar", /#topbar\{display:none/.test(pu));
  ok("purify 藏 CAD 的 .ml-cad-header（顶部 ribbon 工具区）",
    /\.ml-cad-header\{display:none/.test(pu));
  ok("purify 藏 CAD 的底部状态栏 .ml-status-bar（实测真名，不是 .ml-cad-footer）",
    /\.ml-status-bar\{display:none/.test(pu));
  ok("purify 藏 CAD 的命令行 .ml-cli-container（用户补充反馈）",
    /\.ml-cli-container\{display:none/.test(pu));
  ok("purify 藏 CAD 的右侧工具条 .ml-ex-ui-toolbar（用户补充反馈）",
    /\.ml-ex-ui-toolbar\{display:none/.test(pu));
  ok("purify 藏 CAD 的右侧工具条宿主 .ml-vertical-toolbar-host",
    /\.ml-vertical-toolbar-host\{display:none/.test(pu));
  ok("purify 藏 CAD 的右侧顶部工具条 .ml-ui-shortcut-toolbar-shell（用户补充反馈）",
    /\.ml-ui-shortcut-toolbar-shell\{display:none/.test(pu));
  ok("CAD 的 --ml-header-height 归零（否则藏了 header 仍留白）",
    /--ml-header-height\s*:\s*0px/.test(pu));
  ok("CAD 的 --ml-status-bar-height 归零", /--ml-status-bar-height\s*:\s*0px/.test(pu));
}

console.log("\n【15】需求 #6/#7 + #3.1：页签只净化 file-viewer，CAD 要完整工具栏");
{
  const tv = readNoCmt("src/tabview.js");
  // ★ 需求 3.1：页签传 "fv" 而不是 true ★
  //   传 true 会把 CAD 的工具栏也剥掉 —— 用户报"页签里的 CAD 和嵌入块一样了"。
  ok("页签视图用 bare:\"fv\"（只净化 file-viewer，CAD/Office 保留工具栏）",
    /bare\s*:\s*["']fv["']/.test(tv) && !/bare\s*:\s*true/.test(tv));

  const fv = readNoCmt("src/fileview.js");
  ok("full / fvOnly 用严格相等判定（不是真值判定）",
    /const\s+full\s*=\s*this\.bare\s*===\s*true/.test(fv) &&
    /const\s+fvOnly\s*=\s*this\.bare\s*===\s*["']fv["']/.test(fv));
  ok("全净化（嵌入块）才给 CAD 加 cad-bare", /full\s*\?\s*["']cad-bare["']/.test(fv));
  ok("file-viewer 链路在 bare 或 fv-only 时都净化（fileviewer-bare）", /fileviewer-bare/.test(fv));
  ok("Office 链路把 full（== true）透传进 officeUrl", /officeUrl\s*\([^)]*full\s*\)/.test(fv));
  ok("★ Office 只在 full（嵌入块）时才净化，页签（\"fv\"）必须留工具栏",
    /full\s*\?\s*["']office-bare["']\s*:\s*["']["']/.test(fv));
  ok("净化逻辑抽到 purify.js，不再内联一大段 CSS",
    /from\s*"\.\/purify"/.test(fv) && !/#sidebar\{display\s*:\s*none\s*!important/.test(fv));

  const api = readNoCmt("src/api.js");
  ok("★ officeUrl 不再往 URL 上拼 bare（官方那套不认任何模式参数）",
    // 签名保留（调用点没改），但**不能再出现 p.set("bare"…**
    // 净化改成同源注入样式（purifyOffice），见 purify.js。
    /officeUrl\s*\([^)]*bare\s*\)/.test(api) && !/\.set\(\s*["']bare["']/.test(api));
}

console.log("\n【16】预览浮层：贴顶 + 上下导航 + 可折叠操作条（配套 UI）");
{
  const pv = readNoCmt("src/preview.js");
  ok("modal 带 is-flush（贴顶）", /is-flush/.test(pv));
  ok("有导航条 .lfs-navbar", /-navbar/.test(pv));
  ok("翻页前先 validateOpen（邻居可能已被删）", /validateOpen\s*\(/.test(pv));
  ok("操作条可折叠（记住偏好）", /lfs\.preview\.toolsCollapsed/.test(pv));

  const css = stripComments(read("index.css"));
  for (const sel of [".lfs-navbar", ".lfs-nav-btn", ".lfs-nav-label", ".lfs-dlg-body",
                     ".lfs-fav-chip", ".lfs-picker-list", ".lfs-modal.is-bar-collapsed"]) {
    // 选择器可能是单条（…{ 或 …）或成组（…,）；只要它出现在选择器位就算有
    ok(`有样式 ${sel}`, new RegExp(sel.replace(/\./g, "\\.") + "\\s*(?:[,>{]|\\{)").test(css));
  }
  ok("i18n 有翻页/折叠文案（中英）",
    "prevFile" in JSON.parse(read("i18n/zh_CN.json")) &&
    "nextFile" in JSON.parse(read("i18n/en_US.json")));

  const bl = read("tools/build.js");
  ok("build.js MODULES 收录 src/purify.js", /"src\/purify\.js"/.test(bl));
  ok("build.js MODULES 收录 src/dialog.js", /"src\/dialog\.js"/.test(bl));
}

console.log("\n【17】需求 #8：页签只留两层（工具条 + 内容区），复制路径改成图标");
{
  const tv = read("src/tabview.js");
  const tvN = stripComments(tv);
  ok("不再创建信息条 .lfs-tab-info", !/-tab-info/.test(tvN));
  ok("不再有 .lfs-tab-crumb / .lfs-tab-chip", !/lfs-tab-crumb|lfs-tab-chip/.test(tvN));
  ok("只 append 两层（bar + body）",
    /appendChild\(bar\)/.test(tvN) && !/appendChild\(info\)/.test(tvN));
  ok("「复制路径」改成工具条图标按钮（ICON_COPY）", /ICON_COPY/.test(tvN));
  ok("复制路径仍挂在工具条上", /mk\(ICON_COPY/.test(tvN));
  ok("路径信息没丢：挂到标题的 title 上", /title\.title\s*=/.test(tvN));
  ok("下载走 plugin.downloadNode（带体检，与别处一致）",
    /plugin\.downloadNode/.test(tvN) && !/downloadFile\s*\(/.test(tvN));

  // 图标本身
  const ic = readNoCmt("src/icons.js");
  ok("icons.js 定义了 ICON_COPY", /export\s+const\s+ICON_COPY\s*=/.test(ic));
  ok("icons.js 导出里没有重复的 ICON 名", (() => {
    const names = [...ic.matchAll(/export\s+const\s+(ICON_[A-Z0-9_]+)\s*=/g)].map((m) => m[1]);
    return new Set(names).size === names.length;
  })());

  // CSS 里那层外壳的规则应当已被清掉（留着会误导后人）
  const css = stripComments(read("index.css"));
  ok("CSS 不再有 .lfs-tab-info 规则", !/\.lfs-tab-info\s*\{/.test(css));
  ok("CSS 不再有 .lfs-tab-crumb / -chip 规则",
    !/\.lfs-tab-crumb\s*\{/.test(css) && !/\.lfs-tab-chip\s*\{/.test(css));
}

console.log("\n【18】需求 #1.1：dock 放右边 + 网盘图标 + 搬 DOM 持久化");
{
  const idx = readNoCmt("index.js");
  // ★ 2026-10-10 第三轮：用户要求「插件按钮放到**全局关系图**下边」
  //   ⇒ 进 RightTop（全局关系图所在格）并插到 globalGraph 之后。
  ok("DOCK_POSITION = RightTop（全局关系图所在的上半格）", /DOCK_POSITION\s*=\s*["']RightTop["']/.test(idx));
  ok("★ 排序锚点 DOCK_AFTER_TYPE = globalGraph（不是 graph 局部关系图）",
    /DOCK_AFTER_TYPE\s*=\s*["']globalGraph["']/.test(idx));
  ok("addDock 的 position 用 DOCK_POSITION 常量", /position\s*:\s*DOCK_POSITION/.test(idx));

  // ★★ 核心：搬 DOM（两轮排查的最终结论）★★
  //   思源以运行时 DOM 为准；storage(local-plugin-docks) 与 conf.json(uiLayout)
  //   都是它的下游，改了会被反写回去。唯一可靠 = 搬 .dock__item + saveLocalPlugin。
  ok("有 _ensureDockSide() 方法", /_ensureDockSide\s*\(\s*\)\s*\{/.test(idx));
  ok("onload 里调用了 _ensureDockSide()", /this\._ensureDockSide\s*\(\s*\)/.test(idx));
  ok("★ 找到我们的 .dock__item（按 data-type 后缀）",
    /querySelector\s*\(\s*sel\s*\)/.test(idx) && /data-type\$=/.test(idx) && /DOCK_TYPE/.test(idx));
  ok("★ 右侧容器用 document.getElementById(\"dockRight\")",
    /getElementById\s*\(\s*["']dockRight["']\s*\)/.test(idx));
  ok("★ 定位锚点项 '[data-type=\"globalGraph\"]'",
    /querySelector\s*\(\s*["']\[data-type="\s*'\s*\+\s*DOCK_AFTER_TYPE|data-type=.{0,6}DOCK_AFTER_TYPE/.test(idx) &&
    /DOCK_AFTER_TYPE/.test(idx));
  ok("★ 锚点格 = 关系图所在那一格（graphItem.closest('.dock__items')）",
    /closest\s*\(\s*["']\.dock__items["']\s*\)/.test(idx));
  ok("★ 已在锚点正下方则幂等返回（不打断用户拖动）",
    /nextElementSibling\s*===\s*item[\s\S]{0,60}return/.test(idx));
  ok("★ 落位：插到关系图**后面**（graphItem.after(item)）",
    /graphItem\.after\s*\(\s*item\s*\)/.test(idx));
  ok("★ 兜底：没有关系图时 append 到该格末尾",
    /target\.appendChild\s*\(\s*item\s*\)/.test(idx));
  ok("★ 用 rightDock.saveLocalPlugin 固化位置",
    /saveLocalPlugin\s*\(\s*FULL_TYPE\s*,\s*\{\s*position\s*:\s*DOCK_POSITION\s*\}\s*\)/.test(idx));
  ok("FULL_TYPE 是 pluginDir + type 拼法",
    /FULL_TYPE\s*=\s*"siyuan-localfs"\s*\+\s*DOCK_TYPE/.test(idx));
  ok("搬运失败只 warn，不抛（不能让 onload 挂掉）",
    /_ensureDockSide 异常[\s\S]{0,40}console\.warn|console\.warn[\s\S]{0,200}_ensureDockSide 异常/.test(idx));
  ok("移动端不做（mobileOnly 守卫）", /!\s*this\.mobileOnly[\s\S]{0,80}_ensureDockSide/.test(idx));

  // ★★ 图标：必须走「注册 symbol + 传符号 id」，与网盘插件同款 ★★
  //   参考 siyuan-nebuladisk：addIcons(CUSTOM_ICONS) + config.icon="iconNebulaDisk"。
  //   先前传内联 <svg>…</svg> 字符串 ⇒ 内核当 id 查符号、查不到 ⇒ 图标空白。
  const ic = readNoCmt("src/icons.js");
  ok("★ 定义了停靠图标的 symbol（SYMBOL_DOCK，id=iconLocalfsDock）",
    /export\s+const\s+SYMBOL_DOCK\b/.test(ic) && /symbol\s+id="iconLocalfsDock"/.test(ic));
  ok("★ 导出图标符号 id 常量 DOCK_ICON_ID",
    /export\s+const\s+DOCK_ICON_ID\s*=\s*["']iconLocalfsDock["']/.test(ic));
  ok("★ SYMBOLS_ALL 把页签符号与停靠符号一起注册",
    /SYMBOLS_ALL\s*=\s*SYMBOL_LOCALFS\s*\+\s*SYMBOL_DOCK/.test(ic));
  ok("★ 停靠图形是「硬盘」语义（盘体圆角矩形 + 分隔线 + 指示灯）",
    /<rect\s+x="4"\s+y="8"\s+width="24"\s+height="16"\s+rx="3\.2"/.test(ic) &&
    /M4\s+18\.2h24/.test(ic) && /<circle\s+cx="22"\s+cy="21\.2"/.test(ic));
  ok("★ 停靠图形 viewBox 32×32（图形不顶边，18px 下不被切）",
    /symbol\s+id="iconLocalfsDock"\s+viewBox="0 0 32 32"/.test(ic));
  ok("停靠图形不跟主题色乱跑（用 currentColor）", /stroke="currentColor"/.test(ic));
  // ★ 只在 SYMBOL_DOCK 区块里判"不再用云+箭头"（ICON_DOCK 是遗留样例，不影响停靠项）
  const dockSym = (ic.match(/export\s+const\s+SYMBOL_DOCK\s*=([\s\S]*?);\s*\n/) || [])[1] || "";
  ok("★ SYMBOL_DOCK 不再用旧版的「云 + 箭头」（会糊、且箭头方向被读成上传）",
    !/M7\.2\s+18\.5A4\.2/.test(dockSym) && !/M12\s+11\.4v7\.2/.test(dockSym));

  // index.js：注册 + 传 id（而不是内联 SVG）
  ok("★ addIcons 注册的是 SYMBOLS_ALL（含停靠符号）",
    /this\.addIcons\s*\(\s*SYMBOLS_ALL\s*\)/.test(idx));
  ok("★ addDock 的 config.icon 传 DOCK_ICON_ID（符号 id，非内联 SVG）",
    /icon\s*:\s*DOCK_ICON_ID/.test(idx));
  ok("★ addDock 不再把内联 SVG 当 icon（ICON_DOCK 已从 dock 配置移除）",
    !/icon\s*:\s*ICON_DOCK/.test(idx));
  ok("★ config.show 显式给 false（否则侧栏图标挂不上去）",
    /show\s*:\s*false/.test(idx));
  ok("添加了 hotkey 字段（与网盘插件同款 config 形状）", /hotkey\s*:/.test(idx));
}

console.log("\n【19】需求 #1.2：常用文件夹 —— 空 = 全部，填了 = 只显示这几个");
{
  const ex = readNoCmt("src/explorer.js");
  ok("roots() 优先读 settings.favorites", /settings\.favorites/.test(ex));
  ok("favorites 非空时只返回这几个（白名单语义）",
    /fav\s*&&\s*fav\.length[\s\S]{0,160}?return\s+fav\.map/.test(ex));
  ok("状态栏反映**实际显示的根数**（不是本机存储空间总数）",
    /this\.roots\(\)\.length/.test(ex) && /favSuffix/.test(ex));

  const st = readNoCmt("src/settings.js");
  ok("设置面板有「常用文件夹」区", /secFavorites/.test(st));
  ok("保存时把草稿写进 settings.favorites", /settings\.favorites\s*=\s*favDraft/.test(st));
  ok("有目录选择器 openDirPicker", /function\s+openDirPicker/.test(st));
  ok("explorer 打开设置时传 onSaved → reloadAll（保存后立刻重画侧栏）",
    /openSettings\s*\(\s*\(\)\s*=>\s*this\.reloadAll\(\)\s*\)/.test(ex));

  const zh = read("i18n/zh_CN.json");
  const en = read("i18n/en_US.json");
  ok("i18n 有 secFavorites/favoritesEmpty/addFolder（中英）",
    /"secFavorites"/.test(zh) && /"favoritesEmpty"/.test(zh) && /"addFolder"/.test(zh) &&
    /"secFavorites"/.test(en) && /"favoritesEmpty"/.test(en) && /"addFolder"/.test(en));
  ok("i18n 有 favSuffix（状态栏「N 个常用文件夹」）",
    /"favSuffix"/.test(zh) && /"favSuffix"/.test(en));
}

console.log("\n【20】需求 #3.1 / #3.3：嵌入块 CAD 藏全，页签 CAD 保留工具栏");
{
  const pu = readNoCmt("src/purify.js");
  // CAD 的三个"新发现"容器（实测枚举出来的真名）
  ok("CAD 藏命令行 .ml-cli-*", /\.ml-cli-container\{display:none/.test(pu) ||
    /\.ml-cli-bar\{display:none/.test(pu));
  ok("CAD 藏右侧工具条 .ml-ex-ui-toolbar-host / -toolbar",
    /\.ml-ex-ui-toolbar\{display:none/.test(pu));
  ok("CAD 藏右侧顶部工具条 .ml-ui-shortcut-toolbar-shell",
    /\.ml-ui-shortcut-toolbar-shell\{display:none/.test(pu));
  ok("CAD 画布本体四条边都钉死（不只 top/bottom）",
    /\.ml-cad-main\{[^}]*left:0\s*!important/.test(pu) ||
    /\.ml-cad-main\{[^}]*right:0\s*!important/.test(pu));

  const fv = readNoCmt("src/fileview.js");
  ok("页签（bare=\"fv\"）时 CAD 不净化：cad-bare 只在 full 时给",
    /full\s*\?\s*["']cad-bare["']\s*:\s*["']["']/.test(fv));
}

console.log("\n【21】需求 #3.2：Office/PDF 归「飞牛官方 Office文档」那条链路");
{
  const k = readNoCmt("src/kinds.js");
  // ★ 2026-10-10 整理：canToggleEdit 已删除 ★
  //   没有"编辑概念"可切了 —— 官方那套按文件写权限决定模式，插件说了不算。
  ok("★ canToggleEdit 已从 kinds.js 删除，且三个调用点都清干净",
    !/export\s+function\s+canToggleEdit/.test(k) &&
    !/canToggleEdit/.test(readNoCmt("src/explorer.js")) &&
    !/canToggleEdit/.test(readNoCmt("src/preview.js")) &&
    !/canToggleEdit/.test(readNoCmt("src/tabview.js")) &&
    !/canToggleEdit/.test(readNoCmt("index.js")));
  ok("PDF 归 OFFICE 渲染器（官方那套自带 PDF 阅读器）",
    /\[KIND\.PDF\]:\s*RENDERER\.OFFICE/.test(k));
  ok("kinds.js 导出 rendererOf / RENDERER / externalUrlOf",
    /export\s+function\s+rendererOf\b/.test(k) &&
    /export\s+const\s+RENDERER\b/.test(k) &&
    /export\s+function\s+externalUrlOf\b/.test(k));

  // ★ 这里必须做**行为**断言，不能只正则 ★
  //   "集合扩没扩""有没有把 text/markdown 抢走"这两件事，只有真的跑一遍
  //   kindOf / rendererOf 才说得准 —— 正则看不出 MAP 的**覆盖顺序**。
  if (!kinds) {
    ok("kinds.js 可被当 ESM 载入（行为断言的前提）", false);
  } else {
    const { kindOf, kindOfName, rendererOfPath, rendererOf, RENDERER } = kinds;
    // 官方 fileTypes 里的新格式要落到 office
    ["wps", "wpt", "et", "ett", "dps", "dpt", "epub", "fb2", "numbers", "pages",
     "key", "hwp", "djvu", "oform", "vsdx", "xps"].forEach((e) => {
      ok("Office 集合含 ." + e, kindOf("a." + e) === "office", kindOf("a." + e));
    });
    ok("大写后缀同样认（NAS 上 .WPS/.DOCX 很常见）",
      kindOf("X.WPS") === "office" && kindOfName("X.ET") === "office");
    // ★ 反向：官方清单里有、但我们**刻意**留给 native 的那几个 ★
    //   它们在思源侧有更干净的渲染（<pre> 直看源码），不该被 Office 抢走。
    ["md", "txt", "xml", "html", "htm", "csv"].forEach((e) => {
      const kk = kindOf("a." + e);
      ok("★ ." + e + " 仍归 native（没被 Office 抢走）",
        kk !== "office" && kk !== "other" &&
        rendererOf(kk) === RENDERER.NATIVE, kk);
    });
    // 其余链路的归属没被带偏
    ok("CAD / 压缩包 / 图片 的归属没变",
      rendererOfPath("a.dwg") === "cad" &&
      rendererOfPath("a.zip") === "fileviewer" &&
      rendererOfPath("a.png") === "native");
    ok("PDF → office 渲染器", rendererOfPath("a.pdf") === "office");
  }
}

console.log("\n【22】需求 #3.3：图片/音视频/文本改由思源（浏览器原生）渲染");
{
  const fv = readNoCmt("src/fileview.js");
  ok("有 _native 渲染方法", /_native\s*\(\s*item\s*,\s*kind\s*\)\s*\{/.test(fv));
  ok("图片用 <img> 且失败有兜底", /createElement\(\s*["']img["']\s*\)/.test(fv) && /imgFailed/.test(fv));
  ok("音频用 <audio controls>", /createElement\(\s*["']audio["']\s*\)/.test(fv) && /\.controls\s*=\s*true/.test(fv));
  ok("视频用 <video controls playsinline>",
    /createElement\(\s*["']video["']\s*\)/.test(fv) && /playsinline/.test(fv));
  ok("文本用 <pre> 等宽显示", /native-text-pre/.test(fv));
  ok("原生链路不吃 bare（没有 iframe 可净化）", !/native-bare/.test(fv));

  const em = readNoCmt("src/embed.js");
  ok("嵌入块也有原生分支 renderNativeInto", /function\s+renderNativeInto/.test(em));
  ok("嵌入块 resolveUrl 对原生链路返回 null（调用方据此分流）",
    /RENDERER\.NATIVE\)\s*return\s+null/.test(em));
  ok("嵌入块 renderIframe 用 rendererOf 判跨源（PDF 也归 OFFICE）",
    /rendererOf\s*\(\s*kind\s*\)/.test(em));

  const css = stripComments(read("index.css"));
  ok("CSS 有 .lfs-native-img / -video / -audio / -text-pre",
    /\.lfs-native-img\s*\{/.test(css) && /\.lfs-native-video\s*\{/.test(css) &&
    /\.lfs-native-audio\s*\{/.test(css) && /\.lfs-native-text-pre\s*\{/.test(css));
}

/* ---------------------------------------------------------------------------
 * 【23】2026-10-10 三条改动（嵌入块按钮改图标 / 新增「在网页打开」/ 浏览器打开默认编辑）
 * --------------------------------------------------------------------------
 * 这几条同样属于"坏了也不报错"那一类：
 *   · makeTool 的参数顺序被改回 (label, …) ⇒ 图标参数落到 title 上，
 *     按钮变成**一排空白方块**（svg 不在了，console 干净）；
 *   · mode 写死回 "view" ⇒ 用户点「在浏览器中打开」进去还是只读，
 *     要再点一次"编辑"，而"默认编辑"这条需求就静默失效了。
 */
{
  console.log("\n【23】嵌入块按钮改图标 + 新增「在网页打开」+ 浏览器打开默认编辑");

  const em = readNoCmt("src/embed.js");
  ok("makeTool 签名改成 (icon, label, onClick)（与 tabview 的 mk 对齐）",
    /function\s+makeTool\(\s*icon\s*,\s*label\s*,\s*onClick\s*\)/.test(em));
  ok("makeTool 把图标塞进 innerHTML，文案挂 title + aria-label",
    /b\.innerHTML\s*=\s*icon/.test(em) && /b\.title\s*=\s*label/.test(em) &&
    /setAttribute\(\s*["']aria-label["']\s*,\s*label\s*\)/.test(em));
  ok("图标按钮不再带 is-ghost（那个类已从 CSS 删掉）", !/is-ghost/.test(em));
  ok("文件块 5 个工具全用图标常量",
    /makeTool\(\s*ICON_COLLAPSE/.test(em) && /makeTool\(\s*ICON_TAB/.test(em) &&
    /makeTool\(\s*ICON_EXTERNAL/.test(em) && /makeTool\(\s*ICON_DOWNLOAD/.test(em) &&
    /makeTool\(\s*ICON_COPY/.test(em));
  ok("目录块的上级 / 刷新也用图标",
    /makeTool\(\s*ICON_UP/.test(em) && /makeTool\(\s*ICON_REFRESH/.test(em));
  ok("新增「在网页打开」：走统一路由 externalUrlOf + window.open",
    /openInWeb/.test(em) && /externalUrlOf\s*\(/.test(em) && /window\.open\(\s*url/.test(em));
  ok("嵌入块里内嵌的 Office 仍按「只读意图」（mode 传 view）打开",
    // ⚠️ 只是**意图** —— 飞牛官方那套的编辑页按文件写权限自己决定模式，
    //    不接受 mode/layout/bare 任何参数（实测 editor.html 无 location.search 用法）。
    /officeUrl\(\s*path\s*,\s*["']view["']/.test(em));

  // ★ 必须锚 `linkOf(node) {`（带左花括号）★
  //   不带的话会先匹配到 openInBrowser 里那句**调用** `this.linkOf(node);`，
  //   取到的函数体是错的 —— 断言看着"失败"，其实是被自己的正则骗了。
  const linkOfBody = (readNoCmt("index.js").match(/linkOf\(\s*node\s*\)\s*\{[\s\S]*?\n  \}/) || [""])[0];
  // ★ 2026-10-10 整理：allowEdit 已从**所有**链路下线 ★
  //   Office / PDF 的可读可写由飞牛官方应用按**文件自身写权限**决定，
  //   插件传的 mode 它根本不看 ⇒ 三处调用点都改成恒 view（或干脆不传）。
  ok("★ index.js linkOf：mode 恒 view（allowEdit 已删）",
    /mode:\s*["']view["']/.test(linkOfBody) && !/allowEdit/.test(linkOfBody),
    linkOfBody.slice(0, 90));
  ok("★ tabview.js 不再有 allowEdit", !/allowEdit/.test(readNoCmt("src/tabview.js")));
  ok("★ preview.js 不再有 allowEdit", !/allowEdit/.test(readNoCmt("src/preview.js")));
  ok("★ embed.js 不再有 allowEdit", !/allowEdit/.test(readNoCmt("src/embed.js")));
  ok("★ index.js 的 allowEdit() 方法已删", !/allowEdit\s*\(\s*\)\s*\{/.test(readNoCmt("index.js")));
  ok("★ 设置面板不再渲染「允许在线编辑 Office 文档」",
    !/allowEdit/.test(readNoCmt("src/settings.js")));

  const ic = readNoCmt("src/icons.js");
  const dlBody = (ic.match(/ICON_DOWNLOAD\s*=[\s\S]*?;/) || [""])[0];
  ok("ICON_DOWNLOAD 已重画成「托盘 + 向下箭头」",
    /M4\.6 15\.3/.test(dlBody) && /A2 2 0 0 0/.test(dlBody), dlBody.slice(0, 70));
  ok("ICON_DOWNLOAD 不再有那根通长横线 M4.5 19.5h15", !/M4\.5 19\.5h15/.test(dlBody));

  const css2 = stripComments(read("index.css"));
  ok("CSS：.lfs-embed-btn 是 24px 图标按钮（不是原来的文字按钮）",
    /\.lfs-embed-btn\s*\{[\s\S]{0,240}width:\s*24px[\s\S]{0,140}height:\s*24px/.test(css2) &&
    !/\.lfs-embed-btn\s*\{[\s\S]{0,240}padding:\s*2px 7px/.test(css2));
  ok("CSS：.lfs-embed-btn 里有 svg 尺寸规则（否则图标会撑满按钮）",
    /\.lfs-embed-btn\s+svg\s*\{/.test(css2));
  ok("CSS：.lfs-embed-btn.is-ghost 规则已删除", !/\.lfs-embed-btn\.is-ghost/.test(css2));

  const zh = JSON.parse(read("i18n/zh_CN.json"));
  const en = JSON.parse(read("i18n/en_US.json"));
  ok("i18n：zh / en 都补了 openInWeb + collapseBlock，且 key 数量仍然一致",
    !!zh.openInWeb && !!en.openInWeb && !!zh.collapseBlock && !!en.collapseBlock &&
    Object.keys(zh).length === Object.keys(en).length);
}

/* ---------------------------------------------------------------------------
 * 【24】2026-10-10 手机端 OO：永不开启移动版（用户要求）
 * --------------------------------------------------------------------------
 * 这一条属于"坏了不报错"的形态：
 *   · isMobileUi() 一旦退回"按 isMobile() / 视口宽度 / UA 判手机"，手机就会拿到
 *     OO 的**移动版编辑器** —— 那套界面缺掉完整的「文件 / 开始 / 插入 / …」菜单，
 *     而用户要的正是那套菜单（先前专门为它改过 customization）。症状不是报错，
 *     而是"菜单不见了"，很难联想到是这里。
 *   · FPK 侧 effective_layout() 一旦恢复成"按 UA 兜成 mobile"，插件判对也没用 ——
 *     服务端会把 desktop 再改回 mobile，手机上照样是移动版。
 * 两头都必须钉死：插件恒 false + 服务端恒 desktop。
 * 另外编辑器页的 `./diag` 上报是手机上唯一的取证手段，三件套缺一不可。
 */
{
  console.log("\n【24】手机端 OO：永不开启移动版（插件恒 desktop + 服务端恒 desktop）");

  const idx = readNoCmt("index.js");
  ok("isMobileUi() 恒返回 false（不再按 isMobile / 视口 / UA 判手机）",
    /isMobileUi\(\)\s*\{\s*return\s+false\s*;?\s*\}/.test(idx));
  ok("上一版的 looksLikeMobileDevice() 已删除（不留会误导的第二套判定）",
    !/looksLikeMobileDevice/.test(idx));
  ok("根 index.js 里 OO layout 仍走 isMobileUi()（1 处：linkOf）",
    (idx.match(/isMobileUi\(\)\s*\?\s*"mobile"\s*:\s*"desktop"/g) || []).length === 1);
  ok("src 里 4 个调用点也都仍走 isMobileUi()（embed×2 / preview / tabview / fileview）",
    ["src/embed.js", "src/preview.js", "src/tabview.js", "src/fileview.js"]
      .every(f => /isMobileUi\(\)/.test(readNoCmt(f))));

  // FPK 工程在另一个目录；这台机器上有就顺手钉住，没有就明说跳过（不假装通过）
  const FPK = "C:/Users/HP/WorkBuddy/2026-10-08-07-43-01/siyuannote/fnos-package/app/local-fs.py";
  if (existsSync(FPK)) {
    const lf = readFileSync(FPK, "utf8");
    ok("effective_layout() 恒返回 desktop（不再按 UA 兜成 mobile）",
      /def\s+effective_layout\([\s\S]{0,1400}?return\s+"desktop"/.test(lf) &&
      !/return\s+"mobile"\s+if\s+is_mobile_ua/.test(lf));
    ok("按 UA 判手机的帮手（MOBILE_UA_RE / is_mobile_ua）已删除",
      !/MOBILE_UA_RE/.test(lf) && !/def\s+is_mobile_ua/.test(lf));
    ok("_oo_editor 仍调用 effective_layout() 并写一行日志（真机排查全靠它）",
      /def\s+_oo_editor\([\s\S]{0,1200}effective_layout\(\s*layout\s*,\s*ua\s*\)/.test(lf) &&
      /def\s+_oo_editor\([\s\S]{0,1600}log\(/.test(lf));
    ok("编辑器页真机诊断三件套齐全（./diag 上报 + /oo/diag 路由 + _oo_diag）",
      /"\.\/diag"/.test(lf) &&
      /pathname\s*==\s*"\/oo\/diag"/.test(lf) &&
      /def\s+_oo_diag\(/.test(lf));
    ok("诊断探针是 v2：全局找 iframe + 读内部文本（v1 的 iframe-ok/timeout 已去掉）",
      /querySelectorAll\("iframe"\)/.test(lf) &&
      /frames@/.test(lf) &&
      !/iframe-timeout/.test(lf));
    ok("编辑器页带 no-store（手机 webview 缓存会让新探针刷不上去）",
      /def\s+_html\([\s\S]{0,1200}no-store[\s\S]{0,160}must-revalidate/.test(lf));
  } else {
    console.log("  · 跳过 FPK 侧 4 条：本机没有那个工程目录");
  }
}

/**
 * 【25】2026-10-10 两项收尾改动（用户要求）
 * --------------------------------------------------------------------------
 * ① 删掉设置面板里的「手机上用移动版编辑器」开关。
 *    这一条属于"删了功能、旧断言空转"的形态 —— 开关一旦删掉，如果没人**反向**
 *    断言"它不许还在"，那残留的半个开关（比如只删了 DOM 忘了删 DEFAULT_SETTINGS、
 *    或只删了中文漏了英文）不会有任何测试报红。所以这里三处一起钉：
 *    设置面板 / DEFAULT_SETTINGS / i18n(zh+en) 都不许再出现 mobileEditor。
 *    同时**正向**断言 isMobileUi() 仍在 —— 删开关 ≠ 删掉"恒 desktop"的实现。
 * ② 本机文件服务端口**保持 8021**（曾经短暂迁到 8020，已回滚 —— 8020 是
 *    飞牛原生「CAD 看图」应用的端口，思源不该去占它）。
 *    这是**跨三个文件的同一个数字**：插件的 DIRECT_PORT、FPK 侧 local-fs.py 的
 *    默认值、以及 cmd/main 与 reverse-proxy.py 的默认值。改漏任何一处，症状都
 *    只是"探测不到服务"（不会提示端口错），很难联想到是端口没改全。
 *    ⇒ 三处都断言 8021。
 *    ★ 同时**正向**断言 local-fs.py 里那句"引用 fnos-dwg-viewer（:8020）"还在 ★
 *      —— 回滚时最容易被一刀切 sed 改坏的就是它（那是**别人的**端口）。
 *      （FPK 的 manifest 里保留历史 changelog 原文，属于历史记录，不参与断言。）
 */
{
  console.log("\n【25】收尾：删除移动版开关 + 文件服务端口保持在 8021");

  const idx2 = readNoCmt("index.js");
  const st = readNoCmt("src/settings.js");
  const zh = readFileSync(join(ROOT, "i18n/zh_CN.json"), "utf8");
  const en = readFileSync(join(ROOT, "i18n/en_US.json"), "utf8");

  ok("设置面板不再渲染「手机上用移动版编辑器」", !/mobileEditor/.test(st));
  // ★ 只在 DEFAULT_SETTINGS 这个块里判 ★
  //   别在整个 index.js 上搜 —— onload 里的**一次性迁移**（下面那条断言验的）
  //   本来就要写 "mobileEditor" 这个名字，全文件搜会把它误判成"字段还在"。
  const dsBlock = (idx2.match(/const DEFAULT_SETTINGS = \{[\s\S]*?\n\};/) || [""])[0];
  ok("DEFAULT_SETTINGS 不再有 mobileEditor 字段",
    dsBlock.length > 0 && !/mobileEditor/.test(dsBlock));
  ok("i18n 的中英文都不再有 mobileEditor / mobileEditorDesc",
    !/mobileEditor/.test(zh) && !/mobileEditor/.test(en));
  ok("isMobileUi() 仍在且恒 false（删开关 ≠ 删实现）",
    /isMobileUi\(\)\s*\{\s*return\s+false\s*;?\s*\}/.test(idx2));
  // 删 DEFAULT_SETTINGS 的字段只对"新装"生效；老用户存档里还留着那个键，
  // loadData 会原样合并回来（真机实测过）。所以必须有一次性迁移把它删掉 ——
  // 这条断言就是防"以后有人把迁移删了，并以为已经清干净"。
  // ★ 2026-10-10 第二轮整理 ★ 迁移清单从 1 项扩到 4 项（加了 allowEdit /
  //   rememberBase / expandedPaths），实现也从单条 if 改成了循环 —— 断言跟着改。
  ok("onload 里有一次性迁移：清掉存档里残留的 mobileEditor / allowEdit / rememberBase / expandedPaths",
    /for\s*\(\s*const\s+k\s+of\s*\[[\s\S]{0,140}?"mobileEditor"[\s\S]{0,240}?delete\s+this\.settings\[k\]/.test(idx2));

  const api = readNoCmt("src/api.js");
  ok("插件 DIRECT_PORT 已是 8021", /DIRECT_PORT\s*=\s*8021\b/.test(api));

  const FPK_DIR = "C:/Users/HP/WorkBuddy/2026-10-08-07-43-01/siyuannote/fnos-package";
  if (existsSync(FPK_DIR)) {
    const lf2 = readFileSync(FPK_DIR + "/app/local-fs.py", "utf8");
    const rp2 = readFileSync(FPK_DIR + "/app/reverse-proxy.py", "utf8");
    const mn2 = readFileSync(FPK_DIR + "/cmd/main", "utf8");
    ok("local-fs.py 默认端口 8021",
      /LOCAL_FS_PORT"\)\s*or\s*"8021"/.test(lf2));
    // ★ 反向断言：别人的端口不许被"顺手改对"。回滚/重命名时最容易踩的就是它。
    ok("local-fs.py 仍保留「fnos-dwg-viewer（:8020）」这条引用（8020 是原生应用的端口）",
      /fnos-dwg-viewer（:8020）/.test(lf2));
    ok("reverse-proxy.py 的 LOCAL_FS_PORT 默认 8021",
      /PROXY_LOCAL_FS_PORT'\)\s*or\s*'8021'/.test(rp2));
    ok("cmd/main 的 LOCAL_FS_PORT 默认 8021",
      /TRIM_LOCAL_FS_PORT:-8021/.test(mn2));
  } else {
    console.log("  · 跳过 FPK 侧 4 条：本机没有那个工程目录");
  }
}

/**
 * 【26】2026-10-10：CAD 预览改为「借用飞牛原生 CAD 看图应用」
 * --------------------------------------------------------------------------
 * 用户要求：CAD 预览要借用 FN 原生「CAD 看图」应用 —— 与「文件预览」借 :8030
 * **完全同构**。（此前是随包内置一份 cad-viewer 产物，22MB。）
 *
 * 为此动了三层，每层都有一条最容易漏的东西：
 *
 *   ① 反代（reverse-proxy.py）新增 /localfs/cad/* → :8020
 *      · ★ 判定必须排在通用 /localfs 规则**之前** ★ —— 否则被文件服务吃掉
 *        （`/localfs/cad` 也匹配 `/localfs`，这就是"长前缀优先"的意义）。
 *      · ★ 只剥前缀**不够** ★ 该应用的资源是**根绝对** `/assets/…`、`/api/…`，
 *        而这两个命名空间归**思源内核**（笔记里的图片就在 /assets/<file>）
 *        ⇒ 只能改写送出的 HTML/JS/CSS 正文。二进制（9.5MB 的 .wasm、图纸本身）
 *        必须原样中继、一个字节都不缓冲，否则内存与延迟都难看。
 *
 *   ② local-fs.py 删掉内置查看器：STATIC_DIR / _static / prefixed_bytes /
 *      _ASSET_BASE / _CAD_DROP_RULES 与 22MB 的 app/local-fs-dist/。
 *      ⇒ 断言这些**都不存在**了，且根路径改成明确的 404。
 *
 *   ③ 打包链：build-fpk-nas.sh 不再上传那份产物，而且**必须显式删掉 NAS
 *      工作区里的旧产物**（不然它会静默跟着进包）；build-fpk.sh 加一条
 *      **反向断言**拦住它复活。
 *      "删了功能、旧产物却被别的路径带回来"正是这类改动最容易漏的一环。
 */
{
  console.log("\n【26】CAD 预览改为借用原生「CAD 看图」应用（:8020 同源通道）");

  const FPK = "C:/Users/HP/WorkBuddy/2026-10-08-07-43-01/siyuannote";
  if (!existsSync(FPK)) {
    console.log("  · 跳过：本机没有那个工程目录");
  } else {
    const rp = readFileSync(FPK + "/fnos-package/app/reverse-proxy.py", "utf8");
    const lf2 = readFileSync(FPK + "/fnos-package/app/local-fs.py", "utf8");
    const mk2 = readFileSync(FPK + "/fnos-package/cmd/main", "utf8");
    const bfpk = readFileSync(FPK + "/scripts/build-fpk.sh", "utf8");
    const bnas = readFileSync(join(ROOT, "tools/build-fpk-nas.sh"), "utf8");

    // ── ① 反代：通道 + 改写器 + 顺序 ──
    ok("反代有 CAD 通道常量（/localfs/cad → 8020）",
      /CAD_PREFIX\s*=\s*\(os\.environ\.get\('PROXY_CAD_PREFIX'\)\s*or\s*'\/localfs\/cad'\)\.encode\(\)/.test(rp) &&
      /CAD_PORT\s*=\s*int\(os\.environ\.get\('PROXY_CAD_PORT'\)\s*or\s*'8020'\)/.test(rp));
    ok("反代有正文改写器（根绝对 /assets、/api → 补前缀）",
      /_CAD_ABS_RE\s*=\s*re\.compile\(/.test(rp) &&
      /assets\|api/.test((rp.match(/_CAD_ABS_RE\s*=\s*re\.compile\(([^\n]*)\)/) || [])[1] || "") &&
      /def rewrite_cad_asset/.test(rp) && /def cad_rewritable/.test(rp));
    {
      const cr = (rp.match(/def cad_rewritable[\s\S]*?\n\n\n/) || [""])[0];
      // ★ 只从 **_CAD_TEXT_EXT 的元组字面量**里读后缀 ★
      //   别在整个函数体上搜 —— 它的注释里恰好写着"否则 9.5MB 的 .wasm 会被
      //   整份读进内存"，那种写法会把"提到过 wasm"误判成"处理 wasm"（假红）。
      const tup = (rp.match(/_CAD_TEXT_EXT\s*=\s*\(([^)]*)\)/) || [])[1] || "";
      ok("改写器只认 html/js/css（.wasm 等二进制不进这条道）",
        tup.length > 0 && /\.js/.test(tup) && /\.css/.test(tup) &&
        /\.html/.test(tup) && !/wasm/.test(tup), "元组=" + tup);
      ok("改写器按 content-type 兜底拦二进制",
        /def rewrite_cad_asset[\s\S]{0,600}content-type/.test(rp));
      // ★★ 2026-10-10 踩过：只认 `/` 与 `/index.html`，于是 SPA 路由 /open
      //    拿回来的 HTML 没被改写 ⇒ 资源全打到内核 ⇒ 白屏。这条必须盯住。
      ok("★ 改写器覆盖**无扩展名的 SPA 路由**（/open 这类返回的也是 index.html）",
        /b'\.'\s+not\s+in\s+name/.test(cr) && /return\s+True/.test(cr));
      ok("★ 改写器认 /open 这条正规入口（注释与实现都写上）",
        /\/open/.test(cr));
    }
    {
      const pu = (rp.match(/def pick_upstream[\s\S]*?\n    return UPSTREAM_HOST/) || [""])[0];
      const iCad = pu.indexOf("CAD_PREFIX and (path == CAD_PREFIX");
      const iLfs = pu.indexOf("LOCAL_FS_PREFIX and (path == LOCAL_FS_PREFIX");
      ok("★ 分流顺序：CAD 规则排在通用 /localfs 之前（否则被文件服务吃掉）",
        iCad >= 0 && iLfs >= 0 && iCad < iLfs, "iCad=" + iCad + " iLfs=" + iLfs);
    }
    ok("CAD 的文本资源走 fetch_and_rewrite 的一次性连接（不碰常驻中继线程）",
      /if\s+is_cad:[\s\S]{0,700}fetch_and_rewrite\(client, target, new_head, rewrite_cad_asset\)/.test(rp));
    ok("CAD 通道的启动日志里能看到（排障时一眼确认通道起来了）",
      /CAD 看图 %s:%d/.test(rp));
    ok("启动日志点明了「收编 assets」这件事（否则排障时看不出还有第二道）",
      /剥前缀\+收编 assets\+正文改写/.test(rp));

    // ── ①′ 收编（与 file-viewer 收编 /app.js 同一套路）★ 按 8030 的方式做 ──
    {
      const assets = (rp.match(/_CAD_ASSETS\s*=\s*tuple\([\s\S]*?\n\)/) || [""])[0];
      ok("★ 反代有 _CAD_ASSETS（把 CAD 的 /assets/<产物名> 逐个精确收编）",
        assets.length > 0 && /PROXY_CAD_ASSETS/.test(assets));
      // 至少得把实测漏掉的那 3 个收进来（否则又会落到内核 /check-auth 上）
      ok("★ _CAD_ASSETS 收进了实测漏掉的 3 个（style-*.css 与两个 cad-agent-plugin-*）",
        /style-9mXLuaXs\.css/.test(assets) &&
        /cad-agent-plugin-register-B6ardLqw\.js/.test(assets) &&
        /cad-agent-plugin-ewBYyPo4\.js/.test(assets));
      ok("★ 故意**不按 /assets/ 前缀**收编（那是内核的笔记附件目录）",
        /path\.startswith\(b'\/assets\/'\)/.test(rp) &&
        !/_CAD_ASSETS\s*=\s*tuple\(\s*\[[^\]]*b'\/assets/.test(rp));
      ok("is_cad_asset 只认精确相等（不是前缀匹配）",
        /def is_cad_asset[\s\S]{0,900}in _CAD_ASSETS/.test(rp));
    }
    {
      const pu2 = (rp.match(/def pick_upstream[\s\S]*?\n    return UPSTREAM_HOST/) || [""])[0];
      const iOwn = pu2.indexOf("if is_siyuan_owned(path):");
      const iCadAsset = pu2.indexOf("if _CAD_ASSETS and is_cad_asset(path):");
      ok("★ 顺序：CAD 资产收编排在 is_siyuan_owned **之前**（否则 /assets 全归内核）",
        iOwn >= 0 && iCadAsset >= 0 && iCadAsset < iOwn,
        "iCadAsset=" + iCadAsset + " iOwn=" + iOwn);
    }

    // ── ①″ 插件侧：必须给 /open，不是 / ──
    {
      const api2 = readFileSync(join(ROOT, "src/api.js"), "utf8");
      ok("★ 插件有 CAD_OPEN_ROUTE = \"/open\"",
        /export\s+const\s+CAD_OPEN_ROUTE\s*=\s*"\/open"/.test(api2));
      ok("★ cadViewerUrl 用 /open 入口（不是 /?path=）",
        /cadViewerUrl\(path\)\s*\{[\s\S]{0,300}CAD_OPEN_ROUTE/.test(api2) &&
        !/_base \+ CAD_PREFIX \+ "\/\?"/.test(api2));
      ok("★ channelUrl 是**三参**签名 (chan, qs, route)（端口 / 直连开关已删）",
        /function\s+channelUrl\(chan,\s*qs,\s*route\)/.test(api2) &&
        !/channelUrl\(chan,\s*port/.test(api2) &&
        /const\s+r\s*=\s*route\s*\|\|\s*"\/"/.test(api2));
      ok("fileViewerUrl 仍走默认入口 \"/\"（别被 CAD 的改动带偏）",
        /fileViewerUrl\(path\)\s*\{[\s\S]{0,200}channelUrl\(FV_PREFIX, qs\)/.test(api2));
      ok("★ officeUrl 走官方 docs 通道（/localfs/docs + /preview）",
        /officeUrl\(path[\s\S]{0,400}channelUrl\(DOCS_PREFIX, qs, DOCS_OPEN_ROUTE\)/.test(api2));
    }

    // ── ①‴ 三条链路**全部**走 6806 同源通道（2026-10-10 用户改写定档）──
    //   旧定档是"内嵌走通道、在浏览器打开走直连端口"，用户已明确改成
    //   「三条全部收回 6806」⇒ 两个 Open 函数与内嵌版**同址**。
    //   理由：① 外网穿透只映射 6806，直连 8020/8030/5666 根本够不到；
    //        ② 净化靠 iframe.contentDocument，跨源必然静默失败
    //           （查看器自带的工具栏/命令行/文件树会全部冒回来）。
    {
      const api3 = readFileSync(join(ROOT, "src/api.js"), "utf8");
      const fv3 = readFileSync(join(ROOT, "src/fileview.js"), "utf8");
      ok("★ 仍导出 cadOpenUrl / fileViewerOpenUrl（保留只为语义清晰）",
        /export\s+function\s+cadOpenUrl\b/.test(api3) &&
        /export\s+function\s+fileViewerOpenUrl\b/.test(api3));
      ok("★ 两个 Open 函数与内嵌版**同址**（直接 return 各自的 ViewerUrl）",
        /cadOpenUrl\(path\)\s*\{\s*return\s+cadViewerUrl\(path\)/.test(api3) &&
        /fileViewerOpenUrl\(path\)\s*\{\s*return\s+fileViewerUrl\(path\)/.test(api3));
      // ★ 当年被删的是"直连分支（direct）"那套老机制——它自带一个
      //   pageIsHttps 安全网，逻辑绕、出过事，已彻底移除。
      ok("★ 老的 direct 直连分支 / 裸拼接端口已彻底移除",
        !/if\s*\(direct\)/.test(api3) &&
        !/pageIsHttps/.test(api3) &&
        !/"http:\/\/"\s*\+\s*host\s*\+\s*":"\s*\+\s*port/.test(api3));
      ok("★ 内嵌 iframe 用 cadViewerUrl / fileViewerUrl",
        /_iframe\(cadViewerUrl\(item\.path\)/.test(fv3) &&
        /_iframe\(fileViewerUrl\(item\.path\)/.test(fv3));
      ["embed", "preview", "tabview"].forEach((n) => {
        const s3 = readFileSync(join(ROOT, "src", n + ".js"), "utf8");
        ok("★ " + n + ".js 的「在浏览器打开」仍经统一路由拿到 Open 函数",
          /cadViewerUrl:\s*cadOpenUrl/.test(s3) &&
          /fileViewerUrl:\s*fileViewerOpenUrl/.test(s3));
      });
    }

    // ── ② local-fs.py：内置查看器必须真的没了 ──
    ok("★ local-fs.py 不再有内置查看器的静态服务（STATIC_DIR / _static）",
      !/STATIC_DIR/.test(lf2) && !/def _static/.test(lf2));
    ok("★ local-fs.py 不再有资源前缀改写机制（prefixed_bytes / _ASSET_BASE / _CAD_DROP_RULES）",
      !/prefixed_bytes/.test(lf2) && !/_ASSET_BASE/.test(lf2) && !/_CAD_DROP_RULES/.test(lf2));
    ok("★ local-fs.py 不再读 local-fs-dist 目录",
      !/os\.path\.join\(HERE,\s*"local-fs-dist"\)/.test(lf2) && !/LOCAL_FS_STATIC/.test(lf2));
    ok("根路径给了明确的 404（不是空白、也不是旧查看器）",
      /raise\s+ApiError\(404,\s*"NO_PAGE"/.test(lf2));
    ok("文件头写清了「本服务只提供 API，页面借原生应用」",
      /借用飞牛原生「CAD 看图」应用/.test(lf2));
    // 正向断言：删了页面 ≠ 删了数据面
    ok("★ 数据面 API 仍在（/api/file、/api/list 的处理器还在）",
      /pathname\s*==\s*"\/api\/file"/.test(lf2) && /def _serve_file/.test(lf2));

    // ── ③ 打包链 ──
    ok("cmd/main 不再导出 LOCAL_FS_STATIC、不再定义 LOCAL_FS_DIST",
      // ★ 必须连"赋值语句"一起锚，不能只搜词 ★
      //   我在那里留了一句说明性注释（"不再导出 LOCAL_FS_STATIC —— 内置查看器
      //   已删除"），单纯 `!/LOCAL_FS_STATIC/` 会把那条注释误判成"还在导出"。
      !/\n\s*export\s+LOCAL_FS_STATIC=/.test(mk2) && !/\nLOCAL_FS_DIST=/.test(mk2));
    ok("build-fpk.sh 的必需文件清单里已无 local-fs-dist",
      !/app\/local-fs-dist\/index\.html/.test(bfpk));
    ok("★ build-fpk.sh 加了反向断言：包里再出现 local-fs-dist 就拒绝打包",
      /if\s+\[\s+-e\s+"\$\{STAGE\}\/app\/local-fs-dist"\s+\]/.test(bfpk));
    ok("build-fpk-nas.sh 不再打包/上传 local-fs-dist.tgz",
      !/local-fs-dist\.tgz/.test(bnas) && !/tar czf/.test(bnas));
    ok("★ build-fpk-nas.sh 会主动删掉 NAS 工作区里的旧产物 + 反向核对",
      /rm -rf '\$REMOTE\/fnos-package\/app\/local-fs-dist'/.test(bnas) &&
      /local-fs-dist 已不在工作区/.test(bnas));
    ok("build-fpk-nas.sh 的 md5 清单里已无 local-fs-dist",
      !/check\s+"\$SRC\/fnos-package\/app\/local-fs-dist/.test(bnas));
  }
}

console.log("\n" + "─".repeat(70));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
