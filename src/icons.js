/* ==========================================================================
 * 图标（内联 SVG 字符串）
 * --------------------------------------------------------------------------
 * 为什么不用 emoji：思源工具栏/侧栏是线性图标风格，混 emoji 会花；
 * 而且字体差异会让对齐飘。
 * 统一 16×16 viewBox、currentColor 描边，跟着主题走。
 * ========================================================================== */

const wrap = (body, extra) =>
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
  'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
  'stroke-linejoin="round" ' + (extra || '') + '>' + body + '</svg>';

/**
 * 侧栏入口图标 —— 「网盘」语义。
 *
 * ★★ 已废弃（2026-10-09）：改用下面的 SYMBOL_DOCK（硬盘图形）★★
 *   这里内联的 `<svg>` 字符串**不能**直接当 addDock 的 config.icon 用 ——
 *   内核把 icon 当**符号 id** 查 symbol，查不到就渲染空白。留着它是为了
 *   给"内联 SVG（塞 innerHTML 用）"留一族样例；停靠项请走 SYMBOL_DOCK。
 */
export const ICON_DOCK = wrap(
  '<path d="M7.2 18.5A4.2 4.2 0 0 1 7 10.1a5.4 5.4 0 0 1 10.3 1.2 3.7 3.7 0 0 1 .5 7.2"/>' +
  '<path d="M12 11.4v7.2M9.6 14.2 12 11.6l2.4 2.6"/>'
);

export const ICON_FOLDER = wrap(
  '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h5l1.8 2H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>'
);

export const ICON_FOLDER_OPEN = wrap(
  '<path d="M3 8V6.5A1.5 1.5 0 0 1 4.5 5h4.2l1.8 2H18a1.5 1.5 0 0 1 1.5 1.5V10"/>' +
  '<path d="M2.6 11.2A1 1 0 0 1 3.6 10h15.5a1 1 0 0 1 .98 1.2l-1.3 6A1.5 1.5 0 0 1 17.3 18.5H5.2a1.5 1.5 0 0 1-1.47-1.2z"/>'
);

/** 文件：一张纸 + 折角 */
export const ICON_FILE = wrap(
  '<path d="M6 3.5h7L18.5 9v11.5H6z"/>' +
  '<path d="M13 3.5V9h5.5"/>'
);

/** 图纸（CAD） */
export const ICON_CAD = wrap(
  '<path d="M4 19 12 5l8 14z"/>' +
  '<circle cx="12" cy="14.6" r="1.6"/>' +
  '<path d="M4 19h16"/>'
);

/** Office 文档 */
export const ICON_OFFICE = wrap(
  '<path d="M6 3.5h7L18.5 9v11.5H6z"/>' +
  '<path d="M13 3.5V9h5.5"/>' +
  '<path d="M10 12.5v5M10 12.5h4.2a1.6 1.6 0 0 1 0 3.2H10"/>'
);

/** 图片 */
export const ICON_IMAGE = wrap(
  '<rect x="3.5" y="5" width="17" height="14" rx="2"/>' +
  '<circle cx="8.8" cy="10" r="1.5"/>' +
  '<path d="m4.5 17.5 4.6-4.3 3.2 3 3-2.6 4.2 3.9"/>'
);

/** 音视频 */
export const ICON_MEDIA = wrap(
  '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/>' +
  '<path d="M10.5 9.4v5.2l4.4-2.6z"/>'
);

/** 文本 */
export const ICON_TEXT = wrap(
  '<path d="M6 3.5h7L18.5 9v11.5H6z"/>' +
  '<path d="M13 3.5V9h5.5"/>' +
  '<path d="M9 12.5h6M9 15.5h6M9 18h3.5"/>'
);

/** PDF */
export const ICON_PDF = wrap(
  '<path d="M6 3.5h7L18.5 9v11.5H6z"/>' +
  '<path d="M13 3.5V9h5.5"/>' +
  '<path d="M9 17.5v-5h1.6a1.5 1.5 0 0 1 0 3H9"/>'
);

/** 重载 */
export const ICON_REFRESH = wrap(
  '<path d="M20 12a8 8 0 1 1-2.34-5.66"/>' +
  '<path d="M20 4v4.5h-4.5"/>'
);

/**
 * 下载。
 *
 * ★ 2026-10-10 重画（用户报「页签里的下载图标和别的图标风格不一致」）★
 *   旧版 = 一根细箭头（`M12 4v10.5` + 开口 V 头）压在一条**通长横线**
 *   （`M4.5 19.5h15`）上。
 *   把这一排 6 个图标一起放大到 64px 并排看（.verify/_icons-compare.png）就清楚了：
 *   刷新 / 嵌入 / 复制 / 外链 / 编辑 都是「圆角实体 + 描边」的同一套语言，
 *   只有下载那条横线又长又直、箭头又细又短，像是从另一套图标库里拿来的。
 *   现在换成「托盘 + 向下箭头」：托盘是**圆角 U 形路径**（与 EMBED / COPY 的
 *   圆角矩形同族），箭头加长、开口加宽，整体占位也跟邻居对齐
 *   （x 4.6~19.4、y 4.2~19.5，与 EMBED 的 3.5~20.5 / 4.5~19.5 基本一致）。
 *
 * ★ 为什么托盘用 `A`（圆角弧）而不是画个矩形 ★
 *   托盘只有三条边（左右两壁 + 底），顶上必须开口 —— 画矩形再用虚线遮顶
 *   在不同主题下会露出接缝；直接走两段四分之一圆弧最干净。
 */
export const ICON_DOWNLOAD = wrap(
  '<path d="M12 4.2v9.7"/>' +
  '<path d="m7.8 9.8 4.2 4.2 4.2-4.2"/>' +
  '<path d="M4.6 15.3v2.2A2 2 0 0 0 6.6 19.5h10.8a2 2 0 0 0 2-2v-2.2"/>'
);

/** 上传/写回 —— 这里复用成"编辑"的语义 */
export const ICON_EDIT = wrap(
  '<path d="M4.5 19.5h15"/>' +
  '<path d="M14.6 5.4 18 8.8 9.4 17.4l-3.9.5.5-3.9z"/>'
);

/** 在新窗口打开 */
export const ICON_EXTERNAL = wrap(
  '<path d="M13.5 4.5H19.5V10.5"/>' +
  '<path d="M19.5 4.5 11 13"/>' +
  '<path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'
);

/** 关闭 */
export const ICON_CLOSE = wrap('<path d="M6 6l12 12M18 6 6 18"/>');

/** 设置 */
export const ICON_SETTINGS = wrap(
  '<circle cx="12" cy="12" r="2.8"/>' +
  '<path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a1.7 1.7 0 1 1-2.4 2.4l-.06-.06a1.7 1.7 0 0 0-2.87 1.2v.17a1.7 1.7 0 1 1-3.4 0v-.09a1.7 1.7 0 0 0-3.02-1.16l-.06.06a1.7 1.7 0 1 1-2.4-2.4l.06-.06A1.7 1.7 0 0 0 4.5 13.6h-.17a1.7 1.7 0 1 1 0-3.4h.09A1.7 1.7 0 0 0 5.58 7.2l-.06-.06a1.7 1.7 0 1 1 2.4-2.4l.06.06A1.7 1.7 0 0 0 10.85 4.5V4.33a1.7 1.7 0 1 1 3.4 0v.09a1.7 1.7 0 0 0 3.02 1.16l.06-.06a1.7 1.7 0 1 1 2.4 2.4l-.06.06a1.7 1.7 0 0 0 1.2 2.87h.17a1.7 1.7 0 1 1 0 3.4h-.09a1.7 1.7 0 0 0-1.55 1.05z"/>'
);

/** 上一级 */
export const ICON_UP = wrap('<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>');

/** 上一个（文件导航用） */
export const ICON_PREV = wrap('<path d="M15 5.5 8.5 12 15 18.5"/>');

/** 下一个（文件导航用） */
export const ICON_NEXT = wrap('<path d="M9 5.5 15.5 12 9 18.5"/>');

/**
 * 折叠 / 展开操作条。
 * ★ 用一对（chevron + 底横线）而不是上下箭头 ★
 *   上箭头（ICON_UP）在"回到上一级"里已经用了，再用一次会歧义；
 *   这里表达的是"把这条栏收起来 / 放出来"，chevron 更贴切。
 */
export const ICON_COLLAPSE = wrap('<path d="M6 15.5 12 9l6 6.5"/>');
export const ICON_EXPAND = wrap('<path d="M6 9.5 12 16l6-6.5"/>');

/** 对话框：警告三角（校验失败时用） */
export const ICON_WARN = wrap(
  '<path d="M12 4.2 21 19.5H3z"/>' +
  '<path d="M12 10v4"/><path d="M12 16.8v.2"/>'
);

/** 对话框：信息圆（中性提示） */
export const ICON_INFO = wrap(
  '<circle cx="12" cy="12" r="8.5"/>' +
  '<path d="M12 11v5"/><path d="M12 8.2v.2"/>'
);

/** 多选：对勾（选中态、确认） */
export const ICON_CHECK = wrap('<path d="M5 12.5 10 17.5 19 7"/>');

/** 多选：全选 / 方框 */
export const ICON_SELECT = wrap(
  '<rect x="4" y="4" width="16" height="16" rx="2.5"/>' +
  '<path d="M8 12.2 11 15.2 16.2 9"/>'
);

/** 多选：清空选择 */
export const ICON_CLEAR = wrap(
  '<circle cx="12" cy="12" r="8.5"/>' +
  '<path d="M9 9l6 6M15 9l-6 6"/>'
);

/**
 * 复制路径：两片叠放的纸（行业标准的「复制」样子）。
 * ★ 为什么必须画成图标、不能再留文字 ★
 *   页签原来把「复制路径」做成信息条右侧的一串文字，那条信息条本身就是
 *   多出来的一层外壳（用户明确要求去掉）。去掉之后这个动作挪进工具条，
 *   工具条里全是图标 —— 留一个文字按钮会破坏那一排的节奏。
 */
export const ICON_COPY = wrap(
  '<rect x="9" y="9" width="11" height="11" rx="1.6"/>' +
  '<path d="M15 6.2A1.2 1.2 0 0 0 13.8 5H5.2A1.2 1.2 0 0 0 4 6.2v8.6A1.2 1.2 0 0 0 5.2 16h.8"/>'
);

/** 嵌入到文档：一个方块落进一张纸 */
export const ICON_EMBED = wrap(
  '<rect x="3.5" y="4.5" width="10" height="8" rx="1.4"/>' +
  '<path d="M6.5 9.2 9 6.8l2.5 2.4"/>' +
  '<path d="M8.6 16.5v3h11.9v-11h-4.2"/>'
);

/**
 * 在页签中打开：一个窗口 + 顶部一条「页签栏」（后面还有个露出的小页签）。
 * 与 ICON_EXTERNAL（方框+出箭头）刻意区分：那个是"甩到浏览器新窗口"，
 * 这个是"开在思源里"，两个动作不能长得一样。
 */
export const ICON_TAB = wrap(
  '<rect x="3.5" y="7.5" width="17" height="11" rx="1.6"/>' +
  '<path d="M3.5 11h17"/>' +
  '<path d="M7 5.2h4"/>'
);

/**
 * 注册进思源图标表的 <symbol>（页签标题上那个小图标要用它）。
 * ★ 必须走 addIcons ★
 *   `openTab({custom:{icon}})` 的 icon 是**符号 id**，由内核用
 *   `<svg><use xlink:href="#iconLocalfs"></use></svg>` 渲染。
 *   上面那些 ICON_* 是整段内联 SVG（字符串直接塞 innerHTML），
 *   两者形式不同，不能互相替代。
 */
export const SYMBOL_LOCALFS =
  '<symbol id="iconLocalfs" viewBox="0 0 24 24">' +
  '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h5l1.8 2H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>' +
  '<path d="M12 11v5M9.5 13.5 12 11l2.5 2.5"/>' +
  '</symbol>';

/**
 * 侧边栏停靠图标（侧栏入口用）。
 *
 * ★★ 为什么必须注册成 <symbol>，不能直接塞内联 SVG 字符串 ★★
 *
 *   参考对象 = **网盘插件（siyuan-nebuladisk）**，它的侧栏图标在右边、
 *   渲染正常：`addIcons(CUSTOM_ICONS)` 注册 `<symbol id="iconNebulaDisk">`，
 *   然后 `addDock({config:{icon:"iconNebulaDisk"}})` —— icon 传的是**符号 id**。
 *
 *   思源内核渲染停靠项图标时会把它当**符号 id** 走
 *     `<svg><use xlink:href="#<icon>"></use></svg>`
 *   那一套（与 openTab 的 icon 同源）。先前我们传的是一整段
 *   `<svg viewBox=…>…</svg>` 字符串，内核拿它当 id 去查符号，查不到 ⇒
 *   停靠项图标**渲染成空白**（或被 HTML 转义成乱码），这就是"图标不对"的根因。
 *   所以：dock 图标必须**与页签图标同规格** —— 注册 symbol、传 id。
 *
 * ★★ 形状为什么换成「硬盘」（2026-10-09 第二轮）★★
 *   第一版画的是「云 + 向下箭头」。真机放大到 12 倍看（.verify/_icon-zoom.png），
 *   问题很清楚：
 *     · 云轮廓**超出**了停靠项那个 18px 的圆角框，左右被切掉，看着像没画完；
 *     · 箭头画成了**向上**（顶点在上、两撇在下），读出来是"云上传/云备份"，
 *       跟它上面那个「同步」图标（链条）语义撞车；
 *     · 18px 下云 + 箭头太密，糊成一团。
 *   ⇒ 换成本机存储最无歧义的图形：**一块硬盘**（圆角矩形 + 一道分隔线 + 指示灯）。
 *     粗描边（2.2）、viewBox 32×32（图形不顶边，留白 4px），18px 下依然清楚；
 *     与网盘插件的 iconNebulaDisk 同为 32×32 规格、currentColor 上色，跟主题走。
 */
export const SYMBOL_DOCK =
  '<symbol id="iconLocalfsDock" viewBox="0 0 32 32">' +
  // 盘体（圆角矩形）
  '<rect x="4" y="8" width="24" height="16" rx="3.2" fill="none" ' +
  'stroke="currentColor" stroke-width="2.2"/>' +
  // 分隔线（把盘体分成"盘面"与"指示灯区"，这是硬盘的识别特征）
  '<path d="M4 18.2h24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round"/>' +
  // 指示灯（右下角一个小圆点）
  '<circle cx="22" cy="21.2" r="1.5" fill="currentColor"/>' +
  // 左上一个小横条（盘面细节，避免大面积留白显得空）
  '<path d="M8.4 13.2h6.4" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round"/>' +
  '</symbol>';

/** 停靠图标在思源图标表里的符号 id（传给 addDock 的 config.icon） */
export const DOCK_ICON_ID = "iconLocalfsDock";

/** addIcons 一次性注册的全部 symbol（逗号拼接，内核逐个解析） */
export const SYMBOLS_ALL = SYMBOL_LOCALFS + SYMBOL_DOCK;

/** 按类型取图标 */
export function iconForKind(kind, isDir, expanded) {
  if (isDir) return expanded ? ICON_FOLDER_OPEN : ICON_FOLDER;
  switch (kind) {
    case "cad": return ICON_CAD;
    case "office": return ICON_OFFICE;
    case "image": return ICON_IMAGE;
    case "pdf": return ICON_PDF;
    case "audio":
    case "video": return ICON_MEDIA;
    case "markdown":
    case "text": return ICON_TEXT;
    default: return ICON_FILE;
  }
}
