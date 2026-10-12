/* ==========================================================================
 * 文件类型判定与预览方式的选择
 * --------------------------------------------------------------------------
 * ★ 预览链路（2026-10-10 第三次调整：Office 换主）★
 *
 *   用户拍板的路由表：
 *     · OFFICE（doc/docx/xls/ppt…）→ **飞牛官方「Office文档」**（可编辑）
 *     · PDF                        → 同上（官方那套自己就是 OO 内核，PDF 归它）
 *     · CAD（dwg/dxf/dwf）         → **飞牛原生「CAD 看图」应用**（同源通道）
 *     · IMAGE / AUDIO / VIDEO / TEXT / MARKDOWN
 *                                  → **思源原生渲染**（<img>/<video>/<audio>/只读文本）
 *     · 其余（压缩包 / 3D / OFD / 邮件…）
 *                                  → **file-viewer 兜底**（它就是要干这个的）
 *
 *   ★ 三条「借用飞牛应用」的链路**一律走 6806 同源通道**（用户 2026-10-10 定档）★
 *     CAD / 文件预览 / Office 都不再直连各自的应用端口：
 *     外网穿透只映射 6806（直连够不到），且净化要靠同源注入样式。
 *     细节见 api.js 的 channelUrl。
 *   ★ Office 为什么从"自研 OnlyOffice 容器"换成"官方那套" ★
 *     ① 官方那套格式集合大得多（见下面 office 集合，含 wps/et/dps/epub/djvu…）；
 *     ② 与 CAD / 文件预览统一成"借用飞牛应用"的形态，少维护一个容器；
 *     ③ 它自己的页面**不需要正文改写**（按 X-Forwarded-Host 自己拼地址）。
 *     ⚠️ 代价：它**要飞牛登录态** ⇒ 桌面客户端要先「同步飞牛登录态」。
 *
 *   ★ 为什么"能自己画的就自己画" ★
 *     file-viewer 是一个"应用"，它带自己的左侧文件树、顶部条、错误卡片 ——
 *     嵌进来永远要跟它的外壳打架（需求 3.3 那一层就是它的 error overlay）。
 *     而图片/音视频/文本用浏览器原生标签 <img>/<video>/<audio>/<pre> 就是
 *     最干净的预览：**没有外壳、没有跨源、没有额外请求**，还快。
 *
 * ⚠️ 大小写：NAS 上中文名 + 大写的 `.DWG` 很常见（实测就有
 *    `2# 3#厂房(+仓库区域规划)2025.07.29.DWG`），所以一律先 toLowerCase。
 * ========================================================================== */

export const KIND = {
  DIR: "dir",
  CAD: "cad",
  OFFICE: "office",
  IMAGE: "image",
  PDF: "pdf",
  AUDIO: "audio",
  VIDEO: "video",
  MARKDOWN: "markdown",
  TEXT: "text",
  ARCHIVE: "archive",
  OTHER: "other",
};

/**
 * 渲染器：把 KIND 映射成"用哪条链路画"。
 *
 *   · "office"   → 飞牛官方「Office文档」trim.docs（含 PDF），同源通道
 *   · "cad"      → 飞牛原生「CAD 看图」应用（/localfs/cad/）
 *   · "native"   → 思源/浏览器原生标签（图片、音视频、文本）
 *   · "fileviewer" → fnos-file-viewer 兜底
 */
export const RENDERER = {
  OFFICE: "office",
  CAD: "cad",
  NATIVE: "native",
  FILEVIEWER: "fileviewer",
};

const RENDERER_OF_KIND = {
  // PDF 走 Office：官方那套本来就是 OnlyOffice 内核，pdf 也在它自己的
  // fileTypes 清单里（见 .verify/_trimdocs-uiconfig.json），打开即只读阅读器。
  [KIND.PDF]: RENDERER.OFFICE,
  [KIND.OFFICE]: RENDERER.OFFICE,
  [KIND.CAD]: RENDERER.CAD,
  [KIND.IMAGE]: RENDERER.NATIVE,
  [KIND.AUDIO]: RENDERER.NATIVE,
  [KIND.VIDEO]: RENDERER.NATIVE,
  [KIND.TEXT]: RENDERER.NATIVE,
  [KIND.MARKDOWN]: RENDERER.NATIVE,
  // 其余（含压缩包、3D、OFD、eml…）交给 file-viewer —— 它内置 200+ 格式解析，
  // 这些我们不可能自己实现。
};

/** 根据 KIND（或直接给路径）决定用哪条渲染链路 */
export function rendererOf(kind) {
  return RENDERER_OF_KIND[kind] || RENDERER.FILEVIEWER;
}

export function rendererOfPath(path) {
  return rendererOf(kindOfName(path));
}

/**
 * 「在浏览器中打开」该用哪个地址。
 *
 * ★ 为什么要收成一个函数 ★
 *   同一个判断（CAD → 查看器 / Office+PDF → OO / 其余 → file-viewer）
 *   原先在 preview.js 与 tabview.js 各写了一遍，加"PDF 归 OO"这类改动时
 *   极容易只改一处、另一处还按老规矩走（页签里点"浏览器打开"跳到错的地方）。
 *   现在只有一个实现，两处都调它。
 *
 * ★ 原生链路（图片/音视频/文本）返回什么 ★
 *   返回**原始文件地址** —— 那是浏览器最擅长的，直接就能看/听/下载。
 *   注意这里要 `fileUrl` 而不是 file-viewer 页面：对图片来说
 *   "在新标签打开原图"才是用户想要的。
 *
 * @param {string} path
 * @param {{cadViewerUrl:string, officeUrl:string, fileViewerUrl:string, fileUrl:string}} urls
 *        由调用方注入（避免 kinds.js 反向依赖 api.js）
 * @param {{mode?:string, layout?:string}} [opt]
 */
export function externalUrlOf(path, urls, opt) {
  const o = opt || {};
  const r = rendererOfPath(path);
  if (r === RENDERER.CAD) return urls.cadViewerUrl(path);
  if (r === RENDERER.OFFICE) {
    return urls.officeUrl(path, o.mode || "view", o.layout || "desktop");
  }
  if (r === RENDERER.NATIVE) return urls.fileUrl(path);
  return urls.fileViewerUrl(path);
}

// ★ 2026-10-10 整理：canToggleEdit() 已删除 ★
//   Office / PDF 换成飞牛官方那套之后，它的编辑页**自己决定模式**（按文件的
//   写权限；页面实测不读任何查询参数，`static/editor.html` 里没有一处
//   `location.search`）⇒ 我们传的 mode 不会改变它的行为，插件里的「预览/编辑」
//   切换按钮点了和没点一样。三个调用点（文件树菜单、浮层工具条、页签工具条）
//   与这个函数一起下线；要改文件，官方页面自身的编辑能力照用。

const SETS = {
  cad: ["dwg", "dxf", "dwf"],
  /**
   * ★ 与飞牛官方「Office文档」的 `fileTypes` 对齐 ★
   *   清单来源 = 该应用的 `ui/config`（实测取回，存在
   *   `.verify/_trimdocs-uiconfig.json`），不是猜的。
   * ★ 刻意**不包含** md / txt / xml / htm / html / csv ★
   *   官方清单里确实有这几个，但它们在思源侧有更干净的 **native** 渲染
   *   （<pre> 直接看源码，没有启动编辑器的开销）⇒ 留在 text / markdown 集合里。
   *   注意 `SETS` 的键序 = 覆盖顺序（后面的覆盖前面的），text 在最后。
   */
  office: [
    // 文字处理
    "doc", "docm", "docx", "dot", "dotm", "dotx", "odt", "ott", "fodt",
    "rtf", "stw", "sxw", "wps", "wpt", "pages", "epub", "fb2",
    "hwp", "hwpx", "mht", "mhtml",
    // 表格
    "xls", "xlsm", "xlsx", "xlsb", "xlt", "xltm", "xltx",
    "ods", "ots", "fods", "sxc", "et", "ett", "numbers",
    // 演示
    "ppt", "pptx", "pptm", "pot", "potm", "potx", "pps", "ppsm", "ppsx",
    "odp", "otp", "fodp", "sxi", "dps", "dpt", "key", "odg",
    // 官方也认的其余格式（OO 系内核：DjVu / 表单 / XPS）
    "djvu", "docxf", "oform", "oxps", "xps",
    // Visio
    "vsdm", "vsdx", "vssm", "vssx", "vstm", "vstx",
  ],
  image: [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif",
    "tif", "tiff", "heic", "heif",
  ],
  pdf: ["pdf"],
  audio: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "oga", "opus", "wma", "ape"],
  video: ["mp4", "webm", "mkv", "mov", "avi", "m4v", "ts", "ogv", "flv", "wmv"],
  markdown: ["md", "markdown", "mdx"],
  // 压缩包：交给 file-viewer（它能列包内目录、单文件预览）
  archive: [
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz",
    "zst", "lz", "lzma", "cab", "iso", "jar", "war", "apk", "ipa", "deb", "rpm",
  ],
  text: [
    "txt", "log", "json", "jsonc", "xml", "yml", "yaml", "ini", "conf", "cfg",
    "toml", "env", "properties", "csv", "tsv", "sh", "bash", "zsh", "bat",
    "cmd", "ps1", "py", "js", "mjs", "cjs", "ts", "jsx", "tsx", "css", "scss",
    "less", "html", "htm", "vue", "java", "kt", "c", "h", "cpp", "hpp", "cc",
    "cs", "go", "rs", "php", "rb", "pl", "lua", "sql", "r", "m", "swift",
    "gradle", "diff", "patch", "srt",
  ],
};

const MAP = {};
Object.keys(SETS).forEach((kind) => {
  (SETS[kind] || []).forEach((ext) => {
    MAP[ext] = kind;
  });
});

/** 取小写扩展名（含点，如 ".dwg"）；没有扩展名返回 "" */
export function extOf(path) {
  const name = String(path || "").split("/").pop() || "";
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i).toLowerCase();
}

/** 取不带扩展名的文件名 */
export function baseNameOf(path) {
  return String(path || "").split("/").pop() || "";
}

export function kindOf(path) {
  const ext = extOf(path).replace(/^\./, "");
  return MAP[ext] || KIND.OTHER;
}

/** 某些后缀无扩展名但很有代表性（Makefile / Dockerfile / .gitignore） */
export function kindOfName(path) {
  const name = baseNameOf(path).toLowerCase();
  if (name === "makefile" || name === "dockerfile" || name === ".gitignore" ||
      name === ".env" || name === "readme" || name === "license") {
    return KIND.TEXT;
  }
  return kindOf(path);
}
