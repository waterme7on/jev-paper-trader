// GET /api/criteria —— 把判别标准暴露出来，前端不用复制一份（避免两边不一致）

const jev = require("../lib/jev");

// 2026-09-20 的对照实验结果：同一批 35 个样本、同一套交易规则，只换 criteria。
// 数字列在这里是为了让前端如实展示，而不是只挑好看的。
// 详见 README「三套 criteria 的对照实验」。
const BACKTEST = {
  note: "35 个样本 / 7 天 / 小时粒度的一轮回测，样本量太小，不构成结论",
  baseline: { randomMedianPct: 0.40, randomP10Pct: -2.08, randomP90Pct: 2.06, buyHoldPct: 2.72 },
  results: {
    strict:    { buy: 0,  sell: 6,  hold: 64, trades: 0,  pnlPct: 0.00 },
    reversion: { buy: 0,  sell: 0,  hold: 70, trades: 0,  pnlPct: 0.00 },
    trend:     { buy: 29, sell: 28, hold: 13, trades: 10, pnlPct: 2.17 },
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
  });
};
