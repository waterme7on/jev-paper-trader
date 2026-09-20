// GET /api/tick —— 一个节拍：取行情 → 问 Jev → 返回决策。
//
// 前端每 5 秒调一次。但**访问人数不该放大 Jev 调用量**，所以这里做了两层收敛：
//   1. 新鲜度缓存：结果按持仓签名缓存，新鲜期 = TICK_MS（5 秒），期内直接复用
//   2. 并发合并：同时到达的请求 await 同一个 in-flight Promise
// 结果：无论多少人同时打开，Jev 调用恒定 ≈12 次/分钟，稳在 30 次/60 秒的限内。
//
// 为什么按「新鲜期」而不是「时间片」做 key：早期版本用 Math.floor(now/5000) 当 key，
// 一旦某次计算耗时跨过 5 秒边界，缓存就失效，会多打一次 Jev。改成新鲜期就没这个洞。
//
// 持仓由前端带上来（pos 参数），本函数本身不保存账户状态——
// Serverless 是短暂的，账户归前端 localStorage 管，见 assets/app.js。

const market = require("../lib/market");
const jev = require("../lib/jev");

const TICK_MS = 5000;
const HISTORY_MAX = 60;

// 默认用 trend：三套里唯一会真的产生成交的那套（见 README 的对照实验）。
// 其余两套在回测里一次 buy 都没说过，页面会一直空仓、看不到买卖点。
const DEFAULT_VARIANT = "trend";

// 模块级：同一 lambda 实例复用
const cache = new Map();      // key -> { at, payload }
let inflight = new Map();     // key -> Promise
const history = [];           // 最近若干拍，供首屏立刻有东西可看

const SYMBOLS = market.SYMBOLS;

function parsePositions(raw) {
  // 形如 "BTC:0.0123:80123.45,ETH:0:0"
  const out = {};
  if (!raw) return out;
  for (const part of String(raw).split(",")) {
    const [sym, qty, avg] = part.split(":");
    if (!sym || !SYMBOLS.includes(sym)) continue;
    const q = parseFloat(qty);
    const a = parseFloat(avg);
    if (Number.isFinite(q) && q > 0 && Number.isFinite(a) && a > 0) {
      out[sym] = { qty: q, avgPrice: a };
    }
  }
  return out;
}

function positionSignature(positions) {
  return SYMBOLS.map((s) => (positions[s] ? "H" : "-")).join("");
}

/** 缓存 key 必须带上 variant，否则换 criteria 会拿到另一套的答案 */
function cacheKey(positions, variant) {
  return positionSignature(positions) + "|" + variant;
}

function trimMaps(now) {
  for (const [k, v] of cache) {
    if (now - v.at > TICK_MS * 4) cache.delete(k);
  }
  for (const [k, v] of inflight) {
    if (now - v.at > TICK_MS * 6) inflight.delete(k);
  }
  while (history.length > HISTORY_MAX) history.shift();
}

async function compute(key, positions, variant) {
  const snapshot = await market.getSnapshot();

  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "服务端没有配置 AI_GATEWAY_API_KEY",
      hint: "在 Vercel 项目设置里加环境变量 AI_GATEWAY_API_KEY，或本地用 .env 提供。",
      snapshot,
    };
  }

  const state = jev.buildState(snapshot, positions);
  const questions = jev.buildQuestions(SYMBOLS, variant);

  let res;
  try {
    res = await jev.evaluate(state, questions, apiKey);
  } catch (e) {
    // 429 是预期内的：把服务端给的限流参数透出去，前端据此退避。
    return {
      ok: false,
      error: e.message,
      rateLimit: e.rateLimit,
      throttled: e.status === 429,
      snapshot,
      state,
    };
  }

  const decisions = {};
  for (const s of SYMBOLS) {
    const a = res.answers[s];
    if (!a) continue;
    decisions[s] = {
      action: a.choice || "hold",
      probabilities: a.probabilities || {},
      confidence: typeof a.confidence === "number" ? a.confidence : null,
    };
  }
  const risk = res.answers.marketRisk || {};

  // 先入历史，这样 recent 里能包含当前这一拍
  history.push({
    ts: snapshot.ts,
    prices: Object.fromEntries(SYMBOLS.map((s) => [s, snapshot.symbols[s] ? snapshot.symbols[s].price : null])),
    decisions: Object.fromEntries(SYMBOLS.map((s) => [s, decisions[s] ? decisions[s].action : null])),
    risk: risk.probability == null ? null : risk.probability,
    cost: res.gateway.cost == null ? null : res.gateway.cost,
    variant: variant,
  });

  const payload = {
    ok: true,
    ts: snapshot.ts,
    source: snapshot.source,
    snapshot,
    decisions,
    variant,
    risk: { probability: risk.probability == null ? null : risk.probability },
    meta: {
      latencyMs: res.latencyMs,
      usage: res.usage,
      cost: res.gateway.cost == null ? null : res.gateway.cost,
      marketCost: res.gateway.marketCost == null ? null : res.gateway.marketCost,
    },
    // 用 state 回显，方便核对 Jev 到底看到了什么
    stateEcho: state,
    // 服务端最近几拍（best effort：lambda 冷启动会清空，权威记录在前端 localStorage）
    recent: history.slice(-20),
  };

  return payload;
}

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");

  const q = (req.query && req.query.pos) || posFromUrl(req.url);
  const positions = parsePositions(q);
  const variant = ((req.query && req.query.variant) || variantFromUrl(req.url) || DEFAULT_VARIANT);
  const safeVariant = jev.VARIANTS[variant] ? variant : DEFAULT_VARIANT;
  const now = Date.now();
  const key = cacheKey(positions, safeVariant);

  trimMaps(now);

  // 1) 新鲜度缓存：5 秒内算过就直接复用
  const hit = cache.get(key);
  if (hit && now - hit.at < TICK_MS) {
    res.setHeader("x-tick-cache", "hit");
    return res.status(200).json({ ...hit.payload, cached: true, tickAgeMs: now - hit.at });
  }

  // 2) 有同拍请求在飞，等它
  const pending = inflight.get(key);
  if (pending) {
    res.setHeader("x-tick-cache", "coalesced");
    const payload = await pending.promise;
    return res.status(200).json({ ...payload, cached: true, coalesced: true });
  }

  // 3) 本拍第一个，真正去算
  const p = compute(key, positions, safeVariant);
  inflight.set(key, { at: now, promise: p });
  let payload;
  try {
    payload = await p;
  } catch (e) {
    payload = { ok: false, error: "计算出错：" + e.message };
  } finally {
    inflight.delete(key);
  }

  // 失败结果不进缓存，否则一次 429 会被冻住 5 秒
  if (payload.ok) cache.set(key, { at: now, payload });
  res.setHeader("x-tick-cache", "miss");
  return res.status(payload.ok ? 200 : (payload.throttled ? 429 : 502)).json(payload);
};

function variantFromUrl(url) {
  try {
    const u = new URL(url, "http://x");
    return u.searchParams.get("variant");
  } catch (_) { return null; }
}

function posFromUrl(url) {
  try {
    const u = new URL(url, "http://x");
    return u.searchParams.get("pos");
  } catch (_) {
    return null;
  }
}

module.exports.history = history;
