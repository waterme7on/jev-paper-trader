# Jev 纸面交易台（BTC / ETH）

用 [Vercel AI Gateway](https://vercel.com/ai-gateway) 上的 `typesafe-ai/jev` 当决策引擎，
每 5 秒对 BTC / ETH 评估一次，画出买卖点与决策历史。

**纸面交易（paper trading）。不接交易所，不下真实订单，不碰任何资金。**
账户、持仓、成交、盈亏全部存在访问者自己的浏览器 `localStorage` 里。

---

## 先说清楚它不是什么

这一点比功能重要，写在最前面：

**Jev 是评估模型，不是价格预测模型。** 它的接口是「给你一段状态描述和判别标准，
判断这件事成立吗 / 属于哪一类」——它不会预测未来价格。

这个项目里它做的事是：**按写死的 criteria 给当前盘面分类**（买 / 卖 / 不动）。
这套信号有没有预测力，**未经任何回测验证**。目前能观察到的只是「盘面很平时它会说 hold，
置信度低」——这跟「它能赚钱」是两回事。

所以：

- ❌ 不是投资建议，不是能跑的策略
- ✅ 是一个能跑通的「模型即决策引擎」的完整骨架：真实行情 → 结构化状态 → 模型评估 → 执行 → 记账 → 可视化

---

## 回测结果（2026-09-20，真实历史行情）

上面说「未经验证」，那就去验证。用 `tools/backtest.js` 把**和线上完全同一套规则**跑到过去 7 天的真实行情上：

| 项 | 结果 |
|---|---|
| 样本 | 70 个时点 × 2 个标的 = **140 次 Jev 判断**，2026-09-14 → 09-20，小时粒度 |
| **Jev 说 buy** | **0 次** |
| Jev 说 sell | 13 次（BTC 6 / ETH 7） |
| Jev 说 hold | 127 次（**90.7%**） |
| 实际成交 | **0 笔**（没买过，自然也没得卖） |
| 策略收益 | 0.00%（全程空仓） |
| 买入持有基准 | **+2.76%** |
| 差额 | **-2.76 个百分点** |

**拆开看为什么一笔都没成交**（48 次判断的诊断样本）：

| 原因 | 占比 |
|---|---|
| Jev 自己说 hold | 88% |
| Jev 说 sell，但空仓没得卖 | 13% |
| 被风控闸门拦 | **0%**（marketRisk 中位 0.13、最大 0.34，压根没到 0.5） |
| 被概率阈值拦 | 0% |

**结论：不是规则太严，是模型本身几乎不输出 buy。** 风控和阈值都不是瓶颈。

再叠加一个更值得警惕的信号：那一周买入持有是 **+2.76%**（上涨），而 Jev 给出的 13 次「动作」全是 **sell**。方向是反的。

**这个结果说明什么**

- 现在的 `buy` criteria 写得偏严（要求短周期和中周期同时向上），而 `hold` 是个巨大的兜底筐（「信号矛盾、横盘无序」）——很可能是 criteria 的表述问题，而不是模型能力问题。**值得改 criteria 再测一轮**，但不要为了让它成交而放宽：那是在拟合噪声。
- 140 次判断、一周、单一行情区间 —— **样本量太小，不足以得出「Jev 不能做交易信号」的结论**。只能说：**当前这套配置下它不交易。**
- 真要判断有没有 edge，需要：更长区间、跨牛熊、把 criteria 改成可对照的多组、并且和随机信号做基线比较。

**自己跑一遍**：

```bash
export AI_GATEWAY_API_KEY=vck_xxx
node tools/backtest.js --days 7 --samples 70 --step 2
# 常用参数：--days 1 (5分钟粒度) / --threshold 0.55 / --cooldown 0 / --alloc 50
```

限流 30 次/60 秒，脚本默认 2.6 秒间隔 ≈ 23 次/分；70 个样本约 3.5 分钟，实际扣费 $0。

---

## 架构

```
浏览器 (assets/app.js)          服务端 (Vercel Serverless)
┌────────────────────┐          ┌──────────────────────────┐
│ 每 5 秒 tick       │  GET     │ api/tick.js              │
│ 账户 / 持仓 / 历史  │ ───────► │  1. CoinGecko 取行情      │
│ localStorage 持久化 │  /api/   │  2. 组装 state            │
│ 执行买卖 / 记账     │  tick    │  3. 问 Jev（1 请求 3 问） │
│ 画图 / 渲染         │ ◄─────── │  4. 返回决策              │
└────────────────────┘          └──────────────────────────┘
```

**为什么账户放前端**：Serverless 是短暂的，写内存会丢，接数据库又超出「基础网站」的范围。
前端 localStorage 反而成了最可靠的权威账本——刷新不丢，清空可控。

**为什么每拍只发 1 个 Jev 请求**：BTC、ETH、风控三个问题打包在同一个请求里。
Jev 实测限流 **30 次 / 60 秒**，5 秒一拍 = 12 次/分钟，留在限内。

**为什么访问人数不会放大调用量**：`api/tick.js` 做了两层收敛——

1. **新鲜期缓存**：结果按持仓签名缓存 5 秒，期内直接复用
2. **并发合并**：同时到达的请求 `await` 同一个 in-flight Promise

实测 4 个并发请求只触发 1 次 Jev 调用。所以不管多少人同时打开，Jev 调用恒定 ≈12 次/分钟。

---

## Jev 的输入

每一拍真正发出去的状态（`state`）长这样：

```
这是一个加密货币纸面交易账户，交易 BTC 与 ETH 两个标的，每 5 秒重新评估一次。

BTC：现价 80313.61 USD；24h -0.87%；1h -0.08%；5m +0.12%；1m -0.03%。 当前空仓。
ETH：现价 2574.59 USD；24h -1.87%；1h -0.05%；5m +0.08%；1m +0.01%。 当前空仓。
```

问题（`questions`）：

| id | 类型 | 含义 |
|---|---|---|
| `BTC` / `ETH` | choice | `buy` / `sell` / `hold`，criteria 见 `lib/jev.js` |
| `marketRisk` | boolean | 是否处于剧烈波动、不宜开新仓的状态 |

criteria 是写死的，页面底部「Jev 看到的状态 & 判别标准」里能看到原文，也可以 `GET /api/criteria` 取。

**信号要变成实际成交，还要过三道闸**（都在前端，可调）：

1. 概率 ≥ 阈值（默认 0.55）
2. 同标的冷却（默认 60 秒）
3. 风控开关：`marketRisk` ≥ 0.5 时强制不买

---

## 部署

### 环境变量

| 变量 | 说明 |
|---|---|
| `AI_GATEWAY_API_KEY` | **必需**。Vercel AI Gateway 的 key（`vck_` 开头）。没配的话 `/api/tick` 返回 502 并给出提示 |

```bash
vercel env add AI_GATEWAY_API_KEY        # 粘贴 key，选 Production / Preview / Development
```

> ⚠️ AI Gateway 要求账户绑定有效信用卡才会处理请求，**免费模型也一样**。
> 这是实测结论，官方文档没写。没绑卡的表现是所有端点一律 `403 customer_verification_required`。

### 上线

```bash
vercel deploy --prod
```

零依赖，不需要 `npm install`。`api/*.js` 由 Vercel 识别为 Node Serverless Function，
根目录静态文件直接托管。

### 本地

```bash
npx vercel dev          # 需要 .env 里写 AI_GATEWAY_API_KEY
```

---

## 已知限制

| 项 | 说明 |
|---|---|
| **决策历史不跨设备** | 存在 localStorage，换浏览器就没了 |
| **服务端历史会丢** | `recent` 字段依赖 lambda 实例存活，冷启动清空；权威记录只在前端 |
| **冷启动没有短周期动量** | 5m / 1m 涨跌幅靠实例内累积的价格序列，刚启动是「未知」，Jev 会被告知以 24h / 1h 为准 |
| **行情源有免费额度** | CoinGecko 免 key 但有速率限制；拿不到时退回 Coinbase（只有现货价，无 24h 涨跌） |
| **Binance 不能用** | 美国 IP（含 Vercel us-east）返回 `451 Service unavailable from a restricted location`，已实测确认 |
| **上游会超时** | 实测约 2/40 概率出现超时或 504，前端会跳过该拍并在下一拍重试，价格不断线 |
| **信号没有预测力验证** | 最重要的一条，见开头 |

---

## 文件

```
index.html            页面结构
assets/app.js         主循环、账户、执行、渲染、画图
assets/style.css      样式（深色）
api/tick.js           一个节拍：行情 → Jev → 决策（含缓存与并发合并）
api/criteria.js       暴露判别标准，避免前后端各写一份
lib/market.js         行情：CoinGecko 主 + Coinbase 兜底 + 动量计算
lib/jev.js            Jev 客户端：state 组装、questions 定义、限流头解析
```

## 来源

- 模型页 <https://vercel.com/ai-gateway/models/jev>
- 评估能力文档 <https://vercel.com/docs/ai-gateway/modalities/evaluation>
- 限流实测值（30 次 / 60 秒）来自 2026-09-20 用真实 key 压测，429 响应头 `X-Ratelimit-Limit-Requests` 直接给出
