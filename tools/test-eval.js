#!/usr/bin/env node
/* lib/eval.js 的离线单元测试（不联网、不调模型、秒级）。
 *
 * 测的都是**踩过的坑**，不是凑覆盖率：
 *   1. 采样起点：5 分钟粒度下必须回看 288 点才是真 24h（早期写死 30，等于骗模型）
 *   2. 粒度标注：小时粒度必须给 null，不能拿 1 小时变化冒充 5 分钟
 *   3. 基线字段名：median/p90 —— 早期写成 randomMedian/randomP90，取到 undefined
 *      变 NaN，所有比较都走 else，巨亏也被判成「高于 90 分位」
 *   4. 结算口径：胜率只统计卖出、盈亏含手续费
 */

const path = require("path");
const ROOT = path.join(__dirname, "..");
const Eval = require(path.join(ROOT, "lib/eval.js"));
const Strategy = require(path.join(ROOT, "assets/strategy.js"));

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

(async () => {

// 合成一条 5 分钟粒度的行情：价格单调递增，方便验算
function makeRows(n, granMin, fn) {
  const step = granMin * 60000;
  const t0 = Date.parse("2024-01-01T00:00:00Z");
  const rows = [];
  for (let i = 0; i < n; i++) {
    const p = fn(i);
    rows.push({ ts: t0 + i * step, BTC: p, ETH: p / 20 });
  }
  return rows;
}

console.log("=== 采样起点（5 分钟粒度下 24h = 288 点）===");
{
  // 规模对齐真实场景：181 天 × 288 点/天，这样才取得出 90 个样本
  const rows = makeRows(52128, 5, (i) => 100 + (i % 1000));
  const { perHour, start, idx } = Eval.buildIndex(rows, 90, 576);
  ok(perHour === 12, "perHour = 12（5 分钟粒度）", "实际 " + perHour);
  ok(start === 288, "起点 = 288（= 12 点/小时 × 24 小时），不是写死的 30", "实际 " + start);
  ok(idx[0] === start, "第一个样本就是起点");
  ok(idx.length === 90, "取到 90 个样本", "实际 " + idx.length);
}

console.log("\n=== 采样起点（小时粒度下 24h = 24 点）===");
{
  const rows = makeRows(2000, 60, (i) => 100 + i);
  const { perHour, start } = Eval.buildIndex(rows, 50, 24);
  ok(perHour === 1, "perHour = 1（小时粒度）", "实际 " + perHour);
  ok(start === 30, "起点 = 30（max(30, 1×24)）", "实际 " + start);
}

console.log("\n=== 动量标注：粒度不够就给 null，不冒充 ===");
{
  const rows5 = makeRows(6000, 5, (i) => 100 + i);
  const s5 = Eval.snapshotAt(rows5, 1000, 12);
  ok(s5.symbols.BTC.change5m !== null, "5 分钟粒度：change5m 有值");
  ok(s5.symbols.BTC.change1m === null, "5 分钟粒度：change1m 为 null（拿不到就别编）");

  const rows60 = makeRows(2000, 60, (i) => 100 + i);
  const s60 = Eval.snapshotAt(rows60, 500, 1);
  ok(s60.symbols.BTC.change5m === null, "小时粒度：change5m 为 null");
  ok(s60.symbols.BTC.change24h !== null, "小时粒度：change24h 有值");
}

console.log("\n=== pctChange ===");
{
  const col = [100, 110, 121];
  ok(near(Eval.pctChange(col, 1, 1), 10), "回看 1 点：+10%");
  ok(near(Eval.pctChange(col, 2, 2), 21), "回看 2 点：+21%");
  ok(Eval.pctChange(col, 0, 1) === null, "回看越界：null，不是 0");
}

console.log("\n=== 结算：胜率只算卖出，盈亏含手续费 ===");
{
  // 构造：先买后卖，卖价高于买价 → 盈利
  const rows = makeRows(600, 5, (i) => 100);
  const acct = Strategy.freshAccount(10000);
  const cfg = { threshold: 0.5, cooldownSec: 0, allocPct: 50, riskGate: false };
  const trades = [];
  const t0 = rows[0].ts;
  const d1 = Strategy.decide("BTC", { action: "buy", probabilities: { buy: 1 } }, 100, null, cfg, acct, t0);
  trades.push({ action: d1.action, msg: Strategy.execute("BTC", d1.action, 100, cfg, acct, t0) });
  const d2 = Strategy.decide("BTC", { action: "sell", probabilities: { sell: 1 } }, 110, null, cfg, acct, t0 + 1000);
  trades.push({ action: d2.action, msg: Strategy.execute("BTC", d2.action, 110, cfg, acct, t0 + 1000) });
  const sim = Eval.settle(acct, trades, rows);
  ok(sim.trades === 2, "2 笔成交");
  ok(sim.sells === 1 && sim.winRate === 1, "1 笔卖出且盈利 → 胜率 100%", "实际 " + sim.winRate);
  ok(acct.fees > 0, "手续费被计入（" + acct.fees.toFixed(2) + "）");
  ok(sim.pnlPct > 0 && sim.pnlPct < 5, "净收益为正但小于 10%（因为扣了手续费）", "实际 " + sim.pnlPct.toFixed(2) + "%");
}

console.log("\n=== verdict：基线字段名与四档判断 ===");
{
  const base = { median: 5, p10: -3, p90: 12, buyHoldPct: 20 };
  const v = (pnl, trades = 10) => Eval.verdict({ pnlPct: pnl, trades }, base);
  ok(/比随机信号的中位数/.test(v(1)), "低于中位数 → 判定为「没有任何证据」", v(1));
  ok(/噪声区间/.test(v(9)), "落在区间内 → 「看不出 edge」", v(9));
  ok(/高于随机 90 分位/.test(v(15)), "高于 90 分位 → 「但仍需确认」", v(15));
  ok(/跑输「买入并持有」/.test(v(15)), "同时提示跑输买入持有");
  ok(/一笔都没成交/.test(v(0, 0)), "零成交 → 单独一条提示");
  ok(Eval.verdict({ pnlPct: 5, trades: 1 }, { median: undefined, p90: undefined }) === "（基线数据不完整，无法判断）",
     "基线字段名不对时显式报错，而不是悄悄变 NaN 判成利好");

  // 熊市：基线全负，符号逻辑要正确
  const bear = { median: -33, p10: -44, p90: -17, buyHoldPct: -65 };
  ok(/高于随机 90 分位/.test(Eval.verdict({ pnlPct: 4, trades: 10 }, bear)), "熊市：+4% 高于 p90(-17%)");
  ok(/噪声区间/.test(Eval.verdict({ pnlPct: -25, trades: 10 }, bear)), "熊市：-25% 落在区间内");
  ok(/比随机信号的中位数/.test(Eval.verdict({ pnlPct: -56, trades: 10 }, bear)), "熊市：-56% 低于中位数");
}

console.log("\n=== run()：用假 provider 验证「边问边跑」会传真实持仓 ===");
{
  const rows = makeRows(6000, 5, (i) => 100 + (i % 50));
  const { perHour, idx } = Eval.buildIndex(rows, 10, 576);
  const seen = [];
  const fake = {
    name: "fake", label: "假信号源", free: true,
    async signal(snap, ctx) {
      seen.push(Object.keys(ctx.positions || {}).length);
      const out = {};
      for (const s of Eval.SYMBOLS) {
        // 第一拍全买，之后全卖：用来验证持仓确实传进来了
        out[s] = { action: seen.length === 1 ? "buy" : "sell", prob: 1, risk: null };
      }
      return out;
    },
  };
  const cfg = { threshold: 0.5, cooldownSec: 0, allocPct: 50, riskGate: false };
  const r = await Eval.run({ rows, idx, perHour, provider: fake, cfg });
  ok(seen[0] === 0, "第一拍持仓为空");
  ok(seen[1] === 2, "第二拍持仓为 2（BTC+ETH 都买到了）—— 证明持仓传进了 provider", "实际 " + seen[1]);
  ok(r.dist.buy === 2 && r.dist.sell === 18, "1 拍买 + 9 拍卖", `buy=${r.dist.buy} sell=${r.dist.sell}`);
  ok(r.sim.buys === 2, "实际买入 2 笔（每个标的 1 笔）", "实际 " + r.sim.buys);
}

console.log("\n=== 机械规则 provider ===");
{
  const up = { change24h: 3, change1h: 1, change5m: 0.1 };
  const down = { change24h: -3, change1h: -1, change5m: -0.1 };
  const mixed = { change24h: 3, change1h: -1, change5m: 0 };
  const snap = (q) => ({ ts: 0, symbols: { BTC: { symbol: "BTC", price: 100, ...q },
                                           ETH: { symbol: "ETH", price: 5, ...q } } });
  const g = async (key, q) => (await Eval.ruleProvider(key).signal(snap(q))).BTC.action;
  ok((await g("rule:trend-up", up)) === "buy", "涨就买跌就卖：双正 → buy");
  ok((await g("rule:trend-up", down)) === "sell", "涨就买跌就卖：双负 → sell");
  ok((await g("rule:trend-up", mixed)) === "hold", "涨就买跌就卖：矛盾 → hold");
  ok((await g("rule:h24", up)) === "buy", "只看24h：正 → buy");
  ok((await g("rule:h24", down)) === "sell", "只看24h：负 → sell");
  ok((await g("rule:revert", down)) === "buy", "反向：跌 → buy");
  ok((await g("rule:flat", up)) === "hold", "一直空仓：永远 hold");

  // 缺动量时不许瞎猜：页面和回测共用同一份规则定义（assets/strategy.js）
  const S = require(path.join(ROOT, "assets/strategy.js"));
  ok(S.naiveSignal("涨就买跌就卖", { change24h: null, change1h: 1 }) === null,
     "缺动量 → null（页面上显示「动量不足」，不伪装成 hold）");
  ok(S.naiveSignal("涨就买跌就卖", null) === null, "没有行情 → null");
  ok((await Eval.ruleProvider("rule:trend-up")
        .signal({ symbols: { BTC: { change24h: null, change1h: null }, ETH: { change24h: null, change1h: null } } })
      ).BTC.action === "hold", "回测里缺动量回落到 hold（保守，不编信号）");
  ok(Eval.RULES === S.NAIVE_RULES, "lib/eval.js 与页面用的是同一份规则定义（不是两份拷贝）");
}

console.log("\n" + "=".repeat(60));
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log("=".repeat(60));
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试崩了:", e); process.exit(1); });
