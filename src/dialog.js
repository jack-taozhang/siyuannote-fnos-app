/* ==========================================================================
 * 对话框（自绘）
 * --------------------------------------------------------------------------
 * ★ 和 toast 的分工 ★
 *   toast（plugin.toast）是**一闪而过**的：适合"复制成功"这种无需回应的结果。
 *   本文件是**要用户看见并读进去**的：文件打不开、没权限、服务连不上。
 *   以前这类错误一律走 toast —— 手机上 2 秒就消失，用户还没看清就没了，
 *   而且没法复制路径。所以凡是"用户需要据此决定下一步"的提示都走这里。
 *
 * ★ 为什么自绘而不是 siyuan 的 Dialog ★
 *   和设置面板同一个理由：这个插件会被嵌在飞牛 App 的 iframe 里跑，
 *   自绘的 fixed 浮层在 iframe 内定位最稳，也不吃内核版本差异。
 *   样式与设置面板共用（.lfs-mask / .lfs-modal / .lfs-btn 一族）。
 *
 * ★ 类型（kind）★
 *   "error" / "warn" / "info" —— 只影响顶部图标与主色，不影响结构。
 * ========================================================================== */

import { ICON_WARN, ICON_INFO, ICON_CLOSE } from "./icons";

const CLS = "lfs";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let _open = null;   // 同一时刻只保留一个对话框

/**
 * 弹一个对话框。
 *
 * @param {object} opts
 *   title    {string}   标题（缺省按 kind 给）
 *   message  {string}   正文，可含 \n（用 white-space:pre-wrap 呈现）
 *   kind     {"error"|"warn"|"info"}  缺省 "error"
 *   okText   {string}   主按钮文案（缺省「知道了」）
 *   cancelText {string} 给了就多一个次按钮
 *   onOk     {Function} 主按钮回调（对话框会先关闭再调）
 *   onCancel {Function}
 *   detail   {string}   折叠起来的技术细节（status / code），点「详情」才看
 * @returns {{close:Function}}
 */
export function showDialog(opts) {
  const o = opts || {};
  const kind = o.kind === "info" || o.kind === "warn" ? o.kind : "error";

  // 单例：已有对话框就先关掉，避免手机上叠成一堆
  if (_open) {
    try { _open.close(); } catch (e) { /* 忽略 */ }
  }

  const mask = el("div", CLS + "-mask is-narrow");
  const modal = el("div", CLS + "-modal is-narrow is-dialog");

  const head = el("div", CLS + "-head");
  const ico = el("span", CLS + "-dlg-ico is-" + kind);
  ico.innerHTML = kind === "info" ? ICON_INFO : ICON_WARN;
  head.appendChild(ico);

  const tbox = el("div", CLS + "-head-tbox");
  tbox.appendChild(el("div", CLS + "-head-title",
    o.title || (kind === "info" ? "提示" : kind === "warn" ? "请注意" : "无法打开")));
  head.appendChild(tbox);

  const tools = el("div", CLS + "-tools");
  const closeBtn = el("button", CLS + "-btn is-close");
  closeBtn.innerHTML = ICON_CLOSE;
  closeBtn.title = "关闭";
  tools.appendChild(closeBtn);
  head.appendChild(tools);

  const body = el("div", CLS + "-dlg-body");
  const msg = el("div", CLS + "-dlg-msg");
  msg.textContent = o.message || "";
  body.appendChild(msg);

  if (o.detail) {
    const det = el("details", CLS + "-dlg-detail");
    det.appendChild(el("summary", "", "技术细节"));
    const pre = el("pre", CLS + "-dlg-pre", o.detail);
    det.appendChild(pre);
    body.appendChild(det);
  }

  const foot = el("div", CLS + "-form-foot");
  if (o.cancelText) {
    const cancel = el("button", CLS + "-btn-text", o.cancelText);
    cancel.addEventListener("click", () => {
      done();
      if (o.onCancel) o.onCancel();
    });
    foot.appendChild(cancel);
  }
  const ok = el("button", CLS + "-btn-text is-primary", o.okText || "知道了");
  ok.addEventListener("click", () => {
    done();
    if (o.onOk) o.onOk();
  });
  foot.appendChild(ok);
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
  closeBtn.addEventListener("click", () => done());

  function done() {
    document.removeEventListener("keydown", onKey, true);
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    if (_open && _open.mask === mask) _open = null;
  }

  // 先聚焦主按钮，键盘用户回车即关
  setTimeout(() => { try { ok.focus(); } catch (e) { /* 忽略 */ } }, 50);

  const handle = { mask, close: done };
  _open = handle;
  return handle;
}

/**
 * 把「体检结果」直接弹成对话框。
 * 调用方拿到 validateOpen 的返回值后，一行就能给用户一个像样的说明。
 *
 * @param {object} res   validateOpen 的返回
 * @param {object} [opts] { title, okText, onOk }
 */
export function showValidateError(res, opts) {
  const o = opts || {};
  const code = res && res.code;
  const titles = {
    NOT_FOUND: "文件不存在",
    FORBIDDEN: "没有访问权限",
    UNAUTHORIZED: "需要登录",
    IS_DIR: "这是一个目录",
    NO_PATH: "缺少路径",
    PROBE_FAILED: "无法读取文件信息",
  };
  const detail = [];
  if (code) detail.push("code: " + code);
  if (res && res.info && res.info.path) detail.push("path: " + res.info.path);
  return showDialog({
    kind: "error",
    title: o.title || titles[code] || "无法打开",
    message: (res && res.message) || "操作没能完成。",
    detail: detail.join("\n"),
    okText: o.okText,
    onOk: o.onOk,
  });
}
