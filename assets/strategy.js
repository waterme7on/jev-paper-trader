/* 交易规则 —— 浏览器和 Node 共用同一份
 *
 * 为什么必须共用：回测和实盘如果用两套代码，回测结果就没有意义了。
 * 所以这里用 UMD 包装，浏览器 <script> 直接引，Node 里 require 也能用。
 *
 * 注意：这里只有「规则」，没有任何预测逻辑。
 * 信号（buy/sell/hold）是 Jev 给的，这里负责的是：
 *   信号 → 要不要执行（阈值 / 冷却 / 风控）→ 怎么执行（仓位 / 手续费）→ 记账
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Strategy = api;
})(typeof self !== "undefined" ? self : this, function () {

  const FEE = 0.001;              // 手续费假设 0.1%（双边）

  /**
   * 信号 → 动作。
   * @param {string} symbol
   * @param {object} dec  Jev 的答案 { action, probabilities, confidence }
   * @param {number} price
   * @param {number|null} riskProb  marketRisk 概率
   * @param {object} cfg   { threshold, cooldownSec, riskGate }
   * @param {object} acct  { positions, cash, lastActionAt }
   * @param {number} now   时间戳（回测时是历史时刻，所以必须传进来）
   * @returns {{action:string, note:string, signal:string, prob:number}}
   */
  function decide(symbol, dec, price, riskProb, cfg, acct, now) {
    if (!dec) return { action: "hold", note: "Jev 没返回这个标的", signal: null, prob: 0 };

    const signal = dec.action || "hold";
    const prob = (dec.probabilities && dec.probabilities[signal]) || 0;

    // 1) 风控闸门：只在要买的时候拦，卖出永远放行（风控的目的是别在高波动里上车）
    if (cfg.riskGate && riskProb != null && riskProb >= 0.5 && signal === "buy") {
      return { action: "hold", note: "风控拦截（风险概率 " + riskProb.toFixed(2) + " ≥ 0.5）", signal, prob };
    }
    // 2) 信号本身是 hold
    if (signal === "hold") {
      return { action: "hold", note: "信号 hold（" + prob.toFixed(2) + "）", signal, prob };
    }
    // 3) 概率阈值
    if (prob < cfg.threshold) {
      return { action: "hold", note: signal + " 概率 " + prob.toFixed(2) + " < 阈值 " + cfg.threshold.toFixed(2), signal, prob };
    }
    // 4) 同标的冷却
    // now 必须由调用方传入：实盘传 Date.now()，回测传历史时刻。
    // 早期版本 execute() 内部用 Date.now() 记时间戳，回测时「现在」是历史时刻，
    // 算出来的 gap 是个巨大负数，导致冷却永远命中、卖出被永久锁死。
    const last = (acct.lastActionAt && acct.lastActionAt[symbol]) || 0;
    const gap = (now - last) / 1000;
    if (cfg.cooldownSec > 0 && gap > 0 && gap < cfg.cooldownSec) {
      return { action: "hold", note: "冷却中（" + gap.toFixed(0) + "s / " + cfg.cooldownSec + "s）", signal, prob };
    }
    // 5) 可行性
    if (signal === "buy") {
      if (acct.positions && acct.positions[symbol]) return { action: "hold", note: "已持仓，不重复买入", signal, prob };
      if (acct.cash <= 1) return { action: "hold", note: "没有可用现金", signal, prob };
    }
    if (signal === "sell") {
      if (!acct.positions || !acct.positions[symbol]) return { action: "hold", note: "空仓，无可卖", signal, prob };
    }
    return { action: signal, note: "", signal, prob };
  }

  /**
   * 执行动作，直接改 acct。
   * @returns {string} 成交描述，空串表示没成交
   */
  function execute(symbol, action, price, cfg, acct, now) {
    const t = now || Date.now();
    if (action === "buy") {
      const amount = acct.cash * ((cfg.allocPct || 50) / 100);
      if (amount <= 1) return "现金不足";
      const fee = amount * FEE;
      const qty = (amount - fee) / price;
      acct.cash -= amount;
      acct.fees = (acct.fees || 0) + fee;
      acct.positions[symbol] = { qty, avgPrice: price };
      acct.lastActionAt[symbol] = t;
      return "买入 " + qty.toFixed(6) + " @ " + price.toFixed(2) + "（投入 " + amount.toFixed(2) + "）";
    }
    if (action === "sell") {
      const p = acct.positions && acct.positions[symbol];
      if (!p) return "空仓";
      const gross = p.qty * price;
      const fee = gross * FEE;
      acct.cash += gross - fee;
      acct.fees = (acct.fees || 0) + fee;
      acct.realized += (price - p.avgPrice) * p.qty - fee;
      delete acct.positions[symbol];
      acct.lastActionAt[symbol] = t;
      const pnlPct = ((price - p.avgPrice) / p.avgPrice) * 100;
      return "卖出 " + p.qty.toFixed(6) + " @ " + price.toFixed(2) + "（" + (pnlPct >= 0 ? "+" : "") + pnlPct.toFixed(2) + "%）";
    }
    return "";
  }

  /** 总权益 = 现金 + 持仓市值 */
  function equityAt(acct, prices) {
    let v = acct.cash;
    for (const s of Object.keys(acct.positions || {})) {
      const p = acct.positions[s];
      if (p && prices[s]) v += p.qty * prices[s];
    }
    return v;
  }

  function freshAccount(initCash) {
    return {
      initCash: initCash || 10000,
      cash: initCash || 10000,
      positions: {},
      realized: 0,
      fees: 0,
      lastActionAt: {},
      decisions: [],
      points: [],
      createdAt: Date.now(),
    };
  }

  /* 机械规则：不调模型，只看动量的正负号。
   *
   * 为什么放在这里（和交易规则同一份 UMD）：
   * 这几轮回测最重要的发现是「一行 if 的机械规则也能跑赢模型」。
   * 所以页面上要能实时显示「同样行情下，一行 if 会说什么」——
   * 那这条规则就必须和回测里用的是**同一份定义**，否则又变成两套代码。
   * lib/eval.js 的 ruleProvider 直接引这里的 NAIVE_RULES。
   *
   * @param {object} q  { change24h, change1h }（null 视为「不知道」，不做判断）
   */
  const NAIVE_RULES = {
    "涨就买跌就卖": (q) => (q.change1h > 0 && q.change24h > 0 ? "buy"
                        : (q.change1h < 0 && q.change24h < 0 ? "sell" : "hold")),
    "只看24h":     (q) => (q.change24h > 0 ? "buy" : "sell"),
    "只看1h":      (q) => (q.change1h > 0 ? "buy" : "sell"),
    "反向(跌买)":   (q) => (q.change24h < 0 ? "buy" : (q.change24h > 0 ? "sell" : "hold")),
    "一直空仓":     () => "hold",
  };

  /** 页面上默认对照用的那条规则（回测里牛熊两个窗口综合表现最稳的一条） */
  const NAIVE_DEFAULT = "涨就买跌就卖";

  function naiveSignal(name, q) {
    const fn = NAIVE_RULES[name || NAIVE_DEFAULT];
    if (!fn || !q) return null;
    // 动量缺失时不要瞎猜——回测里同样的情况也是给 null
    if (q.change24h == null || q.change1h == null) return null;
    return fn(q) || "hold";
  }

  return { FEE, decide, execute, equityAt, freshAccount, NAIVE_RULES, NAIVE_DEFAULT, naiveSignal };
});
