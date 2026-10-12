/* ==========================================================================
 * 设置面板（自绘，不依赖思源的 Setting 组件）
 * --------------------------------------------------------------------------
 * ★ 为什么不直接用思源的 Setting ★
 *   思源的 `setting` 只在**插件列表**里那个"设置"按钮能打开，手机端不好找；
 *   而我们的设置里最关键的一项（服务地址 + 测试连接）需要**即时反馈**，
 *   还得在连不上时就够得着 —— 也就是说它必须能从浏览面板里直接打开。
 *   所以自绘一个，顺带和面板共用同一套 CSS。
 *
 * ★ 2026-10-10 整理：这是插件**唯一**的设置入口 ★
 *   index.js 里原先还挂了一套思源原生 Setting（服务地址 + 编辑开关），
 *   与本面板内容完全重复、两处各写各的盘 ⇒ 已删除。入口只留文件树顶部齿轮。
 *
 * ★ 面板现在只有四块 ★
 *   服务地址（含测试连接） / 飞牛登录态 / 常用文件夹 / 当前状态。
 *   被删掉的项及理由见下面 openSettings 里那段注释。
 * ========================================================================== */

import { probeBase, probeRaw, normBase, getBase, getHealth, candidateBases, listDir,
         fnosCredStat, fnosCredSync, fnosCredClear,
         fnosCredPageUrl, fnosCredSameOrigin } from "./api";
import { ICON_CLOSE } from "./icons";
import { baseNameOf } from "./kinds";

const CLS = "lfs";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function openSettings(plugin, onSaved) {
  const mask = el("div", CLS + "-mask is-narrow");
  const modal = el("div", CLS + "-modal is-narrow");

  // ★ 2026-10-10：设置面板头部不要那条分隔线（用户要求）⇒ 加 is-flat。
  //   ⚠️ `.lfs-head` 是浮层 / 对话框 / 目录选择器**共用**的样式，
  //      那条 border-bottom 在它们身上是有用的 ⇒ 只在这里关掉，别动通用规则。
  const head = el("div", CLS + "-head is-flat");
  const tbox = el("div", CLS + "-head-tbox");
  tbox.appendChild(el("div", CLS + "-head-title", plugin.t("settingsTitle") || "本机存储 · 设置"));
  // ★ 2026-10-10：副标题（settingsSub「连哪台机器、看哪些文件夹」）按用户要求去掉 ★
  //   面板本来就窄，标题一行已经说清这是什么；多一行灰字只是噪声。
  //   （i18n 里的 settingsSub 词条同步删除；CSS 的 -head-meta 若还出现在别处就留着。）
  head.appendChild(tbox);
  const tools = el("div", CLS + "-tools");
  const closeBtn = el("button", CLS + "-btn is-close");
  closeBtn.innerHTML = ICON_CLOSE;
  closeBtn.title = plugin.t("close") || "关闭";
  closeBtn.addEventListener("click", () => done());
  tools.appendChild(closeBtn);
  head.appendChild(tools);

  const body = el("div", CLS + "-form");

  // ── 服务地址 ─────────────────────────────────────────────────────
  //
  //   ★ 2026-10-10 文案订正 ★
  //     原来给的例子是 `http://192.168.1.10:8021`（直连本机存储服务）。
  //     现在三条链路全都走 6806 同源通道，桌面端再直连 8021 有两处不对：
  //       ① 外网穿透只映射 6806，8021 根本够不到；
  //       ② 绕过反代 ⇒ Office 文档拿不到补上的飞牛登录态，打开就是 403。
  //     所以例子改成 `http://<NAS>:6806/localfs`：同一个口进，
  //     接口、预览、Office 全都在这一条路上（反代按前缀分流）。
  //   ★ 2026-10-10 第二轮（用户追问"最后本机 :8021 应该不对吧"）★
  //     · 探测候选里**真的删掉**了 `:8021`（原来排在最后）：直连能列出文件，
  //       但绕过反代 ⇒ 三条链路拿不到登录态（Office 403）。"探到了却点不开"
  //       比探不到更难排查 ⇒ 文案里的「最后本机 :8021」随之删掉（见 src/api.js）。
  //     · 面板副标题（settingsSub）按用户要求去掉。
  body.appendChild(section(plugin.t("secServer") || "服务地址"));

  const baseRow = field(
    plugin.t("baseUrl") || "本机存储服务地址",
    plugin.t("baseUrlDesc") ||
    "留空 = 自动探测（先同源 /localfs，再同源根）。\n" +
    "桌面客户端探测不到外面，请手填 NAS 的 6806，例如 http://192.168.1.10:6806/localfs\n" +
    "（6806 是对外唯一入口：外网穿透只映射它，Office 文档的登录态也从这条路补上）"
  );
  const baseInput = document.createElement("input");
  baseInput.className = CLS + "-input";
  baseInput.type = "text";
  baseInput.placeholder = plugin.t("baseUrlPlaceholder") || "留空自动探测";
  baseInput.value = plugin.settings.baseUrl || "";
  baseRow.appendChild(baseInput);
  body.appendChild(baseRow);

  // ★ 2026-10-10：状态与「测试连接」的结果**合成一行** ★
  //   用户报「填入新地址时会显示 2 排，看不明白」—— 原来这里是两个元素：
  //     ① 测试结果行（点一下就冒出来一条）
  //     ② 「当前状态」行（一直在）
  //   于是输入地址测一下，同一件事出现两行不同的说法。
  //   现在只有一个 span：平时显示"当前连到哪"，测试时/测试后就地显示测试结果。
  const testRow = el("div", CLS + "-form-row is-inline");
  const testBtn = el("button", CLS + "-btn-text", plugin.t("testConnect") || "测试连接");
  const stat = el("span", CLS + "-form-out");
  testRow.appendChild(testBtn);
  testRow.appendChild(stat);
  body.appendChild(testRow);

  const renderStatus = () => {
    const h = getHealth();
    stat.className = CLS + "-form-out" + (h ? " is-ok" : " is-bad");
    // 精简过：原来还堆了 app 名与版本号（`local-fs 1.0.0`），一行太挤、也看不懂。
    // 真正要回答的只有两件事：连到哪、看得到几个存储空间。
    stat.textContent = h
      ? (plugin.t("connected") || "已连接") + " · " + getBase() + " · " +
        ((h.roots || []).length) + (plugin.t("spacesSuffix") || " 个存储空间")
      : (plugin.t("notConnected") || "未连接");
  };
  renderStatus();

  testBtn.addEventListener("click", async () => {
    const raw = normBase(baseInput.value);
    const list = raw ? [raw, raw + "/localfs"] : candidateBases("");
    stat.className = CLS + "-form-out";
    stat.textContent = plugin.t("testing") || "测试中…";
    for (let i = 0; i < list.length; i++) {
      const h = await probeBase(list[i]);
      if (h) {
        stat.className = CLS + "-form-out is-ok";
        stat.textContent = (plugin.t("ok") || "通") + "：" + list[i] + " · " +
          ((h.roots || []).length) + (plugin.t("spacesSuffix") || " 个存储空间");
        baseInput.dataset.resolved = list[i];
        return;
      }
    }
    delete baseInput.dataset.resolved;
    stat.className = CLS + "-form-out is-bad";
    // ★ 「连不上」和「连上了、但那是别的应用」必须分开说 ★
    //   用户实测的那一幕：地址填成裸根 `http://<nas>:6806`，反代把根绝对的
    //   `/api/health` 交给了「文件预览」应用 ⇒ 界面上出现
    //   `fnos-file-viewer 1.0.3 · 0 个存储空间`，谁都看不明白这是怎么回事。
    //   探活现在核对身份（api.js 的 APP_ID），这里再把"那是谁"如实报出来。
    const raw2 = await probeRaw(list[0]);
    if (raw2 && raw2.app) {
      stat.textContent = (plugin.t("wrongApp") || "这个地址上是") + " " + raw2.app +
        (raw2.version ? " " + raw2.version : "") +
        (plugin.t("wrongAppHint") ||
         "，不是「本机存储」服务 —— 本机存储挂在 /localfs 下，用上面那个带 /localfs 的地址");
    } else {
      stat.textContent = plugin.t("connectFailed") || "连不上这个地址";
    }
  });

  // ── 飞牛登录态（Office 文档用）────────────────────────────────────
  //   ★ 为什么要"同步"这一步 ★
  //     Office / PDF 打开用的是**飞牛官方「Office文档」**，它认飞牛的登录
  //     Cookie（`ost`/`osrt`）。这些 Cookie 是 HttpOnly 且**按主机**存的 ——
  //     浏览器里开思源时自动带得上（Cookie 不区分端口）；
  //     但**桌面思源客户端**的内核跑在本机，那边的 Cookie 罐里根本没有 NAS 的登录态。
  //     ⇒ 让"能拿到 Cookie 的一侧"把它交给 NAS 上的文件服务存起来，
  //       反代在请求没带凭据时补上。
  //   ★ 两种走法（2026-10-10 定案）★
  //     ① 同源（网页版 / 手机经飞牛 App）：直接 POST 一个**空请求**，
  //        浏览器自己把 Cookie 附上，服务端按白名单挑 —— 零输入、不碰密码。
  //     ② 跨源（桌面客户端）：插件里发不出去（带不到 Cookie + 本服务没开
  //        Allow-Credentials，会被浏览器拦成"连不上"）。⇒ 打开 NAS 上的
  //        **同源同步页**（`/localfs/cred-sync`）让浏览器去点那一下；
  //        这边只轮询状态，看到 saved 就报成功。账号密码与二次验证都在
  //        飞牛自己的登录页上完成，插件从头到尾不碰凭据。
  body.appendChild(section(plugin.t("secFnosCred") || "飞牛登录态（Office 文档）"));

  const credSame = fnosCredSameOrigin();

  const credRow = el("div", CLS + "-form-row");
  credRow.appendChild(el("div", CLS + "-form-label", plugin.t("fnosCred") || "飞牛登录态"));
  credRow.appendChild(el("div", CLS + "-form-desc",
    plugin.t("fnosCredDesc") ||
    "Office / PDF 由飞牛官方「Office文档」打开，它要飞牛的登录态。\n" +
    "浏览器里连着飞牛时点「同步」即可（零输入，不读密码）；\n" +
    "桌面客户端会打开一个网页来完成这一步（没登录过飞牛的话，那里会带你去登录）。"));

  const credBtns = el("div", CLS + "-form-row is-inline");
  const credSyncBtn = el("button", CLS + "-btn-text",
    (credSame ? (plugin.t("syncFnosCred") || "同步飞牛登录态")
              : (plugin.t("syncFnosCredBrowser") || "在浏览器中同步")));
  const credClearBtn = el("button", CLS + "-btn-text",
    plugin.t("clearFnosCred") || "清除");
  const credOut = el("span", CLS + "-form-out");
  credBtns.appendChild(credSyncBtn);
  credBtns.appendChild(credClearBtn);
  credBtns.appendChild(credOut);
  credRow.appendChild(credBtns);
  body.appendChild(credRow);

  const credFail = (e) =>
    (plugin.t("credFailed") || "失败") + "：" + ((e && e.message) ? e.message : String(e));

  const refreshCred = async () => {
    credOut.className = CLS + "-form-out";
    credOut.textContent = plugin.t("credChecking") || "查询中…";
    try {
      const s = await fnosCredStat();
      if (s && s.saved) {
        credOut.className = CLS + "-form-out is-ok";
        credOut.textContent = (plugin.t("credSaved") || "已同步") +
          "：" + ((s.names || []).join("、") || "?") +
          (s.savedAt ? "（" + s.savedAt + "）" : "");
      } else {
        credOut.className = CLS + "-form-out";
        credOut.textContent = plugin.t("credNone") ||
          "尚未同步 —— 桌面端打开 Office 会提示未登录";
      }
    } catch (e) {
      credOut.className = CLS + "-form-out is-bad";
      credOut.textContent = credFail(e);
    }
  };

  credSyncBtn.addEventListener("click", async () => {
    // ★ 跨源（桌面客户端）：插件里发不出去 ⇒ 交给浏览器里的同源页面 ★
    //   见 api.js 那段"2026-10-10 定案"。这里只负责打开 + 轮询。
    if (!credSame) {
      const page = fnosCredPageUrl();
      if (!page) {
        credOut.className = CLS + "-form-out is-bad";
        credOut.textContent = plugin.t("credNoBase") ||
          "还不知道 NAS 的地址 —— 请先在上面填好「本机存储服务地址」并点「测试连接」";
        return;
      }
      // 用系统浏览器打开：那份飞牛登录态在浏览器里，不在思源内核里
      // ★ 不能给 window.open 传 "noopener" ★
      //   规范规定带 `noopener` 时**返回值恒为 null** ⇒ 拿不到句柄就分不清
      //   "开了" 和 "被弹窗拦截拦下了"，面板会一律报"被拦"，误导用户。
      //   所以先拿句柄，再手动断掉 opener —— 安全性一样，判断能力有了。
      let w = null;
      try {
        w = window.open(page, "_blank");
        if (w) { try { w.opener = null; } catch (e) { /* 跨源时可能不给设，忽略 */ } }
      } catch (e) { w = null; }

      credOut.className = CLS + "-form-out";
      // ★ 弹窗被拦是**真会发生的**（浏览器拦非用户手势的 window.open；
      //   也可能有插件拦）⇒ 不能只写"已打开浏览器"然后让用户干等 ★
      //   拦下了就把地址原样给出来，用户手动打开一样能同步，轮询照旧。
      credOut.textContent = w
        ? (plugin.t("credBrowserWait") ||
           "已打开浏览器，请在那边完成同步（没登录过飞牛的话先登录）…")
        : (plugin.t("credPopupBlocked") ||
           "浏览器拦下了弹窗 —— 请手动打开这个地址完成同步：") + page;

      // 轮询状态：页面里那一步做完 ⇒ NAS 上就有凭据了 ⇒ 这边收尾。
      //   ★ 面板可能已被关掉（credOut 脱离文档）★ 每次循环都查一下，
      //     别让一个已经没人看的循环一直跑。
      const t0 = Date.now();
      const deadline = t0 + 120000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!credOut.isConnected) return;   // 面板关了，收工
        let st = null;
        try {
          st = await fnosCredStat();
        } catch (e) { /* 网络抖动/还没连上，继续等 */ }
        if (st && st.saved) {
          credOut.className = CLS + "-form-out is-ok";
          credOut.textContent = (plugin.t("credSynced") || "同步成功") +
            "：" + ((st.names || []).join("、") || "?") +
            (st.savedAt ? "（" + st.savedAt + "）" : "");
          return;
        }
      }
      credOut.className = CLS + "-form-out is-bad";
      credOut.textContent = plugin.t("credWaitTimeout") ||
        "还没等到结果 —— 浏览器里那一步完成了吗？完成后可点「测试连接」旁的查询重试";
      return;
    }

    // 同源（网页版 / 手机）：浏览器自己就把飞牛 Cookie 带上了，直接 POST。
    credOut.className = CLS + "-form-out";
    credOut.textContent = plugin.t("credSyncing") || "同步中…";
    try {
      const r = await fnosCredSync();
      if (r && r.saved) {
        credOut.className = CLS + "-form-out is-ok";
        credOut.textContent = (plugin.t("credSynced") || "同步成功") +
          "：" + ((r.names || []).join("、") || "?");
      } else {
        // ★ 这里不该说"成功" ★ —— 后端明确回了 saved:false，说明它没在
        //   请求头上看到任何飞牛凭据（多半是没登录，或者页面与飞牛不同主机）。
        credOut.className = CLS + "-form-out is-bad";
        credOut.textContent = plugin.t("credNoCred") ||
          "没读到飞牛的登录态 —— 请先在浏览器里登录飞牛，再回来点一次";
      }
    } catch (e) {
      credOut.className = CLS + "-form-out is-bad";
      credOut.textContent = credFail(e);
    }
  });

  credClearBtn.addEventListener("click", async () => {
    credOut.className = CLS + "-form-out";
    credOut.textContent = plugin.t("credSyncing") || "处理中…";
    try {
      await fnosCredClear();
      credOut.className = CLS + "-form-out";
      credOut.textContent = plugin.t("credCleared") || "已清除";
    } catch (e) {
      credOut.className = CLS + "-form-out is-bad";
      credOut.textContent = credFail(e);
    }
  });

  refreshCred();

  // ── 常用文件夹（需求 #1）─────────────────────────────────────────
  //   ★ 语义 ★ 填了 ⇒ 浏览面板**只**显示这几个；不填 ⇒ 显示本机全部存储空间。
  //   所以这里给的是"白名单编辑"，不是"快捷方式"——措辞上要让用户看得懂。
  body.appendChild(section(plugin.t("secFavorites") || "常用文件夹"));

  const favRow = el("div", CLS + "-form-row");
  favRow.appendChild(el("div", CLS + "-form-label", plugin.t("favorites") || "只显示这些文件夹"));
  favRow.appendChild(el("div", CLS + "-form-desc",
    plugin.t("favoritesDesc") ||
    "留空 = 显示本机全部存储空间；填了就只显示下面这几个。\n" +
    "点「添加文件夹」从本机存储里挑一个目录。"));

  // 已选清单（保存前的草稿，点「保存」才落盘）
  const favList = el("div", CLS + "-fav-list");
  favRow.appendChild(favList);

  // 草稿：浅拷贝一份，取消就不影响原设置
  let favDraft = Array.isArray(plugin.settings.favorites)
    ? plugin.settings.favorites.slice() : [];

  const renderFavs = () => {
    favList.innerHTML = "";
    if (!favDraft.length) {
      favList.appendChild(el("div", CLS + "-fav-empty",
        plugin.t("favoritesEmpty") || "（未设置 —— 显示本机全部存储空间）"));
      return;
    }
    favDraft.forEach((p, i) => {
      const chip = el("div", CLS + "-fav-chip");
      chip.title = p;
      chip.appendChild(el("span", CLS + "-fav-name", baseNameOf(p) || p));
      chip.appendChild(el("span", CLS + "-fav-path", p));
      const del = el("button", CLS + "-fav-del");
      del.type = "button";
      del.textContent = "\u00D7";
      del.title = plugin.t("remove") || "移除";
      del.addEventListener("click", () => {
        favDraft.splice(i, 1);
        renderFavs();
      });
      chip.appendChild(del);
      favList.appendChild(chip);
    });
  };
  renderFavs();

  const addFavBtn = el("button", CLS + "-btn-text", plugin.t("addFolder") || "添加文件夹");
  addFavBtn.type = "button";
  addFavBtn.addEventListener("click", () => {
    // ★ 2026-10-10：选择器支持**多选**。回调统一收数组，一次把挑中的全并进草稿。★★
    //   旧版一次只能选一个 ⇒ 用户要连着点好几遍「添加文件夹」，很烦。
    //   现在在对话框里勾几个、点一次「选这些文件夹」即可。
    openDirPicker(plugin, (pickedList) => {
      if (!pickedList) return;
      const arr = Array.isArray(pickedList) ? pickedList : [pickedList];
      // 去重：同一个路径不重复加（用户很容易连点两下 / 跨次重复挑）
      arr.forEach((picked) => {
        if (picked && picked.path && favDraft.indexOf(picked.path) < 0) {
          favDraft.push(picked.path);
        }
      });
      renderFavs();
    });
  });
  favRow.appendChild(addFavBtn);
  body.appendChild(favRow);

  // ★ 2026-10-10 整理：删掉了两节 ——「编辑」与「高级」★
  //
  //   · 「允许在线编辑 Office 文档」开关
  //       Office / PDF 改用飞牛官方「Office 文档」后，可读可写由**文件自身的
  //       写权限**决定，插件传的 mode 参数它根本不看 ⇒ 开关勾不勾都一样。
  //   · 「OnlyOffice 缓存」清理
  //       它清的是**自研 OO 容器**的缓存目录。Office 换主之后那条链路已不再
  //       被本插件调用 ⇒ 这项点了大概率只回"找不到缓存目录"，属僵尸项。
  //   · 「记住探测到的地址」开关
  //       这个行为本来就该永远开着（用户感受不到它，只少一轮探测），
  //       不必做成一个选项。
  //
  //   整理后只剩三节：服务地址（含当前状态） / 飞牛登录态 / 常用文件夹。

  // ── 底部 ─────────────────────────────────────────────────────────
  const foot = el("div", CLS + "-form-foot");
  const saveBtn = el("button", CLS + "-btn-text is-primary", plugin.t("save") || "保存");
  const cancelBtn = el("button", CLS + "-btn-text", plugin.t("cancel") || "取消");
  foot.appendChild(cancelBtn);
  foot.appendChild(saveBtn);
  body.appendChild(foot);

  modal.appendChild(head);
  modal.appendChild(body);
  mask.appendChild(modal);
  document.body.appendChild(mask);

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      done();
    }
  };
  document.addEventListener("keydown", onKey, true);
  mask.addEventListener("click", (e) => {
    if (e.target === mask) done();
  });

  function done() {
    document.removeEventListener("keydown", onKey, true);
    if (mask.parentNode) mask.parentNode.removeChild(mask);
  }

  cancelBtn.addEventListener("click", done);
  saveBtn.addEventListener("click", async () => {
    // 输入框里那串地址以「测试通过时解析出来的地址」为准
    const typed = normBase(baseInput.value);
    plugin.settings.baseUrl = typed ? (baseInput.dataset.resolved || typed) : "";
    // 常用文件夹草稿落盘（需求 #1）
    plugin.settings.favorites = favDraft.slice();
    plugin.persist();               // 用户设置本身先落盘（用户动作，一次性）
    done();
    plugin.toast(plugin.t("saved") || "已保存");
    if (onSaved) onSaved();
    // 重探一遍，再把"这次真正用上的地址"记下来。
    // ★ 只有用户动作才会走到这条写盘路径 ★（探测过程自己绝不写，见 plugin.detect）
    plugin.applySettings().then(() => plugin.rememberBase());
  });

  setTimeout(() => baseInput.focus(), 60);
  return { close: done };
}

function section(title) {
  const s = el("div", CLS + "-form-sec", title);
  return s;
}

/**
 * 目录选择器（给「常用文件夹」用）。
 *
 * ★ 为什么自己写而不是复用 Explorer 的 pick 模式 ★
 *   Explorer 走的是"整棵懒加载文件树"，挂进设置面板会太重
 *   （设置面板本来就窄，再塞一棵会滚动的树体验很差）。
 *   这里只做一件事：**一层层往下钻**，勾选若干层后一次确认。
 *   逻辑很小（一个 listDir 循环），却比复用得干净得多。
 *
 * ★★ 多选（2026-10-10）★★
 *   用户报「常用文件夹不能同时选择多个」。原实现是"当前层单选、确认即关闭"，
 *   想加第二个必须重新点开对话框 ⇒ 很不顺手。
 *   现在：每行一个复选框（跨层累计）、顶部「已选 N 个」、底部一次提交全部。
 *
 * @param {object} plugin
 * @param {(picked:Array<{path:string,name:string}>|null)=>void} onPick
 *        null = 取消；否则是**已勾选目录的数组**（≥1 个）
 */
export function openDirPicker(plugin, onPick) {
  const mask = el("div", CLS + "-mask is-narrow");
  const modal = el("div", CLS + "-modal is-narrow");
  modal.classList.add(CLS + "-picker");

  const head = el("div", CLS + "-head");
  const tbox = el("div", CLS + "-head-tbox");
  tbox.appendChild(el("div", CLS + "-head-title", plugin.t("addFolder") || "添加文件夹"));
  head.appendChild(tbox);
  const tools = el("div", CLS + "-tools");
  const closeBtn = el("button", CLS + "-btn is-close");
  closeBtn.innerHTML = ICON_CLOSE;
  closeBtn.title = plugin.t("close") || "关闭";
  closeBtn.addEventListener("click", () => finish(null));
  tools.appendChild(closeBtn);
  head.appendChild(tools);

  // 当前位置 + 上级
  const bar = el("div", CLS + "-picker-bar");
  const upBtn = el("button", CLS + "-btn-text", plugin.t("goUp") || "上级");
  upBtn.type = "button";
  const curEl = el("div", CLS + "-picker-cur");
  bar.appendChild(upBtn);
  bar.appendChild(curEl);

  const list = el("div", CLS + "-picker-list");

  const foot = el("div", CLS + "-form-foot");
  const cancelBtn = el("button", CLS + "-btn-text", plugin.t("cancel") || "取消");
  const pickBtn = el("button", CLS + "-btn-text is-primary", plugin.t("pickThese") || "选这些文件夹");
  foot.appendChild(cancelBtn);
  foot.appendChild(pickBtn);

  modal.appendChild(head);
  modal.appendChild(bar);
  modal.appendChild(list);
  modal.appendChild(foot);
  mask.appendChild(modal);
  document.body.appendChild(mask);

  // ★★ 多选状态（2026-10-10 新增）★★
  //   用户要求「常用文件夹能同时选多个」。语义：
  //     · 每行左侧一个复选框 —— 勾选 = 把这个目录加进「待选」集合
  //     · 「取消勾选」= 从集合里去掉
  //     · 「选这些文件夹」= 一次性把集合里的全部提交（≥1 才可用）
  //     · 顶部实时显示「已选 N 个」，并列出已选路径（太长就省略中段）
  //   仍保留「只看不改」的直觉：勾选**不**自动进目录，点行本身才是进目录。
  const picked = [];                       // [{path, name}]，按勾选顺序
  const pickedPaths = () => picked.map((x) => x.path);
  let curEntries = [];                     // 当前层列出的（含目录与"当前层可被选"的候选）

  const selBar = el("div", CLS + "-picker-sel");
  const selCount = el("span", CLS + "-picker-selcount");
  const selClear = el("button", CLS + "-btn-text " + CLS + "-picker-selclear",
    plugin.t("clearSel") || "清空");
  selClear.type = "button";
  selBar.appendChild(selCount);
  selBar.appendChild(selClear);
  modal.insertBefore(selBar, list);

  const renderSelBar = () => {
    if (!picked.length) {
      selCount.textContent = plugin.t("selNone") || "尚未选择文件夹";
      selBar.classList.remove("is-active");
    } else {
      selCount.textContent =
        (plugin.t("selCount") || "已选 %d 个文件夹").replace("%d", String(picked.length));
      selBar.classList.add("is-active");
    }
    selCount.title = pickedPaths().join("\n");
    selClear.disabled = !picked.length;
    pickBtn.disabled = !picked.length;      // ★ 没有选中就不可提交 ★
  };
  selClear.addEventListener("click", () => {
    picked.length = 0;
    // 把当前层所有勾选清掉（重绘最稳）
    renderSelBar();
    enter(cur);
  });

  // ★★ 从 "/" 开始（2026-10-10 修正）★★
  //   之前从 roots[0]（如 /vol1）起，而 `parentOf("/vol1")` 返回 "" ⇒ 「上级」在
  //   卷根就是 disabled ⇒ **永远到不了 /，也就切不到别的卷**（/vol00、/vol1 是兄弟）。
  //   后端 `/api/list?path=/` 能正常列出全部挂载卷，所以顶层就是 "/"。
  let cur = "/";

  const parentOf = (p) => {
    const s = String(p || "").replace(/\/+$/, "");
    const i = s.lastIndexOf("/");
    return i <= 0 ? "" : s.slice(0, i);
  };
  /** 卷根 = "/vol1" 这种一层路径；"/" 本身不是可选项 */
  const isVolumeRoot = (p) => /^\/[^/]+$/.test(String(p || ""));
  const isTop = (p) => String(p || "").replace(/\/+$/, "") === "";

  const enter = async (path) => {
    cur = isTop(path) ? "/" : path;
    curEl.textContent = cur;
    curEl.title = cur;
    // ★ 「上级」在 "/" 才禁用；卷根（/vol1）可以上到 "/" ★
    upBtn.disabled = isTop(cur);

    list.innerHTML = "";
    list.appendChild(el("div", CLS + "-picker-hint", plugin.t("loading") || "加载中…"));
    let data;
    try {
      data = await listDir(cur);
    } catch (e) {
      list.innerHTML = "";
      list.appendChild(el("div", CLS + "-picker-err",
        String(e && e.message ? e.message : e)));
      return;
    }
    const dirs = ((data && data.items) || []).filter((it) => it.isDir);
    curEntries = dirs.slice();
    list.innerHTML = "";

    // ★ 在卷根层给一个"存储空间"小标题 + 卷快捷入口，让人一眼知道这是哪一层 ★
    if (isTop(cur)) {
      const roots = (getHealth() && getHealth().roots) || [];
      if (roots.length) {
        list.appendChild(el("div", CLS + "-picker-hint",
          plugin.t("pickVolumeHint") || "选择存储空间，再往下钻到你要的文件夹"));
      }
    }

    if (!dirs.length) {
      list.appendChild(el("div", CLS + "-picker-hint",
        plugin.t("noSubDir") || "（没有子文件夹）"));
      return;
    }
    dirs.forEach((d) => {
      const row = el("div", CLS + "-picker-row");
      row.title = d.path;

      // ★ 复选框：勾选 = 加进待选集合；点它**不进**目录（防止误触）★
      const box = el("span", CLS + "-picker-box");
      const isPicked = pickedPaths().indexOf(d.path) >= 0;
      box.textContent = isPicked ? "\u2713" : "";
      box.title = plugin.t("togglePick") || "勾选/取消这个文件夹";
      box.addEventListener("click", (ev) => {
        ev.stopPropagation();               // 别顺带进目录
        const i = pickedPaths().indexOf(d.path);
        if (i >= 0) picked.splice(i, 1);
        else picked.push({ path: d.path, name: d.name });
        box.textContent = i >= 0 ? "" : "\u2713";
        row.classList.toggle("is-picked", i < 0);
        renderSelBar();
      });
      row.classList.toggle("is-picked", isPicked);
      row.appendChild(box);

      row.appendChild(el("span", CLS + "-picker-ico", "\u25B8"));
      row.appendChild(el("span", CLS + "-picker-name", d.name));
      // 点行体（非复选框）= 进这一层
      row.addEventListener("click", () => enter(d.path));
      list.appendChild(row);
    });
  };

  upBtn.addEventListener("click", () => {
    if (isTop(cur)) return;
    const p = parentOf(cur);
    enter(p || "/");
  });
  cancelBtn.addEventListener("click", () => finish(null));
  // ★ 提交 = 把勾选的**全部**交回去（≥1 个才可点）★
  pickBtn.addEventListener("click", () => {
    if (!picked.length) return;
    finish(picked.slice());
  });

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      finish(null);
    }
  };
  document.addEventListener("keydown", onKey, true);
  mask.addEventListener("click", (e) => {
    if (e.target === mask) finish(null);
  });

  function finish(v) {
    document.removeEventListener("keydown", onKey, true);
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    if (onPick) onPick(v);
  }

  renderSelBar();                            // ★ 初始化「已选 N 个」状态条 ★
  pickBtn.disabled = true;                   // 没勾任何东西时不可提交
  enter(cur);
  return { close: () => finish(null) };
}

function field(label, desc) {
  const row = el("div", CLS + "-form-row");
  row.appendChild(el("div", CLS + "-form-label", label));
  if (desc) row.appendChild(el("div", CLS + "-form-desc", desc));
  return row;
}

// ★ 2026-10-10 整理：toggle() 已删除 ★
//   它只服务于两个开关（「允许在线编辑 Office 文档」「记住探测到的地址」），
//   两个开关都下线了 ⇒ 这个构造器没有调用者，一并删掉。

