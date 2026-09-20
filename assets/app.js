/* Jev 纸面交易台 —— 前端
 *
 * 职责划分（重要）：
 *   服务端 /api/tick 只负责「这一步 Jev 说什么」，不保存任何账户状态
 *   （Serverless 是短暂的，写内存会丢）。
 *   账户、持仓、成交、盈亏、决策历史全部存在浏览器 localStorage —— 前端才是权威账本。
 *
 * 节拍：每 5 秒一次。Jev 实测限流 30 次/60 秒，服务端按拍去重后恒定 12 次/分钟。
 */

const SYMBOLS = ["BTC", "ETH"];
const TICK_MS = 5000;
const FEE = 0.001;                 // 纸面交易的手续费假设，0.1%
const LS_KEY = "jev-paper-trader.v1";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 账户

function freshAccount() {
  return {
    initCash: 10000,
    cash: 10000,
    positions: {},                 // { BTC: {qty, avgPrice} }
    realized: 0,
    fees: 0,
    lastActionAt: {},              // 每个标的上次成交时间，用于冷却
    decisions: [],                 // 决策历史
    points: [],                    // 价格序列（画图用）
    createdAt: Date.now(),
  };
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return freshAccount();
    const a = JSON.parse(raw);
    if (!a || typeof a.cash !== "number") return freshAccount();
    a.positions = a.positions || {};
    a.decisions = a.decisions || [];
    a.points = a.points || [];
    a.lastActionAt = a.lastActionAt || {};
    return a;
  } catch (_) {
    return freshAccount();
  }
}

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(acct)); } catch (_) { /* 隐私模式下会失败，忽略 */ }
}

let acct = load();

// ---------------------------------------------------------------- 设置

const cfg = {
  running: false,
  threshold: 0.55,
  cooldownSec: 60,
  allocPct: 50,
  riskGate: true,
};

// ---------------------------------------------------------------- 交易执行

function equityAt(prices) {
  let v = acct.cash;
  for (const s of SYMBOLS) {
    const p = acct.positions[s];
    if (p && prices[s]) v += p.qty * prices[s];
  }
  return v;
}

function priceOf(s, snapshot) {
  return snapshot && snapshot.symbols && snapshot.symbols[s] ? snapshot.symbols[s].price : null;
}

/**
 * 把 Jev 的信号变成实际动作。
 * 返回 {action, note} —— action 是 hold 时 note 说明为什么没动。
 */
function decide(s, dec, price, riskProb) {
  if (!dec) return { action: "hold", note: "Jev 没返回这个标的" };

  const signal = dec.action || "hold";
  const prob = (dec.probabilities && dec.probabilities[signal]) || 0;

  // 1) 风控闸门
  if (cfg.riskGate && riskProb != null && riskProb >= 0.5 && signal === "buy") {
    return { action: "hold", note: `风控拦截（风险概率 ${riskProb.toFixed(2)} ≥ 0.5）`, signal, prob };
  }
  // 2) 信号本身是 hold
  if (signal === "hold") {
    return { action: "hold", note: `信号 hold（${prob.toFixed(2)}）`, signal, prob };
  }
  // 3) 阈值
  if (prob < cfg.threshold) {
    return { action: "hold", note: `${signal} 概率 ${prob.toFixed(2)} < 阈值 ${cfg.threshold.toFixed(2)}`, signal, prob };
  }
  // 4) 冷却
  const last = acct.lastActionAt[s] || 0;
  const gap = (Date.now() - last) / 1000;
  if (cfg.cooldownSec > 0 && gap < cfg.cooldownSec) {
    return { action: "hold", note: `冷却中（${gap.toFixed(0)}s / ${cfg.cooldownSec}s）`, signal, prob };
  }
  // 5) 动作可行性
  if (signal === "buy") {
    if (acct.positions[s]) return { action: "hold", note: "已持仓，不重复买入", signal, prob };
    if (acct.cash <= 1) return { action: "hold", note: "没有可用现金", signal, prob };
  }
  if (signal === "sell") {
    if (!acct.positions[s]) return { action: "hold", note: "空仓，无可卖", signal, prob };
  }
  return { action: signal, note: "", signal, prob };
}

function execute(s, action, price) {
  if (action === "buy") {
    const amount = acct.cash * (cfg.allocPct / 100);
    if (amount <= 1) return "现金不足";
    const fee = amount * FEE;
    const qty = (amount - fee) / price;
    acct.cash -= amount;
    acct.fees += fee;
    acct.positions[s] = { qty, avgPrice: price };
    acct.lastActionAt[s] = Date.now();
    return `买入 ${qty.toFixed(6)} @ ${price.toFixed(2)}（投入 ${amount.toFixed(2)}）`;
  }
  if (action === "sell") {
    const p = acct.positions[s];
    if (!p) return "空仓";
    const gross = p.qty * price;
    const fee = gross * FEE;
    acct.cash += gross - fee;
    acct.fees += fee;
    acct.realized += (price - p.avgPrice) * p.qty - fee;
    delete acct.positions[s];
    acct.lastActionAt[s] = Date.now();
    const pnlPct = ((price - p.avgPrice) / p.avgPrice) * 100;
    return `卖出 ${p.qty.toFixed(6)} @ ${price.toFixed(2)}（${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%）`;
  }
  return "";
}

// ---------------------------------------------------------------- 主循环

let timer = null;
let nextAt = 0;
let lastMeta = null;

function posParam() {
  return SYMBOLS
    .map((s) => {
      const p = acct.positions[s];
      return p ? `${s}:${p.qty}:${p.avgPrice}` : `${s}:0:0`;
    })
    .join(",");
}

async function tick() {
  let data;
  try {
    const res = await fetch("/api/tick?pos=" + encodeURIComponent(posParam()), { cache: "no-store" });
    data = await res.json();
    if (res.status === 429) data.throttled = true;
  } catch (e) {
    setStatus("err", "网络错误");
    $("metaLine").textContent = String(e && e.message || e) + "（下一拍自动重试）";
    schedule(TICK_MS);          // 同样不能让循环断掉
    return;
  }

  if (!data.ok) {
    // 出错也要保住循环——早期版本在这里直接 return，异常一次循环就死了。
    // 同时把这一拍的价格记下来，图不要断。
    if (data.snapshot && data.snapshot.symbols) {
      const p = {};
      for (const s of SYMBOLS) p[s] = priceOf(s, data.snapshot);
      if (p.BTC || p.ETH) {
        acct.points.push({ ts: data.ts || Date.now(), BTC: p.BTC, ETH: p.ETH });
        if (acct.points.length > 1200) acct.points.shift();
      }
      render(data);
    }
    if (data.throttled) {
      const rl = data.rateLimit || {};
      setStatus("err", "被限流，退避中");
      $("metaLine").textContent =
        `Jev 限流：上限 ${rl.limitRequests ?? "?"} 次 / ${rl.resetRequests ?? "?"}，`
        + `剩余 ${rl.remainingRequests ?? "?"}，Retry-After ${rl.retryAfter ?? "?"}s`;
      // 按服务端给的 Retry-After 退避，最多 30 秒
      schedule(Math.min((data.rateLimit && data.rateLimit.retryAfter) || 15, 30) * 1000);
    } else {
      setStatus("err", "决策失败，价格仍在更新");
      $("metaLine").textContent = (data.error || "未知错误") + "（下一拍自动重试）";
      schedule(TICK_MS);
    }
    return;
  }

  const snapshot = data.snapshot || {};
  const prices = {};
  for (const s of SYMBOLS) prices[s] = priceOf(s, snapshot);

  // 记录价格点（画图用）
  if (prices.BTC || prices.ETH) {
    acct.points.push({ ts: data.ts, BTC: prices.BTC, ETH: prices.ETH });
    if (acct.points.length > 1200) acct.points.shift();
  }

  const riskProb = data.risk ? data.risk.probability : null;

  for (const s of SYMBOLS) {
    const price = prices[s];
    if (!price) continue;
    const dec = (data.decisions || {})[s];
    const d = decide(s, dec, price, riskProb);
    let tradeMsg = "";
    if (d.action === "buy" || d.action === "sell") {
      tradeMsg = execute(s, d.action, price);
    }
    acct.decisions.unshift({
      ts: data.ts,
      symbol: s,
      signal: d.signal || (dec && dec.action) || "hold",
      prob: d.prob || 0,
      conf: dec ? dec.confidence : null,
      price,
      action: d.action,
      note: d.note || tradeMsg || "—",
    });
  }
  if (acct.decisions.length > 500) acct.decisions.length = 500;

  lastMeta = data.meta || null;
  save();
  render(data);
  setStatus("on", "运行中");

  const m = data.meta || {};
  $("metaLine").textContent =
    `数据源 ${data.source} · Jev 延迟 ${m.latencyMs ?? "?"}ms · `
    + `本次扣费 $${m.cost == null ? "?" : m.cost}`
    + (m.marketCost ? `（列表价 $${m.marketCost}）` : "")
    + (data.cached ? " · 命中按拍缓存" : "");

  schedule(TICK_MS);
}

function schedule(ms) {
  nextAt = Date.now() + ms;
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
}

function setStatus(kind, text) {
  $("dot").className = "dot " + kind;
  $("statusText").textContent = text;
}

// ---------------------------------------------------------------- 渲染

function fmt(n, d = 2) {
  return n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtSigned(n, d = 2) {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(d);
}
function cls(n) { return n > 0 ? "up" : n < 0 ? "down" : "flat"; }

function render(data) {
  const snapshot = (data && data.snapshot) || {};
  const decisions = (data && data.decisions) || {};
  const prices = {};
  for (const s of SYMBOLS) prices[s] = priceOf(s, snapshot);

  // ---- 账户
  const eq = equityAt(prices);
  const ret = ((eq - acct.initCash) / acct.initCash) * 100;
  $("initCash").textContent = fmt(acct.initCash);
  $("cash").textContent = fmt(acct.cash);
  let pv = 0;
  for (const s of SYMBOLS) { const p = acct.positions[s]; if (p && prices[s]) pv += p.qty * prices[s]; }
  $("posVal").textContent = fmt(pv);
  $("equity").textContent = fmt(eq);
  $("realized").textContent = fmtSigned(acct.realized);
  $("realized").className = cls(acct.realized);
  $("ret").textContent = fmtSigned(ret) + "%";
  $("ret").className = "big " + cls(ret);

  // ---- 行情卡片
  const box = $("market");
  box.innerHTML = "";
  for (const s of SYMBOLS) {
    const q = snapshot.symbols && snapshot.symbols[s];
    const dec = decisions[s];
    const pos = acct.positions[s];
    const card = document.createElement("div");
    card.className = "card";

    // 没有信号时不要伪装成 hold——那样看起来像「Jev 说不动」，其实是没拿到结果
    const hasSignal = !!(dec && dec.action);
    const signal = hasSignal ? dec.action : "hold";
    const probs = (dec && dec.probabilities) || {};
    const conf = dec ? dec.confidence : null;
    const actLabel = hasSignal ? signal.toUpperCase() : "无信号";

    let posHtml;
    if (pos && prices[s]) {
      const pnl = ((prices[s] - pos.avgPrice) / pos.avgPrice) * 100;
      posHtml = `持仓 ${pos.qty.toFixed(6)} · 成本 ${fmt(pos.avgPrice)} · `
        + `<b class="${cls(pnl)}">浮动 ${fmtSigned(pnl)}%</b>`;
    } else {
      posHtml = '<span class="none">空仓</span>';
    }

    const bars = ["buy", "sell", "hold"].map((k) => {
      const v = probs[k] == null ? 0 : probs[k];
      return `<div class="bar-row">
        <span class="lb">${k}</span>
        <span class="track"><span class="fill ${k}" style="width:${(v * 100).toFixed(1)}%"></span></span>
        <span class="vl">${(v * 100).toFixed(0)}%</span>
      </div>`;
    }).join("");

    card.innerHTML = `
      <div class="card-head">
        <span class="sym">${s}</span>
        <span>
          <span class="px">${q ? fmt(q.price) : "—"}</span>
          <span class="chg ${cls(q ? q.change24h : null)}">${q ? fmtSigned(q.change24h) + "%" : ""} <span class="hint">24h</span></span>
        </span>
      </div>
      <div class="sig">
        <span class="act ${hasSignal ? signal : ""}">${actLabel}</span>
        <span class="conf">confidence ${conf == null ? "—" : conf.toFixed(2)}</span>
      </div>
      <div class="bars">${bars}</div>
      <div class="pos">${posHtml}
        <div class="hint">${['1h','5m','1m'].map((lbl, i) => {
          const v = i===0 ? q.change1h : i===1 ? q.change5m : q.change1m;
          return `${lbl} ${v == null ? "—" : fmtSigned(v) + "%"}`;
        }).join(' · ')}</div>
      </div>`;
    box.appendChild(card);
  }

  // ---- Jev 看到的状态
  if (data && data.stateEcho) $("stateEcho").textContent = data.stateEcho;

  // ---- 决策历史
  const tb = document.querySelector("#hist tbody");
  tb.innerHTML = acct.decisions.slice(0, 200).map((d) => {
    const t = new Date(d.ts).toLocaleTimeString("zh-CN", { hour12: false });
    const tagCls = d.action === "buy" ? "buy" : d.action === "sell" ? "sell" : "hold";
    const label = d.action === "buy" ? "买入" : d.action === "sell" ? "卖出" : "不动";
    return `<tr>
      <td>${t}</td>
      <td>${d.symbol}</td>
      <td>${d.signal}</td>
      <td>${(d.prob * 100).toFixed(0)}%</td>
      <td>${d.conf == null ? "—" : d.conf.toFixed(2)}</td>
      <td>${fmt(d.price)}</td>
      <td><span class="tag ${tagCls}">${label}</span></td>
      <td class="note">${escapeHtml(d.note)}</td>
    </tr>`;
  }).join("");
  $("histCount").textContent = `共 ${acct.decisions.length} 条（显示最近 200）`;

  drawChart();
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- 图表

function drawChart() {
  const cv = $("chart");
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 900;
  const h = 260;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const pts = acct.points.filter((p) => p.BTC && p.ETH);
  if (pts.length < 2) {
    g.fillStyle = "#64748b";
    g.font = "12px sans-serif";
    g.fillText("采集中…需要至少两个价格点", 12, h / 2);
    return;
  }

  // 两个标的价位差太大，画成「相对首点的涨跌幅 %」才能同图比较
  const base0 = { BTC: pts[0].BTC, ETH: pts[0].ETH };
  const series = {
    BTC: pts.map((p) => ((p.BTC - base0.BTC) / base0.BTC) * 100),
    ETH: pts.map((p) => ((p.ETH - base0.ETH) / base0.ETH) * 100),
  };

  let lo = Infinity, hi = -Infinity;
  for (const s of SYMBOLS) for (const v of series[s]) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo) || !isFinite(hi)) return;
  if (hi - lo < 0.4) { const m = (hi + lo) / 2; lo = m - 0.2; hi = m + 0.2; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;

  const L = 44, R = 10, T = 10, B = 22;
  const X = (i) => L + (i / (pts.length - 1)) * (w - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);

  // 网格 + Y 轴
  g.strokeStyle = "#243044"; g.lineWidth = 1;
  g.fillStyle = "#64748b"; g.font = "10px sans-serif";
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    const y = Y(v);
    g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke();
    g.fillText(v.toFixed(2) + "%", 4, y + 3);
  }

  // 0 轴
  if (lo < 0 && hi > 0) {
    g.strokeStyle = "#334155"; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(w - R, Y(0)); g.stroke();
    g.setLineDash([]);
  }

  const colors = { BTC: "#60a5fa", ETH: "#a78bfa" };
  for (const s of SYMBOLS) {
    g.strokeStyle = colors[s]; g.lineWidth = 1.6;
    g.beginPath();
    series[s].forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
    g.stroke();
  }

  // 买卖点标记：按时间戳定位到索引
  const idxByTs = new Map();
  pts.forEach((p, i) => idxByTs.set(p.ts, i));
  const marks = acct.decisions.filter((d) => d.action !== "hold");
  let drawn = 0;
  for (const d of marks) {
    if (drawn > 120) break;
    let best = null, bestGap = Infinity;
    for (const [ts, i] of idxByTs) {
      const gap = Math.abs(ts - d.ts);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    if (best == null || bestGap > 15000) continue;
    const x = X(best);
    const v = ((d.price - base0[d.symbol]) / base0[d.symbol]) * 100;
    const y = Y(v);
    g.fillStyle = d.action === "buy" ? "#22c55e" : "#ef4444";
    g.beginPath();
    if (d.action === "buy") { g.moveTo(x, y - 7); g.lineTo(x - 5, y + 3); g.lineTo(x + 5, y + 3); }
    else { g.moveTo(x, y + 7); g.lineTo(x - 5, y - 3); g.lineTo(x + 5, y - 3); }
    g.closePath(); g.fill();
    drawn++;
  }

  // 图例
  g.font = "10px sans-serif";
  g.fillStyle = colors.BTC; g.fillText("BTC", L + 2, T + 10);
  g.fillStyle = colors.ETH; g.fillText("ETH", L + 34, T + 10);
  g.fillStyle = "#64748b";
  g.fillText("▲ 买入   ▼ 卖出（相对首点的涨跌幅 %）", L + 66, T + 10);

  $("chartNote").textContent = `${pts.length} 个价格点 · ${marks.length} 次成交`;
}

// ---------------------------------------------------------------- 控件

function bindControls() {
  $("toggle").addEventListener("click", () => {
    cfg.running = !cfg.running;
    $("toggle").textContent = cfg.running ? "暂停" : "启动";
    if (cfg.running) { setStatus("on", "运行中"); tick(); }
    else { clearTimeout(timer); setStatus("off", "已暂停"); $("countdown").textContent = "—"; }
  });

  $("reset").addEventListener("click", () => {
    if (!confirm("清空账户与全部决策历史？不可恢复。")) return;
    acct = freshAccount();
    save();
    render({ snapshot: { symbols: {} }, decisions: {} });
    $("stateEcho").textContent = "（已清空，重新启动后显示）";
    $("metaLine").textContent = "—";
  });

  const bind = (id, key, fmtFn, scale) => {
    const el = $(id);
    const out = $(id + "Val");
    // 缺一个控件不该把整个启动流程拖死——曾经因为 id 对不上（cdVal vs cooldownVal）
    // 抛异常，导致后面 render 和 criteria 加载全都没执行。
    if (!el || !out) { console.warn("控件缺失，跳过：" + id + " / " + id + "Val"); return; }
    const sync = () => { cfg[key] = scale(el.value); out.textContent = fmtFn(el.value); };
    el.addEventListener("input", sync);
    sync();
  };
  bind("thr", "threshold", (v) => Number(v).toFixed(2), Number);
  bind("cooldown", "cooldownSec", (v) => v + "s", Number);
  bind("alloc", "allocPct", (v) => v + "%", Number);
  $("riskGate").addEventListener("change", (e) => { cfg.riskGate = e.target.checked; });
}

// ---------------------------------------------------------------- 启动

bindControls();
render({ snapshot: { symbols: {} }, decisions: {} });
setStatus("off", "未启动");

// 倒计时
setInterval(() => {
  if (!cfg.running || !nextAt) return;
  const left = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  $("countdown").textContent = left + "s";
}, 250);

window.addEventListener("resize", drawChart);

// 展示判别标准
fetch("/api/criteria")
  .then((r) => r.json())
  .then((c) => {
    $("criteria").textContent =
      "动作（每个标的，choice）\n" + JSON.stringify(c.action, null, 2) +
      "\n\n风控（boolean）\n" + JSON.stringify(c.risk, null, 2);
  })
  .catch(() => { $("criteria").textContent = "（加载失败）"; });
