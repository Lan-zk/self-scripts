// ==UserScript==
// @name         职行力自动刷课助手
// @namespace    https://github.com/Lan-zk
// @version      3.15
// @description  自动播放和评价职行力课程。多讲课程收尾重设计（播完一讲留在课程页直接下一讲，杜绝"退出确认→重进→重播"循环）；可见性伪装+停滞续播（后台持续推进）；设置抽屉免改代码；全量日志+自愈熔断。
// @author       Lan-zk
// @source       https://greasyfork.org/scripts/455353
// @match        https://u.exexm.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 架构说明（为什么这样写）：
 * 1. 单一异步状态机 + 条件早释放互斥锁：多步流程（开视频/评价/文档）上锁期间，
 *    轮询不再重入（杜绝"弹窗被叠开 N 层"）；锁带"预期结果"判断，结果一出现立即放行。
 * 2. 每个动作都有超时和失败出口，任何环节卡住都会降级处理，最终兜底是
 *    location.reload() 自愈（运行状态持久化在 localStorage，刷新后自动续跑）。
 * 3. 自动刷新带熔断器：10 分钟内最多 3 次，防止"刷新→又立刻刷新"死循环。
 * 4. 弹窗治理：堆叠的 ion-modal 自动清理；系统确认框按升级阶梯处理；奖励弹窗自动关闭。
 * 5. 后台运行：Web Worker 驱动 + 静音音频防节流 + 可见性伪装 + 停滞自动续播。
 * 6. 日志抽屉：全量动作/状态快照落盘（跨刷新保留），右侧"日志"入口打开，
 *    "复制排查信息"一键导出完整报告；"⚙ 设置"抽屉动态调整参数，免改代码。
 *
 * 致谢：基于 misaka10032w 的「职行力视频自动播放」(greasyfork #455353) 重写，
 * 原版仅保留课程分发思路；其余（状态机/弹窗治理/日志/设置/后台对抗）均为重构。
 */

(function () {
  "use strict";

  const VERSION = "3.15";
  const LOG_MAX = 2500; // 日志最多保留条数（超出丢弃最旧的；抽屉里最多渲染 800 条）

  // ===================== 配置 =====================
  const CFG = {
    interval: 1000,            // 轮询间隔（毫秒）。全部步骤为条件轮询，小间隔=衔接更快
    muted: true,               // 自动静音视频/音频（也用于刷新后恢复自动播放）
    playbackRate: 0,           // 0=不干预倍速；设为 2/3/4 会强制设定（自行评估账号风控风险）
    stars: 5,                  // 评价星级（1~5）
    comment: "",  // 评价评语
    commentFallback: "很好，讲的不错", // comment 为空且首次保存失败时，重试用该评语

    // ---- 健壮性相关，一般不用改 ----
    stuckOpenSec: 45,          // 打开课件/弹窗多久没出现视为卡死（秒）
    stuckPlayingSec: 180,      // 播放中多久无进度视为卡死（秒）
    stallResumeSec: 15,        // 播放中进度停滞多久就自动续播（秒；细粒度，专门对付后台暂停）
    pipFallback: false,        // true=后台时让视频进画中画小窗（最彻底但会弹出小窗；默认关）
    noProgressMin: 12,         // 整体多久无任何进展就自愈刷新（分钟）
    reloadAfterHours: 3,       // 连续运行该时长后，择机（回到学习页空档）刷新释放内存；0=关闭
    heapLimitMB: 2000,         // JS 堆超过该 MB 数择机刷新（仅 Chrome 可感知；0=关闭）
    maxReloadsPer10min: 3,     // 熔断：10 分钟滚动窗口内最多自动刷新次数
    alertPolicy: "last",       // 系统确认框处理："last"=点最后一个按钮 / "cancel"=点取消 / null=不处理
    antiThrottle: true,        // 挂后台时防止定时器被 Chrome 节流（静音音频，无声音）
    spoofVisibility: true,     // 伪装页面"始终可见"：阻止播放器在后台/最小化时自动暂停（本脚本核心诉求）
    debug: false,              // true=额外在控制台实时输出（页面日志始终全量记录；DevTools 开着时控制台输出更卡，故默认关）
  };
  // ================================================

  // ---------- 用户动态配置（设置抽屉保存的项覆盖上方默认值） ----------
  // 只允许覆盖"白名单"键，防止 localStorage 里的旧/坏数据破坏内部参数。
  // 注意：applyUserConfig 是函数声明（在 store 初始化后的启动段才调用），
  // 不能在这里立即执行——store/CFG 工具尚未就绪，早前版本因此启动即崩。
  const USER_KEYS = [
    "stars", "comment", "commentFallback", "playbackRate", "muted",
    "alertPolicy", "pipFallback", "antiThrottle", "debug",
    "stuckOpenSec", "stuckPlayingSec", "stallResumeSec", "noProgressMin",
    "reloadAfterHours", "heapLimitMB",
  ];
  function applyUserConfig() {
    const saved = store.get("cfg", {});
    if (!saved || typeof saved !== "object") return;
    for (const k of USER_KEYS) {
      if (k in saved) {
        const v = saved[k];
        // 类型守卫：数字键必须是有限数字，其余键非 undefined 即可
        const isNum = ["stars","playbackRate","stuckOpenSec","stuckPlayingSec",
          "stallResumeSec","noProgressMin","reloadAfterHours","heapLimitMB"].includes(k);
        if (isNum && typeof v === "number" && isFinite(v)) CFG[k] = v;
        else if (!isNum && v !== undefined) CFG[k] = v;
      }
    }
  }
  function saveUserConfig() {
    const out = {};
    for (const k of USER_KEYS) out[k] = CFG[k];
    store.set("cfg", out);
  }

  // ---------- 工具 ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();
  const fmtDur = (ms) => {
    const m = Math.floor(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + "h" + (m % 60) + "m" : m + "m";
  };
  const fmtClock = (s) => (!isFinite(s) || !s ? "--:--" :
    Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0"));
  const fmtTime = (t) => new Date(t).toTimeString().slice(0, 8);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const normText = (s) => String(s || "").replace(/\s+/g, "").slice(0, 80);

  // 条件轮询：fn 一成立立即返回 true（替代固定盲等 sleep），超时返回 false
  async function waitFor(fn, timeoutMs, stepMs) {
    const t0 = now();
    const step = stepMs || 150;
    for (;;) {
      let ok = false;
      try { ok = !!fn(); } catch (e) {}
      if (ok) return true;
      if (now() - t0 >= timeoutMs) return false;
      await sleep(step);
    }
  }

  // 记录一次告警日志（不弹 Toast），同一 key 5 分钟内不重复
  const noted = new Map();
  function noteOnce(key, msg) {
    const t = now();
    const until = noted.get(key);
    if (until && t < until) return;
    noted.set(key, t + 300000);
    record("WARN", msg);
  }

  // 完整鼠标事件序列点击：部分控件（Ionic tap 手势/只监听 pointer 或 mouse 事件）不响应合成 .click()。
  // 同时把事件派发到坐标处最内层元素（事件会冒泡到控件本身），最接近真实用户点击。
  function realClick(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let target = el;
      try {
        const hit = document.elementFromPoint(cx, cy);
        if (hit && el.contains(hit)) target = hit;
      } catch (e) {}
      const init = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: cx, clientY: cy, button: 0,
      };
      const fire = (type, Ctor) => { try { target.dispatchEvent(new Ctor(type, init)); } catch (e) {} };
      if (window.PointerEvent) fire("pointerdown", PointerEvent);
      fire("mousedown", MouseEvent);
      if (window.PointerEvent) fire("pointerup", PointerEvent);
      fire("mouseup", MouseEvent);
      fire("click", MouseEvent);
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (e2) { return false; }
    }
  }

  // 评价弹窗的"保存"按钮是否可用（部分站点未选星级前按钮禁用，可用来校验星级是否真的选上了）
  function saveButtonEnabled(me) {
    const s = me && me.querySelector("ion-footer button");
    if (!s) return false;
    if (s.disabled) return false;
    if (/disabled/i.test(s.className || "")) return false;
    if (s.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  // 在可能残留多个 overlay 的 DOM 中选出当前真正打开的那个：
  // 优先 .show-page（Ionic 给活动页加的类），其次可见的，最后才退回 DOM 里最后一个
  function pickOverlay(sel) {
    const list = $$(sel);
    if (!list.length) return null;
    const shown = list.filter((m) => m.classList.contains("show-page"));
    if (shown.length) return shown[shown.length - 1];
    const vis = list.filter((m) => m.getClientRects().length > 0);
    if (vis.length) return vis[vis.length - 1];
    return list[list.length - 1];
  }

  // ---------- 持久化（跨刷新自动续跑的关键） ----------
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem("zk_" + k); return v === null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem("zk_" + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem("zk_" + k); } catch (e) {} },
  };

  // ---------- 日志（内存为主 + 延迟落盘，跨刷新保留） ----------
  const savedLogs = store.get("logs", []);
  let logs = Array.isArray(savedLogs) ? savedLogs : []; // 数据损坏时自愈为空
  let lastSeenErrAt = 0; // 打开抽屉时归零，用于红点计数
  let logFlushTimer = 0;
  let logDirty = false;

  // 延迟落盘：日志写入不再每条约一次 localStorage 同步写（全量日志下会卡页面）
  function flushLogs() {
    if (!logDirty) return;
    logDirty = false;
    try { store.set("logs", logs); } catch (e) {}
  }
  function scheduleFlush() {
    logDirty = true;
    if (logFlushTimer) return;
    logFlushTimer = setTimeout(() => { logFlushTimer = 0; flushLogs(); }, 2000);
  }

  function record(lvl, msg) {
    try {
      const e = { t: now(), lvl, msg: String(msg).slice(0, 300) };
      logs.push(e);
      if (logs.length > LOG_MAX) logs = logs.slice(-LOG_MAX);
      scheduleFlush();
      appendLogLine(e);
      updateBadge();
      if (CFG.debug) console.log("[职行力][" + lvl + "] " + e.msg);
    } catch (er) { /* 日志通道绝不能抛错 */ }
  }

  // ---------- 顶部 Toast（只弹脚本自身的关键信息，页面自身错误不弹） ----------
  let toastBox = null;
  const toastSeen = new Map(); // 同文本 20 秒内去重，避免刷屏
  function notify(msg, level) {
    record(level === "ok" ? "OK" : String(level || "info").toUpperCase(), msg);
    try {
      if (!toastBox) {
        toastBox = document.createElement("div");
        toastBox.id = "zk-toasts";
        document.body.appendChild(toastBox);
      }
      const t = now();
      const prev = toastSeen.get(msg);
      if (prev && t < prev) { toastSeen.set(msg, t + 20000); return; }
      toastSeen.set(msg, t + 20000);

      const el = document.createElement("div");
      el.className = "zk-toast " + (level || "info");
      el.textContent = msg;
      toastBox.appendChild(el);
      while (toastBox.children.length > 3) toastBox.removeChild(toastBox.firstChild);
      // fatal 常驻不自动消失，其余超时移除
      if (level !== "fatal") {
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); },
          level === "error" ? 8000 : 5000);
      }
    } catch (e) { /* 提示通道绝不能抛错 */ }
  }

  function warn(msg) { console.warn("[职行力] " + msg); notify(msg, "error"); }

  // ---------- 运行时状态 ----------
  let running = store.get("running", false);
  let state = "idle"; // idle|entering|opening|playing|closing|evaluating|saving|docopen|backing|halt
  let stateSince = now();
  let busyUntil = 0;          // 互斥锁：多步流程进行中，tick 只做观察不做动作
  let busyCheck = null;       // 锁的提前放行条件：条件满足即解锁放行，不必等满时长
  let busyTag = "";           // 锁用途说明（日志用）
  let busySetAt = 0;          // 上锁时间（统计实际等待时长）
  let lastActivity = now();   // 任何有效进展都更新；全局看门狗依据
  let bootAt = now();
  let ticking = false;
  let consecutiveErrors = 0;
  let evalRetries = 0;
  let recoveryTries = 0;

  // 播放进度追踪
  let lastMediaTime = -1;
  let lastMediaProgressAt = now();
  let lastProgressLogAt = 0;     // 播放进度日志节流（每 60s 一条）
  let lastOpenClickAt = 0;       // 最近一次点击"打开课件"的时间（用于统计打开耗时）
  let currentMediaLabel = "";    // 最近一次打开的课件文本（用于日志与防重播护栏）
  let lastBeat = now();          // 状态快照节流（每 20s 一条）
  let lastSlowWarnAt = 0;        // 卡顿告警节流
  let otherPageSince = 0;        // 进入"非学习页/课程页"的起始时间（空转自愈用）
  let enterTries = 0;            // 学习卡片点击未跳转的连续次数
  let openTries = 0;             // 课件打开失败的连续次数
  let lastTickAt = now();        // 上一次 tick 的时间（停顿检测用）
  let waitLearnedSince = 0;      // "等待服务端更新完成状态"的起始时间（超时自愈用）

  // ---------- 防重播护栏（多条） ----------
  // 多讲课程里播完一讲后，服务端把该讲标记为"已学"可能有延迟；
  // 记录最近完成的课件标签集合（前 24 字），5 分钟内不重复点击，防止整讲重播。
  const DONE_TTL = 300000;   // 护栏有效期 5 分钟
  const DONE_MAX = 10;       // 最多保留条数
  function markDone(label) {
    if (!label) return;
    let arr = store.get("doneMarks", []);
    if (!Array.isArray(arr)) arr = [];
    arr = arr.filter((m) => m && now() - m.at < DONE_TTL && m.label !== label);
    arr.push({ label: label.slice(0, 24), at: now() });
    store.set("doneMarks", arr.slice(-DONE_MAX));
  }
  function isDoneMarked(label) {
    if (!label) return false;
    return store.get("doneMarks", []).some((m) => m && m.label === label && now() - m.at < DONE_TTL);
  }
  const seenMedia = new WeakSet();     // 已挂 ended 监听的媒体元素
  const finishedMedia = new WeakSet(); // 已走完"播完收尾"流程的媒体元素（防重复计数/误退出）
  const progressedMedia = new WeakSet(); // 观测到过播放进度的媒体（用于统计只计真正看过的）

  const stats = store.get("stats", { items: 0, courses: 0 });

  function setState(s) {
    if (state !== s) {
      state = s;
      stateSince = now();
      lastActivity = now();
      record("INFO", "状态 → " + s); // 永久时间线：排查报告里可还原每一步耗时
      refreshStatus();
    }
  }
  const inState = (...ss) => ss.includes(state);
  const stateAge = () => (now() - stateSince) / 1000;
  function touch() { lastActivity = now(); }

  // 上锁：ms=最长等待（兜底），checkFn=提前放行条件（每拍检查，满足即解锁），tag=用途
  function lock(ms, checkFn, tag) {
    busyUntil = now() + ms;
    busyCheck = checkFn || null;
    busyTag = tag || "";
    busySetAt = now();
    record("DBG", "上锁 " + (ms / 1000) + "s：" + busyTag + (checkFn ? "（可提前放行）" : ""));
    if (checkFn) setTimeout(() => { tick().catch(() => {}); }, 400); // 补一拍，加快条件检查
  }
  function clearLock() { busyUntil = 0; busyCheck = null; busyTag = ""; }
  function safeCond() { try { return !!(busyCheck && busyCheck()); } catch (e) { return false; } }

  // ---------- 熔断的自动刷新 ----------
  function recentReloads() {
    let a = store.get("reloads", []);
    a = a.filter((t) => now() - t < 10 * 60 * 1000);
    store.set("reloads", a);
    return a;
  }
  function safeToReload() { return recentReloads().length < CFG.maxReloadsPer10min; }
  function doReload(reason) {
    if (!safeToReload()) {
      running = false;
      store.set("running", false);
      stopAntiThrottle();
      setState("halt");
      setStatus("自动刷新过于频繁已熔断，请人工检查页面后重开", reason);
      notify("⚠ 熔断：10分钟内自动刷新达上限（" + reason + "），已停机，请人工检查", "fatal");
      return;
    }
    const a = recentReloads();
    a.push(now());
    store.set("reloads", a);
    store.set("reloadReason", reason);
    warn("自愈刷新：" + reason + "，刷新后自动续跑");
    notify("自愈刷新：" + reason + "，刷新后自动续跑", "warn");
    setStatus("刷新自愈中…", reason);
    location.reload();
  }

  // ---------- 样式注入 ----------
  function ensureStyles() {
    if (document.getElementById("zk-style")) return;
    const st = document.createElement("style");
    st.id = "zk-style";
    st.textContent = [
      "#zk-panel{position:fixed;right:16px;bottom:16px;z-index:99999;width:176px;display:flex;flex-direction:column;font-family:'Segoe UI',system-ui,sans-serif}",
      "#zk-panel .zk-card{background:rgba(30,32,38,.93);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px;box-shadow:0 10px 30px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:8px}",
      "#zk-panel .zk-title{display:flex;justify-content:space-between;align-items:center;color:#e8eaed;font-size:12px;font-weight:600;letter-spacing:.5px}",
      "#zk-panel .zk-ver{color:#8ab4f8;font-size:10px;font-weight:400}",
      ".zk-btn{border:none;border-radius:9px;cursor:pointer;color:#fff;font-weight:600;font-family:inherit;transition:filter .15s ease,transform .06s ease}",
      ".zk-btn:hover{filter:brightness(1.15)}",
      ".zk-btn:active{transform:scale(.97)}",
      ".zk-primary{width:100%;height:38px;font-size:14px;background:linear-gradient(135deg,#26b565,#1e8e3e);box-shadow:0 3px 10px rgba(30,142,62,.4)}",
      ".zk-primary.on{background:linear-gradient(135deg,#ea5a5a,#d93025);box-shadow:0 3px 10px rgba(217,48,37,.4)}",
      ".zk-ghost{width:100%;height:26px;font-size:12px;font-weight:500;background:rgba(255,255,255,.1);color:#dadce0}",
      ".zk-ghost:hover{background:rgba(255,255,255,.18)}",
      ".zk-status{color:#e8eaed;font-size:12px;font-weight:600;padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".zk-sub{color:#9aa0a6;font-size:10.5px;padding:0 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#zk-toasts{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:100000;display:flex;flex-direction:column;gap:8px;max-width:76vw;pointer-events:none;font-family:'Segoe UI',system-ui,sans-serif}",
      ".zk-toast{padding:9px 16px;border-radius:10px;color:#fff;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.35);border-left:4px solid;word-break:break-all;animation:zk-in .25s ease}",
      ".zk-toast.info{background:rgba(50,53,60,.95);border-color:#9aa0a6}",
      ".zk-toast.ok{background:rgba(23,98,55,.95);border-color:#5bbd82}",
      ".zk-toast.warn{background:rgba(158,95,10,.95);border-color:#ffb84d}",
      ".zk-toast.error{background:rgba(156,32,26,.95);border-color:#ff6d5e}",
      ".zk-toast.fatal{background:rgba(156,32,26,.97);border-color:#fff;font-weight:700}",
      "@keyframes zk-in{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}",
      "#zk-dock{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:100001;background:rgba(30,32,38,.93);color:#e8eaed;border:1px solid rgba(255,255,255,.1);border-right:none;border-radius:10px 0 0 10px;padding:14px 7px;font-size:12px;writing-mode:vertical-rl;letter-spacing:3px;cursor:pointer;font-family:'Segoe UI',system-ui,sans-serif;box-shadow:-4px 4px 14px rgba(0,0,0,.25);user-select:none}",
      "#zk-dock:hover{filter:brightness(1.25)}",
      "#zk-badge{position:absolute;top:-6px;left:-7px;background:#d93025;color:#fff;border-radius:9px;font-size:10px;min-width:16px;height:16px;line-height:16px;text-align:center;writing-mode:horizontal-tb;letter-spacing:0;padding:0 4px;font-weight:700}",
      "#zk-drawer{position:fixed;top:0;right:0;bottom:0;width:340px;max-width:90vw;background:rgba(22,24,29,.98);border-left:1px solid rgba(255,255,255,.1);z-index:100002;display:flex;flex-direction:column;font-family:'Segoe UI',system-ui,sans-serif;transform:translateX(100%);transition:transform .25s ease;pointer-events:none;box-shadow:-10px 0 40px rgba(0,0,0,.4)}",
      "#zk-drawer.open{transform:none;pointer-events:auto}",
      "#zk-drawer .zk-dh{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);color:#e8eaed;font-size:13px;font-weight:600}",
      "#zk-drawer .zk-grow{flex:1}",
      "#zk-drawer .zk-mini{background:rgba(255,255,255,.1);border:none;color:#dadce0;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;white-space:nowrap}",
      "#zk-drawer .zk-mini:hover{background:rgba(255,255,255,.2)}",
      "#zk-drawer .zk-mini.accent{background:#2d6cdf}",
      "#zk-drawer .zk-mini.accent:hover{background:#3d7df0}",
      "#zk-drawer .zk-list{flex:1;overflow-y:auto;padding:6px 0;user-select:text!important;-webkit-user-select:text!important}",
      ".zk-line{font-family:Consolas,Menlo,monospace;font-size:11px;line-height:1.5;padding:3px 10px;border-bottom:1px solid rgba(255,255,255,.04);white-space:pre-wrap;word-break:break-all;color:#c9cdd3}",
      ".zk-line .zk-t{color:#5f6368}",
      ".zk-lv-OK{color:#81c995}.zk-lv-WARN{color:#fdd663}.zk-lv-ERROR{color:#f28b82}.zk-lv-FATAL{color:#ff6d5e;font-weight:700}.zk-lv-PAGE{color:#9aa0a6}.zk-lv-DBG{color:#8ab4f8}.zk-lv-INFO{color:#c9cdd3}",
      "#zk-drawer .zk-empty{color:#5f6368;font-size:12px;text-align:center;padding:20px 0}",
      '#zk-loglist.only-err .zk-line[data-lvl="DBG"],#zk-loglist.only-err .zk-line[data-lvl="INFO"],#zk-loglist.only-err .zk-line[data-lvl="OK"],#zk-loglist.only-err .zk-line[data-lvl="PAGE"]{display:none}',
      // ---- 设置抽屉 ----
      "#zk-settings{position:fixed;top:0;right:0;bottom:0;width:340px;max-width:92vw;background:rgba(22,24,29,.98);border-left:1px solid rgba(255,255,255,.1);z-index:100003;display:flex;flex-direction:column;font-family:'Segoe UI',system-ui,sans-serif;transform:translateX(100%);transition:transform .25s ease;pointer-events:none;box-shadow:-10px 0 40px rgba(0,0,0,.4)}",
      "#zk-settings.open{transform:none;pointer-events:auto}",
      "#zk-settings .zk-dh{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);color:#e8eaed;font-size:13px;font-weight:600}",
      "#zk-settings .zk-body{flex:1;overflow-y:auto;padding:10px 12px 20px}",
      "#zk-settings .zk-sec{color:#8ab4f8;font-size:11px;font-weight:700;letter-spacing:1px;margin:14px 0 6px}",
      "#zk-settings .zk-sec:first-child{margin-top:2px}",
      "#zk-settings .zk-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0}",
      "#zk-settings .zk-lab{color:#c9cdd3;font-size:12.5px;flex:1}",
      "#zk-settings .zk-lab small{display:block;color:#5f6368;font-size:10.5px;margin-top:1px}",
      "#zk-settings input[type=text],#zk-settings input[type=number],#zk-settings select{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#e8eaed;border-radius:7px;padding:5px 8px;font-size:12.5px;font-family:inherit;outline:none}",
      "#zk-settings input[type=text]{width:170px}",
      "#zk-settings input[type=number]{width:74px;text-align:right}",
      "#zk-settings input:focus,#zk-settings select:focus{border-color:#8ab4f8}",
      "#zk-settings .zk-switch{position:relative;width:38px;height:20px;border-radius:10px;background:rgba(255,255,255,.15);border:none;cursor:pointer;transition:background .2s;flex:none}",
      "#zk-settings .zk-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#e8eaed;transition:left .2s}",
      "#zk-settings .zk-switch.on{background:#26b565}",
      "#zk-settings .zk-switch.on::after{left:20px}",
      "#zk-settings .zk-note{color:#5f6368;font-size:10.5px;line-height:1.6;margin-top:10px;border-top:1px solid rgba(255,255,255,.06);padding-top:8px}",
    ].join("\n");
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------- 控制面板 ----------
  let panelEls = null;
  function ensurePanel() {
    if ($("#zk-panel")) return;
    ensureStyles();
    const panel = document.createElement("div");
    panel.id = "zk-panel";
    panel.innerHTML =
      '<div class="zk-card">' +
      '<div class="zk-title"><span>职行力助手</span><span class="zk-ver">v' + VERSION + '</span></div>' +
      '<button class="zk-btn zk-primary"></button>' +
      '<div style="display:flex;gap:6px">' +
      '<button class="zk-btn zk-ghost" style="flex:1">页面可复制</button>' +
      '<button class="zk-btn zk-ghost" id="zk-setbtn" style="flex:1">⚙ 设置</button>' +
      "</div>" +
      '<div class="zk-status">待命</div>' +
      '<div class="zk-sub"></div>' +
      "</div>";
    document.body.appendChild(panel);

    const playBtn = panel.querySelector(".zk-primary");
    if (running) playBtn.classList.add("on");
    playBtn.textContent = running ? "停止刷课" : "开始刷课";
    playBtn.onclick = () => {
      running = !running;
      store.set("running", running);
      playBtn.classList.toggle("on", running);
      playBtn.textContent = running ? "停止刷课" : "开始刷课";
      if (running) {
        evalRetries = 0;
        recoveryTries = 0;
        startAntiThrottle();
        startSilentAudio(); // 用户点击即手势，静音保活从这里开始生效
        installVisibilitySpoof(); // 点击时机安装，确保属性覆写成功
        setState("idle");
        notify("已开始刷课，将自动前往学习页", "ok");
        tick(); // 点击后立即执行一拍，不用等最多 5 秒的轮询
      } else {
        stopAntiThrottle();
        setState("idle");
        setStatus("已停止", "");
        notify("已停止刷课", "ok");
      }
    };

    const copyBtn = panel.querySelector(".zk-ghost:not(#zk-setbtn)");
    copyBtn.onclick = () => {
      const b = document.body;
      b.contentEditable = b.contentEditable === "true" ? "false" : "true";
      copyBtn.textContent = b.contentEditable === "true" ? "页面可编辑" : "页面可复制";
    };

    panel.querySelector("#zk-setbtn").onclick = toggleSettings;

    panelEls = {
      playBtn,
      statusA: panel.querySelector(".zk-status"),
      statusB: panel.querySelector(".zk-sub"),
    };
    refreshStatus();
  }

  function setStatus(main, detail) {
    if (panelEls) {
      panelEls.statusA.textContent = main || "";
      panelEls.statusB.textContent = detail || "";
    }
  }
  function refreshStatus() {
    if (!panelEls) return;
    let main;
    switch (state) {
      case "playing": main = "▶ 播放中"; break;
      case "opening": main = "打开课件…"; break;
      case "closing": main = "本节完成，返回…"; break;
      case "evaluating": main = "评价中…"; break;
      case "saving": main = "保存评价…"; break;
      case "docopen": main = "文档课件…"; break;
      case "backing": main = "返回学习页…"; break;
      case "entering": main = "进入课程…"; break;
      case "halt": main = "已熔断，需人工处理"; break;
      default: main = running ? "运行中…" : "待命";
    }
    const mem = performance.memory
      ? Math.round(performance.memory.usedJSHeapSize / 1048576) + "MB" : "";
    setStatus(main, "已刷 " + stats.items + " 节/" + stats.courses + " 课 · " +
      fmtDur(now() - bootAt) + (mem ? " · " + mem : ""));
  }

  // ---------- 日志抽屉（右侧） ----------
  function ensureDrawer() {
    if (document.getElementById("zk-drawer")) return;
    ensureStyles();

    const dock = document.createElement("div");
    dock.id = "zk-dock";
    dock.title = "打开运行日志";
    dock.innerHTML = '日志<span id="zk-badge" hidden></span>';

    const drawer = document.createElement("div");
    drawer.id = "zk-drawer";
    drawer.innerHTML =
      '<div class="zk-dh"><span>📋 运行日志</span><span class="zk-grow"></span>' +
      '<button class="zk-mini" id="zk-filter">只看异常</button>' +
      '<button class="zk-mini accent" id="zk-copy">复制排查信息</button>' +
      '<button class="zk-mini" id="zk-clear">清空</button>' +
      '<button class="zk-mini" id="zk-close">收起</button></div>' +
      '<div class="zk-list" id="zk-loglist"></div>';

    document.body.appendChild(dock);
    document.body.appendChild(drawer);

    dock.onclick = () => {
      const open = drawer.classList.toggle("open");
      if (open) { lastSeenErrAt = now(); renderLogs(); updateBadge(); }
    };
    drawer.querySelector("#zk-close").onclick = () => drawer.classList.remove("open");
    drawer.querySelector("#zk-filter").onclick = (ev) => {
      const list = document.getElementById("zk-loglist");
      const on = list.classList.toggle("only-err");
      ev.target.textContent = on ? "显示全部" : "只看异常";
    };
    drawer.querySelector("#zk-clear").onclick = () => {
      logs = [];
      logDirty = false;
      if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = 0; }
      store.set("logs", logs);
      lastSeenErrAt = now();
      renderLogs();
      updateBadge();
      notify("日志已清空", "ok");
    };
    drawer.querySelector("#zk-copy").onclick = () => {
      copyText(buildReport()).then((ok) => {
        if (ok) notify("排查信息已复制（含最近 1000 条日志）", "ok");
        else notify("复制失败，请在日志列表中手动选择复制", "error");
      });
    };
    renderLogs();
  }

  const DOM_LINE_MAX = 800; // 抽屉最多渲染行数（更早的仍在内存与报告中）

  function lineHtml(e) {
    return '<span class="zk-t">' + fmtTime(e.t) + "</span> " +
      '<span class="zk-lv-' + esc(e.lvl) + '">[' + esc(e.lvl) + "]</span> " + esc(e.msg);
  }

  function renderLogs() {
    const list = document.getElementById("zk-loglist");
    if (!list) return;
    if (!logs.length) {
      list.innerHTML = '<div class="zk-empty">暂无日志</div>';
    } else {
      list.innerHTML = logs.slice(-DOM_LINE_MAX).map((e) =>
        '<div class="zk-line" data-lvl="' + esc(e.lvl) + '">' + lineHtml(e) + "</div>"
      ).join("");
      list.scrollTop = list.scrollHeight;
    }
    updateBadge();
  }

  // 增量追加渲染：仅抽屉打开时更新 DOM，避免全量日志影响页面流畅度
  function appendLogLine(e) {
    const drawerEl = document.getElementById("zk-drawer");
    if (!drawerEl || !drawerEl.classList.contains("open")) return; // 关闭时零 DOM 开销
    const list = document.getElementById("zk-loglist");
    if (!list) return;
    const empty = list.querySelector(".zk-empty");
    if (empty) empty.remove();
    const div = document.createElement("div");
    div.className = "zk-line";
    div.dataset.lvl = e.lvl;
    div.innerHTML = lineHtml(e);
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.appendChild(div);
    while (list.children.length > DOM_LINE_MAX) list.removeChild(list.firstChild);
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  function updateBadge() {
    const b = document.getElementById("zk-badge");
    if (!b) return;
    const n = logs.filter((e) => (e.lvl === "ERROR" || e.lvl === "FATAL") && e.t > lastSeenErrAt).length;
    b.hidden = n === 0;
    b.textContent = n > 99 ? "99+" : String(n);
  }

  function buildReport() {
    const mem = performance.memory
      ? Math.round(performance.memory.usedJSHeapSize / 1048576) + "MB / 限 " + CFG.heapLimitMB + "MB" : "不可用";
    const repLogs = logs.slice(-1000);
    return [
      "=== 职行力助手 v" + VERSION + " 排查信息 ===",
      "导出时间: " + new Date().toLocaleString("zh-CN", { hour12: false }),
      "页面: " + location.href + " / 隐藏=" + document.hidden +
        " / 视口=" + window.innerWidth + "x" + window.innerHeight,
      "UA: " + navigator.userAgent,
      "运行状态: " + state + " / running=" + running + " / 开机于 " + fmtTime(bootAt) +
        "（已运行 " + fmtDur(now() - bootAt) + "）",
      "当前页面: " + ($("course-detail-page") ? "课程页" : $("page-learn") ? "学习页" : "其它页")
        + "（" + (document.title || "").slice(0, 16) + "） / 打开弹窗数: " + overlays().length,
      "锁: " + (busyUntil > now()
        ? "还剩 " + ((busyUntil - now()) / 1000).toFixed(1) + "s：" + busyTag +
          (busyCheck ? (safeCond() ? "(条件已满足)" : "(条件未满足)") : "")
        : "无"),
      "统计: " + stats.items + " 节 / " + stats.courses + " 课",
      "内存: " + mem,
      "近10分钟自愈刷新: " + (recentReloads().length ? recentReloads().map(fmtTime).join(",") : "无"),
      "配置: " + JSON.stringify(CFG),
      "--- 日志（共 " + logs.length + " 条，报告含最近 " + repLogs.length + " 条） ---",
    ].concat(repLogs.map((e) => fmtTime(e.t) + " [" + e.lvl + "] " + e.msg))
      .join("\n");
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(() => true)
        .catch(() => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  // ---------- 后台防节流（静音音频，人耳无感知） ----------
  let audioCtx = null;
  function startAntiThrottle() {
    if (!CFG.antiThrottle || audioCtx) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
    } catch (e) { /* 无感失败 */ }
  }
  function stopAntiThrottle() {
    try { audioCtx && audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }
  function tryResumeAudio() {
    // Chrome 无手势时会把 AudioContext 挂起，任何一次点击/切回前台都尝试恢复
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    startSilentAudio(); // 静音保活被拦截时（无手势），借这次点击重试
  }

  // ---------- 静音保活：让标签页被 Chrome 视为"正在播放音频"，尽量避免后台冻结 ----------
  // 生成 1 秒全零采样（8-bit 静音）的 WAV，循环播放——没有任何声音、不发起网络请求。
  let silentAudio = null;
  function startSilentAudio() {
    if (silentAudio) {
      if (silentAudio.paused) silentAudio.play().catch(() => {});
      return;
    }
    try {
      const sr = 8000, n = sr; // 1 秒静音
      const buf = new Uint8Array(44 + n);
      const dv = new DataView(buf.buffer);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
      w(0, "RIFF"); dv.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt ");
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, sr, true); dv.setUint32(28, sr, true);
      dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
      w(36, "data"); dv.setUint32(40, n, true);
      buf.fill(128, 44); // 8-bit PCM 静音值 = 128
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      const a = new Audio(url);
      a.loop = true;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
      silentAudio = a;
    } catch (e) { /* 环境不支持则静默降级 */ }
  }

  // ---------- 可见性伪装：让页面"以为"你一直在看 ----------
  // Chrome 在标签页隐藏/最小化时会把 document.visibilityState 变为 "hidden" 并派发
  // visibilitychange/blur；TC Player 等播放器监听这些信号就会暂停或停止推进。
  // 这里覆写属性与事件，让页面始终读到 "visible"。（本脚本自身的调度不依赖这些信号）
  let spoofInstalled = false;
  function installVisibilitySpoof() {
    if (spoofInstalled || !CFG.spoofVisibility) return;
    try {
      const doc = document;
      // 1) 属性伪装
      for (const prop of ["visibilityState", "webkitVisibilityState"]) {
        try {
          Object.defineProperty(doc, prop, {
            get: () => "visible",
            configurable: true,
          });
        } catch (e) {}
      }
      try {
        Object.defineProperty(doc, "hidden", {
          get: () => false,
          configurable: true,
        });
      } catch (e) {}
      try {
        Object.defineProperty(doc, "webkitHidden", {
          get: () => false,
          configurable: true,
        });
      } catch (e) {}
      // 2) 拦截可见性变化事件：页面监听器永远收到"已可见"的旧状态
      doc.addEventListener("visibilitychange", (e) => {
        try {
          e.stopImmediatePropagation();
          const ev = new Event("visibilitychange");
          Object.defineProperty(ev, "target", { value: doc });
          Object.defineProperty(ev, "visibilityState", { value: "visible" });
          doc.dispatchEvent(ev);
        } catch (er) {}
      }, true); // 捕获阶段最先执行
      // 3) 窗口失焦伪装（部分播放器监听 blur 暂停）
      try {
        Object.defineProperty(window, "document", { value: doc }); // no-op 保护
      } catch (e) {}
      spoofInstalled = true;
      record("INFO", "可见性伪装已启用（后台/最小化时页面对播放器保持'可见'）");
    } catch (e) {
      record("WARN", "可见性伪装安装失败：" + (e && e.message));
    }
  }

  // 画中画兜底：后台时把视频放进 PiP 小窗（物理上持续渲染，推进最彻底；会弹出小窗）
  let pipActive = false;
  async function maybePiP(media) {
    if (!CFG.pipFallback || pipActive) return;
    try {
      if (media !== document.pictureInPictureElement && media.requestPictureInPicture) {
        await media.requestPictureInPicture();
        pipActive = true;
        record("INFO", "已进入画中画模式（后台保活播放）");
      }
    } catch (e) { /* 不支持/被拒绝则静默 */ }
  }
  // 主线程的 setTimeout/setInterval 在后台标签页会降到 1 次/分钟甚至完全冻结；
  // Worker 线程的定时器宽松得多，用它来驱动 tick，尽量让脚本在后台也能推进。
  function startWorkerDriver() {
    try {
      const src = "let t=null;onmessage=function(e){if(e.data==='s'){if(!t){t=setInterval(function(){postMessage(0)},1000)}}else{clearInterval(t);t=null}};";
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const w = new Worker(url);
      w.onmessage = () => { tick().catch(() => {}); };
      w.postMessage("s");
      return w;
    } catch (e) { return null; } // CSP 等环境不支持时静默降级
  }

  // ---------- 弹窗治理 ----------
  function overlays() { return $$("ion-modal"); }

  // 同一弹窗的关闭尝试计数（用于发现"关不掉"的弹窗）
  const overlayAttempts = new WeakMap();

  function dismissModal(m) {
    if (!m) return false;
    // 策略1：标题栏返回键 / 显式关闭按钮（评价弹窗、播放器弹窗等）
    const back =
      m.querySelector("ion-header .back-button") ||
      m.querySelector("button.close, .modal-close, ion-header button");
    // 策略2：无标题栏的纯按钮弹窗（奖励弹窗等），匹配确认/取消类文字按钮；
    // 注意不匹配"翻翻背包/保存/提交"等会跳转或提交的按钮
    const ack = $$("button", m).find((b) =>
      /^(我知道了|知道了|确\s*定|关\s*闭|取消|×|✕)$/i.test((b.textContent || "").trim()));
    const btn = back || ack;
    if (!btn) return false;
    realClick(btn);
    touch();
    const n = (overlayAttempts.get(m) || 0) + 1;
    overlayAttempts.set(m, n);
    if (n === 3) {
      record("WARN", "弹窗连续 3 次点击关闭仍存在：「" +
        (m.textContent || "").replace(/\s+/g, "").slice(0, 30) + "」");
    }
    if (n >= 6) {
      // 残留弹窗关不掉会一直空转（实测曾空转 60 秒）：自愈刷新（走熔断保护）
      doReload("残留弹窗无法关闭（已尝试 6 次）：「" +
        (m.textContent || "").replace(/\s+/g, "").slice(0, 24) + "」");
    }
    return true;
  }

  // "获得奖励"弹窗：通过课程后弹出，无标题栏返回键，只有"我知道了/翻翻背包"
  function closeReward() {
    const m = $$("ion-modal, .exe-win-open-modal")
      .find((el) => /获得奖励|恭喜您/.test(el.textContent || ""));
    if (!m) return false;
    const btn = $$("button", m).find((b) => /我知道了|知道了/.test((b.textContent || "").trim()));
    if (btn) {
      realClick(btn);
      touch();
      notify("🎉 课程通过，已自动关闭奖励弹窗", "ok");
      return true;
    }
    return false;
  }

  // 播放期间也要治理"外来"弹窗（奖励/系统确认框/残留弹窗），
  // 否则会一直挂在页面上、越积越多（用户的实际反馈问题）
  function handleForeignOverlays(media) {
    if (handleAlerts()) return true;
    if (closeReward()) return true;
    const home = media ? media.closest("ion-modal") : null;
    const foreign = overlays().filter((m) => m !== home);
    let acted = false;
    for (const m of foreign) if (dismissModal(m)) acted = true;
    return acted;
  }

  // 系统确认框（ion-alert）：不定期的"确定/取消"弹窗，不处理会永久阻塞。
  // 同一弹窗在 10 秒内反复出现（点了没消失）→ 升级：第 3 次改点第一个按钮（通常"否/取消"），
  // 第 6 次仍未消失 → 自愈刷新（走熔断保护）。日志会完整记录弹窗正文，便于追溯。
  const alertStrikes = new Map(); // 签名 -> { n, at }
  let lastAlertHandleAt = 0;
  function handleAlerts() {
    const alerts = $$("ion-alert");
    if (!alerts.length || !CFG.alertPolicy) return false;
    if (now() - lastAlertHandleAt < 2500) return false; // 节流：等待循环里 200ms 一次会锤击弹窗
    lastAlertHandleAt = now();
    for (const a of alerts) {
      const btns = $$(".alert-button", a);
      if (!btns.length) continue;
      const body = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
      const sig = body + "|" + btns.map((b) => (b.textContent || "").trim()).join("/");
      const rec = alertStrikes.get(sig) || { n: 0, at: 0 };
      rec.n = now() - rec.at > 10000 ? 1 : rec.n + 1; // 10 秒内再次出现 = 同一弹窗没关掉
      rec.at = now();
      alertStrikes.set(sig, rec);

      if (rec.n >= 6) {
        record("WARN", "确认框反复出现且关不掉（已点 " + rec.n + " 次）：「" + body + "」，自愈刷新");
        doReload("确认框反复出现无法关闭：" + body.slice(0, 24));
        return true;
      }
      let pick;
      if (rec.n >= 3) {
        pick = btns[0]; // 第 3 次起换一个按钮（通常是"否/取消"）
      } else if (CFG.alertPolicy === "cancel") {
        pick = btns.find((b) => /取消|关闭|否/.test(b.textContent || "")) || btns[0];
      } else {
        pick = btns[btns.length - 1];
      }
      warn("系统弹窗「" + body + "」[" + btns.map((b) => (b.textContent || "").trim()).join("/") +
        "] → 点击「" + (pick.textContent || "").trim() + "」（第 " + rec.n + " 次）");
      realClick(pick);
    }
    lock(3000, () => overlays().length === 0 && !$$("ion-alert").length, "确认框关闭动画");
    return true;
  }

  // 堆叠弹窗回收：我们的流程任何时刻至多一个弹窗；>1 即为历史残留
  function modalGarbageCollect() {
    const mods = overlays();
    if (mods.length > 1) {
      warn("检测到 " + mods.length + " 个堆叠弹窗，清理 " + (mods.length - 1) + " 个");
      mods.slice(0, -1).forEach(dismissModal);
      lock(3000, () => overlays().length === 0, "等弹窗关闭动画");
      return true;
    }
    if (mods.length === 1 && inState("idle", "entering") && !playingMedia()) {
      if (dismissModal(mods[0])) {
        warn("关闭空闲期残留弹窗");
        lock(3000, () => overlays().length === 0, "等弹窗关闭动画");
        return true;
      }
    }
    return false;
  }

  // ---------- 媒体 ----------
  function playingMedia() {
    if (!$("course-detail-page")) return null;
    // 弹窗内媒体优先；audio 兜底全局（音频可能不在 modal 中）；video 不兜底（页面存在杂散 video）
    // 已完结但尚未被 DOM 移除的媒体跳过，避免重复收尾
    return $$("ion-modal video, ion-modal audio, audio")
      .find((m) => !finishedMedia.has(m)) || null;
  }

  function dismissPlayerModal() {
    // 关闭顺序：标题栏返回键 → 播放器左上"关闭"按钮（vjs-close-button，实测部分场景返回键无效）
    let back = $("modal-tc-video-player ion-header button.back-button");
    if (!back) back = $("modal-tc-video-player .vjs-close-button");
    if (!back) {
      const pc = $(".player-container");
      const root = pc ? pc.closest("ion-modal") : null;
      if (root) back = root.querySelector("ion-header button.back-button") ||
        root.querySelector(".vjs-close-button");
    }
    if (back) { realClick(back); touch(); record("DBG", "点击返回（关闭播放器弹窗）"); return true; }
    record("DBG", "未找到播放器弹窗返回按钮");
    return false;
  }

  function goBackFromCourse() {
    const back =
      $("#nav > course-detail-page > ion-header > ion-navbar > button") ||
      $("course-detail-page ion-header ion-navbar button");
    if (back) { realClick(back); touch(); record("DBG", "点击返回（离开课程页）"); return true; }
    record("DBG", "未找到课程页返回按钮");
    return false;
  }

  // 媒体自然播完（事件驱动，后台标签页也能及时触发）
  // 收尾策略（v3.15 重设计）：播完一讲只关播放器弹窗、**留在课程页**，
  // 由主循环直接挑选下一讲；只有整门课全部完成（无待学课件且无需评价）才退出课程。
  // 旧设计"每讲退出→重进"会触发站点的「该课程需要完成学习，是否继续退出」确认框，
  // 点"是"退出整门课再重进，造成多讲课程反复循环、甚至重播已完成的讲次。
  function onMediaEnded(media) {
    if (!inState("playing")) return; // 防重入：closing 期间忽略重复触发
    if (media) finishedMedia.add(media);
    // 立即记账 + 防重播护栏：不等收尾链跑完（链可能被后台冻结打断，晚记会漏护栏导致重播）
    markDone(currentMediaLabel);
    if (media && progressedMedia.has(media)) {
      stats.items++;
      store.set("stats", stats);
      notify("✓ 已完成 1 节（累计 " + stats.items + " 节）", "ok");
    } else {
      record("INFO", "媒体接管时已处于播完状态，本节点不计入统计（是否完成交由站点判定）");
    }
    setState("closing");
    lock(20000, null, "播完收尾"); // 上限 20s；链内每步检查状态，被接管时立即放弃
    (async () => {
      try {
        if (!inState("closing")) return;
        // 1. 只关播放器弹窗，回到课程详情页
        dismissPlayerModal();
        if (!(await waitFor(() => !$("modal-tc-video-player"), 2000))) {
          dismissPlayerModal(); // 兜底再点一次
          await waitFor(() => !$("modal-tc-video-player"), 1500);
        }
        if (!inState("closing")) return; // 已被其它流程接管，放弃收尾

        // 2. 稍等列表状态刷新，判断课程内是否还有事可做
        await sleep(2500);
        if (!inState("closing")) return;
        const items = $$(".course-item");
        const pend = items.filter((el) =>
          !el.classList.contains("learned") &&
          !el.classList.contains("exam2_top") &&
          !el.getAttribute("exepower"));
        const pendNext = pend.filter((el) => !isDoneMarked(normText(el.innerText).slice(0, 24)));
        const needEval = items.some((el) =>
          el.classList.contains("exam2_top") && !/已评定/.test(el.innerText || ""));

        // 3. 还有待学课件（或待评价）：留在课程页，主循环直接选下一个
        if (pendNext.length || needEval) {
          record("INFO", "课程内还有 " +
            (pendNext.length ? pendNext.length + " 个待学课件" : "") +
            (pendNext.length && needEval ? "和" : "") +
            (needEval ? "待评价" : "") + "，留在课程页继续");
          setState("idle");
          clearLock();
          return;
        }

        // 4. 整门课全部完成（剩余课件均处于护栏期视为已完成）才退出课程。
        //    此时退出不会触发「是否继续退出」确认框；万一弹出，handleAlerts 兜底。
        goBackFromCourse();
        let backOk = await waitFor(() => !$("course-detail-page"), 2500);
        if (!inState("closing")) return;
        if (!backOk) {
          goBackFromCourse(); // 兜底再点一次
          backOk = await waitFor(() => !$("course-detail-page"), 2500);
        }
        if (!backOk) noteOnce("back-fail", "返回学习页未确认（课程页仍在 DOM），下拍自动处理");
      } catch (e) { warn("结束流程异常: " + e.message); }
      if (inState("closing")) setState("idle");
      clearLock();
    })();
  }

  function manageMedia(media) {
    if (finishedMedia.has(media)) return; // 已收尾的残留媒体，等待 DOM 移除即可
    if (CFG.muted) media.muted = true;
    if (CFG.playbackRate > 0 && media.playbackRate !== CFG.playbackRate) {
      try { media.playbackRate = CFG.playbackRate; } catch (e) {}
    }

    if (!seenMedia.has(media)) {
      seenMedia.add(media);
      lastMediaTime = -1;
      lastMediaProgressAt = now();
      lastProgressLogAt = now();
      openTries = 0; // 播放器已出现，重置"打不开"计数
      media.addEventListener("ended", () => onMediaEnded(media));
      const dt = lastOpenClickAt ? ((now() - lastOpenClickAt) / 1000).toFixed(1) + "s" : "?";
      record("INFO", "开始播放（点击到接管 " + dt + "）" +
        (currentMediaLabel ? "：" + currentMediaLabel.slice(0, 30) : ""));
    }

    // 关键顺序：先判断"是否已经播完"再做 play()。
    // 后台冻结期间视频可能已自行播完，若先 play() 会把已结束的视频从头重播。
    const cur0 = media.currentTime || 0;
    const dur0 = media.duration;
    if (isFinite(dur0) && dur0 > 0 && cur0 >= dur0 - 1.5) {
      record("INFO", "检测到媒体已播完（" + fmtClock(cur0) + "/" + fmtClock(dur0) + "），直接收尾");
      onMediaEnded(media);
      return;
    }

    if (media.paused) {
      const p = media.play();
      if (p && p.catch) {
        p.catch((err) => {
          // 刷新后无手势，自动播放可能被拦截 → 强制静音重试（静音自动播放是允许的）
          if (err && /NotAllowed/i.test(err.name || "")) {
            warn("自动播放被拦截，转静音重试");
            media.muted = true;
            return media.play().catch(() => {});
          }
        });
      }
    }

    // 进度追踪（正常推进则不断续命看门狗）
    const cur = media.currentTime || 0;
    if (cur > lastMediaTime + 0.5) {
      lastMediaTime = cur;
      lastMediaProgressAt = now();
      progressedMedia.add(media); // 观测到推进：完成统计时才算"真正看过"
      touch();
    }
    setState("playing");
    refreshStatus();

    // 细粒度停滞续播：后台/最小化时播放器可能暂停推进。
    // 与 180s 看门狗不同层：这里 15s 一查，停了就 play() 拉起（必要时换播放器大按钮）。
    if (!media.paused && progressedMedia.has(media) &&
        now() - lastMediaProgressAt > CFG.stallResumeSec * 1000) {
      record("WARN", "进度停滞 " + CFG.stallResumeSec + "s（疑似后台自动暂停），自动续播");
      const p = media.play();
      if (p && p.catch) p.catch(() => {});
      const big = $(".vjs-big-play-button");
      if (big) realClick(big);
      lastMediaProgressAt = now() - (CFG.stallResumeSec * 500); // 给恢复半程观察窗
      maybePiP(media); // 连续停滞时可选进入画中画兜底
    }

    // 播放进度日志（每 60s）：证明播放持续推进、速度与暂停状态一目了然
    if (now() - lastProgressLogAt > 60000) {
      lastProgressLogAt = now();
      record("DBG", "播放进度 " + fmtClock(cur) + "/" + fmtClock(media.duration) +
        " ×" + media.playbackRate + (media.paused ? "（暂停中）" : ""));
    }

    // 播放卡死检测：长时间无进度 → 大播放键恢复 → 仍不行则刷新
    if (now() - lastMediaProgressAt > CFG.stuckPlayingSec * 1000) {
      warn("播放无进度 " + CFG.stuckPlayingSec + "s，尝试恢复 #" + (recoveryTries + 1));
      const big = $(".vjs-big-play-button");
      if (big) big.click();
      if (media.paused) { try { media.play().catch(() => {}); } catch (e) {} }
      lastMediaProgressAt = now(); // 给恢复手段一个观察窗口
      if (++recoveryTries >= 3) {
        recoveryTries = 0;
        doReload("播放卡死");
      }
    } else {
      recoveryTries = 0;
    }

    // ended 事件没触发的兜底（人工拖到结尾等情况）
    if (isFinite(media.duration) && media.duration > 0 && cur >= media.duration - 1.5) {
      onMediaEnded(media);
    }
  }

  // ---------- 各流程（均带互斥锁与超时出口） ----------
  async function runDoc(item) {
    setState("docopen");
    lock(20000, null, "文档课件流程"); // 内部链自清理；20s 为安全上限
    try {
      const t0 = now();
      item.click();
      // 等文档弹窗出现（出现即继续，不再盲等 5 秒）
      const appeared = await waitFor(() => !!$(".exe-win-open-modal .back-button"), 8000);
      if (!appeared) {
        warn("文档弹窗未出现（8s 内未找到 .exe-win-open-modal）");
      } else {
        // 保底停留 5 秒，确保站点记录阅读进度
        const rest = 5000 - (now() - t0);
        if (rest > 0) await sleep(rest);
        $(".exe-win-open-modal .back-button").click();
        await waitFor(() => !$(".exe-win-open-modal"), 3000);
      }
    } catch (e) { warn("文档流程异常: " + e.message); }
    setState("idle");
    clearLock();
  }

  async function runEvaluate(evalItem) {
    if (!evalItem) { setState("idle"); clearLock(); return; }
    setState("evaluating");
    lock(60000, null, "评价流程"); // 内部链（含重试）自清理；60s 为安全上限
    try {
      const t0 = now();
      // 点开评价条目：刚进课程页时条目点击容易撞上页面切换动画，用完整事件序列 + 超时补点
      const isOpen = (m) => !!(m && (m.classList.contains("show-page") || m.getClientRects().length > 0));
      const modalFrame = () => { const m = pickOverlay("modal-evaluate"); return isOpen(m) ? m : null; };
      // "内容就绪" ≠ "弹窗出现"：站点先弹空壳，星级/输入框要过几秒才渲染出来。
      // 不等内容就操作会"未找到星级控件"，保存时被站点拒绝（提交失败：评分还没有完成）。
      const modalReady = () => {
        const m = modalFrame();
        if (!m) return null;
        return (m.querySelector("exe-star") || m.querySelector("textarea") ||
          m.querySelector("ion-footer button")) ? m : null;
      };
      try { evalItem.scrollIntoView({ block: "center" }); } catch (e) {}
      realClick(evalItem);
      let me = null;
      // 第一段：等弹窗框架出现（8s；没出现补点一次，仍没有才放弃）
      if (!(await waitFor(() => { me = modalFrame(); return !!me; }, 8000))) {
        record("WARN", "评价弹窗未出现（8s），补点一次课程条目");
        realClick(evalItem);
        await waitFor(() => { me = modalFrame(); return !!me; }, 8000);
      }
      if (!me) { warn("评价弹窗未出现"); setState("idle"); clearLock(); return; }
      // 第二段：等内容渲染就绪（最多 15s；不重复点击，避免叠弹窗）
      const ready = await waitFor(() => { const r = modalReady(); if (r) me = r; return !!r; }, 15000);
      if (!ready) {
        record("WARN", "评价弹窗内容迟迟未渲染（15s），弹窗文本：「" +
          (me.textContent || "").replace(/\s+/g, " ").slice(0, 60) + "」");
        setState("idle"); clearLock(); return;
      }
      record("INFO", "评价弹窗就绪（" + ((now() - t0) / 1000).toFixed(1) + "s，DOM 中共 " +
        $$("modal-evaluate").length + " 个）");

      // ---- 点星：完整事件序列 + 效果校验（样式变化 / 保存按钮可用性）----
      let starOk = false;
      // 选"真正可打分"的星级容器：优先站点控件名，兜底找含 ≥3 个按钮的 star 类容器（排除装饰性图标）
      const starGroup = (() => {
        const named = [me.querySelector("exe-single-dimension > exe-star"), me.querySelector("exe-star")]
          .filter(Boolean);
        const fallback = $$("[class*='star']", me).filter((el) => $$("button", el).length >= 3);
        const all = named.concat(fallback);
        return all.find((el) => $$("button", el).length >= 3) || all[0] || null;
      })();
      const group = starGroup;
      if (!group) {
        // 站点要求评分（日志可见"提交失败：评分还没有完成"），没有星级控件时提交必被拒。
        // 记录弹窗内容片段便于排查，放弃本轮（不空点保存），交由重试/下一拍。
        record("WARN", "未找到星级控件，本轮不提交。弹窗文本：「" +
          (me.textContent || "").replace(/\s+/g, " ").slice(0, 80) + "」");
        evalRetries++;
        const m0 = pickOverlay("modal-evaluate");
        if (m0) dismissModal(m0);
        await sleep(1000);
        setState("idle");
        clearLock();
        if (evalRetries >= 3) { evalRetries = 0; doReload("评价弹窗缺少星级控件"); }
        return;
      }
      {
        const btns = $$("button", group);
        const idx = Math.min(CFG.stars, btns.length) - 1;
        const target = btns[idx];
        if (!target) {
          warn("星级按钮数量异常：" + btns.length);
        } else {
          const snapCls = () => $$("button", group).map((b) => b.className || "").join("~");
          const before = snapCls();
          realClick(target);
          let clsChanged = await waitFor(() => snapCls() !== before, 2500, 120);
          if (!clsChanged) {
            record("WARN", "星级点击后未检测到样式变化，用完整事件序列重试一次");
            realClick(target);
            clsChanged = await waitFor(() => snapCls() !== before, 2000, 120);
          }
          // 样式没变化时以"保存按钮可用性"兜底（部分实现不改类名）
          starOk = clsChanged || saveButtonEnabled(me);
          record("DBG", "星级操作：共 " + btns.length + " 个按钮，点第 " + (idx + 1) +
            " 个，样式变化=" + clsChanged + "，保存按钮可用=" + saveButtonEnabled(me) + "，判定=" + starOk);
        }
      }

      // ---- 评语：为空时首次留空；若保存失败，重试自动改用默认评语 ----
      const comment = CFG.comment || (evalRetries >= 1 ? CFG.commentFallback : "");
      const ta = me.querySelector("textarea");
      if (ta && comment) {
        ta.value = comment;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await sleep(400); // 给 Angular 变更检测一点时间

      // ---- 保存：星级没选上就不提交，避免被站点拒绝（"提交失败：评分还没有完成"）----
      setState("saving");
      if (!starOk) {
        record("WARN", "星级未选中（校验未通过），本轮不提交保存");
        evalRetries++;
        const m1 = pickOverlay("modal-evaluate");
        if (m1) dismissModal(m1);
        await sleep(1000);
        setState("idle");
        clearLock();
        if (evalRetries >= 3) { evalRetries = 0; doReload("星级反复无法选中"); }
        return;
      }
      const save = me.querySelector("ion-footer button");
      record("DBG", "准备保存：" + (save ? "按钮可用=" + saveButtonEnabled(me) : "未找到保存按钮！") +
        (comment ? "（含评语）" : "（评语为空）"));
      if (save) realClick(save);

      // ---- 结果判定：等待期间实时处理确认框/奖励弹窗（保存后站点常先弹确认框，
      //      干等 8 秒会误判失败、反复重评） ----
      await waitFor(() => {
        const its = $$(".course-item");
        const lst = its[its.length - 1];
        if (lst && /已评定/.test(lst.innerText || "")) return true;
        if ($$("ion-alert").length) handleAlerts();
        closeReward();
        return !isOpen(pickOverlay("modal-evaluate"));
      }, 10000, 200);

      const items = $$(".course-item");
      const last = items[items.length - 1];
      const lastDone = !!(last && /已评定/.test(last.innerText || ""));
      const modalClosed = !isOpen(pickOverlay("modal-evaluate"));
      if (lastDone || modalClosed) {
        setState("backing");
        const back = $(".show-back-button");
        if (back) realClick(back);
        stats.courses++;
        store.set("stats", stats);
        notify("✓ 课程评价完成（累计 " + stats.courses + " 课）", "ok");
        await waitFor(() => !$("course-detail-page"), 3000);
        evalRetries = 0;
      } else {
        evalRetries++;
        warn("评价未确认完成，第 " + evalRetries + " 次重试" + (starOk ? "" : "（星级可能未选中）"));
        const m = pickOverlay("modal-evaluate") || pickOverlay("ion-modal");
        if (m) dismissModal(m);
        await sleep(1000);
        if (evalRetries >= 3) {
          evalRetries = 0;
          doReload("评价流程反复失败");
          return; // 页面即将刷新或已熔断，无需复位状态
        }
      }
    } catch (e) { warn("评价流程异常: " + e.message); }
    setState("idle");
    clearLock();
  }

  // ---------- 页面处理 ----------
  async function handleCourseDetail() {
    enterTries = 0; // 已成功到达课程页，重置"进入重试"计数
    const media = playingMedia();
    if (media) { manageMedia(media); return; }

    const items = $$(".course-item");
    const isPending = (el) =>
      !el.classList.contains("learned") &&
      !el.classList.contains("exam2_top") &&
      !el.getAttribute("exepower");
    const pending = items.filter(isPending);

    // 防重播护栏（多条，5 分钟有效）：刚播完的课件若尚未被服务端标记"已学"，不再点它
    // 用前 24 字前缀匹配，容忍站点在条目文字上追加"进度:xx%"等角标
    const candidates = pending.filter((el) => !isDoneMarked(normText(el.innerText).slice(0, 24)));

    // 跳过无法识别类型的课件（如图文），继续找下一个可处理的，避免堵死列表
    const target = candidates.find((el) => /文档课件|音频|视频/.test(el.innerText || ""));

    if (target) {
      const text = normText(target.innerText);
      if (text.includes("文档课件")) return runDoc(target);
      // 音频 / 视频：短防抖 + 媒体一出现就提前放行（正常 1~3s 即接管播放）
      setState("opening");
      lastOpenClickAt = now();
      currentMediaLabel = text;
      record("DBG", "选中课件[" + (text.includes("文档课件") ? "文档" : text.includes("音频") ? "音频" : "视频") +
        "]：" + text.slice(0, 30) + "（待学 " + pending.length + " / 可处理 " + candidates.length + "）");
      lock(15000, () => !!playingMedia(), "等待播放器出现");
      target.click(); // modal 弹出动画期间有锁，tick 不会重复点击
      // 快速接管探针：播放器一出现就立刻接管挂监听（不等下一次轮询）
      [250, 700, 1500, 3000, 6000].forEach((d) => setTimeout(() => {
        try {
          if (!inState("opening")) return;
          const m = playingMedia();
          if (m && !finishedMedia.has(m)) { clearLock(); manageMedia(m); }
        } catch (e) { /* 探针失败由正常轮询兜底 */ }
      }, d));
      return;
    }

    if (!candidates.length && pending.length) {
      // 只剩"刚完成但还没被标已学"的课件：等状态刷新，避免整节重播。
      // 若等太久（90s）说明服务端标记卡住，刷新页面强制同步（走熔断保护）。
      if (!waitLearnedSince) waitLearnedSince = now();
      noteOnce("wait-learned", "等待服务端更新完成状态（" +
        Math.round((now() - waitLearnedSince) / 1000) + "s）");
      setStatus("等待课时状态刷新…", Math.round((now() - waitLearnedSince) / 1000) + "s");
      if (now() - waitLearnedSince > 90000) {
        waitLearnedSince = 0;
        doReload("等待服务端更新完成状态超时（90s）");
      }
      return;
    }
    waitLearnedSince = 0;
    if (candidates.length) {
      const first = candidates[0];
      noteOnce("unknown-" + normText(first.innerText).slice(0, 24),
        "存在无法识别的课件：" + normText(first.innerText).slice(0, 40));
      setStatus("存在无法识别的课件", normText(first.innerText).slice(0, 24));
      return;
    }

    // 全部课件已学：先看是否已评定（避免重复提交评价），再决定评价或返回
    const lastItem = items[items.length - 1];
    if (lastItem && /已评定/.test(lastItem.innerText || "")) {
      record("INFO", "课程已完成（已评定），返回学习页");
      const back = $(".show-back-button");
      if (back) back.click();
      await waitFor(() => !$("course-detail-page"), 3000);
      return;
    }
    const isEvalItem = !!(lastItem &&
      (lastItem.classList.contains("exam2_top") || /评价/.test(lastItem.innerText || "")));
    if (!isEvalItem) {
      record("INFO", "课件已全部完成且无需评价，返回学习页");
      const back = $(".show-back-button");
      if (back) back.click();
      else goBackFromCourse();
      await waitFor(() => !$("course-detail-page"), 3000);
      return;
    }
    return runEvaluate(lastItem);
  }

  async function handleLearnPage() {
    const seg = $("#nav > page-learn ion-card > exe-segment");
    if (!seg || !seg.innerHTML.includes("在学课程")) {
      setStatus("学习页就绪", "无在学课程分区");
      return;
    }
    const list =
      $("#nav > page-learn > ion-content > div.scroll-content > ion-card > exe-content:nth-child(2) > ion-list") ||
      $$("page-learn ion-list").find((l) => l.querySelector("exe-learn-card"));
    const cards = list ? $$("exe-learn-card", list) : [];
    if (cards.length) {
      setState("entering");
      enterTries++;
      record("DBG", "点击学习卡片（第 " + enterTries + " 次尝试）：进入课程：" +
        normText(cards[0].innerText).slice(0, 24));
      if (enterTries >= 4) {
        enterTries = 0;
        doReload("点击学习卡片后课程页始终未出现（已尝试 4 次）");
        return;
      }
      // 课程页出现且课件列表渲染完成才放行（避免误判旧视图/空列表）
      lock(10000, () => {
        const p = $("course-detail-page");
        return !!p && !!p.querySelector(".course-item");
      }, "等待课程页加载");
      cards[0].click();
    } else {
      noteOnce("no-cards", "学习页没有可进入的在学课程");
      setStatus("没有在学课程", "学习页待命");
    }
  }

  // 不在学习页/课程页时，自动点击底部"学习"标签导航过去
  function gotoLearnTab() {
    // 优先在底部标签栏/侧边菜单范围内找"学习"入口
    const scoped = $$("ion-tabbar button, .tabbar button, ion-tabs button, exe-menus button")
      .find((b) => (b.textContent || "").replace(/\s+/g, "").includes("学习"));
    let btn = scoped || undefined;
    if (!btn) {
      // 兜底：屏幕下方 40% 区域内文本恰为"学习"的按钮（避开正文里的同名链接）
      btn = $$("button").find((b) => {
        if ((b.textContent || "").replace(/\s+/g, "") !== "学习") return false;
        const r = b.getBoundingClientRect();
        return r.top > window.innerHeight * 0.6;
      });
    }
    if (btn) {
      btn.click();
      touch();
      setStatus("正在打开学习页…", "");
      return true;
    }
    return false;
  }

  // ---------- 卡死检测 ----------
  function stuckCheck() {
    if (inState("opening") && stateAge() > CFG.stuckOpenSec) {
      warn("打开课件超时（" + CFG.stuckOpenSec + "s 未出现播放器）");
      const m = overlays()[0];
      if (m) dismissModal(m);
      setState("idle");
      // 反复打不开：自愈刷新（走熔断保护），避免在同一条目上空转
      if (++openTries >= 3) {
        openTries = 0;
        doReload("课件反复打不开（已尝试 3 次）");
      }
    }
    if (inState("entering") && stateAge() > 25) setState("idle");
    // 非播放、非空闲状态超 5 分钟无变化：多步流程的 async 已有自身出口，这里是最后兜底
    if (!inState("playing", "idle") && stateAge() > 300) doReload("流程卡死于 " + state);
    // 全局：运行中长时间没有任何进展（含停在登录页/未知页面）
    if (running && now() - lastActivity > CFG.noProgressMin * 60 * 1000) {
      doReload("超过 " + CFG.noProgressMin + " 分钟无进展");
    }
  }

  // ---------- 择机维护刷新（内存/时长） ----------
  function maybeMaintenanceReload() {
    if (!running) return;
    if (!CFG.reloadAfterHours && !CFG.heapLimitMB) return;
    const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0;
    const memHit = CFG.heapLimitMB && mem > CFG.heapLimitMB;
    const timeHit = CFG.reloadAfterHours && now() - bootAt > CFG.reloadAfterHours * 3600000;
    if (!memHit && !timeHit) return;
    // 内存严重超标：随时刷新（进度服务端有记录，刷新后自动续跑）
    if (memHit && mem > CFG.heapLimitMB * 1.5) return doReload("内存严重超标 " + Math.round(mem) + "MB");
    // 一般情况：等到安全空档（学习页空闲、无弹窗动作）再刷新
    if (inState("idle") && $("page-learn")) {
      doReload(memHit ? "内存 " + Math.round(mem) + "MB 超限" : "定期重置释放内存");
    }
  }

  // ---------- 状态快照（每 20 秒一条，覆盖所有分支含播放期） ----------
  function snapshotLog() {
    if (now() - lastBeat <= 20000) return;
    lastBeat = now();
    try {
      const pageDesc = $("course-detail-page") ? "课程页" : $("page-learn") ? "学习页"
        : "其它页(" + (document.title || "?").slice(0, 12) + ")";
      const pendN = $$(".course-item").filter((el) =>
        !el.classList.contains("learned") && !el.classList.contains("exam2_top") &&
        !el.getAttribute("exepower")).length;
      let lockDesc = "无";
      if (busyUntil > now()) {
        lockDesc = "还剩" + ((busyUntil - now()) / 1000).toFixed(1) + "s:" + busyTag +
          (busyCheck ? (safeCond() ? "(条件已满足)" : "(条件未满足)") : "");
      }
      let mediaDesc = "无";
      const m = playingMedia();
      if (m) mediaDesc = fmtClock(m.currentTime) + "/" + fmtClock(m.duration) + (m.paused ? "(暂停)" : "");
      record("DBG", "📊 state=" + state + " 页面=" + pageDesc + " 弹窗=" + overlays().length +
        " 待学课件=" + pendN + " 媒体=" + mediaDesc + " 锁=" + lockDesc + " 已刷=" + stats.items + "节");
    } catch (e) { /* 快照失败不影响主流程 */ }
  }

  // ---------- 主循环 ----------
  async function tick() {
    if (ticking) return;
    ticking = true;
    const tickT0 = now();
    // 停顿检测：两次 tick 的间隔异常大 = 页面被后台冻结/强节流（报告里可直接确认）
    const gap = now() - lastTickAt;
    lastTickAt = now();
    if (gap > 30000 && running) {
      record("WARN", "引擎停顿 " + (gap / 1000).toFixed(0) + "s（页面在后台被 Chrome 冻结/节流，已恢复）");
      setStatus("已从停顿恢复", "停顿 " + (gap / 1000).toFixed(0) + "s（后台冻结）");
    }
    let chainRan = false; // 本拍是否走了多步流程（链内耗时是正常等待，不算卡顿）
    try {
      ensureUI();
      if (!running || inState("halt")) return;
      if (now() < busyUntil) {
        // 条件早释放：预期结果已出现就立即放行，不等满锁时长
        if (!safeCond()) {
          snapshotLog(); // 锁等待期间也要有周期快照（能看到"条件未满足"持续多久）
          stuckCheck(); // 上锁等待期间同样要能发现超时卡死
          return;
        }
        record("DBG", "锁提前放行（等待 " + ((now() - busySetAt) / 1000).toFixed(1) + "s）：" + busyTag);
      } else if (busyUntil) {
        record("DBG", "锁到期放行（等待 " + ((now() - busySetAt) / 1000).toFixed(1) + "s）：" + busyTag);
      }
      clearLock();
      snapshotLog(); // 正常路径快照（含播放中）

      // 1. 系统确认框优先处理
      if (handleAlerts()) return;

      // 1.5 奖励弹窗（通过课程后弹出，任何状态都可能出现）
      if (closeReward()) return;

      // 2. 维护刷新（须在"播放观察"提前 return 之前检查，
      //    否则严重内存超限时永远轮不到）
      maybeMaintenanceReload();

      // 3. 播放中的媒体：观察 + 治理外来弹窗
      if (inState("playing")) {
        const media = playingMedia();
        if (media) {
          manageMedia(media);
          handleForeignOverlays(media); // 播放期间出现的奖励/确认/残留弹窗在这里关
          return;
        }
        setState("idle"); // 媒体消失（被手动关掉等），回到正常调度
      }

      // 4. 弹窗治理
      if (modalGarbageCollect()) return;

      // 5. 页面分发
      if ($("course-detail-page")) {
        otherPageSince = 0;
        chainRan = true;
        await handleCourseDetail();
      } else if ($("page-learn")) {
        otherPageSince = 0;
        chainRan = true;
        await handleLearnPage();
      } else {
        if (!otherPageSince) otherPageSince = now();
        // 首页/登录页/其它：先自动切到底部"学习"标签，切不过去再提示
        if (gotoLearnTab()) {
          lock(5000, () => !!$("page-learn"), "等待学习页[" + (document.title || "?").slice(0, 12) + "]");
          return;
        }
        const maybeLogin = /login|登录/i.test(document.title || "") || $("page-login");
        noteOnce("other-page", "不在学习页/课程页（" + document.title + "）");
        setStatus(maybeLogin ? "请重新登录" : "非学习页面",
          maybeLogin ? "登录后脚本自动继续" : "未找到学习页入口");
        // 空转自愈：长时间停在既非学习页也非课程页的地方（v3.6 会在这里静默卡住）
        const stuckSec = Math.round((now() - otherPageSince) / 1000);
        if (!maybeLogin) {
          if (stuckSec > 60) {
            noteOnce("other-page-stuck", "已 " + stuckSec + "s 不在学习页/课程页，持续将自愈刷新");
          }
          if (stuckSec > 180) {
            otherPageSince = 0;
            doReload("长时间不在学习页/课程页（" + (document.title || "未知页面") + "）");
            return;
          }
        }
      }

      // 6. 各类看门狗
      stuckCheck();

      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      warn("tick 异常(" + consecutiveErrors + "): " + (e && e.message));
      if (consecutiveErrors >= 10) doReload("连续异常");
    } finally {
      ticking = false;
      const dt = now() - tickT0;
      if (dt > 800 && !chainRan && now() - lastSlowWarnAt > 30000) {
        lastSlowWarnAt = now();
        record("WARN", "tick 处理耗时 " + dt + "ms（页面卡顿或 DOM 异常庞大）");
      }
    }
  }

  // 自调度循环（避免 setInterval 重叠；catch 兜底保证循环永不中断）
  function loop() {
    tick()
      .catch(() => {})
      .finally(() => setTimeout(loop, CFG.interval));
  }

  // ---------- 设置抽屉（动态配置，即时生效） ----------
  // 字段清单：key / 标签 / 说明 / 控件类型 / 选项
  const SETTING_FIELDS = [
    { sec: "评价" },
    { key: "stars", type: "number", min: 1, max: 5, step: 1, label: "评分星级", tip: "1~5 星" },
    { key: "comment", type: "text", label: "评价评语", tip: "留空=不填评语" },
    { key: "commentFallback", type: "text", label: "重试评语", tip: "首次保存失败后重试时使用" },
    { sec: "播放" },
    { key: "playbackRate", type: "number", min: 0, max: 16, step: 1, label: "强制倍速", tip: "0=不干预（用播放器自己的设置）" },
    { key: "muted", type: "switch", label: "自动静音", tip: "关闭会有声音" },
    { key: "pipFallback", type: "switch", label: "画中画兜底", tip: "后台停滞时进画中画小窗" },
    { sec: "自动化" },
    { key: "alertPolicy", type: "select", label: "确认框处理", tip: "系统弹窗点哪个按钮",
      options: [["last", "点最后一个（确定类）"], ["cancel", "点取消类"], ["", "不处理（手动）"]] },
    { key: "antiThrottle", type: "switch", label: "后台防节流", tip: "静音音频防止定时器被冻结" },
    { sec: "阈值（进阶）" },
    { key: "stallResumeSec", type: "number", min: 10, max: 120, step: 5, label: "停滞续播", tip: "秒，进度停多久自动拉起" },
    { key: "stuckPlayingSec", type: "number", min: 60, max: 600, step: 30, label: "播放卡死判定", tip: "秒，超过则尝试恢复/刷新" },
    { key: "stuckOpenSec", type: "number", min: 20, max: 120, step: 5, label: "打开课件超时", tip: "秒" },
    { key: "noProgressMin", type: "number", min: 5, max: 60, step: 1, label: "整体无进展自愈", tip: "分钟，超过则刷新重进" },
    { key: "reloadAfterHours", type: "number", min: 0, max: 24, step: 1, label: "定期重置", tip: "小时，0=关闭" },
    { key: "heapLimitMB", type: "number", min: 500, max: 8000, step: 250, label: "内存上限", tip: "MB，超过则择机刷新" },
    { sec: "调试" },
    { key: "debug", type: "switch", label: "控制台实时输出", tip: "日志抽屉始终全量记录" },
  ];

  function ensureSettings() {
    if (document.getElementById("zk-settings")) return;
    ensureStyles();
    const box = document.createElement("div");
    box.id = "zk-settings";
    let html = '<div class="zk-dh"><span>⚙ 设置</span><span class="zk-grow"></span>' +
      '<button class="zk-mini" id="zk-set-close">关闭</button></div><div class="zk-body">';
    for (const f of SETTING_FIELDS) {
      if (f.sec) { html += '<div class="zk-sec">' + f.sec + "</div>"; continue; }
      html += '<div class="zk-row" data-key="' + f.key + '"><div class="zk-lab">' + f.label +
        (f.tip ? "<small>" + f.tip + "</small>" : "") + "</div>";
      if (f.type === "switch") {
        html += '<button class="zk-switch' + (CFG[f.key] ? " on" : "") + '"></button>';
      } else if (f.type === "select") {
        html += "<select>" + f.options.map(([v, t]) =>
          '<option value="' + v + '"' + (String(CFG[f.key]) === v ? " selected" : "") + ">" + t + "</option>").join("") + "</select>";
      } else if (f.type === "number") {
        html += '<input type="number" value="' + CFG[f.key] + '"' +
          (f.min !== undefined ? " min=" + f.min : "") + (f.max !== undefined ? " max=" + f.max : "") +
          (f.step !== undefined ? " step=" + f.step : "") + ">";
      } else {
        html += '<input type="text" value="' + esc(CFG[f.key] || "") + '">';
      }
      html += "</div>";
    }
    html += '<div class="zk-note">所有修改即时生效并自动保存（刷新后仍有效）。' +
      "强制倍速会覆盖播放器自身设置，过高倍速有被平台判定异常的风险，请自行评估。</div></div>";
    box.innerHTML = html;
    document.body.appendChild(box);

    // 事件绑定：任何改动 → 写 CFG → 持久化 → 记日志
    const commit = (key, val) => {
      const old = CFG[key];
      if (old === val) return;
      CFG[key] = val;
      saveUserConfig();
      record("INFO", "配置修改 " + key + ": " + JSON.stringify(old) + " → " + JSON.stringify(val));
    };
    for (const f of SETTING_FIELDS) {
      if (f.sec) continue;
      const row = box.querySelector('.zk-row[data-key="' + f.key + '"]');
      if (!row) continue;
      if (f.type === "switch") {
        const sw = row.querySelector(".zk-switch");
        sw.onclick = () => {
          const on = sw.classList.toggle("on");
          commit(f.key, on);
        };
      } else if (f.type === "select") {
        const sel = row.querySelector("select");
        sel.onchange = () => commit(f.key, sel.value);
      } else {
        const inp = row.querySelector("input");
        inp.onchange = () => {
          if (f.type === "number") {
            let v = parseFloat(inp.value);
            if (!isFinite(v)) { inp.value = CFG[f.key]; return; }
            if (f.min !== undefined) v = Math.max(f.min, v);
            if (f.max !== undefined) v = Math.min(f.max, v);
            inp.value = v;
            commit(f.key, v);
          } else {
            commit(f.key, inp.value);
          }
        };
      }
    }
    box.querySelector("#zk-set-close").onclick = () => box.classList.remove("open");
  }

  function toggleSettings() {
    ensureSettings();
    document.getElementById("zk-settings").classList.toggle("open");
  }

  function ensureUI() {
    try {
      ensureStyles();
      ensurePanel();
      ensureDrawer();
      ensureSettings();
    } catch (e) { console.error("[职行力] UI初始化异常", e); }
  }

  // ---------- 启动 ----------
  // 页面自身的脚本报错：只进日志不弹横幅（网站本身就有大量自身错误，弹了全是噪音）；
  // 油猴脚本的报错：进日志 + 弹横幅
  window.addEventListener("error", (e) => {
    const fromUs = /user\.js|userscript|tampermonkey/i.test(e.filename || "");
    const src = e.filename ? " @" + String(e.filename).split("/").pop() + ":" + (e.lineno || 0) : "";
    record(fromUs ? "ERROR" : "PAGE", String(e.message || "unknown").slice(0, 200) + src);
    if (fromUs) notify("脚本异常: " + String(e.message || "").slice(0, 60), "error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    record("PAGE", "Promise: " + String((r && r.message) || r || "").slice(0, 200));
  });
  document.addEventListener("visibilitychange", () => {
    tryResumeAudio();
    if (document.hidden) flushLogs(); // 页面隐藏时立即落盘，防刷新丢日志
    else tick(); // 切回前台立即补一拍
  });
  window.addEventListener("focus", () => tick());
  window.addEventListener("pageshow", () => tick());
  window.addEventListener("pagehide", flushLogs);
  window.addEventListener("beforeunload", flushLogs);
  document.addEventListener("click", () => { tryResumeAudio(); tick(); });

  ensureUI();
  applyUserConfig();       // 用户保存的配置覆盖默认值（store 已就绪，早于首个 tick）
  refreshStatus();         // 应用配置后刷新一次面板显示
  const workerDriver = startWorkerDriver(); // Worker 后台驱动：主线程定时器被冻结时仍尽量推进
  record("INFO", "引擎启动 v" + VERSION + "（后台驱动：" + (workerDriver ? "已启用" : "不可用") + "）");
  const reason = store.get("reloadReason", "");
  if (reason) {
    store.del("reloadReason");
    if (running) {
      setStatus("已自动刷新续跑", "原因: " + reason);
      notify("已自动刷新续跑，原因：" + reason, "warn");
    }
  }
  if (running) { startAntiThrottle(); startSilentAudio(); }
  installVisibilitySpoof();
  setTimeout(loop, 1000);
})();
