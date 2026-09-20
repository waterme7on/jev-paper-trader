// lib/market.js 的类型声明。
//
// 存在的理由：yololab.cc 把本仓库当 git 子模块用，而它的 tsconfig 是
// `allowJs: false` —— 直接从 TypeScript 里 import 这些 CommonJS 文件会报
// TS7016（找不到声明文件），CI 的 `npm run typecheck` 会挂。TS 解析
// `./market.js` 时会自动找同名的 .d.ts，所以声明放在这里就够了，
// 宿主仓库不必为它开 allowJs。

export interface Quote {
  symbol: string;
  price: number;
  /** 24h / 1h / 5m / 1m 涨跌幅（百分比）。数据源没给或历史窗口不足时为 null。 */
  change24h: number | null;
  change1h: number | null;
  change5m: number | null;
  change1m: number | null;
  /** 冷启动后短周期数据还不够，调用方应据此提示而不是假装数据完整。 */
  warmup: boolean;
}

export interface MarketSnapshot {
  ts: number;
  /** 实际生效的数据源，例如 "coingecko" 或 "coinbase(fallback)"。 */
  source: string;
  symbols: Record<string, Quote>;
}

export interface PriceTick {
  symbol: string;
  price: number;
  ts: number;
}

export declare const SYMBOLS: string[];

/** 现货价 + 各周期涨跌幅。失败时自动退回 Coinbase 兜底。 */
export declare function getSnapshot(): Promise<MarketSnapshot>;

export interface ChartSeriesResult {
  /** 按时间升序。拿不到的标的直接缺席（键不存在），不是给空数组。 */
  series: Record<string, PriceTick[]>;
  /** 序列实际来自哪个源：coingecko / coinbase / mixed / unavailable。 */
  source: string;
}

/**
 * 画图用的历史价格序列，days 传 1 / 7 / 30。5 分钟缓存。
 *
 * CoinGecko 免费层限流很凶，而序列只有它能给，所以失败时退回 Coinbase Exchange
 * 的 candles——不补这一段，一被限流图就整个空了。
 *
 * 拿不到时让标的缺席而不是给空数组：「没有数据」和「有数据但零个点」是两回事，
 * 调用方能区分才不会画出一条假的平线。
 */
export declare function getChartSeries(days?: number): Promise<ChartSeriesResult>;

/**
 * 逐 tick 的价格序列（按时间升序）。
 * 注意这是进程内的环形缓冲（上限 400 笔/标的），Serverless 冷启动后是空的。
 */
export declare function series(symbol: string): PriceTick[];
