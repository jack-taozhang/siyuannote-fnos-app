/* ==========================================================================
 * 打包：把「本机思源里跑着的产物」收成一个可直接安装的 ZIP
 * --------------------------------------------------------------------------
 * ★ 为什么从**已构建的产物**取 index.js，而不是重新 build 一遍 ★
 *   这两件事是刻意分开的：
 *     · `npm run build` —— 我只想尽快看到改动生效（输出到本机思源）
 *     · `npm run pack`  —— 我要的是"和刚才验证过的那个东西一模一样"的包
 *   如果 pack 里悄悄重新构建，就会出现"包的字节和验证过的不一致"这种
 *   最没必要的怀疑。所以默认用 BUILT 里现成的那份；确实要重建时加 `--rebuild`。
 *
 * 用法：
 *   node tools/pack.js              → 用已构建的 index.js 打包
 *   node tools/pack.js --rebuild    → 先 build 再打包
 * ========================================================================== */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const NAME = "siyuan-localfs";
const BUILT = "D:/Software/SiYuan/data/plugins/" + NAME;
const OUT_DIR = path.join(ROOT, "dist-package");
const ZIP = path.join(OUT_DIR, NAME + ".zip");

const REBUILD = process.argv.includes("--rebuild");

/** 取 plugin.json 里的版本号（打包产物要带版本，否则收件人分不清手上是哪个包） */
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8")).version;
const ZIP_VERSIONED = path.join(OUT_DIR, NAME + "-" + VERSION + ".zip");

if (REBUILD) {
  console.log("── 先重新构建 ──");
  execFileSync(process.execPath, [path.join(__dirname, "build.js")], { stdio: "inherit" });
}

/** [源文件, ZIP 内的相对路径] */
const ITEMS = [
  [path.join(BUILT, "index.js"), "index.js"],
  [path.join(BUILT, "index.css"), "index.css"],
  [path.join(ROOT, "plugin.json"), "plugin.json"],
  [path.join(ROOT, "icon.png"), "icon.png"],
  [path.join(ROOT, "README.md"), "README.md"],
  [path.join(ROOT, "README.zh_CN.md"), "README.zh_CN.md"],
  [path.join(ROOT, "i18n", "zh_CN.json"), "i18n/zh_CN.json"],
  [path.join(ROOT, "i18n", "en_US.json"), "i18n/en_US.json"],
];

/* ---------------- 极简 ZIP 写入（deflate，零依赖） ---------------- */
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = e.data;
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = comp.length < raw.length;
    const data = useDeflate ? comp : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ---------------- 读回来校验（不能只看"写成功了"） ---------------- */
function readZip(buf) {
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP 里找不到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("中央目录头损坏，第 " + i + " 条");
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString("utf8");
    // 本地头里的 extra 长度可能与中央目录不同，必须按本地头读
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnlen + lelen;
    const raw = buf.slice(dataStart, dataStart + csize);
    const plain = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (plain.length !== usize) throw new Error(name + " 解压长度不符");
    if (crc32(plain) !== crc) throw new Error(name + " crc 不符");
    out.push({ name, data: plain });
    off += 46 + nlen + elen + clen;
  }
  return out;
}

/* ---------------- 组装 ---------------- */
const entries = [];
const missing = [];
for (const [src, rel] of ITEMS) {
  if (!fs.existsSync(src)) {
    missing.push(rel);
    continue;
  }
  entries.push({ name: NAME + "/" + rel, data: fs.readFileSync(src), src, rel });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const ZIP_BUF = buildZip(entries);
fs.writeFileSync(ZIP, ZIP_BUF);
fs.writeFileSync(ZIP_VERSIONED, ZIP_BUF);

console.log("产物目录: " + BUILT);
console.log("\n输出: " + ZIP);
console.log("      " + ZIP_VERSIONED + "（带版本号，交付用）");
console.log("大小: " + ZIP_BUF.length + " 字节");
entries.forEach((e) => {
  console.log("   " + String(e.data.length).padStart(8) + "  " + e.name);
});
if (missing.length) console.log("\n⚠️ 缺失（跳过）: " + missing.join(", "));

/* ---------------- 自检 ---------------- */
let failed = 0;
const check = (title, fn) => {
  try {
    const r = fn();
    if (r === false) throw new Error("断言为假");
    console.log("  ✅ " + title + (typeof r === "string" ? "  " + r : ""));
  } catch (e) {
    failed++;
    console.log("  ❌ " + title + "  " + e.message);
  }
};

console.log("\n---------------- 自检 ----------------");
const back = readZip(fs.readFileSync(ZIP));

check("ZIP 可完整解压且 crc 全对", () => back.length + " 条");

check("条目数一致", () => {
  if (back.length !== entries.length) throw new Error(`包内 ${back.length} ≠ 期望 ${entries.length}`);
  return true;
});

check("全部条目都在 " + NAME + "/ 目录下", () => {
  const bad = back.filter((b) => !b.name.startsWith(NAME + "/"));
  if (bad.length) throw new Error(bad.map((b) => b.name).join(", "));
  return true;
});

check("含思源加载必需的四个文件", () => {
  ["plugin.json", "index.js", "icon.png", "i18n/zh_CN.json"].forEach((f) => {
    if (!back.some((b) => b.name === NAME + "/" + f)) throw new Error("缺 " + f);
  });
  return true;
});

check("index.js 与已构建产物逐字节一致", () => {
  const inZip = back.find((b) => b.name === NAME + "/index.js");
  const onDisk = fs.readFileSync(path.join(BUILT, "index.js"));
  if (!inZip.data.equals(onDisk)) throw new Error("不一致 —— 包里的不是刚构建的那份");
  return "(" + onDisk.length + " 字节)";
});

check("index.js 里没有相对 require", () => {
  let src = back.find((b) => b.name === NAME + "/index.js").data.toString("utf8");
  // ★ 先挖空注释再查：产物头部/模块注释里就写着 `require("./src/x.js")` 作为反例说明，
  //   不挖空会把"我自己写的解释"当成真代码报出来（nebuladisk 的构建器踩过这个坑）。
  src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const m = src.match(/require\(\s*["']\.\//g);
  if (m) throw new Error("发现 " + m.length + " 处");
  return true;
});

check("index.js 以 module.exports 暴露插件类", () => {
  const src = back.find((b) => b.name === NAME + "/index.js").data.toString("utf8");
  if (!/module\.exports\s*=/.test(src)) throw new Error("没有 module.exports");
  return true;
});

check("plugin.json 的 name 与目录名一致", () => {
  const pj = JSON.parse(back.find((b) => b.name === NAME + "/plugin.json").data.toString("utf8"));
  if (pj.name !== NAME) throw new Error(`name=${pj.name}`);
  return "v" + pj.version;
});

check("package.json / plugin.json 版本一致", () => {
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
  const pk = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (pj.version !== pk.version) throw new Error(`${pj.version} ≠ ${pk.version}`);
  return "v" + pj.version;
});

check("带版本号的交付包已产出且字节一致", () => {
  if (!fs.existsSync(ZIP_VERSIONED)) throw new Error("缺 " + path.basename(ZIP_VERSIONED));
  if (!fs.readFileSync(ZIP_VERSIONED).equals(ZIP_BUF)) throw new Error("与主产物字节不一致");
  return path.basename(ZIP_VERSIONED) + "  (" + ZIP_BUF.length + " 字节)";
});

check("文件名里的版本号 == plugin.json 的版本号", () => {
  const m = /-(\d+\.\d+\.\d+)\.zip$/.exec(ZIP_VERSIONED);
  if (!m) throw new Error("产物名里读不到版本号");
  if (m[1] !== VERSION) throw new Error(`文件名 ${m[1]} ≠ plugin.json ${VERSION}`);
  return "v" + VERSION;
});

console.log("--------------------------------------");
console.log(failed ? `❌ ${failed} 项未通过` : "✅ 全部通过");
process.exitCode = failed ? 1 : 0;
