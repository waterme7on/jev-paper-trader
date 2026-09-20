/* Strategy 单元测试 —— 不需要网络，也不需要 Jev。
 *
 * 为什么必须有这个：实盘跑了一天 Jev 全是 HOLD，execute() 从来没被调用过。
 * 「买卖点」是核心功能，不能一直是没跑过的代码。
 */

const S = require("../assets/strategy.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const cfg = { threshold: 0.55, cooldownSec: 60, allocPct: 50, riskGate: true };
const mk = () => S.freshAccount(10000);
const buy = (p = 0.9) => ({ action: "buy", probabilities: { buy: p, sell: 1 - p, hold: 0 } });
const sell = (p = 0.9) => ({ action: "sell", probabilities: { sell: p, buy: 1 - p, hold: 0 } });

console.log("\n[1] 买入");
{
  const a = mk(); const t = 1000000;
  const d = S.decide("BTC", buy(), 100, null, cfg, a, t);
  ok("信号 buy 且概率够 → 动作 buy", d.action === "buy", d.note);
  const msg = S.execute("BTC", d.action, 100, cfg, a);
  ok("返回成交描述", /买入/.test(msg), msg);
  ok("现金扣掉一半（allocPct=50）", near(a.cash, 5000), String(a.cash));
  ok("持仓建立", !!a.positions.BTC);
  // 投入 5000，手续费 0.1% = 5，所以实际买入价值 4995
  ok("持仓价值 = 投入 - 手续费", near(a.positions.BTC.qty * 100, 4995, 0.01), String(a.positions.BTC.qty * 100));
  ok("成本均价 = 成交价", near(a.positions.BTC.avgPrice, 100));
  ok("手续费已记", near(a.fees, 5, 0.01), String(a.fees));
}

console.log("\n[2] 卖出盈利");
{
  const a = mk(); const t = 1000000;
  S.execute("BTC", S.decide("BTC", buy(), 100, null, cfg, a, t).action, 100, cfg, a, t);
  const t2 = t + 120000;   // 过了 60s 冷却
  const d = S.decide("BTC", sell(), 110, null, cfg, a, t2);
  ok("冷却结束后可卖", d.action === "sell", d.note);
  S.execute("BTC", d.action, 110, cfg, a, t2);
  ok("持仓清空", !a.positions.BTC);
  // 买 4995 价值 → 卖 110，涨 10%
  const expectRealized = (110 - 100) * a.positions0 || 0;
  ok("已实现盈亏为正", a.realized > 0, String(a.realized));
  ok("权益 = 现金（已空仓）", near(S.equityAt(a, { BTC: 110 }), a.cash));
  ok("权益 > 初始资金", S.equityAt(a, { BTC: 110 }) > 10000, String(S.equityAt(a, { BTC: 110 })));
}

console.log("\n[3] 卖出亏损");
{
  const a = mk(); const t = 1000000;
  S.execute("BTC", S.decide("BTC", buy(), 100, null, cfg, a, t).action, 100, cfg, a, t);
  S.execute("BTC", S.decide("BTC", sell(), 90, null, cfg, a, t + 120000).action, 90, cfg, a, t + 120000);
  ok("已实现盈亏为负", a.realized < 0, String(a.realized));
  ok("权益 < 初始资金", S.equityAt(a, { BTC: 90 }) < 10000);
}

console.log("\n[4] 阈值拦截");
{
  const a = mk();
  const d = S.decide("BTC", buy(0.4), 100, null, cfg, a, 1000000);
  ok("概率 0.4 < 阈值 0.55 → 不动", d.action === "hold", d.note);
  ok("备注里写了原因", /阈值/.test(d.note), d.note);
}

console.log("\n[5] 冷却拦截");
{
  const a = mk(); const t = 1000000;
  S.execute("BTC", S.decide("BTC", buy(), 100, null, cfg, a, t).action, 100, cfg, a, t);
  const d = S.decide("BTC", sell(), 110, null, cfg, a, t + 10000);   // 只过了 10s
  ok("冷却 60s 内 → 不动", d.action === "hold", d.note);
  ok("备注说明冷却中", /冷却/.test(d.note), d.note);
  const d2 = S.decide("BTC", sell(), 110, null, cfg, a, t + 61000);  // 过了 61s
  ok("冷却结束 → 放行", d2.action === "sell", d2.note);
}

console.log("\n[6] 风控闸门");
{
  const a = mk();
  const d = S.decide("BTC", buy(), 100, 0.8, cfg, a, 1000000);
  ok("风险概率 0.8 ≥ 0.5 → 拦住买入", d.action === "hold", d.note);
  ok("备注说明是风控", /风控/.test(d.note), d.note);
  // 卖出不受风控限制（风控的目的是别在高波动里上车，不是不让下车）
  const a2 = mk(); const t = 1000000;
  S.execute("BTC", S.decide("BTC", buy(), 100, null, cfg, a2, t).action, 100, cfg, a2, t);
  ok("高波动下仍然允许卖出", S.decide("BTC", sell(), 110, 0.9, cfg, a2, t + 120000).action === "sell");
  // 关闭风控后买入放行
  const cfg2 = Object.assign({}, cfg, { riskGate: false });
  ok("关掉风控 → 买入放行", S.decide("BTC", buy(), 100, 0.8, cfg2, mk(), 1000000).action === "buy");
}

console.log("\n[7] 可行性检查");
{
  const a = mk(); const t = 1000000;
  S.execute("BTC", S.decide("BTC", buy(), 100, null, cfg, a, t).action, 100, cfg, a, t);
  ok("已持仓时不重复买入", S.decide("BTC", buy(), 100, null, cfg, a, t).action === "hold");
  const b = mk();
  ok("空仓时不能卖", S.decide("BTC", sell(), 100, null, cfg, b, 1000000).action === "hold");
  const c = mk(); c.cash = 0.5;
  ok("现金不足时不买", S.decide("BTC", buy(), 100, null, cfg, c, 1000000).action === "hold");
}

console.log("\n[8] 边界");
{
  ok("没有信号时安全返回 hold", S.decide("BTC", null, 100, null, cfg, mk(), 1).action === "hold");
  ok("缺 probabilities 时不崩", S.decide("BTC", { action: "buy" }, 100, null, cfg, mk(), 1).action === "hold");
  const a = mk();
  const m = S.execute("BTC", "hold", 100, cfg, a);
  ok("执行 hold 不产生成交", m === "" && !a.positions.BTC);
  ok("equityAt 忽略没有报价的标的", S.equityAt(mk(), {}) === 10000);
  ok("手续费常量是 0.1%", near(S.FEE, 0.001));
}

console.log("\n[9] 两个标的独立记账");
{
  const a = mk(); const t = 1000000;
  S.execute("BTC", S.decide("BTC", buy(), 100, null, cfg, a, t).action, 100, cfg, a, t);
  ok("买 BTC 后还剩 5000", near(a.cash, 5000), String(a.cash));
  S.execute("ETH", S.decide("ETH", buy(), 2000, null, cfg, a, t).action, 2000, cfg, a, t);
  ok("再买 ETH 后剩 2500（各占初始的 50%→25%）", near(a.cash, 2500), String(a.cash));
  ok("两个持仓都在", !!a.positions.BTC && !!a.positions.ETH);
  ok("权益 = 现金 + 两个持仓市值", near(S.equityAt(a, { BTC: 100, ETH: 2000 }), 2500 + 4995 + 2497.5, 0.1));
}

console.log("\n" + (fail === 0
  ? `全部通过（${pass} 项）`
  : `${pass} 通过 / ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
