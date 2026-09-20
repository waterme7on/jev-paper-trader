/* 回测评估框架：把「采样 → 构造状态 → 取信号 → 执行 → 结算 → 比基线」串起来。
 *
 * 为什么抽出来：
 * 之前这套逻辑在三份脚本里各写了一遍（backtest / compare-criteria / naive-baseline），
 * pctChange、START、equityAt 全是三份拷贝。而**重复正是 bug 的来源**——
 * 「采样起点没按粒度算」这个 bug 要在两个地方各修一次，「随机基线的概率给 0.9 还是 1」
 * 在两份里还不一样。现在只有一份。
 *
 * 核心抽象是 **provider（信号源）**：
 *     async signal(snapshot, ctx) -> { BTC: {action, prob}, ETH: {...} }
 * 至于信号是模型给的、一行 if 给的、还是随机数给的，框架不关心——
 * 所以「Jev 变体」「机械规则」「随机」是同一种东西，可以直接放在同一张表里比。
 *
 * 这正好是这几轮回测最重要的经验：**光有随机基线不够，还必须有「无模型基线」**。
 * 把两者做成同一个 provider 接口，对照就是一行命令的事。
 */

const path = require("path");
const ROOT = path.join(__dirname, "..");
const Strategy = require(path.join(ROOT, "assets/strategy.js"));
const history = require(path.join(ROOT, "lib/history.js"));

const SYMBOLS = ["BTC", "ETH"];
const IDS = { BTC: "bitcoin", ETH: "ethereum" };
const INIT_CASH = 10000;
const ACTIONS = ["buy", "sell", "hold"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 行情与采样

async function getJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/**
 * 取行情并对齐到同一条时间轴。
 * from/to 优先（能取历史区间，测牛熊必备）；否则按 days 从 CoinGecko 或 Coinbase 取。
 */
async function loadMarket(opts = {}) {
  const { from, to, days, gran = 5, source = "coingecko", verbose = true } = opts;
  let series;

  if (from && to) {
    const s = Date.parse(from), e = Date.parse(to);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new Error(`无效区间：${from} → ${to}`);
    if (verbose) {
      console.log(`  数据源 Coinbase Exchange（${gran} 分钟 K 线，翻页拼接）`);
      console.log(`  区间 ${new Date(s).toISOString().slice(0, 10)} → ${new Date(e).toISOString().slice(0, 10)}`
        + `（${((e - s) / 86400000).toFixed(0)} 天）`);
    }
    series = await history.fetchAllWindow(SYMBOLS, s, e, gran * 60);
  } else if (source === "coinbase") {
    if (verbose) console.log(`  数据源 Coinbase Exchange（5 分钟 K 线）—— 最近 ${days} 天`);
    series = await history.fetchAll(SYMBOLS, parseFloat(days));
  } else {
    if (verbose) console.log(`  数据源 CoinGecko（days=${days}）`);
    series = {};
    for (const s of SYMBOLS) {
      const d = await getJson(`https://api.coingecko.com/api/v3/coins/${IDS[s]}/market_chart?vs_currency=usd&days=${days}`);
      series[s] = ((d && d.prices) || []).map(([ts, p]) => ({ ts, price: p }));
    }
  }

  const spine = series.BTC, eth = series.ETH;
  let j = 0;
  const rows = spine.map((b) => {
    while (j + 1 < eth.length && Math.abs(eth[j + 1].ts - b.ts) < Math.abs(eth[j].ts - b.ts)) j++;
    return { ts: b.ts, BTC: b.price, ETH: eth[j].price };
  });
  if (!rows.length) throw new Error("没取到行情数据");
  return rows;
}

const pctChange = (col, i, back) => {
  const k = Math.max(0, i - back);
  return k === i ? null : ((col[i] - col[k]) / col[k]) * 100;
};

/**
 * 采样。**起点必须按数据粒度算**：5 分钟粒度下 24h 需要回看 288 个点，
 * 写死第 30 点的话 change24h 实际只跨 2.5 小时却标成「24h」——在骗模型。
 */
function buildIndex(rows, samples, step) {
  const perHour = Math.max(1, Math.round(3600000 / (rows[1].ts - rows[0].ts)));
  const start = Math.min(Math.floor(rows.length / 3), Math.max(30, perHour * 24));
  const idx = [];
  for (let i = start; i < rows.length && idx.length < samples; i += step) idx.push(i);
  return { perHour, start, idx };
}

/** 构造与线上每拍一致的 snapshot。粒度不够的动量给 null，不拿长周期冒充短周期。 */
function snapshotAt(rows, i, perHour) {
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
}

// ---------------------------------------------------------------- 信号源（provider）

/**
 * 机械规则：不调模型，只看动量符号。用来回答「这到底是模型的功劳吗」。
 * 定义放在 assets/strategy.js（UMD），浏览器页面和这里用的是**同一份**——
 * 页面上实时显示的「一行 if 会说什么」，必须和回测里跑的是同一条规则。
 */
const RULES = Strategy.NAIVE_RULES;

const RULE_KEYS = { "rule:trend-up": "涨就买跌就卖", "rule:h24": "只看24h", "rule:h1": "只看1h",
                    "rule:revert": "反向(跌买)", "rule:flat": "一直空仓" };

function ruleProvider(key) {
  const name = RULE_KEYS[key] || key;
  if (!RULES[name]) throw new Error("未知机械规则：" + key + "（可选：" + Object.keys(RULE_KEYS).join(", ") + "）");
  return {
    name: key, label: name, free: true,
    async signal(snapshot) {
      const out = {};
      for (const s of SYMBOLS) {
        const a = Strategy.naiveSignal(name, snapshot.symbols[s]) || "hold";
        out[s] = { action: a, prob: 1, risk: null };   // prob=1：机械规则没有概率，别被阈值卡住
      }
      return out;
    },
  };
}

function randomProvider() {
  return {
    name: "random", label: "随机信号", free: true,
    async signal() {
      const out = {};
      for (const s of SYMBOLS) out[s] = { action: ACTIONS[Math.floor(Math.random() * 3)], prob: 1, risk: null };
      return out;
    },
  };
}

/**
 * Jev provider。
 * 注意 ctx.positions —— 必须把**当前持仓**传给模型，否则它不知道自己已经买了，
 * 而 sell 的 criteria 原文写着「已有持仓且出现见顶迹象」。
 */
function jevProvider(variant, apiKey, opts = {}) {
  const jev = require(path.join(ROOT, "lib/jev.js"));
  const delay = opts.delayMs == null ? 2600 : opts.delayMs;
  if (!jev.VARIANTS[variant]) throw new Error("未知 criteria 变体：" + variant
    + "（可选：" + Object.keys(jev.VARIANTS).join(", ") + "）");
  return {
    name: "jev:" + variant, label: "Jev " + variant + "（" + jev.VARIANTS[variant].label + "）",
    free: false,
    async signal(snapshot, ctx) {
      if (!apiKey) throw new Error("缺少 AI_GATEWAY_API_KEY");
      const state = jev.buildState(snapshot, ctx.positions || {});
      const res = await jev.evaluate(state, jev.buildQuestions(SYMBOLS, variant), apiKey);
      const risk = res.answers.marketRisk ? res.answers.marketRisk.probability : null;
      const out = {};
      for (const s of SYMBOLS) {
        const a = res.answers[s];
        if (!a) continue;
        const action = a.choice || "hold";
        out[s] = { action, prob: (a.probabilities && a.probabilities[action]) || 0, risk };
      }
      return out;
    },
    delayMs: delay,
  };
}

/** 按名字造 provider：jev:<variant> / rule:<name> / random */
function makeProvider(spec, apiKey, opts = {}) {
  if (spec === "random") return randomProvider();
  if (spec.startsWith("rule:")) return ruleProvider(spec);
  if (spec.startsWith("jev:")) return jevProvider(spec.slice(4), apiKey, opts);
  throw new Error("未知信号源：" + spec + "（支持 jev:<variant> / rule:<name> / random）");
}

// ---------------------------------------------------------------- 跑一遍

/**
 * 用一个 provider 跑完整场。
 * 边问边跑：持仓随成交变化，下一拍 provider 就能看到（和线上一致）。
 */
async function run({ rows, idx, perHour, provider, cfg, onStep }) {
  const acct = Strategy.freshAccount(INIT_CASH);
  const trades = [];
  const dist = { buy: 0, sell: 0, hold: 0 };
  let errors = 0;

  for (let n = 0; n < idx.length; n++) {
    const i = idx[n], t = rows[i].ts;
    const snap = snapshotAt(rows, i, perHour);
    try {
      const sig = await provider.signal(snap, { positions: acct.positions, ts: t, acct, n });
      for (const s of SYMBOLS) {
        const g = sig[s];
        if (!g) continue;
        dist[g.action] = (dist[g.action] || 0) + 1;
        // 归一化成 api/tick.js 给前端的形状，Strategy 收到的才和线上一致
        const dec = { action: g.action, probabilities: { [g.action]: g.prob }, confidence: 1 };
        const d = Strategy.decide(s, dec, snap.symbols[s].price, g.risk == null ? null : g.risk, cfg, acct, t);
        const msg = (d.action === "buy" || d.action === "sell")
          ? Strategy.execute(s, d.action, snap.symbols[s].price, cfg, acct, t) : "";
        if (msg) trades.push({ n, symbol: s, action: d.action, price: snap.symbols[s].price, ts: t, msg });
      }
    } catch (e) {
      errors++;
      if (e.rateLimit && e.rateLimit.retryAfter) await sleep(Math.min(e.rateLimit.retryAfter, 40) * 1000);
    }
    if (onStep) onStep(n + 1, idx.length);
    if (provider.delayMs) await sleep(provider.delayMs);
  }
  return { dist, trades, sim: settle(acct, trades, rows), errors };
}

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

/** 随机基线：同规则、同样本，蒙特卡洛取分布 */
async function randomBaseline({ rows, idx, perHour, cfg, monte = 200 }) {
  const out = [];
  for (let k = 0; k < monte; k++) {
    const r = await run({ rows, idx, perHour, provider: randomProvider(), cfg });
    out.push(r.sim.pnlPct);
  }
  out.sort((a, b) => a - b);
  return {
    median: out[Math.floor(out.length * 0.5)],
    p10: out[Math.floor(out.length * 0.1)],
    p90: out[Math.floor(out.length * 0.9)],
    monte,
  };
}

/** 买入持有：起点均分两个标的，一直拿到最后 */
function buyHoldPct(rows, start) {
  const first = rows[start], last = rows[rows.length - 1];
  const bh = (INIT_CASH / 2) * (last.BTC / first.BTC) + (INIT_CASH / 2) * (last.ETH / first.ETH);
  return ((bh - INIT_CASH) / INIT_CASH) * 100;
}

const pct = (v) => (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%";

/**
 * 给一个 provider 的结果下判断：对比随机基线和买入持有。
 * base = { median, p10, p90, buyHoldPct }
 * 注意字段名：randomBaseline 返回的是 median / p90。早期这里写成 randomMedian /
 * randomP90，取到 undefined → NaN → 所有比较都走 else 分支，连巨亏也会被判成
 * 「高于随机 90 分位」。所以下面显式做一次数字校验。
 */
function verdict(sim, base) {
  const med = base.median, p90 = base.p90, bh = base.buyHoldPct;
  if (!Number.isFinite(med) || !Number.isFinite(p90)) return "（基线数据不完整，无法判断）";
  if (!sim.trades) return "一笔都没成交 —— 这一轮里它不交易。";

  const vsRandom = sim.pnlPct - med;
  const vsHold = Number.isFinite(bh) ? sim.pnlPct - bh : null;
  let s;
  if (vsRandom < 0) {
    s = `比随机信号的中位数（${pct(med)}）还低，没有任何证据说明它有 edge。`;
  } else if (sim.pnlPct <= p90) {
    s = `落在随机信号的噪声区间内（90% 上界 ${pct(p90)}），看不出 edge。`;
  } else {
    s = `高于随机 90 分位（${pct(p90)}）——但仍需更多区间确认，别急着下结论。`;
  }
  if (vsHold != null && vsHold < 0) {
    s += ` 而且跑输「买入并持有」${Math.abs(vsHold).toFixed(1)} 个百分点（${pct(bh)}）。`;
  }
  return s;
}

module.exports = {
  SYMBOLS, INIT_CASH,
  loadMarket, buildIndex, snapshotAt, pctChange,
  RULES, RULE_KEYS, ruleProvider, randomProvider, jevProvider, makeProvider,
  run, settle, randomBaseline, buyHoldPct, pct, verdict,
};
