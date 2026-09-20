// GET /api/criteria —— 把判别标准暴露出来，前端不用复制一份（避免两边不一致）

const jev = require("../lib/jev");

// 2026-09-20 的对照实验结果：同一批样本、同一套交易规则，只换 criteria。
// 数字列在这里是为了让前端如实展示，而不是只挑好看的。
// 详见 README「三套 criteria 的对照实验」。
//
// 90 天那轮（89 样本 / 2026-06-23 → 09-20）样本量够了，结论从「看不出来」
// 变成「没有 edge」：trend 的 +12.40% 比随机基线的中位数 +12.75% 还低一点，
// 胜率 48%，而买入持有是 +41.71%（这 90 天是强上涨）。
const BACKTEST = {
  note: "89 个样本 / 90 天（2026-06-23 → 09-20）/ 小时粒度；7 天那轮结果一致，见 README",
  baseline: { randomMedianPct: 12.75, randomP10Pct: 2.82, randomP90Pct: 21.44, buyHoldPct: 41.71 },
  results: {
    strict:    { buy: 0,  sell: 14, hold: 164, trades: 0,  pnlPct: 0.00 },
    reversion: { buy: 0,  sell: 0,  hold: 178, trades: 0,  pnlPct: 0.00 },
    trend:     { buy: 77, sell: 50, hold: 51,  trades: 52, pnlPct: 12.40, winRate: 0.48 },
  },
  // 上面那轮只用小时粒度，5m / 1m 是 null，而线上是有的。
  // 用真实 5 分钟 K 线（Coinbase）重跑 trend 后：收益升到 +17.19%，
  // 第一次站上随机中位（+13.04%）——但仍在随机 90% 区间内，且胜率从 48% 掉到 25%。
  // 结论不变：没有 edge。这条是「结论是否稳健」的关键证据，所以也摆在页面上。
  fidelity: {
    note: "换真实 5 分钟 K 线重跑 trend（同一区间、同样 89 样本）：收益 +17.19%，"
      + "比随机中位 +13.04% 高，但仍在随机 90% 区间（上界 +23.50%）内；"
      + "胜率反而从 48% 掉到 25%，收益靠少数几笔大赢撑起来。跑输买入持有 25.3 个百分点。",
  },
  // 上面全是上涨行情。补了一轮熊市（2022 上半年，BTC 4.6 万 → 1.9 万），
  // 再加一组不调模型的机械规则基线，用来回答「这是模型的功劳还是空仓本身的功劳」。
  regimes: {
    bull: { window: "2026-06-23 → 09-20", trendPct: 17.19, buyHoldPct: 43.81,
            randomMedianPct: 13.69, cashPct: 0, bestNaivePct: 28.87, bestNaiveRule: "涨就买跌就卖" },
    bear: { window: "2022-01-01 → 07-01", trendPct: -12.60, buyHoldPct: -64.85,
            randomMedianPct: -32.95, cashPct: 0, bestNaivePct: 4.19, bestNaiveRule: "只看 24h 涨买跌卖" },
    note: "熊市里「什么都不做」（0.00%）就跑赢了 Jev 的 −12.60%，"
      + "还有一行 if 的机械规则拿到 +4.19%；牛市里最好的机械规则 +28.87% 也跑赢 Jev 的 +17.19%。"
      + "两个窗口里都有不用模型的规则跑赢它 —— trend 在熊市的表现来自「空仓本身值钱」，不是模型的判断力。",
  },
};

module.exports = function handler(req, res) {
  res.setHeader("cache-control", "public, max-age=300");
  res.status(200).json({
    model: jev.MODEL,
    defaultVariant: "trend",
    variants: Object.fromEntries(Object.entries(jev.VARIANTS).map(([k, v]) => [k, {
      label: v.label,
      criteria: { buy: v.buy, sell: v.sell, hold: v.hold },
      backtest: BACKTEST.results[k] || null,
    }])),
    risk: jev.RISK_CRITERIA,
    backtest: BACKTEST,
    fidelity: BACKTEST.fidelity,
    regimes: BACKTEST.regimes,
  });
};
