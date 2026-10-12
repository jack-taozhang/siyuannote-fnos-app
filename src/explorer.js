/* ==========================================================================
 * 浏览面板（侧边栏停靠 + 全屏浮层，同一个组件两种宿主）
 * --------------------------------------------------------------------------
 * ★ 为什么同一份代码要能挂两处 ★
 *   思源的**移动端没有 dock（侧边栏停靠）**，而用户明确说手机上也要用。
 *   所以面板不能只按 dock 写死 —— 做成"往任意容器里渲染"的组件，
 *   桌面上挂 dock，手机上由命令拉一个全屏浮层，两边功能一致。
 *
 * ★ 为什么要懒加载 ★
 *   NAS 上单层目录几百上千项很常见，一次递归铺开既慢又没用。
 *   所以只在展开时列该层（`/api/list?path=…`），结果按路径缓存。
 * ========================================================================== */

import { detectBase, getBase, listDir, candidateBases, setBase, probeBase, normBase } from "./api";
import { KIND, kindOfName, baseNameOf } from "./kinds";
import { iconForKind, ICON_REFRESH, ICON_SETTINGS, ICON_FOLDER, ICON_EMBED } from "./icons";
import { DND_MIME } from "./embed";

const CLS = "lfs";

function el(tag, cls, text) {
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

export class Explorer {
  /**
   * @param {object} plugin 插件实例（要用它的 t()/toast()/openPreview()/settings）
   * @param {HTMLElement} host 宿主容器
   * @param {{pick?:object}} [opts]
   *        `opts.pick` 传进来就进**选择模式**（给斜杠菜单用）：
   *          · 点文件 = 选中它（回调 `pick.onPick`），不再开预览
   *          · 目录行右侧多一个「选它」按钮（`pick.allowDir` 为真时），
   *            用来把整个目录嵌成「目录块」
   *          · 顶部显示 `pick.title` 和「取消」（回调 `pick.onCancel`）
   */
  constructor(plugin, host, opts) {
    this.plugin = plugin;
    this.host = host;
    this.pick = (opts && opts.pick) || null;
    this.cfg = null;
    // ★ 2026-10-10 用户定档：「文件夹默认收拢状态」★
    //   以前这里会 `new Set(plugin.expandedPaths)`，把上次展开的目录在下次
    //   打开面板时**自动展开**回来 —— 用户看到的是"一打开就一堆展开的目录"。
    //   现在一律从**空集**起步：每次打开只看到顶层，点开哪层看哪层。
    //   （也因此不再往 plugin.expandedPaths 写回，见 destroy）
    this.expanded = new Set();
    this.cache = new Map();     // path -> items
    this.busy = new Set();
    this.filter = "";
    this.filterInput = null;
    this.rootEl = null;
    this.treeEl = null;
    this.statusEl = null;
    this.destroyed = false;
    // ★ 当前选中高亮的文件路径 ★
    //   单击只选中（不开任何窗口），双击才在页签中打开 —— 见 _fileNode。
    //   存路径而不是存 DOM：展开/刷新会重建行，靠它把高亮补回来。
    this.activePath = "";
  }

  t(k, fb) {
    return this.plugin.t(k) || fb || k;
  }

  destroy() {
    this.destroyed = true;
    this.cache.clear();
    // ★ 不再把展开状态写回 plugin ★
    //   写回的目的就是"下次打开时恢复"，而用户明确要的是**默认收拢**
    //   ⇒ 不写回，展开状态只在本次面板生命周期内有效。
    if (this.rootEl && this.rootEl.parentNode) this.rootEl.parentNode.removeChild(this.rootEl);
    this.rootEl = null;
    this.host = null;
  }

  // ── 外壳 ────────────────────────────────────────────────────────────
  _buildShell() {
    const root = el("div", CLS + "-panel");
    root.innerHTML = "";

    // 工具条
    const bar = el("div", CLS + "-bar");

    const up = el("button", CLS + "-ibtn");
    up.innerHTML = ICON_REFRESH;
    up.title = this.t("refresh", "刷新");
    up.addEventListener("click", () => this.reloadAll());
    bar.appendChild(up);

    const filter = document.createElement("input");
    filter.className = CLS + "-filter";
    filter.type = "search";
    filter.placeholder = this.t("filterPlaceholder", "筛选已展开的文件名…");
    filter.value = this.filter;
    filter.addEventListener("input", () => {
      this.filter = filter.value.trim().toLowerCase();
      this._applyFilter();
    });
    bar.appendChild(filter);
    this.filterInput = filter;

    const set = el("button", CLS + "-ibtn");
    set.innerHTML = ICON_SETTINGS;
    set.title = this.t("settings", "设置");
    set.addEventListener("click", () => this.plugin.openSettings(() => this.reloadAll()));
    bar.appendChild(set);

    root.appendChild(bar);

    // 选择模式：把"点一下会发生什么"写在最上面，别让用户以为点了会开预览
    if (this.pick) {
      const tip = el("div", CLS + "-pickbar");
      tip.appendChild(el("span", CLS + "-pickbar-text",
        this.pick.title || this.t("pickFileTitle", "选择要嵌入的文件")));
      const cancel = el("button", CLS + "-btn-text", this.t("cancel", "取消"));
      cancel.addEventListener("click", () => {
        if (this.pick.onCancel) this.pick.onCancel();
      });
      tip.appendChild(cancel);
      root.appendChild(tip);
    }

    // 状态条：显示当前连到哪台机器
    const status = el("div", CLS + "-status");
    root.appendChild(status);
    this.statusEl = status;

    // 树
    const tree = el("div", CLS + "-tree");
    root.appendChild(tree);
    this.treeEl = tree;

    this.rootEl = root;
    this.host.appendChild(root);
  }

  _setStatus(ok, text) {
    if (!this.statusEl) return;
    this.statusEl.innerHTML = "";
    const dot = el("span", CLS + "-dot" + (ok ? " is-on" : " is-off"));
    const txt = el("span", CLS + "-status-text", text);
    this.statusEl.appendChild(dot);
    this.statusEl.appendChild(txt);
    this.statusEl.title = text;
  }

  // ── 启动 ────────────────────────────────────────────────────────────
  async start() {
    this._buildShell();
    this._setStatus(false, this.t("connecting", "正在连接本机存储服务…"));
    this._showHint(this.t("connecting", "正在连接本机存储服务…"));

    const plugin = this.plugin;
    // 统一走插件那条探测路径：候选顺序（含 lastBase 该不该用）只在 api.js 一处决定
    let res = await plugin.detect();
    if (!res.health && plugin.settings.baseUrl) {
      // 用户手填过地址但不通 —— 再试一轮"忽略手填地址"的自动候选，
      // 免得换了网络或换了访问入口就废掉
      const auto = await detectBase("", plugin.settings.lastBase);
      if (auto.health) {
        res = auto;
        plugin.base = auto.base;
        plugin.health = auto.health;
      }
    }
    if (this.destroyed) return;

    if (!res.health) {
      plugin.base = "";
      this._setStatus(false, this.t("notConnected", "未连接"));
      this._showOffline();
      return;
    }
    plugin.base = res.base;
    plugin.health = res.health;
    // ★ 注意：这里**不能**顺手把地址写回设置 ★
    //   saveData 会让内核推送"插件数据已变" → 前端重载插件 → 面板重新 start。
    //   把写盘放进这条热路径上就是每秒两次的重载风暴（真机踩过）。
    //   缓存地址只由设置面板的「保存」按钮落盘。
    this.cfg = res.health;

    // 把 sources 也拉一次，拿"存储空间 N"这种带标签的根
    try {
      const c = await this.plugin.apiConfig();
      if (c && c.sources && c.sources.length) this.cfg = Object.assign({}, this.cfg, c);
    } catch (e) {
      /* health 里已有 roots，拿不到标签也不致命 */
    }
    if (this.destroyed) return;

    // ★ 状态栏要反映「实际显示出来的根数」，不是本机存储空间总数 ★
    //   设了常用文件夹时 roots() 只返回那几个 —— 之前这里写死报
    //   `res.health.roots.length`（本机全部空间数），于是用户加了常用文件夹后
    //   树变了、状态栏却还写着"3 个存储空间"，看起来就像"没生效"。
    const shown = this.roots().length;
    const favOn = !!(this.plugin.settings && this.plugin.settings.favorites
      && this.plugin.settings.favorites.length);
    this._setStatus(true, res.base.replace(/^https?:\/\//, "") + "　·　" + shown +
      (favOn ? this.t("favSuffix", " 个常用文件夹") : this.t("spacesSuffix", " 个存储空间")));

    this.renderRoots();
  }

  _showHint(text) {
    if (!this.treeEl) return;
    this.treeEl.innerHTML = "";
    this.treeEl.appendChild(el("div", CLS + "-hint", text));
  }

  /**
   * 连不上时的引导页。
   * ★ 一定要给"手填地址"这条出路 ★
   *   思源**桌面客户端**跑的是本机内核，同源下根本没有这个服务 ——
   *   那种情况下自动探测注定失败，不让填地址就等于这个插件在桌面上用不了。
   */
  _showOffline() {
    if (!this.treeEl) return;
    this.treeEl.innerHTML = "";
    const box = el("div", CLS + "-offline");
    box.appendChild(el("div", CLS + "-offline-title", this.t("offlineTitle", "没有找到本机存储服务")));
    box.appendChild(el("div", CLS + "-offline-body",
      this.t("offlineBody",
        // ★ 2026-10-10：不再提"默认端口 8021" ★
        //   那个端口是插件**内部**的直连口：外网够不到、且绕过反代会丢
        //   Office 的登录态。摆在引导页上只会把人往坑里带 —— 引导页要给的是
        //   "填 6806 这条路"这一个动作。（探测候选里也已删掉 8021。）
        "这个服务由「思源笔记」飞牛应用提供。\n" +
        "如果思源跑在 NAS 上，请确认那个应用在运行；\n" +
        "如果用的是思源桌面客户端，请填 NAS 的 6806，例如 http://192.168.1.10:6806/localfs")));

    const row = el("div", CLS + "-offline-row");
    const input = document.createElement("input");
    input.className = CLS + "-input";
    input.type = "text";
    // ★ 例子给的是 6806 那条路，不是 8021 ★
    //   6806 是对外唯一入口（外网穿透只映射它），Office 文档的飞牛登录态
    //   也由反代在这条路上补 —— 直连 8021 会绕过反代，Office 直接 403。
    input.placeholder = "http://192.168.1.10:6806/localfs";
    input.value = this.plugin.settings.baseUrl || "";
    row.appendChild(input);

    const btn = el("button", CLS + "-btn-text", this.t("testConnect", "连接"));
    btn.addEventListener("click", async () => {
      const raw = normBase(input.value);
      if (!raw) {
        this.plugin.toast(this.t("needAddress", "请先填地址"), true);
        return;
      }
      btn.textContent = this.t("testing", "测试中…");
      btn.disabled = true;
      let h = await probeBase(raw);
      // 允许用户只填 `http://host:8021` 或 `http://host:6806`（后者要自动补 /localfs）
      if (!h && !/\/localfs$/.test(raw)) h = await probeBase(raw + "/localfs");
      const useBase = h ? (/\/localfs$/.test(raw) ? raw : (raw + "/localfs").replace(/\/+$/, "")) : "";
      const finalBase = h && h.ok ? (useBase || raw) : "";
      btn.disabled = false;
      btn.textContent = this.t("testConnect", "连接");
      if (!h) {
        this.plugin.toast(this.t("connectFailed", "连不上这个地址"), true);
        return;
      }
      // 校验一遍：确实能列目录才算数
      const trial = h && h.ok ? (/\/localfs$/.test(raw) ? raw : raw + "/localfs") : raw;
      setBase(trial, h);
      const ok = await this._selftest();
      if (!ok) {
        setBase(raw, h);
        if (!(await this._selftest())) {
          this.plugin.toast(this.t("connectFailed", "连不上这个地址"), true);
          return;
        }
        this.plugin.settings.baseUrl = raw;
      } else {
        this.plugin.settings.baseUrl = trial;
      }
      this.plugin.persist();
      this.plugin.toast(this.t("connected", "已连接"));
      this.restart();
    });
    row.appendChild(btn);
    box.appendChild(row);

    const dbg = el("div", CLS + "-offline-list");
    dbg.appendChild(el("div", CLS + "-offline-list-title", this.t("triedAddresses", "已尝试：")));
    candidateBases(this.plugin.settings.baseUrl).forEach((b) => {
      dbg.appendChild(el("div", CLS + "-offline-item", b));
    });
    box.appendChild(dbg);

    this.treeEl.appendChild(box);
    setTimeout(() => input.focus(), 50);
  }

  /** 拿 getBase() 真去列一次根目录，确认这个地址是"能干活"的 */
  async _selftest() {
    try {
      const r = await listDir("/");
      return !!(r && r.items);
    } catch (e) {
      return false;
    }
  }

  restart() {
    this.destroyed = false;
    this.cache.clear();
    this.busy.clear();
    if (this.rootEl && this.rootEl.parentNode) this.rootEl.parentNode.removeChild(this.rootEl);
    this.rootEl = null;
    return this.start();
  }

  async reloadAll() {
    this.cache.clear();
    this.busy.clear();
    const keep = this.filter;
    this.plugin.base = getBase();
    const ok = await this._selftest();
    if (!ok) {
      this._setStatus(false, this.t("notConnected", "未连接"));
      this._showOffline();
      return;
    }
    this._setStatus(true, getBase().replace(/^https?:\/\//, ""));
    this.renderRoots();
    this.filter = keep;
    if (this.filterInput) this.filterInput.value = keep;
  }

  // ── 根列表 ──────────────────────────────────────────────────────────
  /**
   * 面板顶层要显示哪几项。
   *
   * ★ 「常用文件夹」（需求 #1）★
   *   设置里填了常用文件夹 ⇒ **只**显示这几个（路径即答案，不再列存储空间）；
   *   没填 ⇒ 显示本机全部存储空间（原来那一套 sources/roots）。
   *   这样"显示本地所有"与"只显示选中的"是同一条代码路径的两种输入，
   *   不需要两套渲染。
   */
  roots() {
    const fav = this.plugin.settings && this.plugin.settings.favorites;
    if (fav && fav.length) {
      // 路径就是唯一真源；标签取末段名（/vol1/1000/文档 → 文档）
      return fav.map((p) => ({ path: p, label: baseNameOf(p) || p }));
    }
    const c = this.cfg || {};
    if (c.sources && c.sources.length) {
      return c.sources.map((s) => ({ path: s.path, label: s.label || baseNameOf(s.path) }));
    }
    return (c.roots || []).map((p) => ({ path: p, label: baseNameOf(p) || p }));
  }

  renderRoots() {
    if (!this.treeEl) return;
    const roots = this.roots();
    this.treeEl.innerHTML = "";
    if (!roots.length) {
      this._showHint(this.t("noRoots", "没有发现可用存储空间"));
      return;
    }
    const ul = el("ul", CLS + "-list");
    roots.forEach((r) => {
      ul.appendChild(this._dirNode(r.path, r.label, 0, true));
    });
    this.treeEl.appendChild(ul);
    // 渲染后回到**本次会话内**已展开的那些层（不是"上次打开"的，见构造函数）
    //   ⚠️ 选择器必须打在最外层行上（li 上也有 data-path，先用 data-path 会选到 li）
    this.expanded.forEach((p) => {
      const row = this.treeEl.querySelector('[data-rowpath="' + cssEscape(p) + '"]');
      if (row && row.__lfsExpand) row.__lfsExpand();
    });
    this._applyFilter();
  }

  // ── 节点 ────────────────────────────────────────────────────────────
  _dirNode(path, label, depth, isRoot) {
    const li = el("li", CLS + "-node is-dir");
    li.dataset.path = path;

    const row = el("div", CLS + "-row");
    row.style.paddingLeft = 6 + depth * 14 + "px";
    row.dataset.rowpath = path;

    const caret = el("span", CLS + "-caret");
    caret.textContent = "\u25B8";
    row.appendChild(caret);

    const ico = el("span", CLS + "-ico");
    ico.innerHTML = isRoot ? ICON_FOLDER : iconForKind(KIND.DIR, true, false);
    row.appendChild(ico);

    const name = el("span", CLS + "-name", label);
    name.title = path;
    row.appendChild(name);

    // 选择模式：目录行右侧给一个「选它」——把整个目录嵌成**目录块**
    // （目录本身刻意不做成可拖拽的，见 _fileNode 里的说明）
    if (this.pick && this.pick.allowDir) {
      const pickBtn = el("button", CLS + "-pickdir");
      pickBtn.type = "button";
      pickBtn.innerHTML = ICON_EMBED;
      pickBtn.title = this.t("embedDirToDoc", "嵌入这个目录");
      pickBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pick.onPick({ path: path, name: label, isDir: true });
      });
      row.appendChild(pickBtn);
    }

    const kids = el("ul", CLS + "-list is-children");
    li.appendChild(row);
    li.appendChild(kids);

    const self = this;
    let loaded = false;

    const setExpanded = (on) => {
      const isOn = on != null ? on : !li.classList.contains("is-open");
      if (isOn) {
        li.classList.add("is-open");
        self.expanded.add(path);
        caret.textContent = "\u25BE";
        ico.innerHTML = iconForKind(KIND.DIR, true, true);
        if (!loaded) {
          loaded = true;
          self._loadInto(path, kids, depth + 1);
        }
      } else {
        li.classList.remove("is-open");
        self.expanded.delete(path);
        caret.textContent = "\u25B8";
        ico.innerHTML = iconForKind(KIND.DIR, true, false);
      }
    };
    row.__lfsExpand = () => setExpanded(true);

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      setExpanded();
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      self._menuFor(e.clientX, e.clientY, {
        path: path, name: label, isDir: true,
        onRefresh: () => { loaded = false; kids.innerHTML = ""; if (li.classList.contains("is-open")) { setExpanded(false); setExpanded(true); } },
      });
    });
    // 手机上长按 = 右键
    let pressTimer = null;
    row.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      pressTimer = setTimeout(() => {
        pressTimer = null;
        self._menuFor(t.clientX, t.clientY, {
          path: path, name: label, isDir: true,
          onRefresh: () => { loaded = false; kids.innerHTML = ""; },
        });
      }, 550);
    }, { passive: true });
    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    row.addEventListener("touchend", cancelPress);
    row.addEventListener("touchmove", cancelPress);
    row.addEventListener("touchcancel", cancelPress);

    // ★ 2026-10-10 用户定档：「文件夹默认收拢状态」★
    //   这里原来是 `if (isRoot) setTimeout(() => setExpanded(true), 0);` ——
    //   每渲染一个存储空间就**自动展开它**，于是面板一打开就是"卷名 + 一层子目录"。
    //   用户要的是**全收拢**：打开只看到几个卷名，点哪个看哪个。
    //   副作用是好的：首屏不再为每个卷各发一次 /api/list（展开才请求）。
    //   ⚠️ 别顺手删掉 renderRoots 里那段"恢复本次会话内已展开的" ——
    //     刷新/重渲染时要回到用户自己点开的那些层，那是另一回事。
    return li;
  }

  /**
   * 把「选中高亮」挪到这一行（文件树里同时只有一行是选中的）。
   *
   * ★ 为什么记 activePath 而不是只改类名 ★
   *   展开目录 / 刷新 / 切过滤都会整段重建行 DOM，行上的类会跟着丢；
   *   _fileNode 建行时按 activePath 把高亮补回来。
   *
   * @param {HTMLElement} row  .lfs-row 元素（带 data-rowpath）
   */
  _setActiveRow(row) {
    try {
      const path = (row && row.dataset && row.dataset.rowpath) || "";
      this.activePath = path;
      const scope = this.treeEl || this.rootEl || document;
      scope.querySelectorAll("." + CLS + "-row.is-active").forEach((r) => r.classList.remove("is-active"));
      if (row && path) row.classList.add("is-active");
    } catch (e) { /* 忽略：高亮失败不该影响任何功能 */ }
  }

  async _loadInto(path, kidsUl, depth) {
    kidsUl.innerHTML = "";
    kidsUl.appendChild(el("li", CLS + "-loading-row", this.t("loading", "加载中…")));
    let data;
    try {
      data = this.cache.has(path) ? this.cache.get(path) : await listDir(path);
      if (!this.cache.has(path)) this.cache.set(path, data);
    } catch (e) {
      kidsUl.innerHTML = "";
      const err = el("li", CLS + "-err-row");
      err.textContent = String(e && e.message ? e.message : e);
      kidsUl.appendChild(err);
      return;
    }
    if (this.destroyed) return;
    const items = (data && data.items) || [];
    kidsUl.innerHTML = "";
    if (!items.length) {
      kidsUl.appendChild(el("li", CLS + "-empty-row", this.t("emptyDir", "（空目录）")));
      return;
    }
    items.forEach((it) => {
      if (it.isDir) kidsUl.appendChild(this._dirNode(it.path, it.name, depth, false));
      else kidsUl.appendChild(this._fileNode(it, depth));
    });
    this._applyFilter(kidsUl);
  }

  _fileNode(it, depth) {
    const li = el("li", CLS + "-node is-file");
    li.dataset.path = it.path;
    const row = el("div", CLS + "-row");
    row.style.paddingLeft = 6 + depth * 14 + "px";
    row.dataset.rowpath = it.path;
    // ★ 重渲染后把「选中高亮」补回来 ★
    //   展开目录 / 刷新 / 切过滤都会整段重建行，不补的话选中的那行会"掉色"。
    if (this.activePath === it.path) row.classList.add("is-active");

    row.appendChild(el("span", CLS + "-caret is-leaf"));
    const ico = el("span", CLS + "-ico");
    const kind = kindOfName(it.path);
    ico.innerHTML = iconForKind(kind, false, false);
    row.appendChild(ico);
    const name = el("span", CLS + "-name", it.name);
    name.title = it.path;
    row.appendChild(name);
    if (it.size != null) row.appendChild(el("span", CLS + "-size", fmtSize(it.size)));

    const self = this;
    const node = { path: it.path, name: it.name, size: it.size, kind: kind };

    /**
     * ★ 单击 / 双击 的分工（2026-10-10 用户定档）★
     *   单击　　　　　→ **只把这一行选中高亮**，不打开任何东西
     *   双击　　　　　→ 在思源**页签**里打开（要停在里面细看 / 编辑时用）
     *   Ctrl/⌘+单击　 → 直接开一个**新页签**（显式修饰键，不参与双击判定）
     *
     * 用户原话："单击就在页签中打开，改为双击才在页签中打开。"
     * 顺带把"单击延迟 250ms 再开浮层"那一套整套删了 —— 它存在的唯一理由是
     * 「浏览器一次双击必先发两次 click，怕浮层闪一下又没了」。现在单击没有
     * 副作用（只换高亮），双击前那两次高亮完全无害，延迟与取消都不需要了。
     * ★ 浮层快速预览没下线 ★ 右键菜单的「预览」与预览工具条照样进得去。
     */
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      // 选择模式：点一下就选中它，不做任何打开动作（选中面板那边接管高亮）
      if (self.pick) {
        self.pick.onPick({ path: it.path, name: it.name, size: it.size });
        return;
      }
      // 修饰键：立刻开新页签。这是**显式**操作，不必等第二下
      if (e.ctrlKey || e.metaKey) {
        self._setActiveRow(row);
        self.plugin.openFileInTab(node, { forceNew: true });
        return;
      }
      self._setActiveRow(row);
    });

    row.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (self.pick) return;
      self._setActiveRow(row);
      self.plugin.openFileInTab(node);     // 同一个文件已有页签就复用，不重复开
    });

    // ── 拖进笔记正文 ⇒ 生成「文件块」──────────────────────────────
    //
    // ★ 只给**文件**开 draggable，目录不开 ★
    //   目录要嵌的话有两条更明确的路（右键菜单 / 选择模式里的「选它」），
    //   而"拖"这个手势对目录是含糊的：用户完全可能以为是在移动/上传。
    //   网盘插件那边也是被用户要求取消文件夹拖拽后才收敛成这样的。
    //
    // ⚠️ 实测坑：dragstart 里必须至少 setData 一种类型，否则某些浏览器
    //    根本不认为这次拖拽开始了（连 drop 都不会触发）。
    //    所以除了私有 MIME，再塞一个 text/plain 兜底。
    row.draggable = true;
    row.addEventListener("dragstart", (ev) => {
      try {
        ev.dataTransfer.effectAllowed = "copy";
        ev.dataTransfer.setData(DND_MIME, JSON.stringify({
          kind: "file", path: it.path, name: it.name,
        }));
        ev.dataTransfer.setData("text/plain", it.name || it.path);
      } catch (e) {
        /* 老的/受限的浏览器：静默降级，右键菜单和预览工具栏照样能嵌 */
      }
      row.classList.add("is-dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("is-dragging");
    });

    // 选择模式里不给右键菜单：选择模式下要决定的就是"选哪个"，
    // 弹一堆下载/复制路径反而把用户带偏。
    if (!this.pick) {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        self._menuFor(e.clientX, e.clientY, { path: it.path, name: it.name, size: it.size, isDir: false });
      });
      let pressTimer = null;
      row.addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        pressTimer = setTimeout(() => {
          pressTimer = null;
          self._menuFor(t.clientX, t.clientY, { path: it.path, name: it.name, size: it.size, isDir: false });
        }, 550);
      }, { passive: true });
      const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
      row.addEventListener("touchend", cancel);
      row.addEventListener("touchmove", cancel);
      row.addEventListener("touchcancel", cancel);
    }

    li.appendChild(row);
    return li;
  }

  // ── 右键菜单 ────────────────────────────────────────────────────────
  _menuFor(x, y, node) {
    this._closeMenu();
    // 选择模式下不弹菜单（那一步只该做"选哪个"这一件事）
    if (this.pick) return;
    const menu = el("div", CLS + "-menu");
    const add = (label, fn, disabled) => {
      const it = el("div", CLS + "-menu-item" + (disabled ? " is-disabled" : ""), label);
      if (!disabled) {
        it.addEventListener("click", () => {
          this._closeMenu();
          fn();
        });
      }
      menu.appendChild(it);
    };

    if (!node.isDir) {
      add(this.t("preview", "预览"), () => this.plugin.openPreview(node));
      // ★ 页签入口（与网盘插件对齐）★
      //   浮层是"瞟一眼"，页签是"停在里面看/改"；这两个动作都给到手。
      add(this.t("openInTab", "在页签中打开"), () => this.plugin.openFileInTab(node));
      // ★ 2026-10-10 整理：「在页签中编辑」已删 ★
      //   它的唯一作用是传 mode:"edit"，而 Office / PDF 改用飞牛官方应用后
      //   根本不看这个参数 ⇒ 点了和「在页签中打开」一模一样，属于误导。
      //   要改文件，官方页面里本来就有编辑能力（按文件写权限）。
      // ★ 嵌入块：与拖拽、预览工具栏、斜杠菜单走**同一条通道** ★
      //   （plugin.insertNodeEmbed → embed.js 的 insertEmbedIntoDoc）
      add(this.t("embedToDoc", "嵌入到文档"), () => {
        this.plugin.insertNodeEmbed({ path: node.path, name: node.name });
      });
      add(this.t("download", "下载"), () => this.plugin.downloadNode(node));
      add(this.t("openInBrowser", "在浏览器中打开"), () => this.plugin.openInBrowser(node));
      add(this.t("copyPath", "复制路径"), () => this.plugin.copyText(node.path));
    } else {
      add(this.t("expandAll", "展开这一层"), () => {
        const row = this.treeEl.querySelector('[data-rowpath="' + cssEscape(node.path) + '"]');
        if (row && row.__lfsExpand) row.__lfsExpand();
      });
      add(this.t("refreshOne", "刷新这个目录"), () => {
        this.cache.delete(node.path);
        if (node.onRefresh) node.onRefresh();
      });
      // 目录 → 「目录块」（块里是一个能逐层进去的紧凑清单，不是把整棵树搬进来）
      add(this.t("embedDirToDoc", "嵌入这个目录"), () => {
        this.plugin.insertNodeEmbed({ path: node.path, name: node.name }, { isDir: true });
      });
      add(this.t("copyPath", "复制路径"), () => this.plugin.copyText(node.path));
    }
    add(this.t("copyLink", "复制文件链接"), () => this.plugin.copyText(this.plugin.linkOf(node)), node.isDir);

    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 8);
    const top = Math.min(y, window.innerHeight - r.height - 8);
    menu.style.left = Math.max(4, left) + "px";
    menu.style.top = Math.max(4, top) + "px";
    this._menu = menu;
    this._menuOff = (ev) => {
      if (!menu.contains(ev.target)) this._closeMenu();
    };
    setTimeout(() => document.addEventListener("mousedown", this._menuOff, true), 0);
    setTimeout(() => document.addEventListener("touchstart", this._menuOff, true), 0);
  }

  _closeMenu() {
    if (this._menu && this._menu.parentNode) this._menu.parentNode.removeChild(this._menu);
    this._menu = null;
    if (this._menuOff) {
      document.removeEventListener("mousedown", this._menuOff, true);
      document.removeEventListener("touchstart", this._menuOff, true);
      this._menuOff = null;
    }
  }

  // ── 筛选（作用范围 = 已展开的内容）────────────────────────────────
  _applyFilter(scope) {
    const root = scope || (this.treeEl && this.treeEl.querySelector("." + CLS + "-list"));
    if (!root || !this.treeEl) return;
    const q = this.filter;
    // ★ 只筛"根这一棵树"里的行，避免对同一批行重复遍历
    const lists = scope ? [scope] : Array.from(this.treeEl.querySelectorAll("." + CLS + "-list"));
    lists.forEach((ul) => {
      Array.from(ul.children).forEach((li) => {
        if (!li.classList.contains("is-file")) return;
        const nm = li.querySelector("." + CLS + "-name");
        const hit = !q || (nm && nm.textContent.toLowerCase().indexOf(q) >= 0);
        li.style.display = hit ? "" : "none";
      });
    });
    if (!q) return;
    // 筛的时候把命中的父目录显出来
    lists.forEach((ul) => {
      Array.from(ul.children).forEach((li) => {
        if (!li.classList.contains("is-dir")) return;
        const has = Array.from(li.querySelectorAll(".is-file")).some((f) => f.style.display !== "none");
        li.style.display = has || !ul.classList.contains("is-children") ? "" : "none";
      });
    });
  }
}

/** querySelector 里安全地塞路径（路径里有空格、括号、中文、井号…） */
export function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, "\\$&");
}
