/* ==========================================================================
 * 对外契约（供其它插件复用「本机存储」的能力）
 * ==========================================================================
 *
 * ★ 为什么要有这个文件 ★
 *   「盘绘」（siyuan-diskcanvas）里的「网盘文件」入口要改成**读本机存储**。
 *   它需要的其实只有四件事：列目录、拿文件地址、拿预览地址、打开文件。
 *   这四件事本插件已经全部做完了（含地址探测、同源通道、类型分派）——
 *   让消费方自己再实现一遍，就是把同一套规则抄第二份，改一处漏两处。
 *
 *   所以这里把能力**显式暴露**出去，消费方只做转发。
 *   形态刻意与兄弟插件 siyuan-nebuladisk 的 `window.__nebuladiskPlugin.external`
 *   对齐：消费方（画布）那侧已经有一套成熟的"消费契约"写法，可以直接照搬。
 *
 * ★ 对外形状 ★
 *     window.__localfsPlugin = { name: "siyuan-localfs", external: { ... } }
 *
 *   external 上的方法（**全部返回信封，不抛异常穿过边界**）：
 *     health()            → { ok, data:{app,version,roots[]} }
 *     roots()             → { ok, data:[{path,label}] }            本机全部存储空间
 *     list(path)          → { ok, data:{path, items:[{name,path,isDir,size,ext}]} }
 *     probe(path)         → { ok, data:{isDir,readable,size,name,path} }
 *     fileUrl(path)       → { ok, data:"<绝对地址>" }              原生可渲染直链
 *     previewUrl(path)    → { ok, data:"<绝对地址>" }              浏览器可打开的预览地址
 *     openFile(item)      → { ok, data:boolean }                   在思源页签里打开
 *     pickDirectories()   → { ok, data:[{path,name}] }             目录选择器（可多选，取消 = []）
 *     另含 id / version 两个元信息字段。
 *
 *   ★ 信封而不是抛异常 ★
 *     消费方可能在完全不同的上下文里调用（独立网页、跨 realm），
 *     异常穿过边界时常常退化成 "undefined" 一类无法判读的东西。
 *     统一信封 + `reason`（missing / denied / unreachable）能让对方
 *     把"文件不存在"和"服务连不上"分开提示 —— 这两种提示对用户的
 *     行动指引完全不同（重试 vs 找文件）。
 *
 * ★ 边界纪律（与网盘插件那条契约同款）★
 *   · **本插件不认识任何消费方**。契约只描述"我能做什么"，
 *     里面不出现 "canvas" / "盘绘" 之类的字眼。
 *   · **地址一律由本插件构造**。消费方拿到的是可以直接塞进
 *     `<img src>` / `window.open` 的成品地址，不需要知道
 *     /localfs 同源通道、8021 直连端口、CAD/Office 的宿主应用端口这些内部知识。
 * ========================================================================== */

import {
  cadViewerUrl, fileUrl, fileViewerUrl, getHealth, listDir, officeUrl, probeFile,
} from "./api";
import { baseNameOf, externalUrlOf } from "./kinds";
import { openDirPicker } from "./settings";

export const EXTERNAL_ID = "localfs.external";
export const EXTERNAL_VERSION = 1;

/** 成功信封 */
function ok(data) {
  return { data, ok: true };
}

/**
 * 失败信封。
 * @param {*} error  原始信息（人看）
 * @param {string} reason 语义分类：missing / denied / unreachable / ""
 */
function fail(error, reason) {
  return { error: String(error == null ? "" : error), ok: false, reason: reason || "" };
}

/**
 * 把异常归类成 reason。
 *
 * ★ 为什么要分类而不是直接把 message 丢出去 ★
 *   消费方要据此决定提示语。"文件不存在"该建议刷新列表，
 *   "连不上"该建议检查服务 —— 两者都无法从 HTTP 文本里可靠区分。
 *   `apiGet` 抛的 Error 上挂了 `status`（见 src/api.js），这里优先用它；
 *   没有 status 的基本都是网络层失败（fetch reject / 超时）。
 */
function reasonOf(err) {
  const status = err && err.status;
  if (status === 404) return "missing";
  if (status === 403 || status === 401) return "denied";
  const msg = String((err && err.message) || err || "");
  if (!status
    || /Failed to fetch|NetworkError|Network request failed|ERR_|timeout|超时|abort/i.test(msg)) {
    return "unreachable";
  }
  return "";
}

/** 统一把 "可能抛异常的实现" 包成信封 */
async function guard(fn) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail((e && e.message) || e, reasonOf(e));
  }
}

/**
 * 本机全部存储空间。
 *
 * ★ 为什么**先**问 /api/config 而不是直接用 health.roots ★
 *   `/api/health` 的 `roots` 只有**裸路径**（`["/vol00","/vol1"]`），
 *   而 `/api/config` 的 `sources` 带**人类可读标签**（`存储空间 0`）。
 *   独立页/画布的选择器会把 label 直接显示在下拉框里，只用裸路径的话
 *   界面写 `vol00`、本插件自己的侧栏写 `存储空间 0` —— 同一个根两个名字。
 *   本插件侧边栏（`explorer.js` 的 `start`）也是这个优先级，保持一致。
 *   ★ 代价是打开选择器时多一次 `/api/config`（仅此一次）；
 *     失败就退回 health.roots，标签退化成 `baseNameOf`，功能不受影响。
 *
 * ★ 为什么**不**读 plugin.settings.favorites ★
 *   「常用文件夹」是本插件的**显示偏好**（面板顶层只显示那几个）。
 *   而契约是给消费方用的原始能力 —— 消费方有自己的常用文件夹设置，
 *   要的是"这台机器上有哪些存储空间"这个**客观事实**。
 *   把偏好混进能力里，消费方就再也没法拿到完整列表了。
 */
async function allRoots(plugin) {
  await plugin.ensureBase();
  try {
    const c = await plugin.apiConfig();
    if (c && Array.isArray(c.sources) && c.sources.length) {
      return c.sources.map((s) => ({
        label: s.label || baseNameOf(s.path) || s.path,
        path: s.path,
      }));
    }
    if (c && Array.isArray(c.roots) && c.roots.length) {
      return c.roots.map((p) => ({ label: baseNameOf(p) || p, path: p }));
    }
  } catch (e) {
    /* 落到 health 兜底，让消费方至少能列出存储空间 */
  }
  const h = getHealth();
  return ((h && h.roots) || []).map((p) => ({ label: baseNameOf(p) || p, path: p }));
}

/**
 * 构造契约对象。
 * @param {object} plugin 插件实例（用它的 ensureBase / apiConfig / openFileInTab）
 */
function createExternal(plugin) {
  return {
    /** 探测是否连得上（含版本信息），消费方可用它做"能力体检" */
    health() {
      return guard(async () => {
        await plugin.ensureBase();
        return getHealth();
      });
    },

    id: EXTERNAL_ID,

    /** 列目录。目录不存在时后端返回 code 404（HTTP 仍是 200），由 apiGet 归类 */
    list(path) {
      return guard(async () => {
        await plugin.ensureBase();
        const r = await listDir(path || "/");
        return {
          items: (r && r.items) || [],
          path: (r && r.path) || path || "/",
        };
      });
    },

    /** 在思源页签里打开（本插件自己的打开链路，含类型分派与体检） */
    openFile(item) {
      return guard(async () => {
        const node = item || {};
        if (!node.path) throw new Error("缺少 path");
        return plugin.openFileInTab({
          kind: node.kind,
          name: node.name || baseNameOf(node.path),
          path: node.path,
          size: node.size,
        });
      });
    },

    /** 目录选择器（本插件设置面板里那个多选器），取消返回空数组 */
    pickDirectories() {
      return guard(() => new Promise((resolve) => {
        openDirPicker(plugin, (picked) => resolve(Array.isArray(picked) ? picked : []));
      }));
    },

    /** 浏览器可直接打开的预览地址（CAD / Office / 原生类型三档由 kinds.js 分派） */
    previewUrl(path) {
      return guard(async () => {
        await plugin.ensureBase();
        return externalUrlOf(path, { cadViewerUrl, fileUrl, fileViewerUrl, officeUrl }, {
          layout: plugin.isMobileUi() ? "mobile" : "desktop",
          mode: "view",
        });
      });
    },

    /** 单文件元数据（存在性 / 可读性 / 是否目录 / 大小） */
    probe(path) {
      return guard(() => probeFile(path));
    },

    /** 本机全部存储空间 */
    roots() {
      return guard(() => allRoots(plugin));
    },

    /** 原生可渲染直链（图片 / 音视频 / 文本直接塞 <img>/<video>/<a>） */
    fileUrl(path) {
      return guard(async () => {
        await plugin.ensureBase();
        return fileUrl(path);
      });
    },

    version: EXTERNAL_VERSION,
  };
}

/**
 * 把契约挂到 window 上。返回一个"卸载器"。
 *
 * ★ 为什么要返回卸载器并做身份判断 ★
 *   插件重载（onunload → onload）时会把 window 上的对象换成新的。
 *   如果旧实例的 onunload 晚于新实例的 onload 执行，直接 `delete`
 *   会把**新装上去的那个**删掉 —— 消费方随后就看不到契约了。
 *   所以只在"当前那个还是我装的"时才删。
 *
 * @returns {() => void}
 */
export function installExternal(plugin) {
  if (typeof window === "undefined") return () => {};
  const api = { external: createExternal(plugin), name: plugin.name };
  window.__localfsPlugin = api;
  return () => {
    try {
      if (window.__localfsPlugin === api) delete window.__localfsPlugin;
    } catch (e) {
      /* 删不掉也不致命：下一次 onload 会覆盖它 */
    }
  };
}
