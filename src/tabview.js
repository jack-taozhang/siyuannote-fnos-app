/* ==========================================================================
 * 思源页签视图（预览 / 编辑）
 * --------------------------------------------------------------------------
 * 把「本机存储」里的一个文件开进**思源自己的页签**里，而不是新开浏览器窗口。
 *
 * ★ 为什么不沿用浮层（src/preview.js）★
 *   浮层适合"瞟一眼"：它盖在当前文档上，关掉就没了，位置也不能保存。
 *   要**停在里面看 / 改**（比如一边改 Office 文档一边翻笔记、或者 CAD 图纸
 *   要长时间对着），页签才对 —— 它能并排、能持久、能跟着工作区一起恢复。
 *   两者不是替代关系：浮层工具条上留了「在页签中打开」把内容挪过来。
 *
 * ★ 与网盘插件（siyuan-nebuladisk）对齐的点 ★
 *   · 注册方式：`plugin.addTab({ type, init, destroy })`
 *   · 打开方式：`openTab({ app, custom: { id: 插件名+type, icon, title, data } })`
 *   · 同文件**复用已有页签**，不重复开（见 tryReuseViewerTab）
 *   · 工具条：重新加载 / 下载 / 复制路径 / 嵌入到文档 / 在浏览器中打开
 *
 * ★ 内容渲染不在这里 ★
 *   8 条类型分派全在 src/fileview.js 的 FileView；这里只搭工具条 + 信息条，
 *   也就不会出现"浮层能看 CAD、页签看不了"这种两边不一致。
 * ========================================================================== */

import { KIND, kindOfName, baseNameOf, externalUrlOf } from "./kinds";
import { cadOpenUrl, fileViewerOpenUrl, officeUrl, fileUrl } from "./api";
import { FileView, el, fmtSize, pathParts } from "./fileview";
import {
  ICON_REFRESH, ICON_DOWNLOAD, ICON_EXTERNAL, ICON_EMBED, ICON_COPY, iconForKind,
} from "./icons";

const CLS = "lfs";

/**
 * 页签类型后缀。
 * ★ 思源内部把页签标识拼成「插件名 + type」★
 *   所以 type 只写后缀，真正查图标/找页签时要用 full id。
 */
export const TAB_TYPE = "localfsViewer";

/** 完整页签标识（addTab 的 type 与 custom.id 必须一致） */
export function tabTypeFull(plugin) {
  return (plugin && plugin.name ? plugin.name : "siyuan-localfs") + TAB_TYPE;
}

export class TabView {
  /**
   * @param {HTMLElement} element 思源注入的页签内容容器
   * @param {{path:string,name?:string,size?:number,mode?:string,kind?:string}} data 打开时随 custom.data 带过来的
   * @param {object} plugin 插件实例
   */
  constructor(element, data, plugin) {
    this.el = element;
    this.data = data || {};
    this.plugin = plugin;
    this.destroyed = false;
    this.view = null;
    this.mode = this.data.mode === "edit" ? "edit" : "view";
    this.kind = this.data.kind || kindOfName(this.data.path || "");
    this.render();
  }

  /* ---- 外壳 ---- */
  render() {
    if (this.destroyed) return;
    const d = this.data;
    const name = d.name || baseNameOf(d.path || "");

    this.el.classList.add(CLS + "-tab");
    this.el.innerHTML = "";

    // 工具条（需求 #8 后是页签里**唯一**的一层外壳）
    const bar = el("div", CLS + "-tab-bar");

    const ico = el("span", CLS + "-tab-ico");
    ico.innerHTML = iconForKind(this.kind, false, false);
    bar.appendChild(ico);

    // 标题：显示文件名；完整路径挂在 title 上（悬停可见）
    // ★ 原来这里下面还有一条独立的「信息条」显示路径 + 大小 + 复制路径文字 ★
    //   用户明确要求去掉那层 —— 它等于给每个页签都套了道多余的壳。
    //   信息并没有丢：路径在 title、大小并进标题的悬停文案里。
    const title = el("div", CLS + "-tab-title", "");
    title.textContent = name;
    const segs = pathParts(d.path || "");
    segs.pop();
    const dirText = segs.join("/") || "/";
    title.title = d.path
      ? (d.path + (d.size != null ? "　·　" + fmtSize(d.size) : ""))
      : (d.path || "");
    bar.appendChild(title);

    const spacer = el("div", "fn__flex-1");
    bar.appendChild(spacer);

    const mk = (icon, label, fn, on) => {
      const b = el("button", CLS + "-tab-btn" + (on ? " is-on" : ""), icon);
      b.title = label;
      b.setAttribute("aria-label", label);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn(b);
      });
      return b;
    };

    // ★ 2026-10-10 整理：删掉了「预览 / 编辑」切换按钮 ★
    //   与浮层同一个理由：Office / PDF 的模式由飞牛官方应用按文件写权限自己
    //   决定，插件传的 mode 它不看 ⇒ 按钮点了没有任何变化。

    // ★ 顺序：刷新 / 嵌入 / 下载 / 复制路径 / 浏览器打开 ★
    //   「复制路径」原来在信息条右侧（文字），现在收进这一排、改成图标（需求 #8）。
    bar.appendChild(mk(ICON_REFRESH, this.plugin.t("refresh") || "重新加载", () => {
      this.view.rerender();
    }));
    bar.appendChild(mk(ICON_EMBED, this.plugin.t("embedToDoc") || "嵌入到文档", () => {
      this.plugin.insertNodeEmbed({ path: d.path, name });
    }));
    bar.appendChild(mk(ICON_DOWNLOAD, this.plugin.t("download") || "下载", () => {
      // 走插件统一下载路径：先体检"存在 / 权限"，失败弹对话框而不是吞掉
      this.plugin.downloadNode({ path: d.path, name });
    }));
    bar.appendChild(mk(ICON_COPY, this.plugin.t("copyPath") || "复制路径", () => {
      this.plugin.copyText(d.path || "");
    }));
    bar.appendChild(mk(ICON_EXTERNAL, this.plugin.t("openInBrowser") || "在浏览器中打开", () => {
      // ★ 「新标签打开」⇒ 直连端口版（CAD :8020 / 文件预览 :8030）★
      //   内嵌 iframe 走的是 cadViewerUrl / fileViewerUrl（同源通道，保净化）
      const url = externalUrlOf(d.path,
        { cadViewerUrl: cadOpenUrl, officeUrl, fileViewerUrl: fileViewerOpenUrl, fileUrl },
        {
          layout: this.plugin.isMobileUi() ? "mobile" : "desktop",
        });
      window.open(url, "_blank", "noopener");
    }));

    // 内容区：与浮层共用的渲染核
    const body = el("div", CLS + "-tab-body");
    this.body = body;

    this.el.appendChild(bar);
    this.el.appendChild(body);

    // 内容区：与浮层共用的渲染核。
    // ★ bare="fv" ★ 页签里：
    //   · file-viewer 那条链路 ⇒ 藏掉它自己的左侧文件树与顶部条
    //     （那是"应用外壳"，不是文件内容；嵌在思源页签里纯属重复）
    //   · CAD / Office ⇒ **保留完整工具栏** ★（2026-10-09 需求 3.1）
    //     用户明确要求「页签中的 CAD 要显示完整工具栏」——
    //     之前这里传的是 `true`（全净化），把 CAD 的工具栏也一起剥了，
    //     于是页签里的 CAD 和嵌入块长得一模一样，用户报了这个 bug。
    //     现在 `"fv"` 只对 file-viewer 生效，CAD 不受影响。
    this.view = new FileView({ plugin: this.plugin, container: body, bare: "fv" });
    this.view.show({
      path: d.path,
      name,
      size: d.size,
      kind: this.kind,
    }, this.mode);
  }

  destroy() {
    this.destroyed = true;
    if (this.view) {
      try { this.view.destroy(); } catch (e) { /* 忽略 */ }
      this.view = null;
    }
    try { this.el.classList.remove(CLS + "-tab"); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 「这个文件是不是已经开着页签了？」——是就激活它，别再开一个。
 *
 * ★ 为什么必须做 ★
 *   从文件树双击、浮层按钮、嵌入块按钮三个入口点同一个文件，很容易叠出
 *   三四个同样的页签；每个页签背后都是一个 OnlyOffice 编辑器 / CAD wasm
 *   实例，内存直接翻倍（网盘插件那边用户明确抱怨过）。
 *
 * ★ 各版本思源 getOpenedTab() 的返回形态不一样 ★
 *   可能是数组、也可能是以 type 为键的对象；元素上的 model 位置也不固定。
 *   所以这里全程宽松取值，拿不到就当"没有可复用的"，退化成新开一个 —— 
 *   宁可多开一个，也不要因为版本差异直接抛错。
 *
 * @returns {boolean} 是否真的复用并激活了已有页签
 */
export function tryReuseViewerTab(plugin, item) {
  if (!item || !item.path) return false;
  try {
    const tabs = plugin.getOpenedTab ? plugin.getOpenedTab() : null;
    if (!tabs) return false;
    const list = Array.isArray(tabs) ? tabs : Object.values(tabs);
    for (const t of list) {
      if (!t) continue;
      const d = t.data || (t.model && t.model.data);
      if (!d || d.path !== item.path) continue;
      const model = t.model;
      if (model && typeof model.activate === "function") {
        model.activate();
        return true;
      }
    }
  } catch (e) {
    /* 版本差异 —— 忽略，调用方会新开一个 */
  }
  return false;
}
