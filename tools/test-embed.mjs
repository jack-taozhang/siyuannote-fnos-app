/* ==========================================================================
 * 嵌入块（自定义块）契约的离线回归断言
 * --------------------------------------------------------------------------
 * 为什么需要这个文件：
 *   嵌入块这条链路上，「坏掉」有三种**不报错的**形态：
 *     ① 围栏写成反引号 ```   → 内核只当成普通代码块（type=c），
 *        自定义块渲染器永远不会被调用，笔记里显示一坨裸 JSON；
 *     ② 围栏前多一个字符      → 退化成普通段落（type=p），同样是裸 JSON；
 *     ③ data-info 里出现**两个**斜杠 → 内核的解析器（`info.indexOf("/")`
 *        必须等于 `info.lastIndexOf("/")`）判为非法 ⇒ 整块不渲染。
 *   这三种情况 console 一条错都没有、请求也全 200，只有"看到笔记里是 JSON"
 *   才能发现。真机验证脚本能抓，但它要 6~8 分钟、要 NAS、要 Chrome。
 *   ⇒ 把**契约本身**写成断言，让 `node tools/test-embed.mjs` 两秒钟就能挡住。
 *
 * 本文件两层：
 *   A) 纯函数单测 —— 直接把 src/*.js 当 ESM 载进来跑（复制成 .mjs 临时目录）
 *   B) 构建产物契约 —— 断言"接线没被 build 丢掉"（模块清单 / 关键字符串）
 *
 * 用法：node tools/test-embed.mjs
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

/* ---------------------------------------------------------------------------
 * A) 把源码当 ESM 载进来
 *
 * ★ 为什么不用打包产物 ★
 *   产物是单文件 + 私有命名空间的 IIFE，模块内部**不对外暴露**（这正是它
 *   能在思源里跑起来的原因）。所以要么在产物里挖洞（给 embed 开个全局），
 *   要么老老实实把源码当 ESM 载一遍。
 *   源码里的相对 import 都没写扩展名（`from "./api"`），Node 的 ESM 解析器
 *   必须要扩展名 ⇒ 复制到临时目录时顺手把 `.js`（或裸名）补成 `.mjs`。
 *   这几个模块的**顶层**只做常量与函数声明（DOM 只在函数体里用），
 *   所以在 Node 里 import 是安全的。
 * ------------------------------------------------------------------------ */
const TMP = join(ROOT, ".verify", "_esm-embed");
let embed = null;
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
  embed = await import(pathToFileURL(join(TMP, "embed.mjs")).href);
} catch (e) {
  console.log("  ✗ 载入 src 源码失败：" + e.message);
  fail++;
}

if (embed) {
  const {
    BLOCK_TYPE, DND_MIME, parseEmbed, stringifyEmbed, embedLang,
    buildEmbedMarkdown, extractJson, collapseAllOpenEmbeds, openEmbedCount,
  } = embed;

  console.log("\n【1】常量");
  ok("块类型是 localfs（与 data-info 的斜杠后半段一致）", BLOCK_TYPE === "localfs", String(BLOCK_TYPE));
  /* ★ 断言的是"形状"而不是某个写死的值 ★
   *   这个 MIME 是**拖拽协议版本号**：只要旧版本残留监听还在，把版本 +1
   *   就能让它失效（见 src/embed.js 的 DND_MIME 注释）。所以这里只要求
   *   "还是那族名字 + 带 -v<数字>"，而不是钉死 v2 —— 否则将来升 v3 时
   *   这条测试会红，逼着人改测试而不是改代码。 */
  ok("私有 MIME 是老族名 + 版本后缀（残留旧监听靠改名变哑）",
    /^application\/x-localfs-embed-v\d+$/.test(DND_MIME), String(DND_MIME));
  ok("embedLang 用插件名拼（默认 siyuan-localfs/localfs）",
    embedLang() === "siyuan-localfs/localfs" && embedLang("x") === "x/localfs",
    embedLang() + " | " + embedLang("x"));

  console.log("\n【2】parseEmbed（正文里那行 JSON → 规格）");
  const a = parseEmbed('{"kind":"file","path":"/vol1/a.pdf","name":"a.pdf"}');
  ok("标准 JSON 能解析", !!a && a.kind === "file" && a.path === "/vol1/a.pdf" && a.name === "a.pdf",
    JSON.stringify(a));
  const t = parseEmbed('{"kind":"tree","path":"/vol1/1000"}');
  ok("kind=tree 认得出（目录块）", !!t && t.kind === "tree", JSON.stringify(t));
  const k = parseEmbed("path=/vol1/a.txt\nname=a.txt");
  ok("手改过的 key=value 也认（容错）", !!k && k.path === "/vol1/a.txt" && k.name === "a.txt",
    JSON.stringify(k));
  ok("缺前导斜杠会自动补（NAS 路径都是绝对的）",
    (parseEmbed('{"path":"vol1/a.txt"}') || {}).path === "/vol1/a.txt");
  ok("没有 path 一律判坏块（返回 null，渲染器给可读提示）",
    parseEmbed('{"kind":"file"}') === null && parseEmbed("") === null && parseEmbed("随便一段话") === null);
  ok("JSON 语法错误不会抛，只返回 null",
    parseEmbed('{"kind":"file","path":') === null);
  ok("未知 kind 收敛成 file（不认识的按文件处理）",
    (parseEmbed('{"kind":"weird","path":"/a"}') || {}).kind === "file");

  console.log("\n【3】stringifyEmbed / 往返一致");
  ok("file 带 name", stringifyEmbed({ kind: "file", path: "/a", name: "n" }) ===
    '{"kind":"file","path":"/a","name":"n"}', stringifyEmbed({ kind: "file", path: "/a", name: "n" }));
  ok("tree 不带 name", stringifyEmbed({ kind: "tree", path: "/a" }) === '{"kind":"tree","path":"/a"}',
    stringifyEmbed({ kind: "tree", path: "/a" }));
  ok("height 非 0 才写", stringifyEmbed({ kind: "file", path: "/a", height: 0 }) ===
    '{"kind":"file","path":"/a"}' &&
    stringifyEmbed({ kind: "file", path: "/a", height: 300 }) ===
    '{"kind":"file","path":"/a","height":300}');
  const rt = parseEmbed(stringifyEmbed({ kind: "file", path: "/中文 目录/x.txt", name: "x.txt" }));
  ok("含空格/中文的路径往返不丢", !!rt && rt.path === "/中文 目录/x.txt" && rt.name === "x.txt",
    JSON.stringify(rt));

  console.log("\n【4】buildEmbedMarkdown —— 三条铁律");
  const md = buildEmbedMarkdown("siyuan-localfs", { kind: "file", path: "/vol1/a.pdf", name: "a.pdf" });
  ok("① 用 ;;; 围栏（绝不能是反引号）",
    md.startsWith(";;;") && md.indexOf("```") < 0, JSON.stringify(md.slice(0, 30)));
  ok("② 围栏顶格（第 0 个字符就是 ;，前面不许有任何空白/字符）", md[0] === ";", JSON.stringify(md[0]));
  ok("③ 结尾也是顶格的 ;;;", /\n;;;\n$/.test(md), JSON.stringify(md.slice(-8)));

  /* ★ 内核的 data-info 解析器（v3.8.x 前端原文，逐字核实）：
   *     const i = info.indexOf("/");
   *     if (i < 1 || i !== info.lastIndexOf("/") || i === info.length - 1) return;
   *   即：斜杠必须**恰好一个**、且两侧都非空。
   *   这里照抄成断言 —— 一旦谁把插件名或块类型里塞进斜杠，真机上整块不渲染。 */
  const info = md.split("\n")[0].replace(/^;;;/, "");
  const i = info.indexOf("/");
  ok("data-info 里斜杠恰好一个且两侧非空（内核解析器的硬要求）",
    i >= 1 && i === info.lastIndexOf("/") && i !== info.length - 1, JSON.stringify(info));
  ok("data-info 正好是 插件名/块类型", info === "siyuan-localfs/localfs", JSON.stringify(info));

  const json = extractJson(md);
  ok("extractJson 取回的就是中间那行 JSON",
    json === stringifyEmbed({ kind: "file", path: "/vol1/a.pdf", name: "a.pdf" }), json);
  const back = parseEmbed(json);
  ok("往返：buildEmbedMarkdown → extractJson → parseEmbed 不丢信息",
    !!back && back.path === "/vol1/a.pdf" && back.name === "a.pdf", JSON.stringify(back));

  /* 插件名带空格/中文也要能生成合法 info（info 允许 URL 编码前的原文，只要一个斜杠） */
  const md2 = buildEmbedMarkdown("某 插件", { kind: "file", path: "/a" });
  const info2 = md2.split("\n")[0].replace(/^;;;/, "");
  ok("插件名含空格/中文时 info 仍只有一个斜杠",
    info2.indexOf("/") === info2.lastIndexOf("/") && info2.indexOf("/") > 0, JSON.stringify(info2));

  console.log("\n【4b】登记簿：已展开的块数得数得清（「全部收起」靠它）");
  ok("collapseAllOpenEmbeds / openEmbedCount 都已导出",
    typeof collapseAllOpenEmbeds === "function" && typeof openEmbedCount === "function");
  ok("没有块展开时 openEmbedCount() === 0", openEmbedCount() === 0, String(openEmbedCount()));
  /* 空集合上调用不该抛（onunload 会无条件调它） */
  let threw = null;
  try { collapseAllOpenEmbeds(); } catch (e) { threw = e; }
  ok("空集合上「全部收起」不抛异常", threw === null, threw ? threw.message : "");
}

/* ---------------------------------------------------------------------------
 * B) 构建产物契约：接线有没有被 build 丢掉
 * ------------------------------------------------------------------------ */
console.log("\n【5】源码接线（四个入口 + 渲染器）");
const idx = readFileSync(join(ROOT, "index.js"), "utf8");
const expl = readFileSync(join(ROOT, "src/explorer.js"), "utf8");
const prev = readFileSync(join(ROOT, "src/preview.js"), "utf8");
const build = readFileSync(join(ROOT, "tools/build.js"), "utf8");

ok("build.js 的 MODULES 收进了 src/embed.js", /"src\/embed\.js"/.test(build));
ok("index.js onload 里注册渲染器 + 挂拖拽落点",
  /registerEmbed\(\s*this\s*\)/.test(idx) && /bindEmbedDrop\(\s*this\s*\)/.test(idx));
ok("index.js 注册了 protyleSlash（斜杠菜单入口）",
  /this\.protyleSlash\s*=/.test(idx) && /localfsEmbedFile/.test(idx));
ok("index.js 提供 channelReady / activeProtyle（渲染器与定位要用）",
  /channelReady\s*\(\s*\)/.test(idx) && /activeProtyle\s*\(\s*\)/.test(idx));
ok("index.js 有唯一插入出口 insertNodeEmbed",
  /async\s+insertNodeEmbed\s*\(/.test(idx) && /insertEmbedIntoDoc\(/.test(idx));
ok("文件行的 dragstart 写了私有 MIME（用 DND_MIME 常量，不写死字符串）",
  /setData\(\s*DND_MIME/.test(expl));
ok("文件行可拖（row.draggable = true）", /\.draggable\s*=\s*true/.test(expl));
ok("目录行**不**可拖（拖这个手势对目录是含糊的）",
  !/is-dir[\s\S]{0,200}\.draggable\s*=\s*true/.test(expl));
ok("explorer.js 从 embed.js 引 DND_MIME（两处不能各写一份字符串）",
  /import\s*\{[^}]*DND_MIME[^}]*\}\s*from\s*"\.\/embed"/.test(expl));
ok("文件右键菜单有「嵌入到文档」", /embedToDoc/.test(expl));
ok("目录右键菜单有「嵌入这个目录」", /embedDirToDoc/.test(expl));
ok("预览工具栏有「嵌入到文档」按钮", /embedToDoc/.test(prev) && /insertNodeEmbed/.test(prev));
ok("「收起所有嵌入块」有命令入口（addCommand langKey）",
  /langKey:\s*"collapseAllEmbeds"/.test(idx));
ok("onunload 会收起所有展开的块（不留 iframe 在内存里）",
  /onunload\s*\([^)]*\)\s*\{[\s\S]{0,1200}collapseAllEmbeds\s*\(/.test(idx));
ok("收起用的是 embed.js 的 collapseAllOpenEmbeds（不在 index.js 里重写一份）",
  /collapseAllOpenEmbeds/.test(idx) && !/const\s+openEmbeds\s*=/.test(idx));

/* ★ 2026-10-10 修的真 bug：拖一次文件插出**两个**一模一样的嵌入块 ★
 *   根因：bindEmbedDrop 挂在 document 上的监听**从来没被摘过**。
 *   思源每次「重载 / 升级插件」都会重新 onload，而新实例的
 *   `_lfsDropBound` 是 undefined ⇒ 又绑一份，旧的那份还在
 *   ⇒ 一次拖拽两颗 handler 各插一次。Windows 桌面端实测到。
 *   两道防线，两个都要在：
 *     ① 根治 —— 注册表挂 window（跨模块实例），绑前先摘、onunload 必摘
 *     ② 兜底 —— 同一颗事件对象打标记，只处理一次
 */
const emb = readFileSync(join(ROOT, "src/embed.js"), "utf8");
/**
 * 去注释后再断言。
 * ★ 为什么必须去 ★  这些改动的说明性注释里会**原样引用**被禁掉的写法
 *   （例如"早先是 if (plugin._lfsDropBound) return"），
 *   直接拿原文匹配就会把注释里的字样当成代码 —— 既可能假红也可能假绿。
 *   （本文件已经吃过一次：注释里那句 `if (…) return` 让反向断言假红。）
 */
const embCode = emb.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
ok("★ embed.js 导出 unbindEmbedDrop", /export\s+function\s+unbindEmbedDrop\b/.test(embCode));
ok("★ bindEmbedDrop 是「先摘后绑」（不再靠 _lfsDropBound 提前 return）",
  /export\s+function\s+bindEmbedDrop\s*\([\s\S]{0,300}?unbindEmbedDrop\s*\(\s*\)/.test(embCode) &&
  !/if\s*\(\s*plugin\._lfsDropBound\s*\)\s*return/.test(embCode));
ok("★ 监听注册表挂在 window 上（重载插件后新模块实例也能摘掉旧的）",
  /__lfsEmbedDropReg/.test(embCode) && /window\[DND_REG_KEY\]/.test(embCode));
ok("★ 三个监听都经 on() 登记（才摘得掉）",
  /const\s+on\s*=\s*\(type,\s*fn\)/.test(embCode) &&
  (embCode.match(/on\(\s*"(dragover|dragleave|drop)"/g) || []).length === 3);
ok("★ onunload 里摘掉拖拽监听（不摘就会攒监听 ⇒ 插两个块）",
  /onunload\s*\([^)]*\)\s*\{[\s\S]{0,1200}unbindEmbedDrop\s*\(\s*\)/.test(idx));
ok("★ drop 兜底去重：同一颗事件只处理一次（ev.__lfsDropDone）",
  /__lfsDropDone/.test(embCode) &&
  /if\s*\(\s*ev\.__lfsDropDone\s*\)\s*return/.test(embCode));

console.log("\n【6】i18n：新增的 key 两个语言都得有");
const zh = JSON.parse(readFileSync(join(ROOT, "i18n/zh_CN.json"), "utf8"));
const en = JSON.parse(readFileSync(join(ROOT, "i18n/en_US.json"), "utf8"));
for (const k of ["embedToDoc", "embedDirToDoc", "embedFileToDoc", "pickFileTitle",
  "embeddedToDoc", "embedNotCustom", "embedFailed",
  "collapseAllEmbeds", "collapsedEmbeds", "noOpenEmbeds"]) {
  ok(`zh_CN 有 ${k}`, typeof zh[k] === "string" && zh[k].length > 0);
  ok(`en_US 有 ${k}`, typeof en[k] === "string" && en[k].length > 0);
}
ok("zh/en 的 key 集合完全一致",
  JSON.stringify(Object.keys(zh).sort()) === JSON.stringify(Object.keys(en).sort()),
  Object.keys(zh).filter((k) => !(k in en)).join(",") || Object.keys(en).filter((k) => !(k in zh)).join(","));

console.log("\n【7】样式：嵌入块必须自带宽度约束（否则 iframe 撑破正文）");
const css = readFileSync(join(ROOT, "index.css"), "utf8");
const flat = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const cssFlat = flat(css);
ok(".lfs-embed 有 width/max-width 约束",
  /\.lfs-embed\s*\{[^}]*max-width\s*:\s*100%/.test(cssFlat));
ok(".lfs-embed-host 有 max-width:100%（宿主也不能被撑破）",
  /\.lfs-embed-host[^{]*\{[^}]*max-width\s*:\s*100%/.test(cssFlat));
ok(".lfs-embed-path 可收缩 + 省略号（长路径不挤走工具栏）",
  /\.lfs-embed-path\s*\{[^}]*text-overflow\s*:\s*ellipsis/.test(cssFlat) &&
  /\.lfs-embed-title\s*\{[^}]*min-width\s*:\s*0/.test(cssFlat));
ok("有落点高亮 .lfs-drop-target", /\.lfs-drop-target/.test(cssFlat));
ok("有选择模式 .lfs-pickbar", /\.lfs-pickbar/.test(cssFlat));

console.log("\n【8】构建产物里这几样都得在（build 没吞掉）");
if (!existsSync(join(BUILT, "index.js"))) {
  console.log("  – 跳过：本机产物目录不存在（还没构建过）");
} else {
  const b = readFileSync(join(BUILT, "index.js"), "utf8");
  /* ★ 先把注释挖空再找 require ★
   *   产物头部的说明里**故意**写了一句 `require("./src/x.js") 必然失败`
   *   （那是解释"为什么必须单文件"的正文）。不挖注释就会把这句示例当成真依赖，
   *   得到一个永远修不掉的假失败。build.js 的自检也是先 maskComments 再查。 */
  const bMasked = flat(b);
  ok("产物含私有 MIME（带版本后缀）", /application\/x-localfs-embed-v\d+/.test(b));
  /* ★ 一次性拖拽的"第二道防线" ★
   *   万一 document 上不止一份 drop 监听，一次拖拽会被各跑一遍；
   *   全局闸门保证只会落一个块。这条断言防的是"将来有人把这个闸门删了"。 */
  ok("产物含「一次拖拽只插一个块」的全局插入闸门",
    bMasked.indexOf("__lfsEmbedInsertGuard") >= 0 && bMasked.indexOf("isDuplicateInsert") >= 0);
  ok("产物含 ;;; 围栏拼接", bMasked.indexOf(";;;${embedLang(") >= 0);
  /* data-info 的拼法在**源码**里查更准：产物里它是运行期拼出来的，
   * 断言一个"运行期才存在的字符串"只会得到假绿/假红两种噪声。 */
  const embedSrc = readFileSync(join(ROOT, "src/embed.js"), "utf8");
  ok("data-info = 插件名 + 恰好一个斜杠 + BLOCK_TYPE（不能写死两个斜杠）",
    /return\s*`\$\{pluginName[^}]*\}\/\$\{BLOCK_TYPE\}`/.test(embedSrc));
  ok("产物含 customBlockRenders 注册", /customBlockRenders\[BLOCK_TYPE\]/.test(bMasked));
  ok("产物含「插在光标所在块上方」的 nextID 语义", /body\.nextID/.test(bMasked));
  /* ★ 内核的默认行为是**前插**，不是追加 ★（实测：只给 parentID ⇒ 跑到最前面）
   *   所以"无锚点时追加到文末"必须显式带 previousID，否则用户点一次
   *   「嵌入到文档」，块就出现在整篇笔记的开头。 */
  ok("产物含「无锚点时追加到末尾」的 previousID 语义", /body\.previousID/.test(bMasked));
  ok("产物里 nextID / previousID 是互斥选择的（不会两个一起发）",
    /if \(located\.nextID\)[\s\S]{0,200}else if \(located\.previousID\)/.test(bMasked));
  /* ★ 这条断言必须查**源码**，不能再查产物 ★
   *   监听现在是通过局部包装 `on(type, fn)` 注册的（它顺手把监听登记进
   *   window 上的注册表，好让重载插件时能摘干净）。产物里**不存在**
   *   `document.addEventListener("drop"` 这个字面量了 —— 继续拿它当断言
   *   只会得到一个永远修不掉的假失败（上一轮是读到更旧的产物才侥幸过的）。
   *   要守的契约本身没变，三件事：
   *     ① 挂 document —— 文件树与正文是两个互不包含的子树，挂任一子树上
   *        都收不到对方的 drop；
   *     ② 捕获阶段（第三个参数 true）；
   *     ③ 确实监听了 dragover 与 drop（dragover 里不 preventDefault，
   *        浏览器根本不会派发 drop）。 */
  ok("拖拽监听挂在 document 捕获阶段（源码契约）",
    /document\.addEventListener\(\s*type\s*,\s*fn\s*,\s*true\s*\)/.test(embedSrc)
    && /on\(\s*"dragover"/.test(embedSrc)
    && /on\(\s*"drop"/.test(embedSrc));
  ok("产物不含相对 require（思源解析不了）", !/require\(\s*"\.\//.test(bMasked));

  const bc = readFileSync(join(BUILT, "index.css"), "utf8");
  ok("产物 index.css 含 .lfs-embed 规则", /\.lfs-embed\s*\{/.test(bc));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
