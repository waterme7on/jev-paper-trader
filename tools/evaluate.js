#!/usr/bin/env node
/* 统一回测入口：一次命令把「模型 / 机械规则 / 随机」放在同一张表里比。
 *
 * 为什么要有这个：
 * 这几轮回测最重要的教训是——**光有随机基线不够，还必须有「无模型基线」**。
 * 随机基线只能证明「策略不等于乱猜」，证明不了「模型有价值」。
 * 真正该问的是：同样的行情、同样的规则，**一行 if 能不能做得一样好？**
 * 把三者做成同一个 provider 接口后，这件事就是一条命令。
 *
 * 用法：
 *   # 只跑机械规则（零 API 调用，秒级，用来先探行情）
 *   node tools/evaluate.js --from 2022-01-01 --to 2022-07-01 --providers rule:h24,rule:trend-up,rule:flat
 *
 *   # 模型 vs 机械规则，同一批样本
 *   node tools/evaluate.js --from 2026-06-23 --to 2026-09-20 --samples 89 --step 288 \
 *        --providers jev:trend,rule:trend-up,rule:h24,rule:flat
 *
 *   # 三套 criteria 对照
 *   node tools/evaluate.js --days 90 --samples 89 --step 24 --providers jev:strict,jev:reversion,jev:trend
 *
 * provider 写法：
 *   jev:<variant>   调模型（variant ∈ strict / reversion / trend），受 30 次/60 秒限流
 *   rule:<name>     机械规则：trend-up / h24 / h1 / revert / flat，不调模型
 *   random          随机信号（也默认作为基线跑 monte 次）
 *
 * 旧的三个脚本仍在：backtest.js（单套详细诊断）、compare-criteria.js（三套对照）、
 * naive-baseline.js（只跑机械规则）。这个入口是它们的公共抽象。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const Eval = require(path.join(ROOT, "lib/eval.js"));

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const FROM = arg("from", null);
const TO = arg("to", null);
const DAYS = arg("days", "90");
const GRAN = parseInt(arg("gran", "5"), 10);
const SOURCE = arg("source", "coingecko");
const SAMPLES = parseInt(arg("samples", "90"), 10);
const STEP = parseInt(arg("step", "288"), 10);
const MONTE = parseInt(arg("monte", "200"), 10);
const PROVIDERS = (arg("providers", "jev:trend,rule:trend-up,rule:h24,rule:flat")).split(",").map((s) => s.trim()).filter(Boolean);
const OUT = arg("save", null);
const QUIET = argv.includes("--quiet");

const cfg = {
  threshold: parseFloat(arg("threshold", "0.55")),
  cooldownSec: parseInt(arg("cooldown", "60"), 10),
  allocPct: parseFloat(arg("alloc", "50")),
  riskGate: arg("riskGate", "1") !== "0",
};

const apiKey = process.env.AI_GATEWAY_API_KEY
  || (fs.existsSync("/tmp/.jev-key") ? fs.readFileSync("/tmp/.jev-key", "utf8").trim() : null);

(async () => {
  console.log("=== 取历史行情 ===");
  const rows = await Eval.loadMarket({ from: FROM, to: TO, days: DAYS, gran: GRAN, source: SOURCE });
  const { perHour, start, idx } = Eval.buildIndex(rows, SAMPLES, STEP);
  console.log(`  ${rows.length} 个点，粒度 ${(rows[1].ts - rows[0].ts) / 60000} 分钟`
    + ` | 取样 ${idx.length} 个（第 ${start} 点起，每 ${STEP} 点）\n`);

  const results = [];
  for (const spec of PROVIDERS) {
    const p = Eval.makeProvider(spec, apiKey, { delayMs: parseFloat(arg("delay", "2.6")) * 1000 });
    if (!p.free && !apiKey) { console.log(`  跳过 ${spec}：缺少 AI_GATEWAY_API_KEY`); continue; }
    console.log(`=== ${p.label} ===`);
    let last = 0;
    const r = await Eval.run({
      rows, idx, perHour, provider: p, cfg,
      onStep: (n, total) => {
        if (QUIET) return;
        const now = Date.now();
        if (n === total || now - last > 250) { process.stdout.write(`\r  进度 ${n}/${total}   `); last = now; }
      },
    });
    console.log(`\n  信号分布 ${JSON.stringify(r.dist)}`);
    console.log(`  成交 ${r.sim.trades}（买 ${r.sim.buys} / 卖 ${r.sim.sells}）`
      + `  期末 ${Eval.pct(r.sim.pnlPct)}` + (r.errors ? `  （失败 ${r.errors} 次）` : "") + "\n");
    results.push({ spec, name: p.name, label: p.label, ...r });
  }

  // ---------------------------------------------------------------- 基线
  console.log(`=== 基线：随机信号（蒙特卡洛 ${MONTE} 次）===`);
  const base = await Eval.randomBaseline({ rows, idx, perHour, cfg, monte: MONTE });
  const bh = Eval.buyHoldPct(rows, start);
  base.buyHoldPct = bh;

  const W = 78;
  console.log("\n" + "=".repeat(W));
  console.log(`  区间 ${new Date(rows[start].ts).toISOString().slice(0, 10)}`
    + ` → ${new Date(rows[rows.length - 1].ts).toISOString().slice(0, 10)}`
    + ` | ${idx.length} 样本 × ${Eval.SYMBOLS.length} 标的 | 粒度 ${(rows[1].ts - rows[0].ts) / 60000} 分钟`);
  console.log("=".repeat(W));
  console.log("  " + "信号源".padEnd(26) + "buy".padStart(6) + "sell".padStart(6) + "hold".padStart(6)
    + "成交".padStart(7) + "胜率".padStart(8) + "收益".padStart(11));
  console.log("  " + "-".repeat(W - 2));
  for (const r of results) {
    console.log("  " + r.label.slice(0, 25).padEnd(26)
      + String(r.dist.buy || 0).padStart(6) + String(r.dist.sell || 0).padStart(6) + String(r.dist.hold || 0).padStart(6)
      + String(r.sim.trades).padStart(7)
      + (r.sim.winRate == null ? "      —" : (r.sim.winRate * 100).toFixed(0).padStart(6) + "%")
      + Eval.pct(r.sim.pnlPct).padStart(11));
  }
  console.log("  " + "-".repeat(W - 2));
  console.log("  " + "随机基线（" + MONTE + " 次）".padEnd(26)
    + "".padStart(25) + ("中位 " + Eval.pct(base.median)).padStart(11));
  console.log("    90% 区间  " + Eval.pct(base.p10) + " ~ " + Eval.pct(base.p90));
  console.log("  " + "买入持有".padEnd(26) + "".padStart(25) + Eval.pct(bh).padStart(11));
  console.log("  " + "一直空仓".padEnd(26) + "".padStart(25) + Eval.pct(0).padStart(11));
  console.log("=".repeat(W));

  console.log("\n  逐项判断");
  for (const r of results) console.log(`  • ${r.label}：${Eval.verdict(r.sim, base)}`);

  if (OUT) {
    const out = {
      run_at: new Date().toISOString(),
      config: { from: FROM, to: TO, days: DAYS, gran: GRAN, source: SOURCE,
                samples: idx.length, step: STEP, monte: MONTE, ...cfg },
      window: { from: new Date(rows[start].ts).toISOString(), to: new Date(rows[rows.length - 1].ts).toISOString() },
      results,
      baselines: base,
    };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`\n  已保存：${OUT}`);
  }
})().catch((e) => { console.error("失败:", e.message); process.exit(1); });
