/* ==========================================================================
 * 构建：把 ESM 源码打包成**单个** index.js，并拷齐静态资源
 * --------------------------------------------------------------------------
 * ★ 为什么必须是单文件（★ 这是插件装不进去的头号原因 ★）
 *
 *   思源执行插件的方式（从 common.js 反读出来的原文）：
 *
 *     const He = (Ve, Xe) => {
 *       const ft = {}, Tt = { exports: ft };
 *       ce(Xe.js, "plugin:" + Xe.name)(Ue, Tt, ft)     // window.eval 包一层函数
 *       ...
 *     }
 *     const Ue = Ve => Ve === "siyuan" ? P() : window.require?.(Ve);
 *
 *   关键：插件拿到的 require **只认 "siyuan"**，其余一律委托给 Electron 注入的
 *   window.require，而它的解析基准是**渲染进程自己的 bundle 路径**，不是插件目录
 *   ⇒ 插件里写 `require("./src/api.js")` 必然 MODULE_NOT_FOUND。
 *
 *   后果链：脚本抛错 → 只写浏览器 console（siyuan.log 里干干净净）
 *          → 思源放弃这个插件 → 没有 addDock → 侧栏无图标、插件菜单里也没有。
 *   所以本脚本把 src/*.js 与 index.js 按依赖顺序拼进一个文件，
 *   给每个模块套一层私有命名空间来模拟模块作用域。
 *
 * ★ 本脚本相对 nebuladisk 的构建器做的简化 ★
 *   去掉了那边"防跨项目同步覆盖"的项目专属断言（那份是针对那个仓库踩过的三次
 *   事故写的）；这里只保留通用的那一层：入口必须是源码、产物不能有相对 require。
 *
 * 用法：
 *   node tools/build.js               → 输出到本机思源（DEFAULT_OUT）
 *   node tools/build.js <目录>         → 输出到指定目录
 *   node tools/build.js --repo        → 输出到仓库 dist/（留档用）
 * ========================================================================== */

const fs = require("fs");
const path = require("path");

const SRC_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = "D:/Software/SiYuan/data/plugins/siyuan-localfs";
const REPO_DIST = path.join(SRC_ROOT, "dist");

const ENTRY = "index.js";

/**
 * 要打进 bundle 的模块。顺序其实由 import 拓扑排序决定，
 * 显式列在这里只是为了让"模块清单"一眼看全。
 */
const MODULES = [
  "src/api.js",
  "src/kinds.js",
  "src/icons.js",
  "src/purify.js",
  "src/dialog.js",
  "src/fileview.js",
  "src/tabview.js",
  "src/embed.js",
  "src/preview.js",
  "src/explorer.js",
  "src/settings.js",
  "src/external.js",
  ENTRY,
];

/** 原样拷过去的静态资源 */
const STATIC = [
  "plugin.json",
  "index.css",
  "icon.png",
  "README.md",
  "README.zh_CN.md",
  "i18n/zh_CN.json",
  "i18n/en_US.json",
];

/* -------------------------------------------------------------------------
 * 1) import / export 的文本级转换
 * ---------------------------------------------------------------------- */

/**
 * 把注释"挖空"成等长空格（保留换行，行号不漂）。
 *
 * ★ 为什么必须先做这一步 ★
 *   import 的正则是**纯文本**匹配，它不认识注释。而源码注释里完全可能写出
 *   合法的 import 示例（本项目就要解释"为什么不能相对 require"）。不挖空的话，
 *   注释里的示例会被当成真依赖收集进来 ⇒ 同一模块 push 两次 ⇒ 产物里出现
 *   两行同名 `const x = ...` ⇒ **SyntaxError**（const 重复声明是语法错误，
 *   不是覆盖），整包加载即失败，而且只报在浏览器 console。
 */
function maskComments(code) {
  code = code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  code = code.replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, " "));
  return code;
}

function dependenciesOf(code) {
  const masked = maskComments(code);
  const deps = [];
  const push = (d) => {
    if (!deps.some((x) => JSON.stringify(x) === JSON.stringify(d))) deps.push(d);
  };
  let m;
  const reNamed = /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']\s*;?/g;
  while ((m = reNamed.exec(masked))) {
    push({ mod: m[2], names: m[1].split(",").map((s) => s.trim()).filter(Boolean) });
  }
  const reDefault = /import\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']\s*;?/g;
  while ((m = reDefault.exec(masked))) push({ mod: m[2], default: m[1] });
  const reSide = /import\s*["']([^"']+)["']\s*;?/g;
  while ((m = reSide.exec(masked))) push({ mod: m[1], sideEffect: true });
  return deps;
}

function findCommentRanges(code) {
  const ranges = [];
  const re = /\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm;
  let m;
  while ((m = re.exec(code))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/** 删掉真实的 import 语句；★ 在**原文**上删，且跳过注释区间 ★ */
function stripImports(code) {
  const commentRanges = findCommentRanges(code);
  const inComment = (idx) => commentRanges.some(([a, b]) => idx >= a && idx < b);
  const del = (re) => {
    code = code.replace(re, (full, ...args) => {
      const offset = args[args.length - 2];
      return inComment(offset) ? full : "";
    });
  };
  del(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["']\s*;?/g);
  del(/import\s+[A-Za-z_$][\w$]*\s+from\s*["'][^"']+["']\s*;?/g);
  del(/import\s*["'][^"']+["']\s*;?/g);
  return code;
}

/**
 * export 声明 → 普通声明 + 记录导出名。
 * ⚠️ 只支持 `export default class` / `export default <expr>` /
 *    `export (async function|function|class|const|let|var) X` 这几种。
 *    **不支持** `export { a, b }` —— 写那种形式会被原样留在产物里，
 *    而产物是普通脚本，`export` 是语法错误。自检里有兜底检查。
 */
function stripExports(code) {
  const named = [];
  let defaultName = null;

  code = code.replace(/^export\s+default\s+class\s+([A-Za-z_$][\w$]*)?/m, (_m, name) => {
    defaultName = name || "DefaultExport";
    return name ? `class ${name}` : `class ${defaultName}`;
  });
  code = code.replace(
    /^export\s+default\s+([A-Za-z_$][\w$]*(?:\s*\([\s\S]*?\))?)\s*;?/m,
    (_m, expr) => {
      defaultName = expr;
      return "";
    }
  );
  code = code.replace(
    /^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind, name) => {
      named.push(name);
      return `${kind} ${name}`;
    }
  );
  return { code, named, defaultName };
}

/* -------------------------------------------------------------------------
 * 2) 依赖拓扑排序
 * ---------------------------------------------------------------------- */
function resolveDep(fromRel, mod) {
  if (!mod.startsWith(".")) return null;
  const base = path.posix.dirname(fromRel);
  let p = path.posix.normalize(path.posix.join(base, mod));
  if (!p.endsWith(".js")) p += ".js";
  return p;
}

function topoSort() {
  const visited = new Set();
  const order = [];
  const visit = (rel, stack) => {
    if (visited.has(rel)) return;
    if (stack.includes(rel)) return;   // 循环依赖：跳过（靠提升的声明兜）
    const abs = path.join(SRC_ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error(`模块不存在: ${rel}（检查 MODULES 清单）`);
    const deps = dependenciesOf(fs.readFileSync(abs, "utf8"));
    stack.push(rel);
    for (const d of deps) {
      const r = resolveDep(rel, d.mod);
      if (r && MODULES.includes(r)) visit(r, stack);
    }
    stack.pop();
    visited.add(rel);
    order.push(rel);
  };
  for (const m of MODULES) visit(m, []);
  return order;
}

/* -------------------------------------------------------------------------
 * 3) 打包
 * ---------------------------------------------------------------------- */
const nsName = (rel) =>
  "__mod_" + rel.replace(/^src\//, "").replace(/\.js$/, "").replace(/[^\w$]/g, "_");

const NODE_BUILTINS = [
  "http", "https", "url", "fs", "path", "crypto", "os", "stream", "zlib",
  "net", "tls", "events", "util", "querystring", "buffer", "child_process",
];
const isBuiltin = (m) => NODE_BUILTINS.includes(m) || m.startsWith("node:");

function indent(code, n) {
  const pad = " ".repeat(n);
  return code.split("\n").map((l) => (l.trim() ? pad + l : l)).join("\n");
}

function bundle() {
  const order = topoSort();
  const parts = [];
  const exportMap = new Map();
  const declaredNames = new Map();

  for (const rel of order) {
    const abs = path.join(SRC_ROOT, rel);
    const raw = fs.readFileSync(abs, "utf8");
    const deps = dependenciesOf(raw);
    const noImp = stripImports(raw);
    const { code, named, defaultName } = stripExports(noImp);
    exportMap.set(rel, { named, defaultName });

    const declared = declaredNames.get(rel) || new Set();
    declaredNames.set(rel, declared);

    const external = deps.filter((d) => !resolveDep(rel, d.mod));
    const internal = deps.filter((d) => resolveDep(rel, d.mod));

    const ns = nsName(rel);
    const lines = [];
    lines.push(`/* ===== ${rel} ===== */`);
    lines.push(`const ${ns} = (() => {`);

    for (const d of external) {
      if (d.mod === "siyuan") {
        for (const n of d.names || []) {
          if (declared.has(n)) continue;
          declared.add(n);
          lines.push(`  const ${n} = SIYUAN.${n};`);
        }
        if (d.default && !declared.has(d.default)) {
          declared.add(d.default);
          lines.push(`  const ${d.default} = SIYUAN;`);
        }
      } else if (isBuiltin(d.mod)) {
        for (const n of d.names || []) {
          if (declared.has(n)) continue;
          declared.add(n);
          lines.push(`  const ${n} = require(${JSON.stringify(d.mod)}).${n};`);
        }
        if (d.default && !declared.has(d.default)) {
          declared.add(d.default);
          lines.push(`  const ${d.default} = require(${JSON.stringify(d.mod)});`);
        }
      } else {
        for (const n of d.names || []) {
          if (declared.has(n)) continue;
          declared.add(n);
          lines.push(`  const ${n} = require(${JSON.stringify(d.mod)}).${n};`);
        }
        if (d.default && !declared.has(d.default)) {
          declared.add(d.default);
          lines.push(`  const ${d.default} = require(${JSON.stringify(d.mod)});`);
        }
      }
    }

    for (const d of internal) {
      const target = resolveDep(rel, d.mod);
      const tns = nsName(target);
      for (const n of d.names || []) {
        if (declared.has(n)) continue;   // 同名重复 = SyntaxError，必须去重
        declared.add(n);
        lines.push(`  const ${n} = ${tns}.${n};`);
      }
      if (d.default && !declared.has(d.default)) {
        declared.add(d.default);
        lines.push(`  const ${d.default} = ${tns}.default;`);
      }
    }

    lines.push(indent(code.trim(), 2));
    lines.push(`  return {`);
    for (const n of named) lines.push(`    ${n},`);
    if (defaultName) lines.push(`    default: ${defaultName},`);
    lines.push(`  };`);
    lines.push(`})();`);
    parts.push(lines.join("\n"));
  }

  const head = [];
  head.push(`/* -------------------------------------------------------------------------`);
  head.push(` * siyuan-localfs —— 由 tools/build.js 打包生成，请勿直接编辑。`);
  head.push(` *`);
  head.push(` * ★ 必须是单文件：思源给插件的 require 只认 "siyuan"，其余委托给`);
  head.push(` *   Electron 的 window.require（解析基准是渲染进程 bundle，不是插件目录），`);
  head.push(` *   所以 require("./src/x.js") 必然失败，且**只报在浏览器 console**，`);
  head.push(` *   siyuan.log 里看不到任何痕迹。`);
  head.push(` *`);
  head.push(` * 源码：<项目根>/index.js 与 <项目根>/src/*.js（模块见下方 ===== 分隔）`);
  head.push(` * ---------------------------------------------------------------------- */`);
  head.push(`"use strict";`);
  head.push(``);
  head.push(`/** 内核为插件提供的 siyuan 内建模块 */`);
  head.push(`const SIYUAN = require("siyuan");`);
  head.push(``);

  const entryNs = nsName(ENTRY);
  const entryMod = exportMap.get(ENTRY) || {};
  if (!entryMod.defaultName) {
    throw new Error(
      `入口 ${ENTRY} 没有找到 export default —— 无法确定插件类。` +
      `请确认源码里有 "export default class XxxPlugin"。`
    );
  }
  const entryRef = `${entryNs}.default`;

  const tail = [];
  tail.push(``);
  tail.push(`/* ---- 思源的加载契约：module.exports 必须直接是插件类 ---- */`);
  tail.push(`module.exports = ${entryRef};`);
  tail.push(`module.exports.default = ${entryRef};`);
  tail.push(``);

  return head.join("\n") + parts.join("\n\n") + "\n" + tail.join("\n");
}

/* -------------------------------------------------------------------------
 * 4) 自检
 * ---------------------------------------------------------------------- */
function selfCheck(outDir, bundleCode) {
  const problems = [];
  const stripped = maskComments(bundleCode);

  const badReqs = [];
  const re = /require\(\s*["'](\.\/[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(stripped))) badReqs.push(m[1]);
  if (badReqs.length) {
    problems.push(`产物里仍有相对 require（思源无法解析，会静默失败）: ${[...new Set(badReqs)].join(", ")}`);
  }
  if (/^\s*export\s+(default|const|function|class|\{)/m.test(stripped)) {
    problems.push("产物仍含 export 语句（构建器只支持 export default / export const|function|class）");
  }
  if (/^\s*import\s+[\w{*]/m.test(stripped)) {
    problems.push("产物仍含 import 语句");
  }
  if (!/module\.exports\s*=/.test(stripped)) {
    problems.push("产物没有 module.exports");
  }

  // 主题/类名前缀：CSS 与 JS 里用的类名必须是 lfs-
  const classNames = new Set();
  const cre = /"([a-z0-9-]*lfs-[a-z0-9-]*)"/g;
  while ((m = cre.exec(bundleCode))) classNames.add(m[1]);

  try {
    const pj = JSON.parse(fs.readFileSync(path.join(outDir, "plugin.json"), "utf8"));
    const dirName = path.basename(outDir);
    const isRepoDist = path.resolve(outDir) === path.resolve(REPO_DIST);
    if (!isRepoDist && pj.name !== dirName) {
      problems.push(`plugin.json.name(${pj.name}) 与目录名(${dirName}) 不一致 —— 思源靠它配对加载`);
    }
    if (pj.icon && !fs.existsSync(path.join(outDir, pj.icon))) problems.push(`icon 缺失: ${pj.icon}`);
    for (const [k, v] of Object.entries(pj.readme || {})) {
      if (!fs.existsSync(path.join(outDir, v))) problems.push(`readme.${k} 缺失: ${v}`);
    }
  } catch (e) {
    problems.push("plugin.json 无法解析: " + e.message);
  }

  // i18n 必须能被解析，且与源码用到的 key 大致对得上
  try {
    const zh = JSON.parse(fs.readFileSync(path.join(SRC_ROOT, "i18n/zh_CN.json"), "utf8"));
    const called = new Set();
    const kre = /this\.t\(\s*"([A-Za-z0-9_]+)"/g;
    while ((m = kre.exec(bundleCode))) called.add(m[1]);
    const missing = [...called].filter((k) => !(k in zh));
    if (missing.length) {
      problems.push(`i18n/zh_CN.json 缺少源码用到的 key: ${missing.join(", ")}`);
    }
  } catch (e) {
    problems.push("i18n 自检失败: " + e.message);
  }

  return problems;
}

/* -------------------------------------------------------------------------
 * 主流程
 * ---------------------------------------------------------------------- */
function assertEntryIsSource() {
  const entryAbs = path.join(SRC_ROOT, ENTRY);
  if (!fs.existsSync(entryAbs)) {
    throw new Error(`入口源码不存在: ${entryAbs}`);
  }
  const text = fs.readFileSync(entryAbs, "utf8");
  if (!/^\s*export\s+default\s+class\b/m.test(text)) {
    throw new Error(
      `★ 仓库根的 ${ENTRY} 里没有 "export default class" —— 它必须永远是 **ESM 入口源码**。\n` +
      `  如果它看起来像打包产物，说明被"同步产物"那一步覆盖了（本项目根 index.js 同时是 build 的输出名）。`
    );
  }
  return text;
}

function main() {
  let outDir = process.argv[2] || DEFAULT_OUT;
  if (outDir === "--repo") outDir = REPO_DIST;

  assertEntryIsSource();

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "i18n"), { recursive: true });

  const code = bundle();
  fs.writeFileSync(path.join(outDir, "index.js"), code, "utf8");

  console.log(`输出目录：${outDir}\n`);
  console.log(`  ✓ index.js  (打包，${code.length} 字节)`);

  for (const rel of STATIC) {
    const src = path.join(SRC_ROOT, rel);
    if (!fs.existsSync(src)) {
      console.log(`  ! ${rel} 不存在，跳过`);
      continue;
    }
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${rel}  (拷贝)`);
  }

  // 清掉旧的 src/：思源不需要它，留着只会让排查的人以为要多文件加载
  const oldSrc = path.join(outDir, "src");
  if (fs.existsSync(oldSrc)) {
    for (const f of fs.readdirSync(oldSrc)) {
      const fp = path.join(oldSrc, f);
      if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
    }
    try {
      fs.rmdirSync(oldSrc);
      console.log("  ✓ 已移除旧的 src/ 目录（改为单文件打包）");
    } catch (e) {
      /* 非空就算了 */
    }
  }

  const problems = selfCheck(outDir, code);
  console.log("\n---------------- 自检 ----------------");
  if (problems.length === 0) {
    console.log("  ✅ 单文件打包完成；无相对 require；module.exports 已设置；i18n 齐");
  } else {
    console.log("  ❌ 发现 " + problems.length + " 个问题:");
    for (const p of problems) console.log("     · " + p);
  }
  console.log("--------------------------------------\n");
  process.exitCode = problems.length ? 1 : 0;
}

main();
