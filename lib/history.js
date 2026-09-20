/* 历史行情数据源。
 *
 * 为什么要这个模块：回测喂给 Jev 的状态必须和线上一致，否则测的是另一套东西。
 *
 * 线上每拍给模型的是 change24h / change1h / change5m / change1m 四个动量。
 * 但 CoinGecko 免费层有两个硬伤：
 *   1. 区间越长粒度越粗 —— days=1 → 5 分钟；days=7 / 90 → 1 小时
 *      （所以长周期回测里 5m / 1m 只能是 null，模型只拿到一半特征）
 *   2. 只能取「最近 N 天」，没法指定历史区间 —— 想测 2022 年那轮熊市，它给不了
 *
 * Coinbase Exchange 的 K 线接口两个问题都能解：恒定粒度 + 支持任意 start/end，
 * 且免 key。代价是单次最多 300 根，所以这里做逐页拼接。
 *
 * 1 分钟动量仍然不取（1 分钟粒度翻页量太大），保持 null ——
 * 宁可让模型知道「这个没有」，也不要拿 5 分钟变化冒充 1 分钟。
 */

const PER_PAGE = 300;              // 单次返回上限，与粒度无关

const PRODUCTS = { BTC: "BTC-USD", ETH: "ETH-USD" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCandles(product, startMs, endMs, gran, timeoutMs = 20000) {
  const url = `https://api.exchange.coinbase.com/products/${product}/candles`
    + `?granularity=${gran}&start=${new Date(startMs).toISOString()}&end=${new Date(endMs).toISOString()}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    // 429 就按 Retry-After 退避一次
    if (r.status === 429) {
      const ra = Number(r.headers.get("retry-after") || 2);
      await sleep(Math.min(ra, 10) * 1000);
      const r2 = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      if (!r2.ok) throw new Error(`HTTP ${r2.status} ${product}（重试后）`);
      return parseCandles(await r2.json(), product);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${product}`);
    return parseCandles(await r.json(), product);
  } finally { clearTimeout(t); }
}

function parseCandles(j, product) {
  if (!Array.isArray(j)) throw new Error(`返回不是数组：${JSON.stringify(j).slice(0, 120)}`);
  // 每根：[ time, low, high, open, close, volume ]，按时间倒序
  return j.map((c) => ({ ts: c[0] * 1000, price: c[4] }));
}

/**
 * 取某个标的在 [startMs, endMs) 区间内、粒度为 gran 秒的 K 线序列（正序）。
 * 逐页向前推进，直到覆盖整个区间或没有更多数据。
 */
async function fetchWindow(symbol, startMs, endMs, gran = 300, opts = {}) {
  const product = PRODUCTS[symbol];
  if (!product) throw new Error("未知标的 " + symbol);

  const delay = opts.delayMs == null ? 220 : opts.delayMs;
  const verbose = opts.verbose !== false;
  const pageSpan = gran * PER_PAGE * 1000;

  const all = [];
  let cursorEnd = endMs;
  let pages = 0;
  const maxPages = Math.ceil((endMs - startMs) / pageSpan) + 4;

  while (cursorEnd > startMs && pages < maxPages) {
    const cursorStart = Math.max(startMs, cursorEnd - pageSpan);
    let batch;
    try {
      batch = await getCandles(product, cursorStart, cursorEnd, gran);
    } catch (e) {
      // 单页失败不致命：记下来，用已有数据继续
      if (verbose) console.log(`    ! ${symbol} 第 ${pages + 1} 页失败：${e.message}`);
      break;
    }
    if (!batch.length) break;
    all.push(...batch);
    pages++;
    if (verbose && pages % 20 === 0) {
      process.stdout.write(`\r    ${symbol}: 已取 ${all.length} 根（${pages}/${maxPages} 页）   `);
    }
    const oldest = batch[batch.length - 1].ts;
    if (oldest >= cursorEnd) break;       // 没有推进，防止死循环
    cursorEnd = oldest;                   // 下一页到这一页最早的一根为止（不含）
    await sleep(delay);
  }

  if (!all.length) throw new Error("没取到 " + symbol + " 的历史数据");

  // 去重 + 正序 + 按粒度对齐
  const bucket = gran * 1000;
  const byTs = new Map();
  for (const p of all) if (p.ts >= startMs && p.ts < endMs) byTs.set(Math.floor(p.ts / bucket) * bucket, p.price);
  const out = [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, price]) => ({ ts, price }));

  if (verbose) {
    const spanH = (out[out.length - 1].ts - out[0].ts) / 3600000;
    console.log(`  ${symbol}: ${out.length} 根，跨度 ${(spanH / 24).toFixed(1)} 天，`
      + `${gran / 60} 分钟粒度，${pages} 页`);
  }
  return out;
}

/** 取多个标的在指定窗口内的序列并对齐到同一条时间轴 */
async function fetchAllWindow(symbols, startMs, endMs, gran = 300, opts = {}) {
  const out = {};
  for (const s of symbols) out[s] = await fetchWindow(s, startMs, endMs, gran, opts);
  return out;
}

/** 便捷入口：最近 days 天，5 分钟粒度 */
function fetchSeries(symbol, days, opts = {}) {
  const end = Date.now();
  return fetchWindow(symbol, end - days * 86400000, end, 300, opts);
}

function fetchAll(symbols, days, opts = {}) {
  return fetchAllWindow(symbols, Date.now() - days * 86400000, Date.now(), 300, opts);
}

module.exports = { fetchSeries, fetchAll, fetchWindow, fetchAllWindow, PER_PAGE, PRODUCTS };
