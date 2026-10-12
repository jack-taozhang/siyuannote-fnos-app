/* ==========================================================================
 * 文件树「折叠」契约的静态回归断言
 * --------------------------------------------------------------------------
 * 为什么需要这个文件：
 *   2026-10-08 真机报障——「文件树点击文件夹左边的收起，没有反应。
 *   不知道是太小不容易点住还是功能缺失。」
 *   排查结论：**index.css 里根本没有 .lfs-list.is-children 的显隐规则**，
 *   而 <ul> 默认 display:block ⇒ 子树永远摊开、收起时"摘掉 is-open"看不出变化。
 *
 *   这个 bug 有两个特点，正是它必须被单独盯住的原因：
 *     ① **JS 完全正确**。click → setExpanded() → toggle is-open → 换箭头字形，
 *        逻辑一路对，所以只测 JS 的用例全绿（当时 39/39 就是这样过去的）。
 *     ② **不报错**。console 干净，没有异常，没有失败请求。
 *     ③ **在 JS 里也测不出来**：真机验证脚本跑的是"请求数 / 报错数 / 截图"，
 *        而"子树没收起来"既不产生请求也不产生报错。
 *
 *   ⇒ 结论：这类"JSON/CSS 层契约"的坑，只能靠**把契约本身写成断言**来防回归。
 *     本文件就是那份契约的书面化：CSS 必须给出"关闭态隐藏、打开态显示"两条规则，
 *     JS 必须同时具备"造 is-children 容器"和"切 is-open"两半。
 *     三者缺一，树在真机上就是坏的。
 *
 * 用法：node tools/test-collapse.mjs
 * ========================================================================== */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
/** 本机构建产物（deploy-nas.sh 的上传源）——多断言一层"构建没把这条规则丢掉" */
const BUILT = "D:/Software/SiYuan/data/plugins/siyuan-localfs";

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "   → " + extra : "")); }
};

const css = readFileSync(join(ROOT, "index.css"), "utf8");
const js = readFileSync(join(ROOT, "src", "explorer.js"), "utf8");

/** 把 CSS 压成一行比对，躲开缩进/换行差异 */
const flat = (s) => s.replace(/\s+/g, " ").trim();

console.log("\n【1】CSS：关闭态必须隐藏子树");
ok(
  "存在 `.lfs-node.is-dir > .lfs-list.is-children { display: none }`",
  /\.lfs-node\.is-dir\s*>\s*\.lfs-list\.is-children\s*\{[^}]*display\s*:\s*none/.test(flat(css)),
  "缺了这条 ⇒ 子树永远摊开，收起时看起来「没反应」"
);

console.log("\n【2】CSS：打开态必须显示子树");
ok(
  "存在 `.lfs-node.is-dir.is-open > .lfs-list.is-children { display: block }`",
  /\.lfs-node\.is-dir\.is-open\s*>\s*\.lfs-list\.is-children\s*\{[^}]*display\s*:\s*block/.test(flat(css))
);

console.log("\n【3】CSS：折叠箭头的命中区不能退回「12px 小三角」");
{
  const m = css.match(/\.lfs-caret\s*\{([^}]*)\}/);
  ok("能取到 .lfs-caret 规则块", !!m);
  if (m) {
    const w = m[1].match(/width\s*:\s*(\d+)px/);
    ok("宽度 ≥ 16px（原来 12px，鼠标/手指都难点住）", w && Number(w[1]) >= 16, w ? "当前 " + w[1] + "px" : "没有 width");
    ok("占满整行高度（align-self: stretch）", /align-self\s*:\s*stretch/.test(flat(m[1])));
  }
  ok(".lfs-caret.is-leaf 不吃点击（pointer-events: none）", /\.lfs-caret\.is-leaf\s*\{[^}]*pointer-events\s*:\s*none/.test(flat(css)));
}

console.log("\n【4】JS：造容器的类名必须和 CSS 选择器对得上");
ok('JS 里造的是 is-children 容器（el("ul", CLS + "-list is-children")）',
  /el\(\s*"ul"\s*,\s*CLS\s*\+\s*"-list is-children"\s*\)/.test(js));
ok('目录节点带 is-dir 标记', /CLS\s*\+\s*"-node is-dir"/.test(js));

console.log("\n【5】JS：切换 is-open 的两半都在");
ok("展开时 add('is-open')", /classList\.add\(\s*"is-open"\s*\)/.test(js));
ok("收起时 remove('is-open')", /classList\.remove\(\s*"is-open"\s*\)/.test(js));
ok("箭头字形切换 ▸/▾ 都在", js.includes("\\u25BE") && js.includes("\\u25B8"));
ok("点击判定挂在整行上（row.addEventListener('click'…)）", /row\.addEventListener\(\s*"click"/.test(js));

console.log("\n【6】构建产物必须带着这些规则（构建没丢 CSS）");
if (!existsSync(join(BUILT, "index.css"))) {
  console.log("  – 跳过：本机产物目录不存在（还没构建过）");
} else {
  const b = flat(readFileSync(join(BUILT, "index.css"), "utf8"));
  ok("产物 index.css 含关闭态隐藏规则", /\.lfs-node\.is-dir\s*>\s*\.lfs-list\.is-children\s*\{[^}]*display\s*:\s*none/.test(b));
  ok("产物 index.css 含打开态显示规则", /\.lfs-node\.is-dir\.is-open\s*>\s*\.lfs-list\.is-children\s*\{[^}]*display\s*:\s*block/.test(b));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
