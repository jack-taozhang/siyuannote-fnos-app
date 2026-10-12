/* ==========================================================================
 * 预览层（页内浮层，不用思源 Dialog）
 * --------------------------------------------------------------------------
 * ★ 为什么自己画浮层 ★
 *   → 我们要铺满整屏看图纸 / Office，思源 Dialog 的默认尺寸与层级都要反复对抗；
 *   → 这个插件还会被嵌在**飞牛 App 的 iframe** 里跑，任何"新开窗口"的路子都会
 *     被弹窗拦截或者跳到 iframe 外，行为不可控；
 *   → 自己画一个 fixed 浮层，桌面/网页/手机三种布局都好调，也不受思源版本影响。
 *
 * ★ 本文件只管"外壳"（遮罩 / 标题条 / 工具条）★
 *   内容怎么按类型渲染，全在 src/fileview.js 的 FileView 里 —— 页签视图
 *   （src/tabview.js）用的是同一个 FileView，两边不会各写一套分派。
 *
 * ★ 浮层与页签的分工 ★
 *   浮层 = 「不打扰当前排版，快速瞟一眼」；页签 = 「要停在里面细看 / 编辑」。
 *   所以工具条上有「在页签中打开」，把浮层里看到的东西一键挪进页签。
 *
 * ── 2026-10-09 三处 UI 改造（用户要求）─────────────────────────────
 *   ① **顶部贴合**：标题条紧贴内容区，去掉中间那道背景缝；
 *   ② **上一个 / 下一个**：在同一目录的文件之间直接翻，不用回面板再点；
 *   ③ **操作条可折叠**：标题以外的按钮能收起来，把纵向空间让给内容。
 * ========================================================================== */

import { kindOfName, baseNameOf, externalUrlOf } from "./kinds";
import { cadOpenUrl, officeUrl, fileViewerOpenUrl, fileUrl, downloadFile, validateOpen } from "./api";
import { FileView, el, fmtSize, pathParts } from "./fileview";
import { showValidateError } from "./dialog";
import {
  ICON_CLOSE, ICON_DOWNLOAD, ICON_EXTERNAL, ICON_REFRESH, ICON_EMBED, ICON_TAB,
  ICON_PREV, ICON_NEXT, ICON_COLLAPSE, ICON_EXPAND,
  iconForKind,
} from "./icons";

const CLS = "lfs";

/** 「操作条折叠」的用户偏好键（localStorage，跨会话记住） */
const COLLAPSE_KEY = "lfs.preview.toolsCollapsed";

/**
 * 浮层单例。同一时刻只显示一个预览，避免手机上叠成一堆。
 */
export class Preview {
  constructor(plugin) {
    this.plugin = plugin;
    this.mask = null;
    this.modal = null;
    this.body = null;
    this.titleEl = null;
    this.metaEl = null;
    this.toolsEl = null;
    this.navEl = null;
    this.item = null;
    this.mode = "view";
    this.onKey = null;
    this.view = null;
    /** 兄弟文件（供上一个/下一个）；{items:[{path,name,size}], index:number} */
    this.siblings = { items: [], index: -1 };
    /** 操作条是否折叠 */
    this.collapsed = readCollapsed();
    /** 体检进行中的标志，防连点 */
    this._busy = false;
  }

  /** 当前是否正在显示 */
  get opened() {
    return !!this.mask;
  }

  close() {
    if (!this.mask) return;
    try {
      document.removeEventListener("keydown", this.onKey, true);
    } catch (e) {
      /* 忽略 */
    }
    if (this.view) this.view.destroy();
    this.view = null;
    if (this.mask.parentNode) this.mask.parentNode.removeChild(this.mask);
    this.mask = null;
    this.modal = null;
    this.body = null;
    this.item = null;
    this.navEl = null;
  }

  _buildShell() {
    const mask = el("div", CLS + "-mask is-preview");
    // ★ 贴顶：is-flush 把 modal 的上边距清零（见 CSS）
    const modal = el("div", CLS + "-modal is-preview is-flush" + (this.collapsed ? " is-bar-collapsed" : ""));

    // ── 标题条 ────────────────────────────────────────────────────
    const head = el("div", CLS + "-head");
    const left = el("div", CLS + "-head-left");
    const ico = el("span", CLS + "-head-ico");
    const title = el("div", CLS + "-head-title");
    const meta = el("div", CLS + "-head-meta");
    left.appendChild(ico);
    const tbox = el("div", CLS + "-head-tbox");
    tbox.appendChild(title);
    tbox.appendChild(meta);
    left.appendChild(tbox);

    const tools = el("div", CLS + "-tools");

    head.appendChild(left);
    head.appendChild(tools);

    // ── 导航条（上一个 / 下一个）────────────────────────────────
    //   单独一条，和工具条分开：它承载的是"位置感"，不该被"折叠操作条"藏掉。
    const nav = el("div", CLS + "-navbar");

    const body = el("div", CLS + "-body");

    modal.appendChild(head);
    modal.appendChild(tools);   // ★ 操作条独立成一行，便于整体折叠
    modal.appendChild(nav);
    modal.appendChild(body);
    mask.appendChild(modal);
    document.body.appendChild(mask);

    this.mask = mask;
    this.modal = modal;
    this.body = body;
    this.titleEl = title;
    this.metaEl = meta;
    this.toolsEl = tools;
    this.icoEl = ico;
    this.navEl = nav;

    // 内容区交给共享的渲染核（与页签视图同一个类）
    this.view = new FileView({ plugin: this.plugin, container: body });

    // 点遮罩关（点面板本体不关）
    mask.addEventListener("click", (e) => {
      if (e.target === mask) this.close();
    });
    this.onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
        return;
      }
      // ★ 键盘左右翻页 ★ —— 只在"焦点不在输入框里"时生效，
      //   否则用户在编辑器里按方向键会被抢走。
      if (this._isTextTarget(e.target)) return;
      const nav = navInfo(this.siblings);
      if (!nav) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault(); e.stopPropagation(); this._goto(nav.index - 1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault(); e.stopPropagation(); this._goto(nav.index + 1);
      } else if (e.key === "Home" && nav.index > 0) {
        e.preventDefault(); e.stopPropagation(); this._goto(0);
      } else if (e.key === "End" && nav.index < nav.total - 1) {
        e.preventDefault(); e.stopPropagation(); this._goto(nav.total - 1);
      }
    };
    document.addEventListener("keydown", this.onKey, true);
    return this;
  }

  /** 焦点是否落在会吃方向键的元素上（输入框 / 可编辑区） */
  _isTextTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  _tool(icon, label, onClick, extraCls) {
    const b = el("button", CLS + "-btn" + (extraCls ? " " + extraCls : ""), icon);
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(b);
    });
    return b;
  }

  /**
   * 打开预览。
   * @param {{path:string,name:string,size?:number,isDir?:boolean}} item
   * @param {"view"|"edit"} [mode] 仅对 Office 有意义；其余类型忽略
   * @param {{items:Array,index:number}} [siblings] 同目录文件清单（供上下翻）
   */
  open(item, mode, siblings) {
    if (!item || item.isDir) return this;
    const want = mode === "edit" ? "edit" : "view";

    // ★ 同一个文件、同一个模式、已经在显示 ⇒ 直接忽略 ★
    //   双击会连着发两次 click，第二次"关掉重建"等于把刚起来的预览掐掉重来 ——
    //   对用户就是一下明显的白闪，而且 CAD/Office 的 iframe 会重新拉一遍
    //   （几 MB 的查看器 + 9.5MB 的 wasm）。第一次的加载还在路上，这次点击什么都不该做。
    if (this.mask && this.item && this.item.path === item.path && this.mode === want) {
      // 但邻居清单可能是后到的，补上导航条即可
      if (siblings) { this.siblings = siblings; this._renderNav(); }
      return this;
    }

    const keepCollapsed = this.collapsed;
    this.close();
    this.collapsed = keepCollapsed;
    this._buildShell();
    this.item = item;
    this.mode = want;
    this.siblings = siblings || { items: [], index: -1 };

    this._renderHead();
    this._renderTools();
    this._renderNav();
    this.view.show(item, want);
    return this;
  }

  /** 标题条内容（标题 / 路径 / 大小 / 折叠按钮） */
  _renderHead() {
    const item = this.item;
    const kind = kindOfName(item.path);
    const name = item.name || baseNameOf(item.path);
    this.titleEl.textContent = name;
    this.titleEl.title = item.path;
    this.icoEl.innerHTML = iconForKind(kind, false, false);

    const segs = pathParts(item.path);
    segs.pop();
    const dirText = segs.join("/") || "/";
    const nav = navInfo(this.siblings);
    const posText = nav ? `　·　${nav.index + 1}/${nav.total}` : "";
    this.metaEl.textContent = dirText + (item.size != null ? "  ·  " + fmtSize(item.size) : "") + posText;

    // 折叠按钮放在标题条右侧（工具条会被整个收起，它不能跟着消失）
    if (!this.toolsEl.__hasCollapse) {
      const btn = el("button", CLS + "-btn is-collapse");
      const sync = () => {
        btn.innerHTML = this.collapsed ? ICON_EXPAND : ICON_COLLAPSE;
        btn.title = this.collapsed
          ? (this.plugin.t("expandTools") || "展开操作条")
          : (this.plugin.t("collapseTools") || "收起操作条");
      };
      btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        this.collapsed = !this.collapsed;
        writeCollapsed(this.collapsed);
        if (this.modal) this.modal.classList.toggle("is-bar-collapsed", this.collapsed);
        sync();
      });
      this.toolsEl.__hasCollapse = btn;   // 存引用，重建时不重复加
      sync();
      this.toolsEl.appendChild(btn);
    }
  }

  // ★ 2026-10-10 整理：_setMode() 已删除 ★
  //   它唯一的调用者是工具条上那个「预览/编辑」切换按钮，而 Office / PDF 改用
  //   飞牛官方应用后不吃 mode 参数 ⇒ 按钮点了没反应，两者一起下线。

  _renderTools() {
    const T = this.toolsEl;
    // 保留折叠按钮（它由 _renderHead 挂上）
    const collapseRef = T.__hasCollapse;
    T.innerHTML = "";
    const item = this.item;

    // ★ 2026-10-10 整理：删掉了「预览 / 编辑」切换按钮 ★
    //   它靠 canToggleEdit(kind) 判断出现，而 Office / PDF 换飞牛官方应用后
    //   模式由服务端按文件写权限决定、不吃 URL 参数 ⇒ 按钮点了也没变化。

    T.appendChild(this._tool(ICON_REFRESH, this.plugin.t("refresh") || "刷新", () => {
      this.view.rerender();
    }));

    // 在页签中打开：把这个文件挪进思源页签
    // ★ skipGuard：这里的内容刚刚已经渲染成功，没必要再体检一次 ★
    T.appendChild(this._tool(ICON_TAB, this.plugin.t("openInTab") || "在页签中打开", () => {
      this.plugin.openFileInTab({
        path: item.path,
        name: item.name || baseNameOf(item.path),
        size: item.size,
      }, { skipGuard: true });
    }));

    // 嵌入到文档：与文件树右键、拖拽、斜杠菜单同一条通道
    T.appendChild(this._tool(ICON_EMBED, this.plugin.t("embedToDoc") || "嵌入到文档", () => {
      this.plugin.insertNodeEmbed({
        path: item.path,
        name: item.name || baseNameOf(item.path),
      });
    }));

    T.appendChild(this._tool(ICON_EXTERNAL, this.plugin.t("openInBrowser") || "在浏览器中打开", () => {
      // ★ 「新标签打开」⇒ 直连端口版（CAD :8020 / 文件预览 :8030）★
      //   内嵌 iframe 走的是 cadViewerUrl / fileViewerUrl（同源通道，保净化）
      const url = externalUrlOf(item.path,
        { cadViewerUrl: cadOpenUrl, officeUrl, fileViewerUrl: fileViewerOpenUrl, fileUrl },
        {
          layout: this.plugin.isMobileUi() ? "mobile" : "desktop",
        });
      window.open(url, "_blank", "noopener");
    }));

    T.appendChild(this._tool(ICON_DOWNLOAD, this.plugin.t("download") || "下载", async () => {
      try {
        await downloadFile(item.path, item.name || baseNameOf(item.path));
      } catch (e) {
        this.plugin.toast(String(e && e.message ? e.message : e), true);
      }
    }));

    T.appendChild(this._tool(ICON_CLOSE, this.plugin.t("close") || "关闭", () => this.close(), "is-close"));

    // 折叠按钮放最右（顺序：… 关闭 | 折叠）
    if (collapseRef) T.appendChild(collapseRef);
  }

  /** 渲染「上一个 / 下一个」条 */
  _renderNav() {
    const N = this.navEl;
    if (!N) return;
    N.innerHTML = "";
    const nav = navInfo(this.siblings);
    if (!nav) {
      N.classList.add("is-hidden");
      return;
    }
    N.classList.remove("is-hidden");

    const prev = el("button", CLS + "-nav-btn");
    prev.innerHTML = ICON_PREV;
    prev.title = this.plugin.t("prevFile") || "上一个（←）";
    prev.disabled = nav.index <= 0;
    prev.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      this._goto(nav.index - 1);
    });

    const next = el("button", CLS + "-nav-btn");
    next.innerHTML = ICON_NEXT;
    next.title = this.plugin.t("nextFile") || "下一个（→）";
    next.disabled = nav.index >= nav.total - 1;
    next.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      this._goto(nav.index + 1);
    });

    const label = el("div", CLS + "-nav-label");
    const cur = this.siblings.items[nav.index];
    label.textContent = (cur ? cur.name : "") + "　" + (nav.index + 1) + " / " + nav.total;
    label.title = cur ? cur.path : "";

    N.appendChild(prev);
    N.appendChild(label);
    N.appendChild(next);
  }

  /**
   * 跳到兄弟清单的第 idx 个。
   * ★ 先体检再开 ★ —— 邻居可能是刚被删掉的文件，直接换会白屏；
   *   体检失败就弹对话框并**留在原地**（别把用户甩到空白页）。
   */
  async _goto(idx) {
    const nav = navInfo(this.siblings);
    if (!nav) return;
    if (idx < 0 || idx >= nav.total) return;
    if (this._busy) return;
    const target = this.siblings.items[idx];
    if (!target) return;

    this._busy = true;
    // 导航条立刻反馈（置灰，防连点）
    this._renderNav();
    let res;
    try {
      res = await validateOpen(target.path);
    } finally {
      this._busy = false;
    }
    if (!res.ok) {
      showValidateError(res, {
        title: "无法打开下一个文件",
        onOk: () => {
          // 从清单里剔掉它，避免反复撞同一个坏文件
          this.siblings.items.splice(idx, 1);
          this.siblings.index = Math.min(nav.index, this.siblings.items.length - 1);
          this._renderNav();
        },
      });
      return;
    }

    this.siblings.index = idx;
    this.item = {
      path: target.path,
      name: target.name,
      size: (res.info && res.info.size != null) ? res.info.size : target.size,
      kind: kindOfName(target.path),
    };
    // 同一个文件、同一个模式：走 open 的"复用"分支（会补导航条）
    this._renderHead();
    this._renderTools();
    this._renderNav();
    this.view.show(this.item, this.mode);
  }
}

/* ── 小工具 ──────────────────────────────────────────────────────── */

/** 规范化导航信息；不足两个文件就返回 null（隐藏导航条） */
function navInfo(sib) {
  if (!sib || !sib.items || sib.items.length < 2) return null;
  const index = sib.index >= 0 && sib.index < sib.items.length ? sib.index : 0;
  return { total: sib.items.length, index: index };
}

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function writeCollapsed(v) {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
  } catch (e) {
    /* 隐私模式，忽略 */
  }
}
