// lib/jev.js 的类型声明。存在理由同 market.d.ts —— 让 allowJs: false 的
// TypeScript 宿主（yololab.cc）能直接 import 这些 CommonJS 模块。

import type { MarketSnapshot } from "./market.js";

export interface Position {
  qty: number;
  avgPrice: number;
}

export type VariantKey = "strict" | "reversion" | "trend";

export interface VariantCriteria {
  label: string;
  buy: string;
  sell: string;
  hold: string;
}

/** Jev 对一道题的回答。answers 的键形如 "BTC" / "ETH" / "marketRisk"。 */
export interface JevAnswer {
  action?: "buy" | "sell" | "hold";
  probabilities?: Record<string, number>;
  confidence?: number | null;
  [key: string]: unknown;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  usage: Record<string, unknown>;
  gateway: Record<string, unknown>;
  latencyMs: number;
}

export declare const MODEL: string;
export declare const VARIANTS: Record<string, VariantCriteria>;
export declare const ACTION_CRITERIA: Record<string, string>;
export declare const RISK_CRITERIA: Record<string, string>;

/** 按 variant 组装给 Jev 的问题集（含每标的的判别标准和一道市场风险题）。 */
export declare function buildQuestions(
  symbols: string[],
  variant?: string,
): Record<string, unknown>;

/**
 * 把盘面 + 持仓写成一段给 Jev 读的状态描述。
 * positions 必须传真实持仓 —— 卖出的判别标准原文写着「已有持仓且出现见顶迹象」，
 * 传空的话模型全程不知道自己买过。
 */
export declare function buildState(
  snapshot: MarketSnapshot,
  positions?: Record<string, Position> | null,
): string;

/** 调 Jev。apiKey 由调用方注入（Cloudflare 里从 env 取），不读 process.env。 */
export declare function evaluate(
  state: string,
  questions: Record<string, unknown>,
  apiKey: string,
  timeoutMs?: number,
): Promise<JevResult>;
