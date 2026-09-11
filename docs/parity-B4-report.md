# B4 交付核对报告：股市三卡链路（2026-09-11）

> 基准：gzinfo @ /Users/shengc/ccworkstaion/gzinfo ｜ 验收口径见 `docs/parity-plan.md` §5 B4
> 结论：**功能对齐通过**，无行为遗漏；范围按实测发现切分（经用户拍板）；不一致项已列出并说明。

## 1. 范围（用户拍板后的 B4 定义）

按实测发现：**trading 交易面板/commentary/regen-trading 不在 gzinfo 主链**（`daily.ts` 从不产出
`report.trading`，交易面板唯一产出口是本地运维脚本 `npm run regen-trading`），故 B4 只做**主链股市链路**，
trading 面板顺延 B6 运维批次；加密模块按 D4 裁决不移植。

| 项 | gzinfo 模块 | 规模 | 2.0 落位 | 状态 |
|---|---|---|---|---|
| 行情 API | `sources/quote-api.ts` | 222 | `services/market/quotes.ts` | ✅ |
| 三卡生成 | `ai/stock-recap.ts` | 559 | `services/market/recap.ts` | ✅ |
| 收评锚定 | `ai/stock-recap-anchor.ts` | 219 | `services/market/recap-anchor.ts` | ✅ |
| 股市清单 AI | `ai/stock-news-analysis.ts` | 118 | `services/market/news-analysis.ts` | ✅ |
| 交易日状态 | `side-outputs/stock-recap.ts`（computeMarketStatus 段） | ~40 | `services/market/market-status.ts` | ✅ |
| 复盘旁路 | `side-outputs/stock-recap.ts` | 189 | `pipeline/side-outputs/side-stock-recap.ts` | ✅（接回主链） |
| 清单旁路 | `side-outputs/stock-news.ts` | 146 | `pipeline/side-outputs/side-stock-news.ts` | ✅（接回主链） |
| 股市口播 | `audio/stock-spoken.ts` | 423 | `services/voice/stock-spoken.ts` | ✅（升级 voice 股市段） |
| 广东IPO健康度（P5） | `scripts/daily.ts` ⑦.5 | ~40 | `pipeline/index.ts checkIpoHealth` | ✅（B3 遗漏补齐） |
| 加密指标（D4） | `trading/coingecko.ts` + `fear-greed.ts` | 92 | — | 🚫 裁决不移植 |
| 交易面板（顺延） | `trading/*` + `ai/trading-commentary.ts` + `render/sections.ts` 交易面板 | ~1030 | — | ⏭ B6 运维批次 |

## 2. 逐项功能核对

### 2.1 行情抓取（`quotes.ts`）
| 功能点 | gzinfo | 2.0 | 核对 |
|---|---|---|---|
| A股点位+涨跌幅 | 新浪日 K 线按目标交易日精确匹配（绝不错日） | 逐字 | ✅ |
| 港股点位+涨跌幅 | hq `f[6]`=收盘 / `f[3]`=昨收，同源自算涨跌幅 | 逐字 | ✅ |
| 美股点位+涨跌幅 | hq `f[1]`=最新收盘 / `f[2]`=涨跌幅 | 逐字 | ✅ |
| 重试语义 | 3 次尝试、600ms/1.2s 指数退避、4xx（非 429）不重试 | 逐字 | ✅ 官方测试 3 用例通过 |
| 降级 | hq 全失败 → 仅 A股 K 线 fallback（渠道标「新浪K线」） | 逐字 | ✅ |
| `prevTradingDay` | 本地构造+本地格式化，规避 UTC 偏移 | 逐字 | ✅ |

### 2.2 三卡生成（`recap.ts` + `recap-anchor.ts`）
| 功能点 | gzinfo | 2.0 | 核对 |
|---|---|---|---|
| 收评锚定 | 发布日 === 行情取值日 才锚定；同日多条按 scope→要点数→标题长排序 | 逐字 | ✅ 官方测试通过 |
| 锚定解析 | 去前缀切要点（顿号不作分隔）、噪声过滤、术语展开（科指→恒生科技指数） | 逐字 | ✅ |
| 一致性校验 | 收评 vs 行情涨跌幅差异 > 0.05pp → 以收评为真 | 逐字 | ✅ |
| LLM 生成 | 只含未锚定市场进 prompt + 显式禁写其他市场 + 指数权威核验 | 逐字 | ✅ |
| 四级抢救 | 平衡扫描 → jsonrepair → 逐市场 → 字段级 | 逐字 | ✅ 官方测试通过 |
| 指数兜底合成 | `synthesizeFallbackCard` / `synthesizeRecapFromQuotes`（空卡保底） | 逐字 | ✅ |
| 港股权威源 | `findHkRecapReport` 锚定收评入口 + `rankHkStockItems` | 逐字 | ✅ |
| 复用语义 | `selectStockRecap`：SKIP_AI 仅复用 store；AI 默认重生成 | 逐字 | ✅ B4-4 用例 |

### 2.3 股市清单（`news-analysis.ts` + `side-stock-news.ts`）
| 功能点 | gzinfo | 2.0 | 核对 |
|---|---|---|---|
| 三市场采集 | a-share/hk 取 crawled.stocks（3 天窗）、us 取 rawArticles（4 天窗） | 逐字 | ✅ |
| 每市场上限 | 12 条 | 逐字 | ✅ |
| AI 归纳 | 中性事实（summary/tags/importance），禁业务引申与投资建议 | 逐字 | ✅ |
| 主板块去重 | `filterStockNewsAgainstSections`（主板块优先） | 复用 B2 已移植件 | ✅ B4-5 用例 |
| 弱相关过滤 | A股全留；美股/港股需 STOCK_BIZ_KW 或 STOCK_MARKET_KW 命中 | 逐字 | ✅ 官方测试通过 |
| store 复用 | SKIP_AI 读 store，缺失回退原始清单 + warn | 逐字 | ✅ |

### 2.4 股市口播（`stock-spoken.ts` + voice 股市段）
| 功能点 | gzinfo | 2.0 | 核对 |
|---|---|---|---|
| 三层叙述 | 整体行情 → 结构分化（过渡句按方向+变体轮换）→ 重点板块 | 逐字 | ✅ 官方测试通过 |
| 板块打分筛选 | 资金流向(+3) > 涨跌方向/数字/异动原因(+2) > 描述充分(+1)；套话 -100 淘汰；与 overview Dice≥0.5 去重 | 逐字 | ✅ |
| 跨市场预算轮转 | 先保各市场大盘，再按 A股→港股→美股 轮转发板块，吃「总上限−已拼−收尾」剩余额度 | 逐字 | ✅ |
| 压缩 | 生产调用显式 `maxSectors: 2`（模块默认 4 供单测） | 逐字 | ✅ |
| 时区/日期标注 | A股/港股「北京时间X月X日 周X收盘」、美股「美东时间」；引导句「下面是X月X日股市收盘信息」 | 逐字 | ✅ B4-6 用例 |
| 兜底 | 板块/大盘皆缺 → 退回该市场 LLM spoken（截断 140 字） | 逐字 | ✅ |

### 2.5 交易日状态（`market-status.ts`）
| 功能点 | gzinfo | 2.0 | 核对 |
|---|---|---|---|
| 休市判定 | 周日/周六/周一 = 休市时段 | 逐字 | ✅ B4-2 用例 |
| `note` | 页面橙字警示（仅休市） | 逐字 | ✅（契约补 `note` 字段） |
| `spokenNote` | 口播恒带日期（交易日也有） | 逐字 | ✅ |

### 2.6 广东IPO 健康度（P5，B3 遗漏补齐）
| 功能点 | gzinfo | 2.0 | 核对 |
|---|---|---|---|
| 计数+分源明细 | 打印「板块 N 条 → 广东 M 条（源 明细）」 | 逐字 | ✅ |
| 0 条告警 | `::warning::`（Actions 注解） | 逐字 | ✅ |
| 滞后告警 | 最新条目 MM/DD 距今日 > 3 天 → `::warning::` | 逐字 | ✅（`dayGap` 同款） |

## 3. 架构调整清单（内容 + 理由）

| # | 调整 | 理由 |
|---|---|---|
| 1 | `IndexQuote`/`MarketQuotes`/`QuoteResult`/`StockItem` 类型上移 `contracts/market.ts` | gzinfo 定义在 quote-api / stock-recap 内部；这些类型被 services 与其消费方共同引用，归契约层符合端口-适配器架构（类型不变、行为不变） |
| 2 | 行情抓取改经 `HttpClient` 端口注入（`fetchMarketQuotes(date, http)`） | gzinfo 用全局 `fetch`；2.0 服务层不得持有副作用出口，端口注入同时让行情链路可离线测试（官方重试测试因此可注入 fake） |
| 3 | `runLlm` 直连 → `MarketLlmRunner` 注入（`services/market/runner.ts` 工厂） | 同 B2/B3 既有模式；服务层零 SDK 依赖 |
| 4 | `writeStockRecap`/`loadStockRecap`/`writeStockNews`/`loadStockNews` 的 fs 移入 `adapters/persistence.ts`（字段级 read-modify-write） | 服务层零 `node:`；保留 gzinfo 的「与 executive 共存于同一 store.json、调用顺序无关」语义 |
| 5 | `computeMarketStatus`/`formatCnDate(Short)` 从 side-output 下沉 `services/market/market-status.ts` | 口播侧（voice）与卡面侧（side-output）需共用同一套日期文案，gzinfo 靠 audio.ts 从 side-output import 实现——2.0 放 services 避免 pipeline→services 反向依赖 |
| 6 | `filterByWindow` / `dayGap` 收进 `utils/time.ts` | 与 `isWithinCalendarDays`/`todayKey` 同族纯函数；gzinfo 分别散在 ingest/merge 与 crawler staleness |
| 7 | voice 股市段从「各市场 spoken 拼接」升级为 `buildStockSpoken` 三层叙述 + 预算轮转 + 时区标注 | 对齐 gzinfo 2026-09-03/09-11 口径（卡面全、口播精） |

## 4. 按 gzinfo 对齐的行为修正（B3 遗留差异）

| # | B3 实现 | gzinfo 实际 | 处理 |
|---|---|---|---|
| V1 | 口播 hero 段：`exec.spoken_hero ?? report.hero_line` | **只读** `exec.spoken_hero` | ✅ 已改为单来源（回退路径删除） |
| V2 | must_read/insights/risk 段：exec 缺失时从 report 字段拼装 | **只读** `exec.spoken_must_read/spoken_insights/spoken_risk` | ✅ 已删除回退拼装（缺失即跳过该段并告警） |
| V3 | 无 exec 仍尝试拼口播 | gzinfo：无 store.json → 跳过语音生成 | ✅ B3 已对齐（pipeline 侧 `exec` 缺失即跳过） |

## 5. 行为等价证据

1. **gzinfo 官方测试全量移植并通过**（6 文件 / 66 用例）：`quote-api-retry`、`stock-recap-anchor`、
   `stock-recap-parse`、`stock-recap`、`stock-spoken`、`stock-news-relevance`（仅改 import 与 mock 方式）。
2. **管线级验证**（新增 `tests/pipeline-stock.test.ts`）：注入 crawlers → `runPipeline` → 三卡产出
   （`quoteDate` / 港股指数块 / 收评锚定 sectors / `marketStatus`）、`stock_news` 产出、
   `store.json` 中 `stock_recap` 与 `executive` 共存、口播稿非空；无爬虫端口时优雅降级不阻断。
3. **链路级验证**（新增 `tests/stock-side-outputs.test.ts` 7 用例）：行情解析（A股 K线/港股 f[6]/美股 f[1]）、
   交易日文案分流、store 字段级落盘、SKIP_AI 零 LLM 复用、清单去重与弱相关过滤、口播股市段前缀与板块要点、
   行情全失败降级。
4. **实测产物对照**：gzinfo `history/<date>/store.json` 的 `stock_news` 为 3×12=36 条（三市场各 12）；
   2.0 同结构落盘（本地方案一致）。
5. 全量回归：**180/180 测试通过**，`tsc --noEmit` 0 错误，`architecture:check` 通过。

## 6. 已记录的实现差异（不视为功能缺失）

| # | 差异 | 说明 |
|---|---|---|
| D1 | 主板块去重会导致部分股市条目**不出现在**股市动态 | gzinfo 同机制（主板块优先）；实测 gzinfo 生产每日 36 条说明其主板块极少收编股市条目，2.0 结构一致 |
| D2 | 交易面板（tickers/commentary/加密恐惧贪婪）未移植 | 用户裁决：加密不移植；面板主链不产出 → 顺延 B6（如需启用，届时按 B6 批次移植 `trading/*` + commentary，并明确加密剔除口径） |
| D3 | `STOCK_BIZ_KW` / `STOCK_MARKET_KW` 词表位置 | 与 gzinfo 同文件内置（未数据化），保持逐字；词表数据化不在 B4 范围 |
| D4 | 行情渠道名 | gzinfo 固定文案「新浪行情」/「新浪K线」，逐字保留 |

## 7. 顺带修正

- **AGENTS.md**（4 处过时）：`enrich/relevance.ts` 已删（B2）→ 目录描述更新；红线③终审方改为 PASS1 keep；
  历史库语义改为「stage6 跨天判重 + history-step 回流/滚动并入」；命令表补 `npm run ipo:local`。
- **契约补字段**：`StockRecap.marketStatus.note`（页面休市警示文案，gzinfo 有而 2.0 缺）。
