/* ==========================================================================
 * 本机存储服务（siyuannote 应用里的 local-fs，:8021）的客户端
 * --------------------------------------------------------------------------
 * ★ 为什么"地址"要探测而不是写死 ★
 *   同一个插件要同时在三种处境下能用，而它们该连的地址并不一样：
 *
 *     ① 网页版 / 手机（经飞牛 App 或 FN Connect 穿透）
 *        → 页面本身就是**从这台机器的 6806** 发出的
 *        ⇒ 同源 `location.origin + /localfs` 就是正解（穿透只映射这一个端口）
 *     ② 网页版（局域网 IP / ZeroTier 直连 6806）
 *        → 同上，同源即可
 *     ③ 思源**桌面客户端**
 *        → 它跑的是**自己本机的内核**，同源地址上压根没有这个服务
 *        ⇒ 必须在设置里手填 NAS 的地址（且要填 **6806** 那条路，见下）
 *
 *   所以这里的顺序是：**先已保存的 → 再同源带前缀 → 再同源裸根**，
 *   逐个用 /api/health 试，谁先答对就用谁。都答不上时给出可操作的提示，
 *   而不是让用户对着空白面板发呆。
 *
 * ★★ 2026-10-10：**不再把 `:8021` 放进自动候选** ★★
 *   直连 8021（local-fs 的监听端口）能连上**文件接口**，但它是"半坏"的：
 *     ① 外网穿透只映射 6806 ⇒ 8021 根本够不到；
 *     ② 绕过反代 ⇒ Office 那条路拿不到反代补的飞牛登录态，打开就是 403。
 *   ⇒ 一旦探测"成功"选中它，用户看到的是"面板能列出文件、点开文档就坏"，
 *     比直接探不到还难排查。所以这条候选**整个拿掉**。
 *   （后端 local-fs 仍监听 8021 —— DIRECT_PORT 常量还在，用于端口对齐与
 *     解析用户手填的地址；只是插件不再**主动**去试它。）
 *
 * ★ 关于跨源（现在只剩"用户手填"这一种）★
 *   local-fs 回了 `Access-Control-Allow-Origin: <回显 Origin>`（见其 _cors()），
 *   所以用户手填 `http://<nas>:8021` 这类跨源地址仍能被试通（不推荐，但能用）。
 *   ⚠️ 但判"通不通"只能看 fetch 成不成 —— `res.headers.get("access-control-allow-origin")`
 *      在 JS 侧通常读到 null（ACAO 不在 CORS 安全清单里，除非服务端回 Expose-Headers）。
 * ========================================================================== */

/** 同源通道的前缀，与 reverse-proxy.py 的 PROXY_LOCAL_FS_PREFIX 一致 */
export const PREFIX = "/localfs";

/** 直连端口，与 cmd/main 的 LOCAL_FS_PORT 一致 */
export const DIRECT_PORT = 8021;

/**
 * **思源反代的端口**（对外唯一入口）—— 三条「借用飞牛应用」的链路
 * （CAD 看图 / 文件预览 / Office 文档）全部拼在它上面的**同源通道**里。
 *
 * ★ 与 reverse-proxy.py 的监听端口一致（`cmd/main` 的 PROXY_LISTEN_PORT）★
 * ★ 2026-10-10 定档：不再直连 8020 / 8030 / 5666 —— 理由见 channelUrl ★
 */
export const PROXY_PORT = 6806;

const PROBE_TIMEOUT = 2500;
const API_TIMEOUT = 15000;

/**
 * 一轮探测全失败后，这么久之内不重复探同一组候选。
 * ★ 为什么需要它 ★
 *   插件的设置是存在**内核**里的（saveData → /api/petal/savePluginData），
 *   全机器共享。而探测可能在一次页面加载里被触发好几次
 *   （onload / onLayoutReady / 每个面板 start），同源又不通时就会把
 *   同一组失败地址反复打一遍 —— 跨源那几个还会各刷一条 CORS 报错。
 *   有了负缓存，一轮不通之后剩下的触发直接复用结论。
 */
const NEGATIVE_TTL = 5000;

// 探测结果缓存在模块里：面板、预览、设置都要用，别每次重探
let _base = "";
let _health = null;
let _detected = false;

// 同一时刻只跑一轮探测（并发的 start()/onLayoutReady 共用同一个 Promise）
let _inflight = null;
let _failKey = "";
let _failAt = 0;

/** 把 base 归一成 `scheme://host[:port]`，用于比"是不是同一个源" */
function originOf(base) {
  const m = /^(https?:\/\/[^/]+)/i.exec(normBase(base));
  return m ? m[1].toLowerCase() : "";
}

/** 从 base 里取出**主机名**（去掉 scheme 与端口）；取不到返回 "" */
function hostOf(base) {
  const m = /^https?:\/\/([^/:]+)/i.exec(normBase(base));
  return m ? m[1] : "";
}

/**
 * 「借用飞牛应用」的地址 —— **一律走思源反代（:6806）的同源通道**。
 *
 * ★★ 2026-10-10 定档：三条链路（CAD 看图 / 文件预览 / Office 文档）全部收回到
 *    6806 的同源通道，**不再直连各自的应用端口**（8020 / 8030 / 5666）★★
 *
 *   好处是三种走法一份代码：
 *     · 浏览器开 NAS 的思源       → 页面自身就在 6806 上；
 *     · 手机经飞牛 App / 外网穿透 → 穿透**只映射 6806** 这一个端口，
 *                                    直连 8020/8030/5666 根本够不到；
 *     · 桌面思源客户端            → 内核在本机（本机没有反代），
 *                                    按 _base 探测到的 NAS 主机 + 6806 走。
 *
 *   ★ 为什么不直连（哪怕内网明明可达）★
 *     内嵌要**净化**：藏掉那两个查看器自带的 UI（CAD 的工具条/命令行/
 *     底部状态栏、文件预览的左侧文件树与顶栏、Office 的工具栏）靠的是
 *     `iframe.contentDocument` 注入样式（见 purify.js）。
 *     一旦 iframe 跨源，`contentDocument` 恒 null ⇒ 注入静默失败
 *     ⇒ 那些外壳**全部回来**（用户专门提过"命令行挡图纸"）。
 *     同源通道同时解决了"够不够得到"和"能不能净化"两件事。
 *
 *   ⚠️ 踩过：更早的版本只看 `location.protocol`，页面是 http 就直接用
 *      `location.origin` —— 在桌面客户端上那指向本机内核，
 *      `/localfs/fv/…` 必然 404（桌面端文件预览一直打不开，根因在此）。
 *
 * @param {string} chan 同源通道路径，如 "/localfs/cad"
 * @param {string} qs   查询串（**不含** "?"）
 * @param {string} [route] 该应用**自己的入口路径**，默认 "/"。
 *   ★ CAD 看图必须给 "/open" ★
 *     它的 server 只对 `/` 做静态兜底，带 path 打开图纸那条正规路由是
 *     「/open」这条 SPA 路由（server/index.mjs：「SPA 兜底：把 /open?path=... 之类的路径
 *     交给前端路由」）。给 `/` 虽然多数情况也能被前端自己读 location.search
 *     打开，但那等于绕开它的正规入口 —— 出问题时没法解释。
 *   Office 文档给 "/preview"；file-viewer 没有这种区分，保持默认 "/"。
 * @returns {string} 完整地址；连主机都取不到时返回 ""（调用方自行兜底）
 */
function channelUrl(chan, qs, route) {
  const r = route || "/";
  let pageOrigin = "";
  try {
    if (/^https?:$/.test(location.protocol)) pageOrigin = location.origin;
  } catch (e) { /* 非浏览器环境，忽略 */ }

  // ① _base 与页面同源（浏览器直接开 NAS 的思源、手机经飞牛 App、外网穿透）
  //    ⇒ 页面 origin 本身就是那条同源通道，直接用。
  if (pageOrigin && _base && originOf(_base) === originOf(pageOrigin)) {
    return pageOrigin + chan + r + "?" + qs;
  }
  // ② 桌面思源客户端：内核在本机，**本机没有反代** ⇒ 按 _base 探测到的 NAS
  //    主机 + 反代端口走（内网 / ZeroTier 都通）。
  const host = hostOf(_base);
  if (host) return "http://" + host + ":" + PROXY_PORT + chan + r + "?" + qs;
  // ③ 还没探测出 _base：退回页面 origin（多数情况它就是 NAS 的反代）
  return pageOrigin ? pageOrigin + chan + r + "?" + qs : "";
}



export function getBase() {
  return _base;
}

export function getHealth() {
  return _health;
}

export function isReady() {
  return !!( _base && _health );
}

/** 记住一次成功的地址（设置面板里"测试连接"通过时也会调） */
export function setBase(base, health) {
  _base = base;
  if (health !== undefined) {
    _health = health;
  }
  _detected = !!_health;
  if (_health) {
    _failKey = "";
    _failAt = 0;
  }
}

/** 忘掉缓存（含失败缓存），下次 detectBase 会老老实实重探一轮 */
export function resetDetection() {
  _base = "";
  _health = null;
  _detected = false;
  _failKey = "";
  _failAt = 0;
}

/** 把用户输入的地址收拾干净：补协议、去尾斜杠 */
export function normBase(u) {
  let s = String(u == null ? "" : u).trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  return s.replace(/\/+$/, "");
}

async function fetchTimeout(url, opt, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const init = Object.assign({ cache: "no-store", signal: ac.signal }, opt || {});
  try {
    return await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 本机存储服务的身份标识（= `local-fs.py` 的 APP_ID）。
 *
 * ★★ 2026-10-10 踩到：探活**必须核对身份**，只判 `ok` 会认错人 ★★
 *   反代为了收编"文件预览"那套前端，把 `/health`、`/api/list` 这些**根绝对**
 *   命名空间划给了 fnos-file-viewer（见 reverse-proxy.py 的 `_FV_ROOT_PREFIXES`）。
 *   于是 `http://<nas>:6806/api/health` 答的是 **file-viewer**：
 *       {"ok":true,"app":"fnos-file-viewer","version":"1.0.3", …}
 *   只判 `ok:true` 的话，插件会把它当成"本机存储连上了"，把 `_base` 设成**裸根**
 *   —— 接着 `/api/list`、`/api/file` 全被反代交给 file-viewer
 *   ⇒ 面板显示成 `fnos-file-viewer 1.0.3 · 0 个存储空间`（用户实测如此），
 *     文件树里的东西也不是 NAS 的目录。
 *   ⇒ 所以这里认死 `app === "siyuan-local-fs"`：认错人的代价远大于探不通。
 */
export const APP_ID = "siyuan-local-fs";

/**
 * 这个地址上**有没有东西**在答 `/api/health`（不校验身份）。
 * 只给诊断用 —— 用来把"连不上"和"连上了、但那是别的应用"区分开。
 */
export async function probeRaw(base) {
  const b = normBase(base);
  if (!b) return null;
  try {
    const res = await fetchTimeout(b + "/api/health", null, PROBE_TIMEOUT);
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.ok ? j : null;
  } catch (e) {
    return null;
  }
}

/**
 * 探一下这个 base 上有没有**本机存储服务**；有就返回它的 health 对象。
 * ★ 身份不对（比如上面那种 file-viewer）一律算没探到 ★
 */
export async function probeBase(base) {
  const j = await probeRaw(base);
  return j && j.app === APP_ID ? j : null;
}

/**
 * 候选地址。顺序 = 命中概率。
 *
 * ★ 顺序是有讲究的（踩过坑）★
 *   早先的写法把"上次探测成功的地址"（缓存）放在**最前面**。结果是这样翻车的：
 *   插件设置存在内核里、全机器共享，上次是在 `172.16.30.128:6806` 打开的页面，
 *   缓存里就留下了那台主机的地址；这次从 `192.168.193.70:6806` 打开，
 *   插件第一件事就是去 fetch `http://172.16.30.128:6806/localfs/api/health`
 *   —— 那是**跨源**请求，浏览器直接拦下（服务端 CORS 只认它自己那台主机），
 *   于是 console 被刷屏，还白等 2.5 秒才轮到同源那个真正能用的地址。
 *
 *   所以规则是：**缓存地址只在"与当前页面同源"时才敢用**；
 *   跨源地址一律排到最后（那是桌面客户端的活）。
 *
 * @param {string} [saved] 用户在设置里亲口填的地址（最高优先）
 * @param {string} [last]  上次探测成功的地址（缓存，同源才认）
 */
export function candidateBases(saved, last) {
  const out = [];
  const push = (v) => {
    const b = normBase(v);
    if (b && out.indexOf(b) < 0) out.push(b);
  };

  // ① 用户亲口指定的地址：桌面客户端场景下它是唯一能用的那个
  push(saved);

  let origin = "";
  let httpish = false;
  try {
    httpish = location.protocol === "http:" || location.protocol === "https:";
    origin = httpish ? location.origin : "";
    // （这里原本还要读 location.hostname 拼 `:8021` 跨源候选 —— 那条候选已删，
    //   见下面 ④ 的说明。）
  } catch (e) {
    /* 非浏览器环境，忽略 */
  }

  const cached = normBase(last);

  if (httpish) {
    // 缓存只在同源时才敢先探（见上面那段踩坑说明）
    if (cached && originOf(cached) === originOf(origin)) push(cached);
    // ② 同源带前缀：网页版 / 手机（含外网穿透）的正解
    push(origin + PREFIX);
    // ③ 同源裸根：给"文件服务直接占着这个源"的部署留的。
    //    ★ 在**思源反代**这套部署里它永远不该命中 ★ —— 反代把根绝对
    //      `/api/*`、`/health` 划给了「文件预览」应用，裸根答的是 file-viewer。
    //      所以它现在靠 `probeBase` 的**身份校验**兜着（见 APP_ID 那段注释）：
    //      认不出 `siyuan-local-fs` 就当没探到，继续往下走。
    push(origin);
  } else {
    // file:// / 自定义协议：没有"同源"可言（Electron 客户端属于这类），
    // 缓存地址是唯一线索，照用
    push(cached);
  }

  // ④ 这里曾有一条「跨源直连 `http://<host>:8021`」候选。
  //    ★ 2026-10-10 已删除 ★
  //    直连 8021 能列出文件，但绕过了反代 ⇒ CAD / 文件预览 / Office 三条链路
  //    全部拿不到登录态（Office 直接 403）。"探到了却点不开"比探不到更难排查，
  //    所以不留这条候选。要直连的用户仍可在设置里**手填**（手填永远优先）。
  //    （DIRECT_PORT 常量保留：它标注后端真实监听端口，也用于解析手填地址。）
  return out;
}

/**
 * 逐个候选探一遍。返回 { base, health }；全不通时 health 为 null。
 *
 * ★ 两个节流 ★
 *   · 同一时刻只跑一轮（_inflight）—— 并发的 onload/onLayoutReady/面板 start 合并
 *   · 一轮全失败后 NEGATIVE_TTL 内复用结论（_failKey/_failAt）—— 不刷日志、不刷报错
 */
export function detectBase(saved, last) {
  if (_inflight) return _inflight;
  _inflight = _detectOnce(saved, last).then(
    (r) => { _inflight = null; return r; },
    (e) => { _inflight = null; throw e; }
  );
  return _inflight;
}

async function _detectOnce(saved, last) {
  const list = candidateBases(saved, last);
  const key = list.join("|");

  // 已经有可用地址，而且它仍在这一轮候选里 ⇒ 直接复用，不必再探一遍。
  // （面板每次 start 都会调探测；没有这一条就是每个面板各探一轮，白费且刷日志）
  if (_health && list.indexOf(_base) >= 0) {
    _detected = true;
    return { base: _base, health: _health };
  }

  if (!_health && _failKey === key && Date.now() - _failAt < NEGATIVE_TTL) {
    _detected = true;
    return { base: _base, health: null };
  }

  for (let i = 0; i < list.length; i++) {
    const h = await probeBase(list[i]);
    if (h) {
      _base = list[i];
      _health = h;
      _detected = true;
      _failKey = "";
      return { base: _base, health: _health };
    }
  }
  _base = list[0] || "";
  _health = null;
  _detected = true;
  _failKey = key;
  _failAt = Date.now();
  return { base: _base, health: null };
}

export function wasDetected() {
  return _detected;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** GET 一个 JSON 接口。失败时抛出带可读信息的 Error。 */
export async function apiGet(path, query, ms) {
  if (!_base) throw new Error("尚未连接到本机存储服务");
  const qs = new URLSearchParams();
  Object.keys(query || {}).forEach((k) => {
    const v = query[k];
    if (v !== undefined && v !== null && v !== "") qs.set(k, v);
  });
  const url = _base + path + (qs.toString() ? "?" + qs.toString() : "");
  let res;
  try {
    res = await fetchTimeout(url, null, ms || API_TIMEOUT);
  } catch (e) {
    throw new Error("连不上本机存储服务（" + _base + "）");
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* 不是 JSON，留 null */
  }
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || text.slice(0, 120) || ("HTTP " + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.code = json && json.code;
    throw err;
  }
  return json;
}

/** 列目录。返回 { path, items:[{name,path,isDir,size,mtime,ext}] } */
export function listDir(path) {
  return apiGet("/api/list", { source: "local", path: path || "/" });
}

/** 探文件存在性 / 大小 / 后缀 */
export function probeFile(path) {
  return apiGet("/api/probe", { source: "local", path: path }, 8000);
}

/**
 * 打开前的统一体检：**存在吗 / 有权限吗 / 是什么**。
 *
 * ★ 为什么必须在"打开"前单独做这一趟 ★
 *   预览/编辑/下载/嵌入四条入口各自去 iframe 或 fetch 时，失败形态极其难懂：
 *     · 文件不存在  → 后端回 404，但 iframe 里只看到一片空白；
 *     · 没有读权限  → 后端回 403，同样在白屏里看不出来；
 *     · 是目录      → CAD/Office 内核会把它当空文件，报"内容与扩展名不匹配"。
 *   所以先用 `/api/probe` 把这三件事问清楚，再决定"开"还是"拦"。
 *
 * @returns {Promise<{ok:boolean, code?:string, message?:string, info?:object}>}
 *   ok=false 时 code 是机器可判的短码（NOT_FOUND / FORBIDDEN / IS_DIR / …），
 *   message 是可以直接进对话框的中文说明。调用方**不要**自己再拼文案。
 */
export async function validateOpen(path) {
  if (!path) {
    return { ok: false, code: "NO_PATH", message: "没有指定文件路径。" };
  }
  let info;
  try {
    info = await probeFile(path);
  } catch (e) {
    const code = e && e.code;
    const status = e && e.status;
    if (code === "NOT_FOUND" || status === 404) {
      return {
        ok: false, code: "NOT_FOUND",
        message: "找不到这个文件：\n" + path + "\n\n它可能已被移动、重命名或删除。",
      };
    }
    if (code === "FORBIDDEN" || status === 403) {
      return {
        ok: false, code: "FORBIDDEN",
        message: "没有权限读取这个文件：\n" + path + "\n\n请确认它在飞牛的存储空间里，且本应用有权访问。",
      };
    }
    if (status === 401) {
      return { ok: false, code: "UNAUTHORIZED", message: "本机存储服务要求先登录。" };
    }
    return {
      ok: false, code: "PROBE_FAILED",
      message: "无法确认这个文件的状态：\n" + (e && e.message ? e.message : e),
    };
  }

  // probe 成功：再判"是不是目录"（目录不能当文件开）
  if (info && info.isDir) {
    return {
      ok: false, code: "IS_DIR", info: info,
      message: "这是一个目录，不能作为文件打开：\n" + path + "\n\n可以双击展开它，或右键选择「嵌入这个目录」。",
    };
  }
  // readable 明确为 false 才算没权限（老后端可能不带这个字段 ⇒ 视为可读）
  if (info && info.readable === false) {
    return {
      ok: false, code: "FORBIDDEN", info: info,
      message: "没有权限读取这个文件：\n" + path,
    };
  }
  return { ok: true, info: info };
}

/** 原始文件地址（iframe / img / video 的 src 用） */
export function fileUrl(path, asAttachment) {
  const p = new URLSearchParams();
  p.set("path", path);
  if (asAttachment) p.set("download", "1");
  return _base + "/api/file?" + p.toString();
}

/**
 * CAD（.dwg / .dxf）预览页面地址 —— 交给飞牛原生「CAD 看图」应用渲染。
 *
 * ★ 为什么是"借用原生应用"，而不是本应用自带一个查看器 ★
 *   和「文件预览」交给 :8030 完全同构：图纸解析是那个应用的专职，
 *   思源这边只负责把 path 递过去。
 *   （2026-10-10 之前这里指向 local-fs 自己内置的 cad-viewer 产物 ——
 *     那份 22MB 的复制品已删除，见 local-fs.py 文件头。）
 *
 * ★ 该应用支持 `/open?path=<绝对路径>` 直接打开 ★
 *   它用的是**绝对路径**语义（/vol1/…），与思源里的 path 一致，不用转换。
 *   ★ 入口是「/open」而不是「/」★
 *     server 只对 `/` 做静态兜底；「带上 path 打开图纸」是 /open 这条 SPA 路由
 *     （它的 server 注释原话：「把 /open?path=... 之类的路径交给前端路由」）。
 *     给 `/` 也曾能打开（前端自己读 location.search），但那不是正规入口。
 *   地址怎么选（一律走同源通道）见 channelUrl 的说明。
 */
export function cadViewerUrl(path) {
  const qs = new URLSearchParams({ path: path }).toString();
  return channelUrl(CAD_PREFIX, qs, CAD_OPEN_ROUTE)
      || (_base + CAD_PREFIX + CAD_OPEN_ROUTE + "?" + qs);
}

/**
 * 「在浏览器中打开」图纸用的地址 —— **与内嵌同一个地址**（都走 6806 同源通道）。
 *
 * ★ 为什么不再直连 :8020 ★
 *   用户 2026-10-10 定档：三条链路（CAD / 文件预览 / Office）全部收回到 6806。
 *   直连端口在「手机经飞牛 App / 外网穿透」时根本够不到（穿透只映射 6806），
 *   统一走通道后三种走法一份代码 —— 见 channelUrl 的说明。
 *   保留这个函数名只是为了语义清晰（调用点区分"内嵌"与"新标签"），
 *   两者地址完全一致。
 */
export function cadOpenUrl(path) {
  return cadViewerUrl(path);
}

/**
 * 文件预览（file-viewer）页面地址 —— **除 CAD / Office 外的格式都走它**。
 *
 * ★ 为什么必须同源通道 ★
 *   内嵌要净化（藏掉它自带的左侧文件树 #sidebar 与顶栏 #topbar，见 purify.js），
 *   而注入样式要求 iframe 同源 ⇒ 一律走反代挂出来的**同源通道** `/localfs/fv/`
 *   （内网、ZeroTier、外网穿透三种走法全都成立）。
 *   （桌面客户端没有同源，才退到 `_base` 的主机 + 6806 —— 见 channelUrl。）
 *
 * ★ 路径怎么给 ★
 *   file-viewer 支持 `/?path=<绝对路径>` 直接打开预览（见其 web/app.js 的
 *   incoming 分支），它会自己调 /api/probe 探类型。
 */
export function fileViewerUrl(path) {
  const qs = new URLSearchParams({ path: path }).toString();
  return channelUrl(FV_PREFIX, qs) || (_base + FV_PREFIX + "/?" + qs);
}

/**
 * 「在浏览器中打开」用的文件预览地址 —— **与 fileViewerUrl 同一个地址**
 * （都走 6806 同源通道，理由同 cadOpenUrl）。
 */
export function fileViewerOpenUrl(path) {
  return fileViewerUrl(path);
}

/** CAD 看图（fnos-dwg-viewer）的同源通道路径，与 reverse-proxy.py 的 PROXY_CAD_PREFIX 一致 */
export const CAD_PREFIX = "/localfs/cad";
/**
 * CAD 看图应用**自己的端口**（manifest 的 service_port）。
 *
 * ⚠️ 2026-10-10 起**不再用它拼地址** —— 三条链路一律走 6806 同源通道
 *    （理由见 channelUrl）。留着只为对照飞牛应用配置，别再往 URL 上拼。
 */
export const CAD_PORT = 8020;
/**
 * CAD 看图应用**自己的入口路径**（拼在 chan / 端口之后）。
 *
 * ★ 为什么不是 "/" ★
 *   它的 server 只对 `/` 做静态兜底；「带上 ?path= 打开某张图纸」走的是
 *   「/open」这条 SPA 路由（server/index.mjs 里写着「SPA 兜底：把
 *   /open?path=... 之类的路径交给前端路由」）。用 `/` 多数情况也能打开
 *   （前端自己读 location.search），但那不是它的正规入口。
 */
export const CAD_OPEN_ROUTE = "/open";

/** file-viewer 的同源通道路径，与 reverse-proxy.py 的 PROXY_FV_PREFIX 一致 */
export const FV_PREFIX = "/localfs/fv";
/**
 * 文件预览应用**自己的端口**（manifest 的 service_port）。
 * ⚠️ 同 CAD_PORT：**不再用它拼地址**（三条链路一律走 6806 同源通道），
 *    留着只为对照飞牛应用配置。
 */
export const FV_PORT = 8030;

/** 飞牛官方「Office文档」(trim.docs) 的同源通道路径，与 reverse-proxy.py 的 PROXY_DOCS_PREFIX 一致 */
export const DOCS_PREFIX = "/localfs/docs";
/**
 * Office 文档应用**自己的端口**（manifest 的 service_port；飞牛主 nginx 的 5666）。
 * ⚠️ 同 CAD_PORT / FV_PORT：**不再用它拼地址**。
 */
export const DOCS_PORT = 5666;
/**
 * Office 应用自己的入口路径。
 * ★ 官方就是 `/docs/preview?path=<绝对路径>` ★ —— 走同源通道后是
 *   `/localfs/docs/preview?path=…`（反代把 `/localfs` 剥掉再转给 :5666，
 *   上游看到的正是它认识的 `/docs/preview`）。
 */
export const DOCS_OPEN_ROUTE = "/preview";

/**
 * Office 文档的预览 / 编辑页 —— 飞牛官方「Office文档」(trim.docs)，经 6806 同源通道。
 *
 * ★★ 2026-10-10 起换主：从"我们自研的 OnlyOffice 容器(:8082)"改用
 *    **飞牛官方那套**（直装宿主，:5666）★★——与 CAD / 文件预览统一成
 *    「借用飞牛应用 + 6806 同源通道」的形态。好处是格式集合大得多：
 *    多了 epub / fb2 / wps / wpt / et / ett / pages / numbers / key /
 *    hwp / hwpx / djvu / xlsb / pps / ppsx / docxf / oform…
 *
 * ★ 它只要一个 path 参数 ★
 *   官方入口就是 `/docs/preview?path=<绝对路径>`（浏览器真实请求实测如此）。
 *   以前自研那套的 mode / layout / bare 三个参数**它不认** —— 签名保留只是为了
 *   不改调用点，这里不再拼出来。工具栏的隐藏改由 purify.js 注入样式做
 *   （同源，注入得进去；连 OO 的内层 iframe 也在 6806 上，同一个源）。
 *
 * ⚠️ 它**要飞牛登录态**（浏览器 cookie ost/osrt）。桌面思源客户端的内核在
 *    127.0.0.1，那侧没有 NAS 的 cookie ⇒ 需要先「同步飞牛登录态」
 *    （设置里那个按钮，发给 /localfs/api/fnos-cred，凭据存到 NAS 上，
 *     由反代在请求没带凭据时补上）。详见反代里 inject_cred_cookie 的说明。
 */
export function officeUrl(path, mode, layout, bare) {   // eslint-disable-line no-unused-vars
  const qs = new URLSearchParams({ path: path }).toString();
  return channelUrl(DOCS_PREFIX, qs, DOCS_OPEN_ROUTE)
      || (_base + DOCS_PREFIX + DOCS_OPEN_ROUTE + "?" + qs);
}

/* ── 飞牛登录态同步（Office 文档要用）────────────────────────────────
 *
 * ★ 为什么需要它 ★
 *   飞牛官方「Office文档」(:5666) 的鉴权在它自己的服务进程里：请求没带
 *   飞牛的登录 Cookie（`ost` / `osrt`）就直接 302 到 `/docs/403`。
 *   浏览器里开思源时这些 Cookie **自动带得上** —— Cookie 不区分端口，
 *   `172.16.30.128` 上那份飞牛登录态对 `:6806` 同样有效；
 *   但**桌面思源客户端**跑在本机内核上，那侧压根没有 NAS 的 Cookie。
 *   ⇒ 让"能拿到 Cookie 的一侧"把 Cookie 交给 NAS 上的文件服务存起来
 *     （`local-fs.py` 的 `/api/fnos-cred`），反代在请求没带凭据时补上。
 *
 * ★ 为什么不用 JS 读 document.cookie ★
 *   飞牛的登录 Cookie 是 **HttpOnly** —— JS 读不到。
 *   所以这里**不发任何 Cookie 内容**，只发一个空请求：
 *   浏览器会自己把该带上的 Cookie 附在请求头上，服务端从 `Cookie` 头里
 *   按白名单挑（`local-fs.py` 的 `FNOS_CRED_NAMES`）。
 *
 * ★★ 2026-10-10 定案：桌面端靠**在同源页面上点一下**来完成 ★★
 *   桌面客户端"在插件里点一下同步"**从原理上不可能**，两道门一起挡着：
 *     ① 那份 Cookie 在**浏览器**的 Cookie 罐里，桌面端页面跑在 127.0.0.1 上，
 *        跨源 fetch 带不到它（`credentials:"include"` 也白搭）；
 *     ② 本服务的 `_cors()` **没有** `Access-Control-Allow-Credentials`，
 *        跨源带 credentials 的响应会被浏览器直接拦下 —— 而且报出来只是
 *        "连不上"，反而把真正的原因盖住。
 *   ⇒ 后端加了一个**同源页面** `GET /localfs/cred-sync`（local-fs.py 的
 *     `CRED_SYNC_HTML`）：插件在桌面端只负责 `window.open` 它，
 *     那个页面自己 POST —— 同源，浏览器自动带 Cookie，一次点完。
 *     页面上还留了「去登录飞牛」（`/login?redirect_uri=` 回跳），
 *     **账号密码与二次验证全都在飞牛自己的登录页上做**，
 *     插件与本服务从头到尾不碰凭据。
 */

/**
 * 拼 `/localfs/**` 那一侧的地址（凭据接口 / 同步页共用一套规则）。
 *
 * ★ 优先级：与页面同源的 `_base`（手机 / 外网穿透时 `_base` 就是页面源）
 *   → `_base` 自己的源 → `_base` 的主机 + 反代端口。
 * ★ 为什么优先用 `originOf(_base)` 而不是硬拼 `:6806` ★
 *   手填 `http://<nas>:8021` 的人，凭据接口与同步页也该落在 :8021 上
 *   —— local-fs 两头都认（前缀它会自己剥）；硬拼会把用户的选择悄悄改掉。
 * ★ 连 `_base` 都没有时返回空串，**不要**退回页面 origin ★
 *   桌面端的页面 origin 是 `http://127.0.0.1:<内核端口>` —— 拼出来那个地址
 *   打开就是个 404（本机内核上没有 /localfs），比什么都不做更误导。
 *   空串由调用方翻译成"先填服务地址"。
 */
function credUrl(tail) {
  let pageOrigin = "";
  try { if (/^https?:$/.test(location.protocol)) pageOrigin = location.origin; } catch (e) { /* 忽略 */ }
  const o = originOf(_base);
  if (o) {
    if (pageOrigin && o === originOf(pageOrigin)) return pageOrigin + PREFIX + tail;
    return o + PREFIX + tail;
  }
  const host = hostOf(_base);
  if (host) return "http://" + host + ":" + PROXY_PORT + PREFIX + tail;
  return "";
}

/**
 * `/localfs/api/fnos-cred` 的地址。
 * ★ 必须尽量**同源** ★ —— 只有同源才会稳稳带上浏览器里那份飞牛登录态。
 */
export function fnosCredUrl() {
  return credUrl("/api/fnos-cred");
}

/**
 * 「飞牛登录态同步页」的地址（NAS 上的同源页面，**要在浏览器里打开**）。
 * 桌面端点「同步」时就是把这个地址丢给 `window.open`。
 */
export function fnosCredPageUrl() {
  return credUrl("/cred-sync");
}

/**
 * 页面与文件服务是不是**同源** —— 决定「同步」是直接在插件里发 POST，
 * 还是必须把用户送去浏览器（见上面那段"2026-10-10 定案"）。
 */
export function fnosCredSameOrigin() {
  let pageOrigin = "";
  try { if (/^https?:$/.test(location.protocol)) pageOrigin = location.origin; } catch (e) { /* 忽略 */ }
  return !!(pageOrigin && _base && originOf(_base) === originOf(pageOrigin));
}

async function fnosCredReq(method) {
  const url = fnosCredUrl();
  if (!url) throw new Error("还不知道 NAS 的地址，先点「测试连接」");
  // ★ credentials 分两种 ★
  //   同源（网页版 / 手机）：include —— 浏览器会把飞牛 Cookie 附上，POST 才存得下来。
  //   跨源（桌面端）      ：omit —— 带 include 只会被 CORS 拦成"连不上"，
  //                        而且本来就带不到 Cookie。跨源只当"查状态 / 清除"用，
  //                        真正要写入的那一次交给同源同步页。
  const cred = fnosCredSameOrigin() ? "include" : "omit";
  let res;
  try {
    res = await fetchTimeout(url, { method: method, credentials: cred }, API_TIMEOUT);
  } catch (e) {
    throw new Error("连不上 " + url);
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  try {
    return await res.json();
  } catch (e) {
    throw new Error("接口没回 JSON（这个地址上不是本插件的文件服务？）");
  }
}

/** 查 NAS 上有没有存着飞牛凭据（**接口永不回显凭据本身**，只回 saved/names/savedAt） */
export function fnosCredStat() { return fnosCredReq("GET"); }
/** 把**当前浏览器**里的飞牛登录态同步到 NAS —— 零输入，不碰密码 */
export function fnosCredSync() { return fnosCredReq("POST"); }
/** 清掉 NAS 上存的飞牛凭据 */
export function fnosCredClear() { return fnosCredReq("DELETE"); }

/** 下载：先转成对象 URL 再触发，这样跨源也能带上真实文件名 */
export async function downloadFile(path, name) {
  const res = await fetchTimeout(fileUrl(path, true), null, 600000);
  if (!res.ok) throw new Error("下载失败：HTTP " + res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "download";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      /* 忽略 */
    }
  }, 2000);
}

/** 读文本内容（用于文本/代码/Markdown 预览）。只取前 N 字节，别把大日志拉满。 */
export async function readText(path, maxBytes) {
  const limit = maxBytes || 1024 * 512;
  const url = fileUrl(path);
  const res = await fetchTimeout(url, {
    headers: { Range: "bytes=0-" + (limit - 1) },
  }, 30000);
  if (!res.ok && res.status !== 206) throw new Error("读取失败：HTTP " + res.status);
  const buf = await res.arrayBuffer();
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } catch (e) {
    text = "";
  }
  return {
    text: text,
    truncated: res.status === 206 && buf.byteLength >= limit,
    bytes: buf.byteLength,
  };
}
