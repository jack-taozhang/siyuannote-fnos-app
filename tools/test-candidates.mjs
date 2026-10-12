/**
 * api.js 的探测顺序专项测试（不需要浏览器、不需要 NAS）
 * -------------------------------------------------------------------------
 * 这里为什么值得单独写一个测试：
 *
 *   探测顺序错了**不会报错**，只会表现成"面板偶尔空白、console 被 CORS 刷屏"，
 *   真机上极难定位。而它的逻辑又全是纯函数 + 几个模块级缓存，完全可以在 node 里
 *   用假的 location / fetch 精确钉死。
 *
 * 钉住三件事：
 *   ① 缓存地址（lastBase）只在**与当前页面同源**时才允许进候选 ——
 *      否则换个网口/域名打开就会先去探测另一台主机，跨源必被浏览器拦下；
 *   ② 候选的排序：用户手填 > 同源带前缀 > 同源裸根；
 *      （`http://<host>:8021` 那条跨源候选 2026-10-10 已删 —— 直连绕过反代，
 *        CAD / 文件预览 / Office 三条链路都拿不到登录态，Office 直接 403）
 *   ③ 探测的节流：并发合并 + 失败负缓存（防刷日志/刷报错）。
 *
 * 用法：node tools/test-candidates.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "api.js");

// api.js 是纯 ESM 且没有任何 import ⇒ 原样拷成 .mjs 就能直接 import
const tmp = join(mkdtempSync(join(tmpdir(), "lfs-cand-")), "api.mjs");
writeFileSync(tmp, readFileSync(SRC, "utf8"));

// 装一个可变的 location：测试过程中逐条改
globalThis.location = { protocol: "http:", origin: "http://x", hostname: "x" };

const api = await import(pathToFileURL(tmp).href);
const { candidateBases, detectBase, resetDetection, normBase, PREFIX } = api;

let PASS = 0;
let FAIL = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    PASS++;
    console.log("  ok   " + label);
  } else {
    FAIL++;
    console.log("  FAIL " + label + "\n         got = " + a + "\n         want= " + b);
  }
};
const ok = (label, cond, detail) => {
  if (cond) {
    PASS++;
    console.log("  ok   " + label);
  } else {
    FAIL++;
    console.log("  FAIL " + label + (detail ? "  <- " + detail : ""));
  }
};

const setLoc = (protocol, origin, hostname) => {
  globalThis.location = { protocol, origin, hostname };
};

console.log("─".repeat(70));
console.log("① 网页版：同源可用时，绝不能先去碰跨源的缓存地址");
// 场景：插件数据存在内核里、全机共享。上次从 172.16.30.128 打开，缓存里就留了
//      那台主机；这次从 192.168.193.70 打开 —— 必须先同源，绝不先跨源。
setLoc("http:", "http://192.168.193.70:6806", "192.168.193.70");
{
  const list = candidateBases("", "http://172.16.30.128:6806/localfs");
  eq("候选顺序（1=同源带前缀, 2=同源裸根）", list, [
    "http://192.168.193.70:6806/localfs",
    "http://192.168.193.70:6806",
  ]);
  ok("跨源缓存地址没有混进候选",
    !list.some((b) => b.indexOf("172.16.30.128") >= 0), JSON.stringify(list));
  ok("★ 候选里再也没有 `:8021`（直连绕过反代 ⇒ Office 拿不到登录态）",
    !list.some((b) => /:8021\b/.test(b)), JSON.stringify(list));
}

console.log("\n② 同源缓存会被复用（省一轮往返）");
{
  const list = candidateBases("", "http://192.168.193.70:6806/localfs");
  eq("同源缓存排第一", list[0], "http://192.168.193.70:6806/localfs");
  ok("且没有重复项", new Set(list).size === list.length, JSON.stringify(list));
}

console.log("\n③ 用户手填的地址永远排第一（桌面客户端场景它是唯一正解）");
{
  const list = candidateBases("http://192.168.1.10:8021", "http://192.168.193.70:6806/localfs");
  eq("手填地址在最前", list[0], "http://192.168.1.10:8021");
}

console.log("\n④ https 源 / 局域网以外的域名");
{
  setLoc("https:", "https://office.app.5ddd.com:38981", "office.app.5ddd.com");
  const list = candidateBases("", "");
  eq("优先 https 的同源地址", list.slice(0, 2), [
    "https://office.app.5ddd.com:38981/localfs",
    "https://office.app.5ddd.com:38981",
  ]);
}

console.log("\n⑤ 本机地址不补 :8021（现在任何地址都不补了）");
{
  setLoc("http:", "http://127.0.0.1:6806", "127.0.0.1");
  eq("127.0.0.1 不产生跨源候选", candidateBases("", ""), [
    "http://127.0.0.1:6806/localfs",
    "http://127.0.0.1:6806",
  ]);
}

console.log("\n⑥ Electron 客户端（file:// 之类没有「同源」可言）");
{
  setLoc("file:", "null", "");
  eq("只剩缓存地址", candidateBases("", "http://192.168.193.70:6806/localfs"),
    ["http://192.168.193.70:6806/localfs"]);
  eq("没有缓存就什么都探不到（要用户手填）", candidateBases("", ""), []);
}

console.log("\n⑦ 去重：手填地址恰好就是同源地址时不重复");
{
  setLoc("http:", "http://192.168.193.70:6806", "192.168.193.70");
  eq("同源带前缀被手填占掉后不再出现两次",
    candidateBases("http://192.168.193.70:6806/localfs", ""),
    ["http://192.168.193.70:6806/localfs", "http://192.168.193.70:6806"]);
}

console.log("\n⑧ 并发合并 + 失败负缓存 + resetDetection");
{
  setLoc("http:", "http://192.168.193.70:6806", "192.168.193.70");
  resetDetection();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: false, status: 502, json: async () => ({}), text: async () => "" };
  };

  // 并发两轮：内部只应该真的探一轮
  const [r1, r2] = await Promise.all([
    detectBase("", ""),
    detectBase("", ""),
  ]);
  const want = [
    "http://192.168.193.70:6806/localfs/api/health",
    "http://192.168.193.70:6806/api/health",
  ];
  eq("并发两轮只探一轮（2 次请求）", calls.length, 2);
  eq("探测地址就是候选顺序", calls, want);
  eq("两个调用都拿到 health=null", [r1.health, r2.health], [null, null]);

  const n = calls.length;
  await detectBase("", "");
  eq("负缓存期内不再重复探测", calls.length, n);

  resetDetection();
  await detectBase("", "");
  eq("resetDetection 后又真探了一轮", calls.length, n + 2);
}

console.log("\n⑨ 命中：第 2 个候选可用时选它，且记进 base");
{
  setLoc("http:", "http://192.168.193.70:6806", "192.168.193.70");
  resetDetection();
  const calls = [];
  // ★ 注意这里必须带 `app` —— 探活现在要核对身份（见 ⑫），
  //   只回 {ok,roots} 会被判成"连上了但不是本服务"，这条会假红。
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const hit = String(url) === "http://192.168.193.70:6806/api/health";
    return {
      ok: hit,
      status: hit ? 200 : 502,
      json: async () => (hit ? { ok: true, app: "siyuan-local-fs", roots: ["/vol1"] } : {}),
      text: async () => (hit ? '{"ok":true,"app":"siyuan-local-fs","roots":["/vol1"]}' : ""),
    };
  };
  const r = await detectBase("", "");
  eq("选中裸根那个", r.base, "http://192.168.193.70:6806");
  eq("health 传了出来", r.health && r.health.roots, ["/vol1"]);
  eq("只探到命中为止（2 次）", calls.length, 2);

  // 命中之后：再调一次不应重新探测
  const n = calls.length;
  const r2 = await detectBase("", "");
  eq("命中后复用，不再探测", calls.length, n);
  eq("复用的 base 一致", r2.base, r.base);
}

console.log("\n⑩ normBase / PREFIX 基本约定没被改坏");
eq("normBase 补协议", normBase("192.168.1.10:8021"), "http://192.168.1.10:8021");
eq("normBase 去尾斜杠", normBase("http://a.b/localfs///"), "http://a.b/localfs");
eq("前缀常量", PREFIX, "/localfs");

console.log("\n⑪ 飞牛登录态：桌面端必须走「同源同步页」，不能硬发跨源凭据请求");
// 背景（2026-10-10 定案）：
//   桌面端页面跑在本机内核上，跨源 fetch **带不到** NAS 的飞牛 Cookie；
//   而且 local-fs 的 _cors() 没回 Access-Control-Allow-Credentials ⇒ 带
//   credentials:"include" 的跨源响应会被浏览器直接拦成"连不上"。
//   ⇒ 判定同源用的是 fnosCredSameOrigin()，"同步"按钮据此分两条路。
//   这几条断言钉的就是这个判定 + 两个地址的拼法（同源/跨源各一遍）。
const { setBase, fnosCredUrl, fnosCredPageUrl, fnosCredSameOrigin } = api;

{
  // ① 网页版 / 手机：页面就在 NAS 的 6806 上 ⇒ 同源
  setLoc("http:", "http://192.168.193.70:6806", "192.168.193.70");
  setBase("http://192.168.193.70:6806/localfs", { ok: true });
  ok("同源判定为真", fnosCredSameOrigin() === true);
  eq("同源凭据接口走页面 origin",
    fnosCredUrl(), "http://192.168.193.70:6806/localfs/api/fnos-cred");
  eq("同源同步页也在页面 origin",
    fnosCredPageUrl(), "http://192.168.193.70:6806/localfs/cred-sync");

  // ② 桌面思源客户端：页面在内核（127.0.0.1），_base 是手填的 NAS
  setLoc("http:", "http://127.0.0.1:6808", "127.0.0.1");
  setBase("http://192.168.193.70:6806/localfs", { ok: true });
  ok("跨源判定为假", fnosCredSameOrigin() === false);
  eq("跨源凭据接口按 _base 的源拼",
    fnosCredUrl(), "http://192.168.193.70:6806/localfs/api/fnos-cred");
  eq("跨源同步页按 _base 的源拼（window.open 用的就是它）",
    fnosCredPageUrl(), "http://192.168.193.70:6806/localfs/cred-sync");

  // ③ 手填直连 8021：地址要**跟着用户填的源走**，不能悄悄改回 :6806
  //    （local-fs 两头都认：前缀它自己剥）
  setBase("http://192.168.193.70:8021", { ok: true });
  eq("手填 :8021 ⇒ 凭据接口也走 :8021",
    fnosCredUrl(), "http://192.168.193.70:8021/localfs/api/fnos-cred");
  eq("手填 :8021 ⇒ 同步页也走 :8021",
    fnosCredPageUrl(), "http://192.168.193.70:8021/localfs/cred-sync");

  // ④ 还没探测出地址：返回空串，让调用方提示"先填地址"，而不是拼出个野地址
  resetDetection();
  eq("没有 _base 时凭据接口返回空串", fnosCredUrl(), "");
  eq("没有 _base 时同步页返回空串", fnosCredPageUrl(), "");
  ok("没有 _base 时不算同源", fnosCredSameOrigin() === false);

  // ⑤ 浏览器版：_base 是裸根（同源候选③）也要能拼对
  setLoc("http:", "http://nas.lan:6806", "nas.lan");
  setBase("http://nas.lan:6806", { ok: true });
  eq("裸根同源 ⇒ 凭据接口补上前缀",
    fnosCredUrl(), "http://nas.lan:6806/localfs/api/fnos-cred");
  ok("裸根同源判定为真", fnosCredSameOrigin() === true);
}

console.log("\n⑫ 探活必须核对身份：裸根上的 fnos-file-viewer 不能被当成「本机存储」");
// 背景（2026-10-10，用户报"上面显示的信息应该不对吧"）：
//   反代把根绝对的 /api/*、/health 划给了「文件预览」应用 ⇒
//   `http://<nas>:6806/api/health` 答的是 {"app":"fnos-file-viewer","version":"1.0.3"}。
//   只判 ok:true 的探活会认下它、把 _base 设成裸根 ⇒ 面板显示
//   `fnos-file-viewer 1.0.3 · 0 个存储空间`（用户看到的那一行），文件树也是别人的。
//   ⇒ probeBase 现在认死 app === APP_ID；probeRaw 保留给"那是谁"的诊断。
{
  const { probeBase, probeRaw, APP_ID } = api;
  eq("APP_ID 与后端对齐", APP_ID, "siyuan-local-fs");

  setLoc("http:", "http://192.168.193.70:6806", "192.168.193.70");

  // ① 裸根：答的是 file-viewer ⇒ 探活必须"没探到"，但 probeRaw 要能报出它是谁
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, app: "fnos-file-viewer", version: "1.0.3", roots: [] }),
    text: async () => "",
  });
  eq("裸根答 file-viewer ⇒ probeBase 返回 null（不认错人）",
    await probeBase("http://192.168.193.70:6806"), null);
  const raw = await probeRaw("http://192.168.193.70:6806");
  ok("probeRaw 仍能如实报出「那是谁」（供面板诊断）",
    raw && raw.app === "fnos-file-viewer" && raw.version === "1.0.3", JSON.stringify(raw));

  // ② 真正的本机存储（带 /localfs）⇒ 正常探到
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, app: "siyuan-local-fs", roots: ["/vol00", "/vol1"] }),
    text: async () => "",
  });
  const good = await probeBase("http://192.168.193.70:6806/localfs");
  ok("真本机存储 ⇒ probeBase 命中且带 roots",
    good && good.app === "siyuan-local-fs" && good.roots.length === 2, JSON.stringify(good));

  // ③ 没有 app 字段的应答（别的东西恰好也答 ok:true）⇒ 同样不认
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true }),
    text: async () => "",
  });
  eq("只有 ok:true、无 app ⇒ 不认（宁可探不通，也不认错人）",
    await probeBase("http://192.168.193.70:6806"), null);

  // ④ 端到端复现用户那一幕：**手填裸根**（手填永远排第一）⇒
  //    第一个候选答的是 file-viewer，被身份校验拦下，才轮到带 /localfs 的那个。
  resetDetection();
  const hits = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    hits.push(u);
    const isFv = u === "http://192.168.193.70:6806/api/health";
    return {
      ok: true, status: 200,
      json: async () => (isFv
        ? { ok: true, app: "fnos-file-viewer", version: "1.0.3", roots: [] }
        : { ok: true, app: "siyuan-local-fs", roots: ["/vol00", "/vol1"] }),
      text: async () => "",
    };
  };
  const r3 = await detectBase("http://192.168.193.70:6806", "");
  eq("★ 裸根被拦下后才轮到带 /localfs 的地址（探 2 次）", hits.length, 2);
  eq("★ 最终选中的是带 /localfs 的地址，不是裸根",
    r3.base, "http://192.168.193.70:6806/localfs");
  eq("★ health 是本机存储的（2 个存储空间），不是 file-viewer 的 0 个",
    r3.health && r3.health.roots, ["/vol00", "/vol1"]);
}

console.log("\n" + "─".repeat(70));
console.log("通过 " + PASS + " / 失败 " + FAIL);
process.exit(FAIL ? 1 : 0);
