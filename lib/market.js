// 行情数据源。
//
// 选 CoinGecko 的原因：一次请求就能拿到 BTC + ETH 两个价格，且不需要 API key。
// Binance 试过——从美国 IP（含 Vercel 的 us-east 区域）会返回
// 451 "Service unavailable from a restricted location"，所以不能用。
// Coinbase 只给现货价，没有 24h 涨跌，作为兜底。

const CG_SIMPLE = "https://api.coingecko.com/api/v3/simple/price";
const CG_CHART = "https://api.coingecko.com/api/v3/coins";
const CB_SPOT = "https://api.coinbase.com/v2/prices";
const CB_EXCHANGE = "https://api.exchange.coinbase.com";

const IDS = { BTC: "bitcoin", ETH: "ethereum" };
const SYMBOLS = ["BTC", "ETH"];

// ---------------------------------------------------------------- 模块级缓存
// Serverless 是短暂的，但同一个 lambda 实例会被复用，所以这些数据在实例存活期间有效。
// 冷启动后会重建——代码里所有用到它们的地方都必须能容忍「暂时没有」。

const ring = [];              // 逐 tick 的价格序列，用来算 1m / 5m 动量
const RING_MAX = 400;         // 5s 一笔的话约 33 分钟
let chartCache = { at: 0, data: null };
const CHART_TTL_MS = 5 * 60 * 1000;

function pushRing(symbol, price, ts) {
  ring.push({ symbol, price, ts });
  for (const s of SYMBOLS) {
    const n = ring.filter((r) => r.symbol === s).length;
    if (n > RING_MAX) {
      const idx = ring.findIndex((r) => r.symbol === s);
      if (idx >= 0) ring.splice(idx, 1);
    }
  }
}

function series(symbol) {
  return ring.filter((r) => r.symbol === symbol).sort((a, b) => a.ts - b.ts);
}

function changeOver(symbol, windowMs, now) {
  const s = series(symbol);
  if (s.length < 2) return null;
  const latest = s[s.length - 1];
  const cutoff = now - windowMs;
  // 找窗口内最早的一笔
  let ref = null;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i].ts <= cutoff) { ref = s[i]; break; }
  }
  if (!ref) {
    // 窗口比现有历史还长，用最早那笔做参考（会低估，但比没有强）
    ref = s[0];
    if (now - ref.ts < windowMs * 0.5) return null;   // 历史太短，不给数
  }
  if (!ref.price) return null;
  return ((latest.price - ref.price) / ref.price) * 100;
}

// ---------------------------------------------------------------- 拉取

async function getJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "jev-paper-trader/1.0" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 现货价 + 24h 涨跌。失败时退回 Coinbase（只有价格，没有涨跌）。 */
async function fetchSpot() {
  const ids = SYMBOLS.map((s) => IDS[s]).join(",");
  const url =
    CG_SIMPLE +
    "?ids=" + ids +
    "&vs_currencies=usd" +
    "&include_24hr_change=true" +
    "&include_last_updated_at=true" +
    "&precision=2";
  try {
    const d = await getJson(url);
    const out = {};
    for (const s of SYMBOLS) {
      const row = d[IDS[s]];
      if (!row || typeof row.usd !== "number") throw new Error("缺 " + s);
      out[s] = {
        price: row.usd,
        change24h: typeof row.usd_24h_change === "number" ? row.usd_24h_change : null,
      };
    }
    return { quotes: out, source: "coingecko" };
  } catch (e) {
    // 兜底：Coinbase 逐个取。
    // 注意别只取价格就完事 —— Coinbase spot 接口不给 24h 涨跌，
    // 而 24h 是四个动量里权重最高的一个，丢掉它模型和机械规则都少了一半输入。
    // 所以用 Coinbase Exchange 的 stats（含 24h 开盘价）把 change24h 补回来。
    const out = {};
    let ok = false;
    for (const s of SYMBOLS) {
      try {
        const d = await getJson(CB_SPOT + "/" + s + "-USD/spot");
        const v = parseFloat(d?.data?.amount);
        if (!Number.isFinite(v)) continue;
        out[s] = { price: v, change24h: null };
        ok = true;
        try {
          const st = await getJson(CB_EXCHANGE + "/products/" + s + "-USD/stats", 8000);
          const last = parseFloat(st?.last), open = parseFloat(st?.open);
          if (Number.isFinite(last) && Number.isFinite(open) && open > 0) {
            out[s].change24h = ((last - open) / open) * 100;
          }
        } catch (_) { /* 24h 拿不到就算了，价格还是要的 */ }
      } catch (_) { /* 这个标的放弃 */ }
    }
    if (!ok) throw new Error("行情源全部不可用：" + e.message);
    return { quotes: out, source: "coinbase(fallback)" };
  }
}

/** 1 小时涨跌，用来给 Jev 一个中周期动量。5 分钟缓存一次，冷启动后也能立刻有数。 */
async function fetchHourChange(now) {
  if (chartCache.data && now - chartCache.at < CHART_TTL_MS) {
    return chartCache.data;
  }
  const out = {};
  try {
    for (const s of SYMBOLS) {
      try {
        const d = await getJson(
          CG_CHART + "/" + IDS[s] + "/market_chart?vs_currency=usd&days=1", 10000
        );
        const pts = d?.prices || [];
        if (pts.length < 2) continue;
        const last = pts[pts.length - 1][1];
        const cutoff = pts[pts.length - 1][0] - 60 * 60 * 1000;
        let ref = pts[0][1];
        for (let i = pts.length - 1; i >= 0; i--) {
          if (pts[i][0] <= cutoff) { ref = pts[i][1]; break; }
        }
        if (Number.isFinite(last) && Number.isFinite(ref) && ref > 0) {
          out[s] = ((last - ref) / ref) * 100;
        }
      } catch (_) { /* 拿不到就算了，不是致命的 */ }
    }
  } catch (_) { /* 同上 */ }
  chartCache = { at: now, data: out };
  return out;
}

/**
 * 一次快照：现货价 + 各周期动量。
 * 返回结构里每个字段都可能是 null —— 消费方必须处理缺值。
 */
async function getSnapshot() {
  const now = Date.now();
  const [{ quotes, source }, hour] = await Promise.all([
    fetchSpot(),
    fetchHourChange(now).catch(() => ({})),
  ]);

  for (const s of SYMBOLS) {
    if (quotes[s] && Number.isFinite(quotes[s].price)) pushRing(s, quotes[s].price, now);
  }

  const out = { ts: now, source, symbols: {} };
  for (const s of SYMBOLS) {
    const q = quotes[s];
    if (!q) continue;
    out.symbols[s] = {
      symbol: s,
      price: q.price,
      change24h: q.change24h,
      change1h: Number.isFinite(hour[s]) ? hour[s] : null,
      change5m: changeOver(s, 5 * 60 * 1000, now),
      change1m: changeOver(s, 60 * 1000, now),
      // 冷启动后的前几个 tick 没有足够历史，前端要据此提示
      warmup: series(s).length < 3,
    };
  }
  return out;
}

module.exports = { getSnapshot, SYMBOLS, series };
