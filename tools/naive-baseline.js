#!/usr/bin/env node
/* 机械规则基线：不调 Jev，只看动量符号做决策。
 *
 * 为什么需要这个：
 * 熊市那轮 trend 跑出 -12.60%，优于随机信号的 90 分位（-17.30%）——
 * 是三轮里第一次落在噪声区间外。但这有个很自然的质疑：
 *   「在单边下跌行情里，任何『趋势不好就空仓』的规则都能做到，跟 Jev 有什么关系？」
 *
 * 所以这里加一组**零成本、不调模型**的机械基线，用同一批样本、同一套交易规则跑一遍。
 * 如果 Jev 和一行 if 语句的结果差不多，那模型就没带来额外价值；
 * 如果差很远，才谈得上「模型的判断」这件事本身有内容。
 *
 * 用法（--from/--to/--samples/--step 必须和对照实验那次一致，采样才是同一批）：
 *   node tools/naive-baseline.js --from 2022-01-01 --to 2022-07-01 --samples 90 --step 576
 *   node tools/naive-baseline.js --from 2026-06-23 --to 2026-09-20 --samples 89 --step 288
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const Strategy = require(path.join(ROOT, "assets/strategy.js"));
const history = require(path.join(ROOT, "lib/history.js"));

const SYMBOLS = ["BTC", "ETH"];
const INIT_CASH = 10000;

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FROM = arg("from", null);
const TO = arg("to", null);
const DAYS = parseFloat(arg("days", "90"));
const GRAN_MIN = parseInt(arg("gran", "5"), 10);
const SAMPLES = parseInt(arg("samples", "90"), 10);
const STEP = parseInt(arg("step", "288"), 10);
const MONTE = parseInt(arg("monte", "200"), 10);
const COOLDOWN = parseInt(arg("cooldown", "60"), 10);
const ALLOC = parseFloat(arg("alloc", "50"));
const OUT = arg("save", path.join(ROOT, "naive-baseline.json"));

const pctChange = (col, i, back) => {
  const k = Math.max(0, i - back);
  return k === i ? null : ((col[i] - col[k]) / col[k]) * 100;
};

// ---------------------------------------------------------------- 机械规则
// prob 直接给 1.0：机械规则没有概率概念，别让它被阈值卡住
const RULES = {
  "涨就买跌就卖": (q) => (q.change1h > 0 && q.change24h > 0 ? "buy"
                        : (q.change1h < 0 && q.change24h < 0 ? "sell" : "hold")),
  "只看24h":     (q) => (q.change24h > 0 ? "buy" : "sell"),
  "只看1h":      (q) => (q.change1h > 0 ? "buy" : "sell"),
  "反向(跌买)":   (q) => (q.change24h < 0 ? "buy" : (q.change24h > 0 ? "sell" : "hold")),
  "一直空仓":     () => "hold",
};

function simulate(rule, rows, idx, perHour) {
  const acct = Strategy.freshAccount(INIT_CASH);
  const cfg = { threshold: 0.55, cooldownSec: COOLDOWN, allocPct: ALLOC, riskGate: false };
  const trades = [];
  const dist = { buy: 0, sell: 0, hold: 0 };

  for (const i of idx) {
    const t = rows[i].ts;
    for (const s of SYMBOLS) {
      const col = rows.map((x) => x[s]);
      const back5m = perHour >= 12 ? Math.round(perHour / 12) : null;
      const back1m = perHour >= 60 ? Math.round(perHour / 60) : null;
      const q = {
        price: rows[i][s],
        change24h: pctChange(col, i, perHour * 24),
        change1h: pctChange(col, i, perHour),
        change5m: back5m ? pctChange(col, i, back5m) : null,
        change1m: back1m ? pctChange(col, i, back1m) : null,
      };
      const sig = rule(q) || "hold";
      dist[sig] = (dist[sig] || 0) + 1;

      // 归一化成 api/tick.js 给前端的形状；prob=1 保证不因为阈值被拦
      const dec = { action: sig, probabilities: { [sig]: 1 }, confidence: 1 };
      const d = Strategy.decide(s, dec, q.price, null, cfg, acct, t);
      const msg = (d.action === "buy" || d.action === "sell")
        ? Strategy.execute(s, d.action, q.price, cfg, acct, t) : "";
      if (msg) trades.push({ symbol: s, action: d.action, price: q.price, ts: t, msg });
    }
  }

  const last = rows[rows.length - 1];
  const eq = Strategy.equityAt(acct, { BTC: last.BTC, ETH: last.ETH });
  const sells = trades.filter((x) => x.action === "sell");
  const wins = sells.filter((x) => /\+/.test(x.msg)).length;
  return {
    dist, trades: trades.length,
    buys: trades.filter((x) => x.action === "buy").length,
    sells: sells.length,
    winRate: sells.length ? wins / sells.length : null,
    equity: eq,
    pnlPct: ((eq - INIT_CASH) / INIT_CASH) * 100,
  };
}

(async () => {
  console.log("=== 取历史行情（不调 Jev）===");
  let series;
  if (FROM && TO) {
    const s = Date.parse(FROM), e = Date.parse(TO);
    console.log(`  区间 ${FROM} → ${TO}（${((e - s) / 86400000).toFixed(0)} 天），${GRAN_MIN} 分钟粒度`);
    series = await history.fetchAllWindow(SYMBOLS, s, e, GRAN_MIN * 60);
  } else {
    console.log(`  最近 ${DAYS} 天，${GRAN_MIN} 分钟粒度`);
    series = await history.fetchAll(SYMBOLS, DAYS);
  }
  const spine = series.BTC, eth = series.ETH;
  let j = 0;
  const rows = spine.map((b) => {
    while (j + 1 < eth.length && Math.abs(eth[j + 1].ts - b.ts) < Math.abs(eth[j].ts - b.ts)) j++;
    return { ts: b.ts, BTC: b.price, ETH: eth[j].price };
  });

  const perHour = Math.max(1, Math.round(3600000 / (rows[1].ts - rows[0].ts)));
  const START = Math.min(Math.floor(rows.length / 3), Math.max(30, perHour * 24));
  const idx = [];
  for (let i = START; i < rows.length && idx.length < SAMPLES; i += STEP) idx.push(i);
  console.log(`  ${rows.length} 个点，取样 ${idx.length} 个（第 ${START} 点起，每 ${STEP} 点）\n`);

  // ---------------------------------------------------------------- 机械规则
  console.log("=== 机械规则基线 ===");
  const results = {};
  for (const [name, rule] of Object.entries(RULES)) {
    const r = simulate(rule, rows, idx, perHour);
    results[name] = r;
    console.log(`  ${name.padEnd(14)} buy ${String(r.dist.buy || 0).padStart(3)}`
      + `  sell ${String(r.dist.sell || 0).padStart(3)}  hold ${String(r.dist.hold || 0).padStart(3)}`
      + `  | 成交 ${String(r.trades).padStart(3)}`
      + `  | ${(r.pnlPct >= 0 ? "+" : "") + r.pnlPct.toFixed(2)}%`);
  }

  // ---------------------------------------------------------------- 随机基线（同分布）
  const AC = ["buy", "sell", "hold"];
  const rnd = [];
  for (let m = 0; m < MONTE; m++) {
    const acct = Strategy.freshAccount(INIT_CASH);
    const cfg = { threshold: 0.55, cooldownSec: COOLDOWN, allocPct: ALLOC, riskGate: false };
    for (const i of idx) {
      for (const s of SYMBOLS) {
        const sig = AC[Math.floor(Math.random() * 3)];
        const dec = { action: sig, probabilities: { [sig]: 1 }, confidence: 1 };
        const d = Strategy.decide(s, dec, rows[i][s], null, cfg, acct, rows[i].ts);
        if (d.action === "buy" || d.action === "sell") Strategy.execute(s, d.action, rows[i][s], cfg, acct, rows[i].ts);
      }
    }
    const last = rows[rows.length - 1];
    rnd.push(((Strategy.equityAt(acct, { BTC: last.BTC, ETH: last.ETH }) - INIT_CASH) / INIT_CASH) * 100);
  }
  rnd.sort((a, b) => a - b);
  const p10 = rnd[Math.floor(rnd.length * 0.1)];
  const med = rnd[Math.floor(rnd.length * 0.5)];
  const p90 = rnd[Math.floor(rnd.length * 0.9)];

  const first = rows[START], last = rows[rows.length - 1];
  const bh = (INIT_CASH / 2) * (last.BTC / first.BTC) + (INIT_CASH / 2) * (last.ETH / first.ETH);
  const bhPct = ((bh - INIT_CASH) / INIT_CASH) * 100;

  console.log("\n" + "=".repeat(74));
  console.log(`  随机基线（${MONTE} 次）  中位 ${med >= 0 ? "+" : ""}${med.toFixed(2)}%`
    + `   90% 区间 ${p10 >= 0 ? "+" : ""}${p10.toFixed(2)}% ~ ${p90 >= 0 ? "+" : ""}${p90.toFixed(2)}%`);
  console.log(`  买入持有              ${bhPct >= 0 ? "+" : ""}${bhPct.toFixed(2)}%`);
  console.log("=".repeat(74));

  const out = {
    run_at: new Date().toISOString(),
    config: { from: FROM, to: TO, days: DAYS, granularityMin: GRAN_MIN,
              samples: idx.length, step: STEP, cooldownSec: COOLDOWN, allocPct: ALLOC, monte: MONTE },
    window: { from: new Date(rows[START].ts).toISOString(), to: new Date(last.ts).toISOString() },
    rules: results,
    baselines: { randomMedian: med, randomP10: p10, randomP90: p90, buyHoldPct: bhPct },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n  已保存：${OUT}`);
})().catch((e) => { console.error("失败:", e); process.exit(1); });
