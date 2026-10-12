/**
 * sim-loader.cjs —— 严格复刻思源的插件加载器，并真正把 onload 跑起来
 * -------------------------------------------------------------------------
 * 为什么不能只"构建成功就算完"：
 *
 *   思源是这样执行插件的（从 common.js 里读出来的原文）：
 *
 *     const Ue = Ve => Ve === "siyuan" ? P() : window.require?.(Ve);
 *     const ce = (Ve, Xe) => window.eval(
 *       "(function anonymous(require, module, exports){" + Ve + " }) //# sourceURL=" + Xe
 *     );
 *     const He = (Ve, Xe) => {
 *       const ft = {}, Tt = { exports: ft };
 *       try { ce(Xe.js, "plugin:" + name)(Ue, Tt, ft) }
 *       catch (Et) { console.error(`plugin ${name} run error:`, Et); return }
 *       const mt = (Tt.exports || ft).default || Tt.exports;
 *       if (typeof mt != "function") throw ... "has no export"
 *       if (!(mt.prototype instanceof Plugin)) throw ... "does not extends Plugin"
 *       return new mt({ app, displayName, name, i18n });
 *     }
 *
 *   两个"静默失败"的口子：
 *     ① 脚本抛错 → 只写浏览器 console，siyuan.log 里干干净净；
 *     ② 注册类的调用（addDock / addCommand）写错了，也只有运行时才暴露。
 *   所以这里：
 *     · window.require **只会抛错**（逼出任何相对 require）；
 *     · 造一套够用的 DOM / fetch 桩，把 onload() **真的跑一遍**，
 *       检查它到底注册了什么，以及面板能不能把目录列出来、点文件能不能开预览。
 *
 * 用法：node tools/sim-loader.cjs [插件安装目录]
 */
const fs = require("fs");
const path = require("path");

const PLUGIN_DIR = process.argv[2] || "D:/Software/SiYuan/data/plugins/siyuan-localfs";
const PLUGIN_NAME = path.basename(PLUGIN_DIR);
const BASE = "http://192.168.193.70:6806/localfs";

let PASS = 0;
let FAIL = 0;
const check = (label, cond, detail) => {
  if (cond) {
    PASS++;
    console.log("  ok   " + label + (detail ? "  " + detail : ""));
  } else {
    FAIL++;
    console.log("  FAIL " + label + (detail ? "  <- " + detail : ""));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── 极简 DOM ───────────────────────── */
class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this._attrs = {};
    this._cls = new Set();
    this._text = "";
    this._html = "";
    this._listeners = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.title = "";
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._cls.add(x)),
      remove: (...c) => c.forEach((x) => self._cls.delete(x)),
      contains: (c) => self._cls.has(c),
      toggle: (c, on) => (on ? self._cls.add(c) : self._cls.delete(c)),
    };
  }
  get className() { return Array.from(this._cls).join(" "); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) {
    let p = n;
    while (p) {
      if (p === this) return true;
      p = p.parentNode;
    }
    return false;
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k]; }
  removeAttribute(k) { delete this._attrs[k]; }
  addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); }
  removeEventListener(t, f) {
    const a = this._listeners[t] || [];
    const i = a.indexOf(f);
    if (i >= 0) a.splice(i, 1);
  }
  dispatch(t, ev) {
    const e = Object.assign({ type: t, stopPropagation() {}, preventDefault() {}, target: this }, ev || {});
    (this._listeners[t] || []).slice().forEach((f) => f(e));
    return e;
  }
  focus() {}
  select() {}
  _walk(fn) {
    for (const c of this.children) {
      fn(c);
      c._walk(fn);
    }
  }
  querySelectorAll(sel) {
    const out = [];
    let match;
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      match = (e) => e._cls.has(cls);
    } else if (/^[a-z]+$/i.test(sel)) {
      match = (e) => e.tagName === sel.toUpperCase();
    } else {
      // 属性选择器 [a="b"]：够本项目用
      const m = /^\[([\w-]+)="?(.*?)"?\]$/.exec(sel);
      match = m
        ? (e) => {
          const key = m[1].replace(/^data-/, "");
          const v = m[1].startsWith("data-") ? e.dataset[key] : e._attrs[m[1]];
          return String(v) === m[2];
        }
        : () => false;
    }
    this._walk((e) => {
      if (match(e)) out.push(e);
    });
    return out;
  }
  querySelector(sel) {
    const a = this.querySelectorAll(sel);
    return a.length ? a[0] : null;
  }
  getBoundingClientRect() { return { width: 160, height: 120, left: 0, top: 0 }; }
}

const body = new El("body");

global.document = {
  createElement: (tag) => new El(tag),
  createTextNode: (t) => { const e = new El("#text"); e.textContent = t; return e; },
  body,
  head: new El("head"),
  documentElement: new El("html"),
  querySelector: (s) => body.querySelector(s),
  querySelectorAll: (s) => body.querySelectorAll(s),
  getElementById: () => null,
  addEventListener(t, f) { (this._l = this._l || {}); (this._l[t] = this._l[t] || []).push(f); },
  removeEventListener() {},
  execCommand: () => true,
};

global.window = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  open(url) { (global.window.__opened = global.window.__opened || []).push(url); },
  require(spec) {
    // ★ 故意只会抛错：任何相对 require 都必须在这里暴露
    const err = new Error("Cannot find module '" + spec + "'");
    err.code = "MODULE_NOT_FOUND";
    throw err;
  },
  eval: (code) => eval(code),
};
global.navigator = { userAgent: "Electron", clipboard: { writeText: () => Promise.resolve() } };
global.location = {
  protocol: "http:",
  origin: "http://192.168.193.70:6806",
  hostname: "192.168.193.70",
  href: BASE + "/",
};
global.CSS = { escape: (s) => String(s).replace(/(["\\])/g, "\\$1") };

/* ───────────────────────── fetch 桩 ───────────────────────── */
const HEALTH = { ok: true, app: "siyuan-local-fs", version: "1.0.0", oo: true, roots: ["/vol1"] };
const CONFIG = {
  app: "siyuan-local-fs",
  sources: [{ label: "存储空间 1", path: "/vol1" }],
  allowedRoots: ["/vol1"],
  runsAsRoot: true,
  onlyoffice: { enabled: true, url: "http://127.0.0.1:8082" },
};
const LIST = {
  "/vol1": {
    source: "local", path: "/vol1",
    items: [
      { name: "图纸", path: "/vol1/图纸", isDir: true, size: 4096, mtime: 1, ext: "" },
      { name: "文档", path: "/vol1/文档", isDir: true, size: 4096, mtime: 1, ext: "" },
      { name: "规划图2025.DWG", path: "/vol1/规划图2025.DWG", isDir: false, size: 123456, mtime: 1, ext: ".dwg" },
      { name: "方案.docx", path: "/vol1/方案.docx", isDir: false, size: 4567, mtime: 1, ext: ".docx" },
      { name: "照片.png", path: "/vol1/照片.png", isDir: false, size: 98765, mtime: 1, ext: ".png" },
    ],
  },
  "/vol1/图纸": {
    source: "local", path: "/vol1/图纸",
    items: [{ name: "大样.dxf", path: "/vol1/图纸/大样.dxf", isDir: false, size: 2048, mtime: 2, ext: ".dxf" }],
  },
};
const FETCHED = [];
global.fetch = (url, opt) => {
  FETCHED.push({ url: String(url), opt });
  const u = String(url);
  const send = (obj, status) => Promise.resolve({
    ok: status ? status < 400 : true,
    status: status || 200,
    headers: { get: () => null },
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
    arrayBuffer: () => Promise.resolve(Buffer.from("hello").buffer),
    blob: () => Promise.resolve({}),
  });
  if (u.endsWith("/api/health")) return send(HEALTH);
  if (u.indexOf("/api/config") >= 0) return send(CONFIG);
  if (u.indexOf("/api/list") >= 0) {
    const p = decodeURIComponent((u.split("path=")[1] || "").split("&")[0]);
    return send(LIST[p] || { source: "local", path: p, items: [] });
  }
  if (u.indexOf("/api/probe") >= 0) return send({ ok: true, size: 100, ext: ".txt" });
  if (u.indexOf("/api/file") >= 0) return send({}, 200);
  return send({}, 404);
};

/* ───────────────────────── 模拟 siyuan 模块 ───────────────────────── */
// 数一下插件到底写了几次盘。
// ★ 这条是**回归断言**，不是凑数 ★
//   saveData 会写 /data/storage/petal/<插件名>/，内核随后推送"插件数据已变"，
//   前端就重载插件；只要探测/面板启动这条热路径上写盘，就会变成
//   写 → 重载 → 再探测 → 再写 的死循环。真机上实测过：静置 6 秒被重载 13 次。
let SAVE_CALLS = 0;
class Plugin {
  constructor(o) {
    this.app = (o && o.app) || {};
    this.name = o && o.name;
    this.displayName = o && o.displayName;
    this.i18n = (o && o.i18n) || {};
    this.__docks = [];
    this.__topbars = [];
    this.__commands = [];
    this.__data = {};
  }
  addDock(o) { this.__docks.push(o); }
  addTopBar(o) { this.__topbars.push(o); }
  addCommand(o) { this.__commands.push(o); }
  // ★ 记下注册过的符号 ★
  //   停靠图标必须是"符号 id"，而 id 只有在 addIcons 注册了同名 <symbol>
  //   时才渲染得出来；不记下来就没法验后半句（漏了会**空白且不报错**）。
  addIcons(s) { this.__icons = (this.__icons || []).concat(String(s == null ? "" : s)); }
  addTab() {}
  loadData(k) { return Promise.resolve(this.__data[k] === undefined ? null : this.__data[k]); }
  saveData(k, v) { SAVE_CALLS++; this.__data[k] = v; return Promise.resolve({ code: 0 }); }
}
const SIYUAN = {
  Plugin,
  getFrontend: () => "desktop",
  isMobile: () => false,
  showMessage: (m) => { (global.__toasts = global.__toasts || []).push(String(m)); },
  confirm: () => Promise.resolve(true),
  Dialog: function () {},
  Setting: function () { this.addItem = () => {}; },
};

/* ───────────────────────── 加载 ───────────────────────── */
console.log("模拟思源插件加载器（window.require 只会抛错）");
console.log("插件: " + PLUGIN_NAME);
console.log("─".repeat(62));

const PLUGIN_JS = fs.readFileSync(path.join(PLUGIN_DIR, "index.js"), "utf8");
const I18N = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "i18n", "zh_CN.json"), "utf8"));

const req = (spec) => {
  if (spec === "siyuan") return SIYUAN;
  return global.window.require(spec);
};
const moduleObj = { exports: {} };

let factory;
try {
  factory = new Function("require", "module", "exports", PLUGIN_JS);
} catch (e) {
  console.log("★ 语法错误：" + e.message);
  process.exit(1);
}
try {
  factory(req, moduleObj, moduleObj.exports);
} catch (e) {
  console.log("★ 插件脚本执行抛错（思源会 console.error 后静默放弃，不写 siyuan.log）");
  console.log("  " + e.message);
  process.exit(1);
}
check("插件脚本执行成功（无 require 错误）", true);

const Cls = (moduleObj.exports || {}).default || moduleObj.exports;
check("导出是函数", typeof Cls === "function", Cls && Cls.name);
check("继承自 Plugin", typeof Cls === "function" && Cls.prototype instanceof Plugin);
if (!(typeof Cls === "function" && Cls.prototype instanceof Plugin)) {
  console.log("\n通过 " + PASS + " / 失败 " + FAIL);
  process.exit(1);
}

(async () => {
  const plugin = new Cls({
    app: { workspace: {} },
    name: PLUGIN_NAME,
    displayName: "本机存储",
    i18n: I18N,
  });

  // ★ 预置一份「从内核里读回来的设置」，里面带着**另一台主机**的缓存地址 ★
  //   插件设置是 saveData 存到内核里的，全机器共享：上次在 172.16.30.128 打开的
  //   页面会把那台主机写进 lastBase，这次从 192.168.193.70 打开就会先去探它 ——
  //   那是跨源请求，浏览器必拦，console 刷屏、面板还要白等 2.5 秒。
  plugin.__data.settings = {
    baseUrl: "",
    lastBase: "http://172.16.30.128:6806/localfs",
    allowEdit: true,
    mobileEditor: true,
    rememberBase: true,
  };

  await plugin.onload();
  await sleep(60);

  check("onload 注册了 1 个侧边栏停靠", plugin.__docks.length === 1, "type=" + (plugin.__docks[0] || {}).type);
  check("停靠 type 与常量一致", (plugin.__docks[0] || {}).type === "localfsExplorer");
  const dockCfg = (plugin.__docks[0] || {}).config || {};
  const dockIcon = String(dockCfg.icon || (plugin.__docks[0] || {}).icon || "");
  // ★ 图标必须是**符号 id**，不是内联 <svg> 字符串 ★
  //   内核把 icon 当 id 去 `<use xlink:href="#…">` 查符号：传整段 <svg>
  //   会渲染成空白**且不报错**（真机踩过）。所以两头都要验：
  //   ① icon 本身是个 id；② addIcons 真的注册了同名 <symbol>。
  check("停靠 icon 是符号 id（不是内联 SVG 串）", /^icon[A-Za-z0-9_]+$/.test(dockIcon), dockIcon);
  const iconBlob = (plugin.__icons || []).join("");
  check("★ addIcons 注册了同名 <symbol>（漏了会空白且不报错）",
    iconBlob.indexOf('id="' + dockIcon + '"') >= 0,
    "已注册 symbol 数=" + (iconBlob.match(/<symbol/g) || []).length);
  check("停靠 init 是函数", typeof (plugin.__docks[0] || {}).init === "function");
  // ★ 顶栏按钮已删（2026-10-10）：入口收敛到「命令面板 / 快捷键」★
  //   这里断言 0 是有意的 —— 哪天被"顺手补回来"，这条会红。
  check("不注册顶栏按钮（入口已收敛，不再占顶栏）", plugin.__topbars.length === 0,
    "实际 " + plugin.__topbars.length + " 个");
  check("注册了 2 个命令", plugin.__commands.length === 2,
    JSON.stringify(plugin.__commands.map((c) => c.langKey)));
  check("每个命令的 langKey 都在 zh_CN 词表里有对应",
    plugin.__commands.every((c) => !!I18N[c.langKey]),
    JSON.stringify(plugin.__commands.map((c) => c.langKey)));

  // ── 把停靠初始化一遍，看面板能不能真的列出目录 ────────────────
  const dockEl = new El("div");
  const dock = { element: dockEl, type: "localfsExplorer" };
  const ret = plugin.__docks[0].init(dock);
  check("停靠 init 返回 {update,destroy}",
    ret && typeof ret.update === "function" && typeof ret.destroy === "function");
  check("面板已挂进停靠容器", dockEl.querySelectorAll(".lfs-panel").length === 1);

  const explorer = plugin._explorers[0];
  check("面板实例已建立", !!explorer);
  if (!explorer) {
    console.log("\n通过 " + PASS + " / 失败 " + FAIL);
    process.exit(1);
  }
  // 面板自己已经 start() 过；等它把根列出来
  await sleep(200);

  const gb = global.__toasts || [];
  check("探测用的是同源 /localfs（而不是别的）",
    FETCHED.some((f) => f.url.indexOf(":6806/localfs/api/health") >= 0),
    FETCHED.length ? FETCHED[0].url : "(没有请求)");
  check("★ 第一个请求就是同源 /localfs（没有被跨源缓存地址抢先）",
    FETCHED.length > 0 && FETCHED[0].url === BASE + "/api/health",
    FETCHED.length ? FETCHED[0].url : "(没有请求)");
  check("★ 跨源缓存地址（172.16.30.128）从未被探测",
    !FETCHED.some((f) => f.url.indexOf("172.16.30.128") >= 0),
    JSON.stringify(FETCHED.map((f) => f.url).slice(0, 6)));
  check("拿到了存储空间列表", !!(explorer.cfg && (explorer.cfg.sources || []).length >= 1));
  check("状态条显示已连接", !!explorer.statusEl && /is-on/.test(explorer.statusEl.children[0].className),
    explorer.statusEl ? explorer.statusEl.children[0].className : "无状态条");
  check("没有弹错误提示", gb.length === 0, JSON.stringify(gb));

  // ★ 根行是**惰性展开**的 ★
  //   2026-10-10 用户定档「文件夹默认收拢」，根行不再自动展开
  //   （原来是 `if (isRoot) setTimeout(() => setExpanded(true), 0)`）。
  //   ⇒ 必须先点开第一个根，否则这里永远只有一行，后面找 .docx 会拿到
  //     undefined 直接把脚本崩掉 —— 这也是它此前一直红、却看不出原因的地方。
  const rootRows = explorer.rootEl.querySelectorAll(".lfs-row");
  check("根行已渲染（标签取自 sources）", rootRows.length >= 1,
    JSON.stringify(rootRows.map((r) => (r.querySelector(".lfs-name") || {}).textContent)));
  rootRows[0].dispatch("click");
  await sleep(220);

  const listRows = explorer.rootEl.querySelectorAll(".lfs-node");
  const names = listRows.map((r) => {
    const n = r.querySelector(".lfs-name");
    return n ? n.textContent : "";
  });
  check("树里有 /vol1 这一层", names.indexOf("图纸") >= 0 && names.indexOf("文档") >= 0,
    JSON.stringify(names));
  check("文件行也在（含大写 .DWG）",
    names.indexOf("规划图2025.DWG") >= 0, JSON.stringify(names));

  // 点一个 .docx → 应该开预览浮层，且 iframe 指向 /oo/editor
  const rows = explorer.rootEl.querySelectorAll(".lfs-row");
  const docxRow = rows.find((r) => (r.querySelector(".lfs-name") || {}).textContent === "方案.docx");
  check("找到 docx 那一行", !!docxRow);
  docxRow.dispatch("click");
  // ★ 单击是**延迟 250ms** 才开浮层的 ★
  //   文件行同时要支持单击（预览）与双击（开页签）⇒ 单击推迟一拍，
  //   真双击来了就取消它（见 explorer.js 的 clickTimer）。
  //   等 120ms 是等不到的 —— 这条之前一直红就是这个原因。
  await sleep(340);
  check("预览浮层已挂到 body", !!plugin.preview && plugin.preview.opened);
  // ★ 取"最近一次 iframe 的地址"要读 FileView.lastSrc ★
  //   浮层自己不认识 URL：它只是壳，渲染交给 FileView（preview.view）。
  //   旧写法读的是预览浮层上的 `_lastSrc` —— 那个字段**从来不存在**，
  //   取到 undefined 后正则必然不匹配，于是永远红（且看起来像"路由错了"）。
  const lastSrc = () => (plugin.preview && plugin.preview.view
    && plugin.preview.view.lastSrc) || "";
  // ★ 2026-10-10 定档：Office 改走**飞牛官方「Office文档」**通道 ★
  //   不再是自研 OO 的 /oo/editor（那个地址已成历史）。
  check("★ docx 走飞牛官方「Office文档」通道（/localfs/docs/）",
    /\/localfs\/docs\//.test(lastSrc()), lastSrc());
  plugin.preview.close();
  check("预览能关掉", !plugin.preview.opened);

  // 点一个 .DWG → 内置查看器
  const dwgRow = rows.find((r) => (r.querySelector(".lfs-name") || {}).textContent === "规划图2025.DWG");
  dwgRow.dispatch("click");
  await sleep(340);
  // ★ 定档：CAD 走**飞牛原生「CAD 看图」**应用的通道 ★
  //   内置图纸查看器（local-fs-dist）已删，`/localfs/?path=` 那个地址不再提供服务。
  check("★ DWG 走「CAD 看图」通道（/localfs/cad/）",
    /\/localfs\/cad\//.test(lastSrc()), lastSrc());
  plugin.preview.close();

  // 点一个 .png → <img>
  const pngRow = rows.find((r) => (r.querySelector(".lfs-name") || {}).textContent === "照片.png");
  pngRow.dispatch("click");
  await sleep(340);
  check("png 用 <img> 内联（不是 iframe）", !!plugin.preview.body.querySelector("img"));
  plugin.preview.close();

  // 展开子目录 → 应该懒加载 /vol1/图纸
  const dirRow = rows.find((r) => (r.querySelector(".lfs-name") || {}).textContent === "图纸");
  dirRow.dispatch("click");
  await sleep(200);
  check("子目录能展开并列内容",
    FETCHED.some((f) => f.url.indexOf("/api/list") >= 0 && decodeURIComponent(f.url).indexOf("/vol1/图纸") >= 0));

  // 命令 → 全屏浮层
  plugin.__commands[0].callback();
  await sleep(200);
  check("命令能拉起全屏浏览浮层", !!plugin._overlay);
  plugin.closeExplorer();
  check("浮层能关掉", !plugin._overlay);

  // ── 写盘的纪律（历史死循环的根因，必须钉死）──────────────────
  // ★ 加载期**恰好 1 次**写盘，且只该是设置迁移那次 ★
  //   loadSettings 会删掉 4 个废弃键（mobileEditor / allowEdit / rememberBase /
  //   expandedPaths）；夹具里预置了它们 ⇒ dirty=true ⇒ persist 一次。
  //   ★ 红线不是"0 次"，而是**不随操作增长** ★
  //     （历史事故：写 → 内核推"数据已变" → 前端重载插件 → 再写，
  //       静置 6 秒被重载 13 次，console 一片 saveData 拒绝）。
  check("★ 加载 + 探测 + 面板启动 + 点预览 全程只落 1 次盘（设置迁移，不随操作增长）",
    SAVE_CALLS === 1, "saveData 被调用 " + SAVE_CALLS + " 次");

  // ★ 先把速率闸的时间戳归零，再验"连续写盘被限流" ★
  //   ⚠️ 不归零这条就是**假绿**：上面那次迁移刚把 _lastPersistAt 设成"现在"，
  //     下面 3 次 persist 全在 2.5 秒窗口里被跳过 ⇒ SAVE_CALLS 仍是 1，
  //     "3 次只落 1 次"会拿迁移顶账、在"3 次全被跳过"时也照样通过。
  plugin._lastPersistAt = 0;
  SAVE_CALLS = 0;
  plugin.persist();
  plugin.persist();
  plugin.persist();
  check("★ 连续写盘被闸门限流（3 次只落 1 次）",
    SAVE_CALLS === 1, "saveData 被调用 " + SAVE_CALLS + " 次");
  plugin.base = "http://example.test/localfs";
  plugin.settings.lastBase = "";
  plugin.rememberBase();
  check("用户动作后 rememberBase 会把当前地址记进 lastBase",
    plugin.settings.lastBase === "http://example.test/localfs",
    String(plugin.settings.lastBase));

  // ── 对外契约（盘绘等消费方的唯一入口）──────────────────────────
  // ★ 这段是"跨插件契约"的回归闸门 ★
  //   契约只是往 window 上挂一个对象：构建成功、插件跑得起来，
  //   **都不能**说明它挂上了、挂对了形状。之前的做法是"画布那边刷不出来
  //   才发现没挂" —— 那是把可自动化的判据留给了肉眼。
  const api = global.window.__localfsPlugin;
  check("★ onload 把契约挂到 window.__localfsPlugin 上", !!api);
  check("契约带 name", !!(api && api.name), api && api.name);
  const ext = api && api.external;
  check("契约 external.id = localfs.external", !!(ext && ext.id === "localfs.external"),
    ext && ext.id);
  check("契约 version 是数字（消费方可据此判兼容）",
    typeof (ext && ext.version) === "number", String(ext && ext.version));

  const need = ["health", "roots", "list", "probe", "fileUrl", "previewUrl", "openFile", "pickDirectories"];
  const missing = need.filter((m) => typeof (ext || {})[m] !== "function");
  check("契约八件套齐备（画布只依赖这几个）", missing.length === 0,
    missing.length ? "缺：" + JSON.stringify(missing) : need.join("/"));

  if (ext) {
    const r = await ext.roots();
    check("roots() 返回成功信封 {ok:true,data:[…]}",
      !!(r && r.ok && Array.isArray(r.data)), JSON.stringify(r && r.error));
    // ★ 标签必须取自 /api/config 的 sources（"存储空间 1"），不能是裸路径 "vol1" ★
    //   直接拿 health.roots（只有路径）当标签是最顺手的写法，界面上就变成
    //   "vol1" —— 与本插件自己侧栏写的"存储空间 1"是同一个根两个名字。
    //   这条断言就是钉住那个优先级；老写法（health 优先）会返回 label="vol1"。
    check("★ roots() 的 label 用 sources 的「存储空间 1」，不是裸路径 vol1",
      !!(r && r.data && r.data[0] && r.data[0].label === "存储空间 1"),
      JSON.stringify(r && r.data));

    const l = await ext.list("/vol1");
    check("list() 返回 {ok:true,data:{items:[…]}}（5 项）",
      !!(l && l.ok && l.data && Array.isArray(l.data.items) && l.data.items.length === 5),
      String(l && l.data && l.data.items && l.data.items.length));

    const p = await ext.probe("/vol1/照片.png");
    check("probe() 返回信封（不抛异常）", !!(p && typeof p.ok === "boolean"), JSON.stringify(p));

    const u1 = await ext.fileUrl("/vol1/照片.png");
    check("fileUrl() 给出可塞进 src 的成品地址",
      !!(u1 && u1.ok && typeof u1.data === "string" && u1.data), String(u1 && u1.data));

    // ★ 地址一律由本插件构造，而且要落在**当前定档的通道**上 ★
    //   这三条不是"冻结当前输出"，是三条架构决定：
    //     · Office → 飞牛官方「Office文档」（/docs/*），**不再**是自研 OO 的 /oo/editor
    //     · CAD    → 飞牛原生「CAD 看图」（/localfs/cad/*），内置查看器已删
    //     · 图片等原生类型 → 直链 /api/file，不套任何 iframe 应用
    const u2 = await ext.previewUrl("/vol1/方案.docx");
    check("★ previewUrl() docx 走飞牛官方「Office文档」通道（/localfs/docs/）",
      !!(u2 && u2.ok && /\/localfs\/docs\//.test(String(u2.data))
        && !/\/oo\/editor/.test(String(u2.data))), String(u2 && u2.data));

    const u3 = await ext.previewUrl("/vol1/规划图2025.DWG");
    check("★ previewUrl() DWG 走「CAD 看图」通道（/localfs/cad/）",
      !!(u3 && u3.ok && /\/localfs\/cad\//.test(String(u3.data))), String(u3 && u3.data));

    // ★ 失败必须是信封而不是异常 ★
    //   消费方可能在另一个 realm（独立网页 / iframe）里调，
    //   异常穿过去常常退化成 undefined 一类没法判读的东西。
    const realFetch = global.fetch;
    global.fetch = () => Promise.reject(new Error("Failed to fetch"));
    const dead = await ext.list("/vol1");
    global.fetch = realFetch;
    check("★ 网络层失败 → {ok:false,reason:'unreachable'}（异常不穿边界）",
      !!(dead && dead.ok === false && dead.reason === "unreachable"), JSON.stringify(dead));
  }

  // 卸载
  plugin.onunload();
  check("★ onunload 摘掉契约（不留僵尸入口给消费方）", !global.window.__localfsPlugin);
  check("onunload 不抛错", true);

  console.log("\n通过 " + PASS + " / 失败 " + FAIL);
  process.exit(FAIL ? 1 : 0);
})();
