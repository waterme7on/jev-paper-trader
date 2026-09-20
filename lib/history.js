/* 历史行情数据源。
 *
 * 为什么要这个模块：回测喂给 Jev 的状态必须和线上一致，否则测的是另一套东西。
 *
 * 线上每拍给模型的是 change24h / change1h / change5m / change1m 四个动量。
 * 但 CoinGecko 免费层有个硬伤：区间越长粒度越粗——
 *   days=1  → 5 分钟粒度，四个动量都有
 *   days=90 → 小时粒度，只有 24h / 1h 可信，5m / 1m 只能给 null
 * 也就是说，用 CoinGecko 跑长周期回测时，模型只拿到一半特征。
 *
 * Coinbase Exchange 的 K 线接口能给出真实的 5 分钟粒度，且免 key，
 * 只是单次最多 300 根（= 25 小时），所以这里做逐页回溯拼接。
 * 这样长周期回测也能算出真实的 5m 动量。
 *
 * 1 分钟动量仍然拿不到（1 分钟粒度要翻 432 页，不值得），
 * 保持 null —— 宁可让模型知道「这个没有」，也不要拿 5 分钟变化冒充 1 分钟。
 */

const GRAN = 300;              // 5 分钟
const PER_PAGE = 300;          // 单次上限
const PAGE_SPAN = GRAN * PER_PAGE * 1000;

const PRODUCTS = { BTC: "BTC-USD", ETH: "ETH-USD" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCandles(product, startMs, endMs, timeoutMs = 20000) {
  const url = `https://api.exchange.coinbase.com/products/${product}/candles`
    + `?granularity=${GRAN}&start=${new Date(startMs).toISOString()}&end=${new Date(endMs).toISOString()}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${product}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`返回不是数组：${JSON.stringify(j).slice(0, 120)}`);
    // 每根：[ time, low, high, open, close, volume ]，按时间倒序
    return j.map((c) => ({ ts: c[0] * 1000, price: c[4] }));
  } finally { clearTimeout(t); }
}

/**
 * 取某个标的近 days 天的 5 分钟序列（正序）。
 * 逐页向前回溯，直到覆盖要求的区间或没有更多数据。
 */
async function fetchSeries(symbol, days, opts = {}) {
  const product = PRODUCTS[symbol];
  if (!product) throw new Error("未知标的 " + symbol);

  const end = Date.now();
  const start = end - days * 86400000;
  const delay = opts.delayMs == null ? 220 : opts.delayMs;
  const verbose = opts.verbose !== false;

  const all = [];
  let cursorEnd = end;
  let pages = 0;
  const maxPages = Math.ceil((days * 86400000) / PAGE_SPAN) + 4;

  while (cursorEnd > start && pages < maxPages) {
    const cursorStart = Math.max(start, cursorEnd - PAGE_SPAN);
    let batch;
    try {
      batch = await getCandles(product, cursorStart, cursorEnd);
    } catch (e) {
      // 单页失败不致命：记下来，用已有数据继续
      if (verbose) console.log(`    ! ${symbol} 第 ${pages + 1} 页失败：${e.message}`);
      break;
    }
    if (!batch.length) break;
    all.push(...batch);
    pages++;
    if (verbose && pages % 20 === 0) {
      process.stdout.write(`\r    ${symbol}: 已取 ${all.length} 根（${pages} 页）   `);
    }
    // 这一页最早的一根，下一页就到这里为止
    const oldest = batch[batch.length - 1].ts;
    if (oldest >= cursorEnd) break;       // 没有推进，防止死循环
    cursorEnd = oldest - 1;
    await sleep(delay);
  }

  if (!all.length) throw new Error("没取到 " + symbol + " 的历史数据");

  // 去重 + 正序 + 按 5 分钟对齐
  const byTs = new Map();
  for (const p of all) byTs.set(Math.floor(p.ts / (GRAN * 1000)) * GRAN * 1000, p.price);
  const out = [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, price]) => ({ ts, price }));

  if (verbose) {
    const spanH = (out[out.length - 1].ts - out[0].ts) / 3600000;
    console.log(`  ${symbol}: ${out.length} 根，跨度 ${spanH.toFixed(0)} 小时（${(spanH / 24).toFixed(1)} 天），5 分钟粒度，${pages} 页`);
  }
  return out;
}

/** 取多个标的并对齐到同一条时间轴 */
async function fetchAll(symbols, days, opts = {}) {
  const out = {};
  for (const s of symbols) out[s] = await fetchSeries(s, days, opts);
  return out;
}

module.exports = { fetchSeries, fetchAll, GRAN, PRODUCTS };
