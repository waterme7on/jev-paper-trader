// Jev 决策引擎。
//
// 重要前提：Jev 是**评估模型**，不是预测模型。
// 它做的是「给定一段状态描述和判别标准，判断属于哪一类 / 是否成立」，
// 它不会预测未来价格。这里让它做的是：按下面写死的 criteria 给当前盘面分类。
// 这套信号有没有预测力，是未经证实的——所以本项目是纸面交易，不碰真钱。
//
// 限流：实测 30 次 / 60 秒（429 响应头 X-Ratelimit-Limit-Requests）。
// 每拍只发 **1 个请求**（BTC + ETH + 风控 3 个问题打包在一起），
// 5 秒一拍 = 12 次/分钟，留在限内且不随访问人数放大（见 api/tick.js 的按拍去重）。

const ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
const MODEL = "typesafe-ai/jev";

// ---------------------------------------------------------------- 问题定义

const ACTION_CRITERIA = {
  buy: "动量与趋势同时向上（短周期和中周期同向为正），且不是已经连续大涨后的追高位置；回调企稳或刚启动都算",
  sell: "动量转弱或趋势向下（短周期与中周期至少一个明显为负），或已有持仓且出现见顶迹象，应减仓或离场",
  hold: "信号相互矛盾、横盘无序、涨跌幅都很小，或者刚成交不久还需要观察——不动作就是最好的动作",
};

const RISK_CRITERIA = {
  true: "短周期波动明显放大、或 24 小时涨跌幅绝对值很大，属于不宜开新仓的高风险状态",
  false: "波动在正常范围内，可以按信号执行",
};

function buildQuestions(symbols) {
  const qs = {};
  for (const s of symbols) {
    qs[s] = {
      type: "choice",
      instructions:
        "基于下面这段市场状态，这只标的在**当前这一拍**应该采取什么动作？" +
        "只看状态和给定的判别标准，不要假设任何未来走势。",
      criteria: ACTION_CRITERIA,
    };
  }
  qs.marketRisk = {
    type: "boolean",
    instructions: "整体市场当前是否处于剧烈波动、不适合开新仓的状态？",
    criteria: RISK_CRITERIA,
  };
  return qs;
}

/**
 * 把盘面 + 持仓写成一段给 Jev 读的状态描述。
 * 写清楚数值含义很重要——Jev 只能读到你写出来的东西。
 */
function buildState(snapshot, positions) {
  const lines = [];
  lines.push("这是一个加密货币纸面交易账户，交易 BTC 与 ETH 两个标的，每 5 秒重新评估一次。");
  lines.push("");
  for (const s of Object.keys(snapshot.symbols)) {
    const q = snapshot.symbols[s];
    const pos = (positions && positions[s]) || null;
    const pct = (v) => (v == null ? "未知" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%");
    let line = `${s}：现价 ${q.price.toFixed(2)} USD；`
      + `24h ${pct(q.change24h)}；1h ${pct(q.change1h)}；`
      + `5m ${pct(q.change5m)}；1m ${pct(q.change1m)}。`;
    if (q.warmup) line += "（短周期数据窗口不足，请以 24h / 1h 为准。）";
    if (pos && pos.qty > 0) {
      const pnl = ((q.price - pos.avgPrice) / pos.avgPrice) * 100;
      line += ` 当前持仓 ${pos.qty.toFixed(6)} 枚，成本均价 ${pos.avgPrice.toFixed(2)}，`
        + `浮动盈亏 ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%。`;
    } else {
      line += " 当前空仓。";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- 调用

async function evaluate(state, questions, apiKey, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
        "user-agent": "jev-paper-trader/1.0",
      },
      body: JSON.stringify({ model: MODEL, state, questions }),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }

    if (!res.ok) {
      const err = new Error(
        "Jev HTTP " + res.status + " — " + ((data && data.error && data.error.message) || text.slice(0, 200))
      );
      err.status = res.status;
      err.rateLimit = res.status === 429 ? parseRateHeaders(res.headers) : null;
      throw err;
    }
    return {
      answers: data.answers || {},
      usage: data.usage || {},
      gateway: ((data.providerMetadata || {}).gateway) || {},
      latencyMs: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// 限流头只在 429 上出现，200 上没有——要读配额就得先触发一次 429。
function parseRateHeaders(h) {
  const get = (n) => h.get ? h.get(n) : (h[n] || h[n.toLowerCase()] || null);
  const int = (v) => { const n = parseInt(String(v).replace(/s$/, ""), 10); return Number.isFinite(n) ? n : null; };
  return {
    limitRequests: int(get("x-ratelimit-limit-requests")),
    remainingRequests: int(get("x-ratelimit-remaining-requests")),
    resetRequests: get("x-ratelimit-reset-requests"),
    retryAfter: int(get("retry-after")),
  };
}

module.exports = { evaluate, buildQuestions, buildState, MODEL, ACTION_CRITERIA, RISK_CRITERIA };
