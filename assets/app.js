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
const LS_KEY = "jev-paper-trader.v1";

const $ = (id) => document.getElementById(id);
const freshAccount = () => Strategy.freshAccount(10000);

// ---------------------------------------------------------------- 账户
// 交易规则（阈值 / 冷却 / 风控 / 仓位 / 手续费）全部在 assets/strategy.js，
// 与回测脚本 tools/backtest.js 共用同一份——两边不一致的话回测就没意义了。

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
  variant: "trend",        // 服务端默认值，加载 /api/criteria 后以服务端为准
};

// ---------------------------------------------------------------- 交易执行
// 全部委托给 assets/strategy.js，与回测共用同一份规则

function equityAt(prices) { return Strategy.equityAt(acct, prices); }

function priceOf(s, snapshot) {
  return snapshot && snapshot.symbols && snapshot.symbols[s] ? snapshot.symbols[s].price : null;
}

function decide(s, dec, price, riskProb) {
  // now 用当前时间；回测时传的是历史时刻
  return Strategy.decide(s, dec, price, riskProb, cfg, acct, Date.now());
}

function execute(s, action, price) {
  return Strategy.execute(s, action, price, cfg, acct, Date.now());
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
    const res = await fetch("/api/tick?pos=" + encodeURIComponent(posParam())
      + "&variant=" + encodeURIComponent(cfg.variant), { cache: "no-store" });
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
    + (data.cached ? " · 命中按拍缓存" : "")
    // 风控概率一直在决定要不要拦买入，但以前整页都没显示过它
    + ` · 风控 ${riskProb == null ? "—" : riskProb.toFixed(2)}`;

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

    // 同一份行情、同一条规则（定义在 assets/strategy.js，回测用的是同一份）
    const nv = q ? Strategy.naiveSignal(Strategy.NAIVE_DEFAULT, q) : null;
    // 动量缺失时要说清楚是「行情源降级」还是「本来就没有」，别含糊地写「动量不足」
    const degraded = !!(data && data.source && /fallback/.test(data.source));
    if (hasSignal && nv) {
      acct.naive = acct.naive || { same: 0, total: 0 };
      acct.naive.total++;
      if (nv === signal) acct.naive.same++;
    }

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
      <div class="naive-line">一行 <code>if</code>（${Strategy.NAIVE_DEFAULT}）：
        ${nv ? `<b class="act ${nv}">${nv.toUpperCase()}</b>`
             : `<span class="none">${degraded ? "行情源降级，缺 24h" : "动量不足"}</span>`}
        ${hasSignal && nv ? (nv === signal
          ? '<span class="agree">与 Jev 一致</span>'
          : '<span class="diff">与 Jev 不同</span>') : ""}
      </div>
      <div class="pos">${posHtml}
        <div class="hint">${q ? ['1h','5m','1m'].map((lbl, i) => {
          const v = i===0 ? q.change1h : i===1 ? q.change5m : q.change1m;
          return `${lbl} ${v == null ? "—" : fmtSigned(v) + "%"}`;
        }).join(' · ') : "等待数据"}</div>
      </div>`;
    box.appendChild(card);
  }

  // ---- Jev vs 一行 if 的一致率
  {
    const n = acct.naive || { same: 0, total: 0 };
    const box2 = $("naiveCmp");
    if (!n.total) {
      const why = (data && data.source && /fallback/.test(data.source))
        ? "当前行情源降级（CoinGecko 限流，已切 Coinbase 兜底），拿不到完整动量。"
        : "需要同时有 Jev 信号和 1h/24h 动量。";
      box2.innerHTML = `<div class="hint">还没有可比的数据 —— ${why}</div>`;
      if ($("naiveVerdict")) $("naiveVerdict").textContent = "";
      if ($("naiveNote")) $("naiveNote").textContent = "";
    } else {
      const rate = (n.same / n.total) * 100;
      const rows = SYMBOLS.map((s) => {
        const q = snapshot.symbols && snapshot.symbols[s];
        const dec = decisions[s];
        const nv = q ? Strategy.naiveSignal(Strategy.NAIVE_DEFAULT, q) : null;
        const jv = dec && dec.action ? dec.action : null;
        return `<tr><td>${s}</td>`
          + `<td><b class="act ${jv || ""}">${jv ? jv.toUpperCase() : "—"}</b></td>`
          + `<td><b class="act ${nv || ""}">${nv ? nv.toUpperCase() : "—"}</b></td>`
          + `<td>${jv && nv ? (jv === nv ? '<span class="agree">一致</span>' : '<span class="diff">不同</span>') : "—"}</td>`
          + "</tr>";
      }).join("");
      box2.innerHTML = `<table class="cmp-t"><thead><tr><th>标的</th><th>Jev</th>`
        + `<th>一行 if</th><th>是否一致</th></tr></thead><tbody>${rows}</tbody></table>`;
      $("naiveNote").textContent =
        `累计 ${n.total} 次可比判断，一致 ${n.same} 次（${rate.toFixed(0)}%）`;
      // 一致率高就直接把话说出来，别让人自己去推
      const note = $("naiveVerdict");
      if (note) {
        note.textContent = n.total < 10
          ? `样本还太少（${n.total} 次），先看着。`
          : rate >= 80
            ? `一致率 ${rate.toFixed(0)}% —— 目前看，Jev 基本等价于一行 if。`
            : rate >= 50
              ? `一致率 ${rate.toFixed(0)}% —— 两者经常不同，但这不代表模型更对（回测里没证明它有 edge）。`
              : `一致率 ${rate.toFixed(0)}% —— 两者多数时候不同，同样不代表模型更对。`;
      }
    }
  }

  // ---- Jev 看到的状态
  if (data && data.stateEcho) $("stateEcho").textContent = data.stateEcho;

  // ---- Jev 的原始输出
  renderModelOut(data);

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

/* ---- 模型原始输出 ----
 *
 * 之前页面上只有「Jev 看到的状态」（输入），没有「Jev 说了什么」（输出原文），
 * 模型给出的 marketRisk 概率更是全程没露过面——但它一直在悄悄决定要不要拦买入。
 * 这里把 answers 原文整段打出来，失败时也一样打（错误原因 / 限流参数），
 * 否则「模型没输出」和「页面没显示」看起来完全一样。
 */

let outLogLines = [];
let lastOutBody = "";

function renderModelOut(data) {
  const el = $("modelOut");
  if (!el) return;

  // 首次渲染 / 清空账户时会传一个空壳对象，不要误报成「模型没输出」
  const failed = !!data && !data.ok && !!(data.error || data.throttled);
  if (!data || !data.ok) {
    if (failed) {
      const head = $("outHead");
      if (head) head.textContent = "这一拍没有模型输出";
      el.textContent = [
        "error:    " + (data.error || "—"),
        data.rateLimit ? "rateLimit: " + JSON.stringify(data.rateLimit) : "",
        data.state ? "\n本想发给它的 state（原文）：\n" + data.state : "",
      ].filter(Boolean).join("\n");
    }
    return;
  }

  const m = data.meta || {};
  const u = m.usage || {};
  const risk = data.risk ? data.risk.probability : null;
  const t = new Date(data.ts || Date.now()).toLocaleTimeString("zh-CN", { hour12: false });

  const head = [
    t,
    data.variant,
    "延迟 " + (m.latencyMs == null ? "?" : m.latencyMs) + "ms",
    "token " + (u.inputTokens == null ? "?" : u.inputTokens) + " in / "
            + (u.outputTokens == null ? "?" : u.outputTokens) + " out",
    "风控概率 " + (risk == null ? "—" : risk.toFixed(2))
      + (risk != null && risk >= 0.5 ? "（≥0.5，买入被拦截）" : ""),
    data.cached ? "命中按拍缓存" : "",
  ].filter(Boolean).join(" · ");
  if ($("outHead")) $("outHead").textContent = head;

  const body = JSON.stringify(data.answers || {}, null, 2);
  lastOutBody = body;

  if ($("outLog") && $("outLog").checked) {
    outLogLines.push("── " + head + "\n" + body);
    if (outLogLines.length > 60) outLogLines.shift();
    el.textContent = outLogLines.join("\n\n");
  } else {
    el.textContent = body;
  }

  if ($("questionsEcho")) {
    $("questionsEcho").textContent = JSON.stringify((data && data.questionsEcho) || {}, null, 2);
  }
  el.scrollTop = el.scrollHeight;
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
  const marks = acct.decisions.filter((d) => d.action !== "hold");
  // 说明文字要在提前返回之前写好，否则点数不足时这一栏一直是空的
  $("chartNote").textContent = pts.length
    ? `${pts.length} 个价格点 · ${marks.length} 次成交`
    : "等待数据…";
  if (pts.length < 2) {
    g.fillStyle = "#64748b";
    g.font = "12px sans-serif";
    g.fillText("采集中…需要至少两个价格点（每 5 秒一个）", 12, h / 2);
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
    outLogLines = [];
    lastOutBody = "";
    $("modelOut").textContent = "（已清空，重新启动后显示）";
    $("outHead").textContent = "（启动后显示）";
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

  // 输出面板的两个控件。同样不能因为 id 缺失把启动流程拖死。
  const logBox = $("outLog");
  if (logBox) {
    logBox.addEventListener("change", () => {
      // 关掉累积就回到「只看最新一拍」
      if (!logBox.checked) { outLogLines = []; $("modelOut").textContent = lastOutBody; }
    });
  }
  const copyBtn = $("copyOut");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      const text = $("modelOut").textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => { copyBtn.textContent = "已复制"; setTimeout(() => { copyBtn.textContent = "复制"; }, 1200); },
          () => { copyBtn.textContent = "复制失败"; setTimeout(() => { copyBtn.textContent = "复制"; }, 1200); }
        );
      } else {
        copyBtn.textContent = "不支持剪贴板";
        setTimeout(() => { copyBtn.textContent = "复制"; }, 1200);
      }
    });
  }
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

// 判别标准：三套可切换，并把回测数字摆在旁边
fetch("/api/criteria")
  .then((r) => r.json())
  .then((c) => {
    const sel = $("variant");
    sel.innerHTML = "";
    Object.entries(c.variants || {}).forEach(([k, v]) => {
      const bt = v.backtest;
      const opt = document.createElement("option");
      opt.value = k;
      // 把实测结果写进选项，避免「挑一个能成交的」看起来像没代价
      opt.textContent = v.label + (bt ? `  —  回测：${bt.trades} 笔成交，${bt.pnlPct >= 0 ? "+" : ""}${bt.pnlPct.toFixed(2)}%` : "");
      sel.appendChild(opt);
    });
    cfg.variant = c.defaultVariant || cfg.variant;
    sel.value = cfg.variant;
    $("variantVal").textContent = (c.variants && c.variants[cfg.variant]
      ? c.variants[cfg.variant].label : cfg.variant);

    const showCriteria = () => {
      const cur = (c.variants || {})[cfg.variant];
      $("criteria").textContent =
        "动作（每个标的，choice）—— 当前：" + cfg.variant + "\n"
        + JSON.stringify(cur ? cur.criteria : {}, null, 2)
        + "\n\n风控（boolean）\n" + JSON.stringify(c.risk, null, 2);
    };

    sel.addEventListener("change", () => {
      cfg.variant = sel.value;
      $("variantVal").textContent = (c.variants && c.variants[cfg.variant]
        ? c.variants[cfg.variant].label : cfg.variant);
      showCriteria();
      renderCmp();
      // 换了 criteria 就立刻重算，别等到下一拍
      if (cfg.running) tick();
    });

    showCriteria();

    // 三套对照。
    // 结论文字全部按接口给的数字算出来，不硬编码——否则换了回测结果，
    // 页面还在一本正经地说上一轮的旧数字。
    const b = c.backtest || {};
    const base = b.baseline || {};
    const pct = (v) => (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%";

    const renderCmp = () => {
      let html = '<table class="cmp-t"><thead><tr>'
        + "<th>criteria</th><th>buy</th><th>sell</th><th>hold</th>"
        + "<th>成交</th><th>胜率</th><th>收益</th></tr></thead><tbody>";
      for (const [k, v] of Object.entries(c.variants || {})) {
        const r = v.backtest;
        html += `<tr${k === cfg.variant ? ' class="cur"' : ""}><td>${k}<div class="lb">${v.label}</div></td>`
          + (r ? `<td>${r.buy}</td><td>${r.sell}</td><td>${r.hold}</td><td>${r.trades}</td>`
                + `<td>${r.winRate == null ? "—" : (r.winRate * 100).toFixed(0) + "%"}</td>`
                + `<td class="${r.pnlPct >= 0 ? "up" : "down"}">${pct(r.pnlPct)}</td>`
              : '<td colspan="6">—</td>')
          + "</tr>";
      }
      html += "</tbody></table>";
      html += `<p class="hint">基线：随机信号中位 ${pct(base.randomMedianPct)}`
        + `（90% 区间 ${pct(base.randomP10Pct)} ~ ${pct(base.randomP90Pct)}）`
        + ` · 买入持有 ${pct(base.buyHoldPct)}。${b.note || ""}</p>`;

      // 当前这套到底怎么样，按数字自己下判断
      const cur = (c.variants || {})[cfg.variant];
      const r = cur && cur.backtest;
      if (r && r.trades > 0) {
        const vsRandom = r.pnlPct - base.randomMedianPct;
        const vsHold = r.pnlPct - base.buyHoldPct;
        const inNoise = r.pnlPct <= base.randomP90Pct;
        let verdict;
        if (vsRandom < 0) {
          verdict = `<b>${cfg.variant} 的 ${pct(r.pnlPct)} 比随机信号的中位数（${pct(base.randomMedianPct)}）还低</b>`
            + `——没有任何证据说明它有 edge。`;
        } else if (inNoise) {
          verdict = `<b>${cfg.variant} 的 ${pct(r.pnlPct)} 落在随机信号的噪声区间内</b>，看不出 edge。`;
        } else {
          verdict = `${cfg.variant} 的 ${pct(r.pnlPct)} 高于随机 90 分位，`
            + `但只跑了 ${b.note ? "一轮" : "一轮"}回测，仍不足以确认。`;
        }
        if (vsHold < 0) {
          verdict += ` 而且<b>跑输「买入并持有」${Math.abs(vsHold).toFixed(1)} 个百分点</b>`
            + `（${pct(base.buyHoldPct)}）——这轮行情里，频繁进出反而把收益磨掉了。`;
        }
        html += `<p class="hint warn-line">${verdict}</p>`;
      } else if (r) {
        html += `<p class="hint warn-line"><b>${cfg.variant} 在这一轮回测里一笔都没成交</b>`
          + `——${r.buy} 次 buy / ${r.sell} 次 sell，${r.hold} 次 hold。页面会一直空仓。</p>`;
      }
      if (b.fidelity && b.fidelity.note) {
        html += `<p class="hint">稳健性：${b.fidelity.note}</p>`;
      }
      // 上面那张表全是上涨行情，补一段跨行情对照，别让人以为结论只对牛市成立
      const rg = b.regimes;
      if (rg && rg.bull && rg.bear) {
        html += '<p class="hint" style="margin-top:8px"><b>跨行情检验</b></p>';
        html += '<table class="cmp-t"><thead><tr><th>行情</th><th>trend</th>'
          + '<th>一直空仓</th><th>最好的机械规则</th><th>随机中位</th><th>买入持有</th>'
          + '</tr></thead><tbody>';
        for (const [k, label] of [["bull", "牛市"], ["bear", "熊市"]]) {
          const r = rg[k];
          html += `<tr><td>${label}<div class="lb">${r.window}</div></td>`
            + `<td class="${r.trendPct >= 0 ? "up" : "down"}">${pct(r.trendPct)}</td>`
            + `<td>${pct(r.cashPct)}</td>`
            + `<td class="${r.bestNaivePct >= 0 ? "up" : "down"}">${pct(r.bestNaivePct)}`
            + `<div class="lb">${r.bestNaiveRule}</div></td>`
            + `<td>${pct(r.randomMedianPct)}</td>`
            + `<td class="${r.buyHoldPct >= 0 ? "up" : "down"}">${pct(r.buyHoldPct)}</td></tr>`;
        }
        html += "</tbody></table>";
        html += '<p class="hint">两行都来自 5 分钟粒度的高保真回测，所以牛市数字与上面那张'
          + "（小时粒度）的表略有差异（+17.19% vs +12.40%）。</p>";
        html += `<p class="hint warn-line">${rg.note}</p>`;
      }
      $("variantCmp").innerHTML = html;
    };

    renderCmp();
  })
  .catch(() => { $("criteria").textContent = "（加载失败）"; });
