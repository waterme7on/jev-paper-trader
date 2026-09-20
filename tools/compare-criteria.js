#!/usr/bin/env node
/* 对照实验：同一批历史样本，只换 criteria 措辞，看信号会怎么变。
 *
 * 背景：第一轮回测 140 次判断里 Jev 一次 buy 都没说过、90.7% 是 hold。
 * 分不清是「模型不给买入信号」还是「这句 buy 写得没人能达到」。
 * 固定样本、只改措辞，才能分开这两种可能。
 *
 * 另外加了两条基线，用来判断「有成交」到底值多少钱：
 *   1. 随机信号（同样本数、同样规则，蒙特卡洛 200 次取分布）
 *   2. 买入持有
 *
 * 用法：
 *   AI_GATEWAY_API_KEY=... node tools/compare-criteria.js --samples 36 --days 7
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const jev = require(path.join(ROOT, "lib/jev.js"));
const Strategy = require(path.join(ROOT, "assets/strategy.js"));
const history = require(path.join(ROOT, "lib/history.js"));

const SYMBOLS = ["BTC", "ETH"];
const IDS = { BTC: "bitcoin", ETH: "ethereum" };

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SAMPLES = parseInt(arg("samples", "36"), 10);
const STEP = parseInt(arg("step", "4"), 10);
const DAYS = arg("days", "7");
// coinbase：真实 5 分钟 K 线，长周期也能算出 5m 动量（推荐做长周期对照时用）
// coingecko：区间越长粒度越粗，days=90 只有小时粒度
const SOURCE = arg("source", "coingecko");
// 指定历史窗口（测牛熊以外的行情必备）：--from 2022-06-01 --to 2022-12-01
// CoinGecko 免费层只能取「最近 N 天」，给不了历史区间；Coinbase 可以。
const FROM = arg("from", null);
const TO = arg("to", null);
const GRAN_MIN = parseInt(arg("gran", "5"), 10);      // 粒度，分钟
const DELAY_MS = parseFloat(arg("delay", "2.6")) * 1000;
const ONLY = arg("variant", null);
const MONTE = parseInt(arg("monte", "200"), 10);
const INIT_CASH = 10000;
const OUT = arg("save", path.join(ROOT, "criteria-compare.json"));

const key = process.env.AI_GATEWAY_API_KEY
  || (fs.existsSync("/tmp/.jev-key") ? fs.readFileSync("/tmp/.jev-key", "utf8").trim() : null);
if (!key) { console.error("缺少 AI_GATEWAY_API_KEY"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, t = 15000) {
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), t);
  try { const r = await fetch(url, { signal: c.signal, headers: { accept: "application/json" } });
        if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  finally { clearTimeout(tm); }
}

async function loadRows() {
  let series;
  if (FROM && TO) {
    const start = Date.parse(FROM), end = Date.parse(TO);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`--from/--to 不是有效区间：${FROM} → ${TO}`);
    }
    console.log(`  数据源 Coinbase Exchange（${GRAN_MIN} 分钟 K 线，翻页拼接）`);
    console.log(`  区间 ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`
      + `（${((end - start) / 86400000).toFixed(0)} 天）`);
    series = await history.fetchAllWindow(SYMBOLS, start, end, GRAN_MIN * 60);
  } else if (SOURCE === "coinbase") {
    console.log(`  数据源 Coinbase Exchange（5 分钟 K 线，翻页拼接）—— 取 ${DAYS} 天`);
    series = await history.fetchAll(SYMBOLS, parseFloat(DAYS));
  } else {
    console.log(`  数据源 CoinGecko（days=${DAYS}）`);
    series = {};
    for (const s of SYMBOLS) {
      const d = await getJson(`https://api.coingecko.com/api/v3/coins/${IDS[s]}/market_chart?vs_currency=usd&days=${DAYS}`);
      series[s] = ((d && d.prices) || []).map(([ts, p]) => ({ ts, price: p }));
    }
  }
  const spine = series.BTC; const eth = series.ETH; let j = 0;
  return spine.map((b) => {
    while (j + 1 < eth.length && Math.abs(eth[j + 1].ts - b.ts) < Math.abs(eth[j].ts - b.ts)) j++;
    return { ts: b.ts, BTC: b.price, ETH: eth[j].price };
  });
}

const pctChange = (col, i, back) => {
  const k = Math.max(0, i - back);
  return k === i ? null : ((col[i] - col[k]) / col[k]) * 100;
};

/** 用一份信号序列跑完整模拟，返回结算结果 */
function simulate(signals, rows, idx, cfg) {
  const acct = Strategy.freshAccount(INIT_CASH);
  const trades = [];
  for (let n = 0; n < idx.length; n++) {
    const i = idx[n], r = rows[i], t = r.ts;
    for (const s of SYMBOLS) {
      const sig = signals[n] && signals[n][s];
      if (!sig) continue;
      const price = r[s];
      // 归一化成 api/tick.js 给前端的形状，Strategy 收到的才和线上一致
      const dec = { action: sig.signal, probabilities: { [sig.signal]: sig.prob } };
      const d = Strategy.decide(s, dec, price, sig.risk, cfg, acct, t);
      const msg = (d.action === "buy" || d.action === "sell")
        ? Strategy.execute(s, d.action, price, cfg, acct, t) : "";
      if (msg) trades.push({ n, symbol: s, action: d.action, price, ts: t, msg });
    }
  }
  return settle(acct, trades, rows);
}

/** 结算：期末权益 + 胜率。simulate 和「边问边跑」两条路径共用，保证口径一致 */
function settle(acct, trades, rows) {
  const last = rows[rows.length - 1];
  const eq = Strategy.equityAt(acct, { BTC: last.BTC, ETH: last.ETH });
  const sells = trades.filter((x) => x.action === "sell");
  const wins = sells.filter((x) => /\+/.test(x.msg)).length;
  return {
    trades: trades.length,
    buys: trades.filter((x) => x.action === "buy").length,
    sells: sells.length,
    winRate: sells.length ? wins / sells.length : null,
    equity: eq,
    pnlPct: ((eq - INIT_CASH) / INIT_CASH) * 100,
    realized: acct.realized,
    fees: acct.fees,
  };
}

(async () => {
  console.log("=== 取历史行情 ===");
  const rows = await loadRows();
  const perHour = Math.max(1, Math.round(3600000 / (rows[1].ts - rows[0].ts)));
  console.log(`  ${rows.length} 个点，粒度 ${(rows[1].ts - rows[0].ts) / 60000} 分钟（${perHour} 点/小时）`);

  // 前面必须留够 24 小时窗口，否则 change24h 实际只跨了几个点却标成 24h
  const START = Math.min(Math.floor(rows.length / 3), Math.max(30, perHour * 24));
  const idx = [];
  for (let i = START; i < rows.length && idx.length < SAMPLES; i += STEP) idx.push(i);
  console.log(`  取样 ${idx.length} 个（第 ${START} 点起，每 ${STEP} 点）\n`);

  // 预先算好每个样本的状态（三套 criteria 共用同一份 state，保证公平）
  // 构造与线上一致的 snapshot。注意：state 要等到跑的时候再构造，
  // 因为 buildState 需要**当前持仓**——线上每拍都把持仓传给 Jev，
  // 早期版本这里预计算成空持仓，等于 Jev 全程不知道自己已经买了，
  // 而 sell 的 criteria 里明确写了「已有持仓且出现见顶迹象」。
  const buildSnapshot = (i) => {
    const snap = { ts: rows[i].ts, symbols: {} };
    const back5m = perHour >= 12 ? Math.round(perHour / 12) : null;
    const back1m = perHour >= 60 ? Math.round(perHour / 60) : null;
    for (const s of SYMBOLS) {
      const col = rows.map((x) => x[s]);
      snap.symbols[s] = {
        symbol: s, price: rows[i][s],
        change24h: pctChange(col, i, perHour * 24),
        change1h: pctChange(col, i, perHour),
        change5m: back5m ? pctChange(col, i, back5m) : null,
        change1m: back1m ? pctChange(col, i, back1m) : null,
        warmup: false,
      };
    }
    return snap;
  };

  const cfg = { threshold: 0.55, cooldownSec: 60, allocPct: 50, riskGate: true };
  const names = ONLY ? [ONLY] : Object.keys(jev.VARIANTS);

  // ---------------------------------------------------------------- 跑每套 criteria
  const results = {};
  for (const v of names) {
    console.log(`=== criteria: ${v}（${jev.VARIANTS[v].label}）===`);
    // 边问边跑：持仓随成交变化，下一拍的 state 里 Jev 就能看到真实持仓（和线上一致）
    const acct = Strategy.freshAccount(INIT_CASH);
    const trades = [];
    const signals = [];
    const dist = {};
    let errors = 0;
    for (let n = 0; n < idx.length; n++) {
      const i = idx[n], t = rows[i].ts;
      const snap = buildSnapshot(i);
      const state = jev.buildState(snap, acct.positions);
      try {
        const res = await jev.evaluate(state, jev.buildQuestions(SYMBOLS, v), key);
        const risk = res.answers.marketRisk ? res.answers.marketRisk.probability : null;
        const row = {};
        for (const s of SYMBOLS) {
          const a = res.answers[s];
          if (!a) continue;
          const signal = a.choice || "hold";
          dist[signal] = (dist[signal] || 0) + 1;
          row[s] = { signal, prob: (a.probabilities && a.probabilities[signal]) || 0, risk };

          // 归一化成 api/tick.js 给前端的形状，Strategy 收到的才和线上一致
          const dec = { action: signal, probabilities: a.probabilities || {}, confidence: a.confidence };
          const d = Strategy.decide(s, dec, snap.symbols[s].price, risk, cfg, acct, t);
          const msg = (d.action === "buy" || d.action === "sell")
            ? Strategy.execute(s, d.action, snap.symbols[s].price, cfg, acct, t) : "";
          if (msg) trades.push({ n, symbol: s, action: d.action, price: snap.symbols[s].price, ts: t, msg });
        }
        signals.push(row);
      } catch (e) {
        errors++;
        signals.push(null);
        if (e.rateLimit && e.rateLimit.retryAfter) await sleep(Math.min(e.rateLimit.retryAfter, 40) * 1000);
      }
      process.stdout.write(`\r  进度 ${n + 1}/${idx.length}   `);
      await sleep(DELAY_MS);
    }
    const sim = settle(acct, trades, rows);
    results[v] = { label: jev.VARIANTS[v].label, dist, sim, errors,
                   signals: signals.map((x) => x && Object.fromEntries(
                     Object.entries(x).map(([k, y]) => [k, y.signal]))) };
    console.log(`\n  信号分布 ${JSON.stringify(dist)}`);
    console.log(`  成交 ${sim.trades}（买 ${sim.buys} / 卖 ${sim.sells}）  期末 ${sim.pnlPct.toFixed(2)}%\n`);
  }

  // ---------------------------------------------------------------- 基线 1：随机信号
  console.log("=== 基线：随机信号（蒙特卡洛 " + MONTE + " 次）===");
  const rnd = [];
  for (let k = 0; k < MONTE; k++) {
    const signals = [];
    for (let n = 0; n < idx.length; n++) {
      const row = {};
      for (const s of SYMBOLS) {
        const pick = ["buy", "sell", "hold"][Math.floor(Math.random() * 3)];
        row[s] = { signal: pick, prob: 0.9, risk: null };   // 概率给高，确保过阈值
      }
      signals.push(row);
    }
    rnd.push(simulate(signals, rows, idx, cfg).pnlPct);
  }
  rnd.sort((a, b) => a - b);
  const rndMedian = rnd[Math.floor(rnd.length / 2)];
  const rndP10 = rnd[Math.floor(rnd.length * 0.1)];
  const rndP90 = rnd[Math.floor(rnd.length * 0.9)];

  // ---------------------------------------------------------------- 基线 2：买入持有
  const first = rows[START], last = rows[rows.length - 1];
  const bh = (INIT_CASH / 2) * (last.BTC / first.BTC) + (INIT_CASH / 2) * (last.ETH / first.ETH);
  const bhPct = ((bh - INIT_CASH) / INIT_CASH) * 100;

  // ---------------------------------------------------------------- 汇总
  console.log("\n" + "=".repeat(74));
  console.log("对照结果（同一批 " + idx.length + " 个样本，同一套交易规则，只换 criteria）");
  console.log("=".repeat(74));
  console.log("  " + "criteria".padEnd(12) + "buy".padStart(5) + "sell".padStart(6)
    + "hold".padStart(6) + "  成交".padStart(7) + "   胜率".padStart(8) + "    收益".padStart(10));
  console.log("  " + "-".repeat(70));
  for (const v of names) {
    const r = results[v];
    const d = r.dist, s = r.sim;
    console.log("  " + v.padEnd(12)
      + String(d.buy || 0).padStart(5) + String(d.sell || 0).padStart(6) + String(d.hold || 0).padStart(6)
      + String(s.trades).padStart(7)
      + (s.winRate == null ? "      —" : (s.winRate * 100).toFixed(0).padStart(6) + "%")
      + ((s.pnlPct >= 0 ? "+" : "") + s.pnlPct.toFixed(2) + "%").padStart(10));
  }
  console.log("  " + "-".repeat(70));
  console.log("  " + "随机基线".padEnd(12) + "".padStart(17) + "".padStart(7)
    + "".padStart(8) + (("中位 " + (rndMedian >= 0 ? "+" : "") + rndMedian.toFixed(2) + "%")).padStart(10));
  console.log("    90% 区间   " + (rndP10 >= 0 ? "+" : "") + rndP10.toFixed(2) + "%  ~  "
    + (rndP90 >= 0 ? "+" : "") + rndP90.toFixed(2) + "%");
  console.log("  " + "买入持有".padEnd(12) + "".padStart(17) + "".padStart(7)
    + "".padStart(8) + (("+" + bhPct.toFixed(2) + "%")).padStart(10));
  console.log("=".repeat(74));

  const out = {
    run_at: new Date().toISOString(),
    config: { samples: idx.length, step: STEP, days: DAYS, source: SOURCE,
              granularityMin: (rows[1].ts - rows[0].ts) / 60000,
              variant: ONLY || "all",
              threshold: cfg.threshold, cooldownSec: cfg.cooldownSec, allocPct: cfg.allocPct },
    window: { from: new Date(rows[START].ts).toISOString(), to: new Date(last.ts).toISOString() },
    variants: results,
    baselines: { randomMedian: rndMedian, randomP10: rndP10, randomP90: rndP90,
                 monte: MONTE, buyHoldPct: bhPct },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log("\n  已保存：" + OUT);
})().catch((e) => { console.error("失败:", e); process.exit(1); });
