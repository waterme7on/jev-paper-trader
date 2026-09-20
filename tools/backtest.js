#!/usr/bin/env node
/* 回测：把 Jev 的决策逻辑跑在真实历史行情上。
 *
 * 为什么要做这个：实盘页面今天跑了一整天，Jev 一次 buy 都没说过——
 * 全是 HOLD。这要么说明盘面确实平，要么说明这套 criteria 根本不会触发 buy。
 * 不回测就分不清是哪一种。
 *
 * 关键点：
 *   - 状态构造直接复用 lib/jev.js 的 buildState（和线上每拍发的一模一样）
 *   - 交易规则直接复用 assets/strategy.js（和浏览器里跑的一模一样）
 *   两边共用同一份代码，否则回测结果没有意义。
 *
 * 用法：
 *   AI_GATEWAY_API_KEY=... node tools/backtest.js [--samples 60] [--step 4] [--days 1]
 *
 * 限流：Jev 实测 30 次/60 秒，这里默认 2.6s 间隔 ≈ 23 次/分。
 * 60 个样本约 3 分钟。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const jev = require(path.join(ROOT, "lib/jev.js"));
const Strategy = require(path.join(ROOT, "assets/strategy.js"));

const SYMBOLS = ["BTC", "ETH"];
const IDS = { BTC: "bitcoin", ETH: "ethereum" };

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const SAMPLES = parseInt(arg("samples", "60"), 10);
const STEP = parseInt(arg("step", "4"), 10);      // 每隔几个点取一个样本
const DAYS = arg("days", "1");                     // CoinGecko: days=1 → 5 分钟粒度
const DELAY_MS = parseFloat(arg("delay", "2.6")) * 1000;
const THRESHOLD = parseFloat(arg("threshold", "0.55"));
const COOLDOWN = parseInt(arg("cooldown", "60"), 10) * 1000;   // 回测里按毫秒算
const ALLOC = parseFloat(arg("alloc", "50"));
const INIT_CASH = parseFloat(arg("cash", "10000"));
const OUT = arg("save", path.join(ROOT, "backtest-result.json"));

const key = process.env.AI_GATEWAY_API_KEY
  || (fs.existsSync("/tmp/.jev-key") ? fs.readFileSync("/tmp/.jev-key", "utf8").trim() : null);
if (!key) {
  console.error("缺少 AI_GATEWAY_API_KEY。用法：AI_GATEWAY_API_KEY=xxx node tools/backtest.js");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 取历史数据

async function getJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchSeries() {
  const out = {};
  for (const s of SYMBOLS) {
    const d = await getJson(
      `https://api.coingecko.com/api/v3/coins/${IDS[s]}/market_chart?vs_currency=usd&days=${DAYS}`
    );
    const pts = (d && d.prices) || [];
    if (!pts.length) throw new Error("没取到 " + s + " 的历史数据");
    out[s] = pts.map(([ts, p]) => ({ ts, price: p }));
    console.log(`  ${s}: ${pts.length} 个点，跨度 ${((pts[pts.length-1][0] - pts[0][0]) / 3600000).toFixed(1)} 小时`);
  }
  return out;
}

/** 用 BTC 的时间戳做主轴，ETH 按最近时间戳对齐 */
function align(series) {
  const spine = series.BTC;
  const ethByTs = series.ETH;
  let j = 0;
  return spine.map((b) => {
    while (j + 1 < ethByTs.length && Math.abs(ethByTs[j + 1].ts - b.ts) < Math.abs(ethByTs[j].ts - b.ts)) j++;
    return { ts: b.ts, BTC: b.price, ETH: ethByTs[j].price };
  });
}

/** 把「为什么没买」归成一类，用来判断是模型不说还是规则拦了 */
function reasonOf(d, signal, riskProb, cfg) {
  if (d.action !== "hold") return "成交:" + d.action;
  if (signal === "hold") return "Jev 说 hold";
  if (cfg.riskGate && riskProb != null && riskProb >= 0.5 && signal === "buy") return "风控拦截";
  if ((d.prob || 0) < cfg.threshold) return "未达阈值";
  if (/冷却/.test(d.note)) return "冷却中";
  if (/已持仓/.test(d.note)) return "已持仓";
  if (/空仓/.test(d.note)) return "空仓无可卖";
  return "其他";
}

const pctChange = (rows, i, back) => {
  const k = Math.max(0, i - back);
  if (k === i) return null;
  return ((rows[i] - rows[k]) / rows[k]) * 100;
};

// ---------------------------------------------------------------- 主流程

(async () => {
  console.log("=== 取历史行情 ===");
  const series = await fetchSeries();
  const rows = align(series);
  console.log(`  对齐后 ${rows.length} 个点\n`);

  // 粒度：days=1 → 5 分钟一点
  const perHour = Math.round(3600000 / (rows[1].ts - rows[0].ts));
  console.log(`  粒度约 ${(rows[1].ts - rows[0].ts) / 60000} 分钟/点（${perHour} 点/小时）`);

  // 采样：从第 30 个点开始（前面留够窗口算 24h/1h）
  const START = Math.min(30, Math.floor(rows.length / 3));
  const idx = [];
  for (let i = START; i < rows.length && idx.length < SAMPLES; i += STEP) idx.push(i);
  console.log(`  取样 ${idx.length} 个（从第 ${START} 点起，每 ${STEP} 点一个）\n`);

  const acct = Strategy.freshAccount(INIT_CASH);
  const cfg = { threshold: THRESHOLD, cooldownSec: COOLDOWN / 1000, allocPct: ALLOC, riskGate: true };

  const tally = { buy: 0, sell: 0, hold: 0 };
  const perSymbol = {};
  for (const s of SYMBOLS) perSymbol[s] = { buy: 0, sell: 0, hold: 0, noSignal: 0 };
  const probs = [];
  const confs = [];
  const riskProbs = [];
  const reasons = [];
  const trades = [];
  const errors = [];
  let costTotal = 0;
  let marketTotal = 0;
  let latencySum = 0;

  console.log("=== 跑回测 ===");
  for (let n = 0; n < idx.length; n++) {
    const i = idx[n];
    const r = rows[i];
    const priceBTC = rows[i].BTC, priceETH = rows[i].ETH;

    // 构造与线上完全一致的 snapshot
    const snapshot = { ts: r.ts, symbols: {} };
    for (const s of SYMBOLS) {
      const col = rows.map((x) => x[s]);
      // 粒度不够就不要硬算——把 1 小时的变化标成「5m」是在骗模型。
      // days=1 → 5 分钟粒度（12 点/小时），5m 可用，1m 不可用
      // days=7 → 小时粒度（1 点/小时），只有 1h / 24h 可信
      const back5m = perHour >= 12 ? Math.round(perHour / 12) : null;
      const back1m = perHour >= 60 ? Math.round(perHour / 60) : null;
      snapshot.symbols[s] = {
        symbol: s,
        price: s === "BTC" ? priceBTC : priceETH,
        change24h: pctChange(col, i, perHour * 24),
        change1h: pctChange(col, i, perHour),
        change5m: back5m ? pctChange(col, i, back5m) : null,
        change1m: back1m ? pctChange(col, i, back1m) : null,
        warmup: false,
      };
    }

    const state = jev.buildState(snapshot, acct.positions);
    const questions = jev.buildQuestions(SYMBOLS);

    let res;
    try {
      res = await jev.evaluate(state, questions, key);
    } catch (e) {
      console.log(`  [${n + 1}/${idx.length}] 调用失败：${e.message}`);
      errors.push(e.message);
      await sleep(Math.min((e.rateLimit && e.rateLimit.retryAfter) || 20, 40) * 1000);
      continue;
    }
    latencySum += res.latencyMs;
    if (res.gateway.cost != null) costTotal += Number(res.gateway.cost) || 0;
    if (res.gateway.marketCost != null) marketTotal += Number(res.gateway.marketCost) || 0;

    const riskProb = res.answers.marketRisk ? res.answers.marketRisk.probability : null;

    for (const s of SYMBOLS) {
      const a = res.answers[s];
      const price = snapshot.symbols[s].price;
      if (!a) { perSymbol[s].noSignal++; continue; }

      // choice 类型的答案字段叫 choice（action 是 api/tick.js 里映射后的名字），
      // 这里直接读原始响应，所以用 choice。
      const signal = a.choice || "hold";
      perSymbol[s][signal] = (perSymbol[s][signal] || 0) + 1;
      tally[signal] = (tally[signal] || 0) + 1;
      probs.push((a.probabilities && a.probabilities[signal]) || 0);
      if (a.confidence != null) confs.push(a.confidence);

      // 归一化成 api/tick.js 给前端的形状，这样 Strategy 收到的东西和线上一致
      const dec = { action: signal, probabilities: a.probabilities || {}, confidence: a.confidence };
      const d = Strategy.decide(s, dec, price, riskProb, cfg, acct, r.ts);
      // 诊断：把「没买」拆开看是谁拦的
      if (riskProb != null) riskProbs.push(riskProb);
      reasons.push(reasonOf(d, signal, riskProb, cfg));
      const msg = (d.action === "buy" || d.action === "sell") ? Strategy.execute(s, d.action, price, cfg, acct, r.ts) : "";
      if (msg) {
        trades.push({ ts: r.ts, date: new Date(r.ts).toISOString(), symbol: s,
                      action: d.action, price, prob: d.prob, msg });
        console.log(`  [${n + 1}/${idx.length}] ${new Date(r.ts).toLocaleString("zh-CN")} ${s} ${msg}`);
      }
    }

    process.stdout.write(`\r  进度 ${n + 1}/${idx.length}    `);
    await sleep(DELAY_MS);
  }
  console.log("\n");

  // ---------------------------------------------------------------- 结算

  const last = rows[rows.length - 1];
  const endPrices = { BTC: last.BTC, ETH: last.ETH };
  const eq = Strategy.equityAt(acct, endPrices);
  const pnl = eq - INIT_CASH;
  const pnlPct = (pnl / INIT_CASH) * 100;

  // 买入持有基准：同样的钱，一开始均分两个标的一直拿着
  const first = rows[START];
  const bh = (INIT_CASH / 2) * (endPrices.BTC / first.BTC) + (INIT_CASH / 2) * (endPrices.ETH / first.ETH);
  const bhPct = ((bh - INIT_CASH) / INIT_CASH) * 100;

  const wins = trades.filter((t) => t.action === "sell" && /\+/.test(t.msg)).length;
  const sells = trades.filter((t) => t.action === "sell").length;

  console.log("=== 结果 ===");
  console.log(`  样本数          ${idx.length}（每个样本问 2 个标的）`);
  console.log(`  区间            ${new Date(rows[START].ts).toLocaleString("zh-CN")} → ${new Date(last.ts).toLocaleString("zh-CN")}`);
  console.log("");
  console.log("  Jev 信号分布");
  for (const s of SYMBOLS) {
    const p = perSymbol[s];
    const tot = p.buy + p.sell + p.hold;
    console.log(`    ${s.padEnd(4)} buy ${String(p.buy).padStart(3)}  sell ${String(p.sell).padStart(3)}  hold ${String(p.hold).padStart(3)}`
      + (p.noSignal ? `  (无信号 ${p.noSignal})` : ""));
    if (tot) console.log(`         hold 占比 ${(p.hold / tot * 100).toFixed(1)}%`);
  }
  console.log("");
  console.log(`  成交次数        ${trades.length}（买 ${trades.filter(t=>t.action==='buy').length} / 卖 ${sells}）`);
  if (sells) console.log(`  卖出盈利笔数    ${wins}/${sells}`);
  console.log(`  已实现盈亏      ${acct.realized.toFixed(2)}`);
  console.log(`  手续费合计      ${acct.fees.toFixed(2)}`);
  console.log(`  期末权益        ${eq.toFixed(2)}  (${pnl >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`);
  console.log(`  买入持有基准    ${bh.toFixed(2)}  (${bhPct >= 0 ? "+" : ""}${bhPct.toFixed(2)}%)`);
  console.log(`  vs 基准         ${(pnlPct - bhPct >= 0 ? "+" : "")}${(pnlPct - bhPct).toFixed(2)} 个百分点`);
  console.log("");
  if (probs.length) {
    probs.sort((a, b) => a - b);
    console.log(`  选中项概率      min ${probs[0].toFixed(2)}  中位 ${probs[Math.floor(probs.length/2)].toFixed(2)}  max ${probs[probs.length-1].toFixed(2)}`);
  }
  if (confs.length) {
    confs.sort((a, b) => a - b);
    console.log(`  confidence      min ${confs[0].toFixed(2)}  中位 ${confs[Math.floor(confs.length/2)].toFixed(2)}  max ${confs[confs.length-1].toFixed(2)}`);
  }
  if (riskProbs.length) {
    const rs = riskProbs.slice().sort((a, b) => a - b);
    const blocked = riskProbs.filter((v) => v >= 0.5).length;
    console.log(`  marketRisk      中位 ${rs[Math.floor(rs.length/2)].toFixed(2)}  max ${rs[rs.length-1].toFixed(2)}  | ≥0.5 共 ${blocked}/${rs.length} 次`);
  }
  if (reasons.length) {
    const rc = {};
    for (const r of reasons) rc[r] = (rc[r] || 0) + 1;
    console.log("\n  没成交的原因分布");
    Object.entries(rc).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`    ${k.padEnd(14)} ${String(v).padStart(3)}  ${(v / reasons.length * 100).toFixed(0)}%`));
  }
  console.log(`  Jev 平均延迟    ${(latencySum / Math.max(1, idx.length)).toFixed(0)} ms`);
  console.log(`  实际扣费        $${costTotal.toFixed(8)}（列表价 $${marketTotal.toFixed(8)}）`);
  if (errors.length) console.log(`  失败 ${errors.length} 次：${[...new Set(errors)].slice(0,3).join(" | ")}`);

  const result = {
    run_at: new Date().toISOString(),
    config: { samples: idx.length, step: STEP, days: DAYS, threshold: THRESHOLD,
              cooldownSec: COOLDOWN/1000, allocPct: ALLOC, initCash: INIT_CASH },
    window: { from: new Date(rows[START].ts).toISOString(), to: new Date(last.ts).toISOString() },
    signals: { tally, perSymbol },
    trades,
    account: { equity: eq, realized: acct.realized, fees: acct.fees,
               pnlPct, buyHoldPct: bhPct, alpha: pnlPct - bhPct },
    meta: { avgLatencyMs: latencySum / Math.max(1, idx.length), cost: costTotal,
            marketCost: marketTotal, errors: errors.length },
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`\n  结果已保存：${OUT}`);
})().catch((e) => { console.error("回测失败:", e); process.exit(1); });
