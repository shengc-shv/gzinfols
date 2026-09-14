# gzinfo 修复清单（供 AI coding 直接执行）

> 产出时间：2026-09-14（北京时间）
> 目标仓库：`/Users/shengc/ccworkstaion/gzinfo`（当前 HEAD `3e5428a`，171 个 TS/MJS 文件 / 33,257 行）
> 来源：对 gzinfo **真实源码与真实产物**的逐项核验（非推测）。每条都给了 `文件:行号` 与复现方式。
>
> **执行要求**
> 1. **先读 `AGENTS.md` 与 `CLAUDE.md`**，遵守仓库既有约定（尤其：不得硬编码行名/机构标识，统一写「某股分行」）。
> 2. 按优先级 `P0 → P2` 修；**每条独立 commit**，便于回滚与二分。
> 3. 每条修完必须给出验证证据（命令 + 输出），不要只说"已修改"。
> 4. **第 6 节「不要动的部分」务必先看**，避免把本来正确的实现改坏。
> 5. 全文不出现具体银行/机构名称；若需引用代码里的敏感缩写，仅照抄变量名，不要展开含义。

---

## P0-1【合规】加密资产模块仍存在于代码与契约中，须彻底清除

**为什么是 P0**：用户已明令「加密资产内容不合规，任何形态都不得出现——不移植、不渲染、**不进契约**」。

**现状核验**（`grep -rniE "coingecko|fear.?greed|crypto|bitcoin" lib scripts` 共 **110 处**）：

| 位置 | 内容 |
|---|---|
| `lib/trading/coingecko.ts` | 拉 `https://api.coingecko.com/api/v3/global` 的加密市值数据 |
| `lib/trading/fear-greed.ts` | 加密恐慌贪婪指数 |
| `lib/types.ts:217` | 契约字段 `crypto_fear_greed?: FearGreedSnapshot` ← **违反"不进契约"** |
| `lib/types.ts:11` | `import type { CryptoGlobalStats }` |
| `lib/ai/trading-commentary.ts:39,113,140-148` | 把加密指数写进喂给 LLM 的文案（"加密恐慌贪婪指数 = …"） |
| `lib/output/render/sections.ts:100,115` | `fearGreedTone()` / `renderCryptoWidgets()` |
| `lib/output/render/i18n.ts:47-49,109-111` | 文案「加密恐慌贪婪」「加密总市值」「BTC 主导率」（中英各 3 条） |
| `lib/output/render/theme.ts:854-911` | `.crypto-widgets` / `.crypto-widget` / `fg-fear`/`fg-greed` 全套样式 |
| `scripts/regen-trading.ts:10,57,68` | `import { fetchCryptoGlobal }`，**会写回** `cryptoFearGreed` 与 `crypto_fear_greed` |

**当前是否已渲染**：否。`lib/output/render.ts` 已无任何 `crypto|fear` 引用（`renderCryptoWidgets` **无调用方**），
`history/2026-09-13/2026-09-13.json` 无 `trading` 段、无 crypto 字段，产物 HTML 中 `.crypto-widget` 出现 0 次。
**但这只是"恰好没接线"**：执行一次 `npm run regen:trading` 就会重新抓取并写入加密字段，契约字段也仍在类型里。

**要求**：
1. 删除 `lib/trading/coingecko.ts`、`lib/trading/fear-greed.ts`；
2. 删除 `lib/types.ts` 的 `crypto_fear_greed` 字段与 `CryptoGlobalStats` 引用，以及 `lib/trading/index.ts`（若有）的导出；
3. 删除 `renderCryptoWidgets` / `fearGreedTone` / 对应 i18n 文案 / theme 里 `.crypto-*` 样式；
4. 删除 `lib/ai/trading-commentary.ts` 中所有加密分支；
5. 清理 `scripts/regen-trading.ts`（去掉 coingecko 调用与两个 crypto 字段写入）；
6. **加防回归**：在内容校验的违禁词表补入加密相关变体（coingecko / fear&greed / 加密 / 虚拟货币 / BTC / 比特币 / 加密总市值…），并在契约层加一条测试断言 `TradingSection` 不含任何 crypto 字段。

**验证**：`grep -rniE "coingecko|fear.?greed|crypto|bitcoin|加密|虚拟货币" lib scripts sources.config.json sources.keywords.json` 应**只剩**「Token贷/词元贷」这类**银行信贷产品**词（若存在，属正常业务词，**不要删**）。

---

## P0-2【硬性规定】时区回落系统时区，与用户永久规定冲突

**规定原文**（用户 2026-09-12，全项目永久生效）：
> 时区只认北京时间 `Asia/Shanghai`；**不接受 env 覆盖、不回落系统时区**。
> 禁止：`process.env.REPORT_TZ`、无 `timeZone` 的 `Intl.DateTimeFormat`、直接用 `new Date()` 取日历日。
> 背景：CI runner 默认 UTC，若回落系统时区会导致日期键/窗口/交易日**全部错日**。

**现状核验（违规）**：

```ts
// lib/utils.ts:11-13
export function getReportTz(): string | undefined {
  return process.env.REPORT_TZ?.trim() || undefined;   // ← 未设置时返回 undefined
}
```
`undefined` 传给 `Intl.DateTimeFormat({ timeZone: undefined })` → **回落 runner 系统时区**。而 `todayKey()`、
`isWithinCalendarDays()`、`exec-pool` 的窗口全部依赖它。

其余同样的 env 依赖：
- `lib/memory/store.ts:121` — `timeZone: process.env.REPORT_TZ || "Asia/Shanghai"`
- `lib/memory/broadcast-time.ts:28` — `process.env.MEMORY_TZ || process.env.REPORT_TZ || "Asia/Shanghai"`
- `lib/ai/exec-pool.ts:218` 的注释**明确承认**："REPORT_TZ 未设置时为 undefined（Intl 回落到系统时区）"

**而且 `AGENTS.md:47` 写的是相反的约定（必须一并改）**：
> `Honors REPORT_TZ env var; defaults to system local TZ. Don't hardcode Asia/Shanghai or UTC anywhere.`

**历史事故**（证明这不是理论风险）：`ai-workspace/log/2026-08-31-workbuddy-29date-leak-fix.md:76`
> "daily.yml 只给 gate 岗传 `TZ_VAL`，build 岗 Node 进程是 UTC（REPORT_TZ 只驱动 todayKey）→
>  任何用 `d.getMonth()/getDate()` 的显示都会与窗口判定时区错位。已统一改用 `todayKey(REPORT_TZ)`。"

**要求**：
1. 新增常量并作为唯一真源，例如 `lib/utils.ts`: `export const REPORT_TZ = "Asia/Shanghai";`
2. `getReportTz()` 改为**返回该常量**（保留函数形态以兼容调用点），**不再读 env**；
3. 删除 `MEMORY_TZ` 这条分支，`broadcast-time.ts` / `store.ts` 统一走常量；
4. **改写 `AGENTS.md:47`**，与用户规定对齐（禁止系统时区回落）；
5. 全库消除 `process.env.REPORT_TZ`；
6. 加测试：在 `TZ=UTC`、`TZ=America/New_York` 两种环境下跑日期键/窗口测试均应通过（`npm test` 三档时区全绿）。

**验证**：
```bash
grep -rn "process.env.REPORT_TZ\|MEMORY_TZ" lib scripts AGENTS.md   # 应为空
TZ=UTC npx tsx --test tests/…   # 全绿
TZ=America/New_York npx tsx --test tests/…   # 全绿
```

---

## P0-3【数据正确性·已在线生效】美国创投新闻被当成「广东 IPO 商机」展示

**实证（线上产物）**：
```
history/2026-09-13/2026-09-13.json  →  sections.ipo 共 12 条，其中 1 条：
    source = Crunchbase News
    title  = "How This Doctor-Turned-Startup-Founder Decided To Fix …"
    tags   = ["粤"]      ← 被打上广东标
    ipoCity= "广东"       ← 被标成广东
history/2026-09-12/…                →  同样 1 条
```
即**当前线上每天都有美国创投新闻被渲染为广东 IPO 商机**。

**根因链（三处叠加，缺一不可）**：

| # | 位置 | 问题代码 |
|---|---|---|
| 1 | `sources.config.json` | `crunchbase-news`（`https://news.crunchbase.com/feed/`，**美国创投通用 RSS**）被配成 `"category": "gd-ipo"` |
| 2 | `lib/output/render.ts:1530` | `if (a.category === "ipo" \|\| a.category === "gd-ipo") { … return "ipo"; }` —— 用 category **直通**决定板块 |
| 3 | `lib/pipeline/side-outputs/gd-ipo.ts:36-41` 与 `:44-47` | `if (IPO_CAT.has(a.category ?? "")) return true;`（入板块）<br>`if (a.category === "gd-ipo") return true;`（**打「粤」标**） |

**要求**（与同一套修复在另一仓库的已验证做法一致）：
1. `sources.config.json`：`crunchbase-news` 的 `category` 由 `gd-ipo` 改为**非 IPO 类**（建议 `finance`），
   并更新其 `note` 说明「归属一律由内容判定」。
2. 三处去掉 `category` 直通，改为「**结构化信号** 或 **内容判定**」：
   - 入板块：`Boolean(a.ipoStage || a.gdBasis) || isGdIpoCandidate(title, excerpt)`
     （保留港交所「全国参考」递表条目——它们带 `ipoStage` 结构化字段）
   - 打「粤」标：`a.gdBasis \|\| (a.registeredProvince 匹配 广东/GD/guangdong) \|\| isGdIpoCandidate(title, excerpt)`
     （爬虫透传的 `registeredProvince`，`lib/sources/crawlers/**` 各 IPO 源均会写）
3. **加不变量测试**：
   - 启用源中 `category ∈ {ipo, gd-ipo}` 的，其 `type` 必须非 `rss`（或 `role === "crawled-input"`）；
   - 一条 `category: "gd-ipo"` 但内容为英文创投新闻的条目，**不得**进 IPO 板块、**不得**带「粤」标；
   - 一条含 `registeredProvince: "广东"` 但标题无粤地名的条目，**必须**带「粤」标（防过度收紧）。

**验证**：用归档数据回放——`history/2026-09-13/2026-09-13.json` 的 `sections.ipo` 应不再含 Crunchbase 条目，
且真广东企业仍带「粤」标。

---

## P0-4【真 bug】`categoryToSection` 有两份，且已经漂移

**两份实现**：

```ts
// lib/ai/pipeline.ts:33   ← 少了 isGdIpoCandidate 分支
function categoryToSection(cat?: string, title = "", excerpt = ""): ReportSectionKey {
  if (cat === "tech") return "tech";
  if (cat === "ipo" || cat === "gd-ipo") return "ipo";
  if (isGzLocalCandidate(title, excerpt)) return "gz_local";
  if (isPolicyMarketCandidate(title, excerpt)) return "policy_market";
  return "biz_insight";
}

// lib/output/report-from-articles.ts:25   ← 有该分支（2026-08-30 新增）
export function categoryToSection(cat?: string, title = "", excerpt = ""): ReportSectionKey {
  if (cat === "tech") return "tech";
  if (cat === "ipo" || cat === "gd-ipo") return "ipo";
  if (isGdIpoCandidate(title, excerpt)) return "ipo";   // ← ai/pipeline.ts 缺这条
  …
}
```
而 `lib/output/report-from-articles.ts:7` 的注释仍写着
「与 pipeline.ts 的 categoryToSection **保持一致**」——**与事实不符**。

**影响**：`lib/ai/pipeline.ts:90` 在 **SKIP_AI 模式**下用它决定条目归属。
缺少该分支 → 媒体源报道的广东企业 IPO 进展（如「证监会同意粤芯半导体IPO注册」「某粤企：IPO已受理」）
**不会进入 IPO 板块**，而是落到 gz_local / policy_market / biz_insight。即 SKIP_AI 模式下广东 IPO 板块会缺量。

**要求**：
1. 合并为**单一真源**（建议移到 `lib/classify/` 下，如 `lib/classify/section.ts`，因为它是分类规则、不属于渲染或 AI 层）；
2. 删除 `lib/ai/pipeline.ts` 的私有副本与 `lib/output/report-from-articles.ts` 的重复定义（改为 import）；
3. 顺带核对第三处内联实现 `lib/output/render.ts:1524` 的 `sectionOf`：
   它多了一条「资本运作公告排除」（`IPO_CAPITAL_ACT_RE && !IPO_FLOW_RE`）与
   `isGzLocalCandidate(title)`（**只传标题**，另两处传 `title + excerpt`）。
   后者经注释确认是**有意为之**（摘要里的「广州」是 AI 解读视角，不代表事件在广州）→ **保留该差异并加注释说明**，
   或将其收敛为显式参数（如 `opts.titleOnly`），避免被误当 bug 修掉。
4. 加测试：同一组输入经三处入口应得到**同一板块**（除有意的差异项）。

---

## P1-1【内容质量】`cnbc-top` 是通用头条 RSS，污染数据池

`sources.config.json`：`cnbc-top` → `https://www.cnbc.com/id/100003114/device/rss/rss.html`
（`100003114` = CNBC **Top News 通用头条**，非股市频道）。

实测抓取到的条目示例（与股市/银行零售业务无关）：
- `I'm a psychologist who studies couples: Emotionally intelligent partners ask …`
- `NFL and midterm elections set up prediction markets for a critical fall season`
- `Washington scrambles to meet calls for AI guardrails …`

**要求**：URL 换为 CNBC **Investing** 频道 `https://www.cnbc.com/id/15839069/device/rss/rss.html`
（已实测该频道内容全部为股市/投资主题，无生活方式噪音），并把 `name` 由 `CNBC Top Stories` 改为 `CNBC Investing`、
更新 `note` 记录本次更换原因。`id` 保持不变（历史库按 sourceId 关联）。

**可选**：`investing-news`（`investing.com/rss/news.rss`）与 `sina-a-stock`（`finance.sina.com.cn/stock/` 频道根页）
同属"宽频道"，建议顺带人工抽查一轮。

---

## P1-2【脱敏】`--accent-cmb` 变量名含主体英文缩写，且输出到公开 HTML

`lib/output/render/theme.ts` 定义 `--accent-cmb`（并多处使用 `var(--cmb, #e60012)` 形式的回退引用），
该变量名会**原样出现在每个发布页面的 `<style>` 里**。变量名中的三段字母是特定银行主体的英文缩写，
页面为公开静态站，属可反查主体的信息。

**要求**：
1. 全局改名为语义名（建议 `--accent-cmb` → `--accent-brand`、`--cmb` → `--brand`）；
2. **色值保持原样不要改**（避免视觉变化引发额外确认成本）；
3. 顺带检查 `tests/` 中的临时目录前缀（若有历史项目代号，一并改成中性名）。

**验证**：`grep -rn "accent-cmb" lib tests` 应为空；重新渲染后页面 `<style>` 内不再出现旧名。

---

## P1-3【健壮性】SKIP_AI 的 allow-list 把「空集」当成「全部无关」

```ts
// lib/ai/pipeline.ts:80,83
const keepAll = !relevantUrls;
… .filter((it: any) => keepAll || relevantUrls.has(it.url))
```
`relevantUrls` 由 `lib/pipeline/bootstrap.ts:63-68` 构造 = history 中 `ai_relevant === true` 的 url 集合。

**实测**：`data/article-history.json` 147 条中仅 **23 条** `ai_relevant === true`（124 条为 `None`）。
→ SKIP_AI 模式下**只有这 23 个 url 能进板块**，其余条目（即便高度相关）被一刀切掉 → 主体板块长期缺量。

> 同一处代码在姊妹仓库（gzinfols）因历史库 `ai_relevant` 全库缺失（0 条 true）而**整份报告四个主板块全空**。
> gzinfo 因为有 23 条 true，表现为"缺量"而非"全空"——**同一缺陷、不同严重度**。

**要求**：
1. allow-list **为空或明显过小时**退化为「全量保留 + 内容判定归栏 + 相关性评分把关」，
   而不是硬白名单过滤；`keepAll` 的判据从 `!relevantUrls`（只区分 undefined）改为 `!relevantUrls || relevantUrls.size === 0`（可按需再加下限阈值）；
2. 触发退化时打一条 `console.warn`，让 CI 日志可见；
3. 在管线里加**产物级观测**：四个主板块（gz_local / biz_insight / policy_market / tech）合计为 0 时输出
   `::warning::`（当前无任何告警，静默通过）。
4. 加测试：空 allow-list → 条目全保留；非空 allow-list → 只保留命中的（防回归）。

---

## P2 可选（低成本、非阻塞）

| # | 项 | 位置 | 说明 |
|---|---|---|---|
| P2-1 | 渲染时刻用隐式时钟 | `lib/output/render.ts:1861` `…format(new Date())` | 「数据截至 HH:mm」取系统当前时刻 → 同一天两次渲染结果不同。建议由调用方注入时间（管线传起始时间）。**注意**：该处已正确指定 `timeZone: "Asia/Shanghai"`，**不会错日**，所以只是可复现性问题，非红线违规 |
| P2-2 | 渲染层直读 env | `lib/output/render.ts:1873,1920,1951`（`REPORT_BASE_URL` / `WEB_MODE`） | gzinfo 无端口-适配器分层，这属"风格"而非违规；若想收敛，可由调用方注入 |
| P2-3 | `Date.now()` 用于窗口计算 | `lib/ai/exec-pool.ts:130,346` | 建议改为注入参照日，便于单测固定时间 |

---

## 不要动的部分（这些是本仓库**正确**的实现，已核验）

| 项 | 核验结果 | 说明 |
|---|---|---|
| `assets/og-image.png` | ✅ **存在**（10 KB） | 分享缩略图资源齐备，`scripts/build-site.mjs:65-70` 的拷贝逻辑与 `assets/` 匹配 |
| `build-site` 接线 | ✅ **已接线**（`.github/workflows/daily.yml:487` `run: npm run build-site`） | 且 `daily.yml:287-300` 会先从 gh-pages 恢复历史各期再聚合。**`build-site.mjs` 输出到 `daily_reports/` 在本仓库是正确设计**（该目录既是归档又是发布源）——**不要**把它改成别的目录 |
| `WEB_MODE` | ✅ **已设置**（`daily.yml:403` `WEB_MODE: 'true'`） | 因此页面「归档」链接是有效的，别当成死代码删除 |
| `history/` 归档保留 | ✅ **已实现**（`scripts/cleanup-history.mjs:119` 调 `lib/history/retention.mjs#pruneHistoryDirs`，默认 7 天） | 有测试覆盖，不要重复实现 |
| 8 处 `Intl.DateTimeFormat` | ✅ **全部显式传了 `timeZone`** | 不存在"无 timeZone 隐式系统时区"的问题（问题只在 P0-2 的 `getReportTz()` 返回 undefined 这一条路径上） |
| 内容判定词表单一份 | ✅ **只有 `lib/output/render/cards.ts` 一份**，全部消费方（`pipeline/side-outputs/gd-ipo.ts`、`audio/audio.ts`、`ai/exec-pool.ts`、`output/report-from-articles.ts`、`output/render.ts`）都从它 import | 不存在 gzinfols 那种"渲染层复制了一份词表"的重复。**注意**：`cards.ts` 位于渲染层却被 AI/音频层引用，属分层味道（业务规则住在渲染层），但**不是缺陷**，如要调整请单独评估 |
| 测试规模 | 70 个测试文件 / 476 个 `test(` | 基线较厚，改动后请全量跑通 |

---

## 建议执行顺序

```
1. P0-1 加密模块清除（合规，独立 commit，先做）
2. P0-2 时区常量化 + AGENTS.md 对齐（跨项目硬性规定，独立 commit）
3. P0-3 IPO 板块 category 直通修复 + 源配置纠错 + 不变量测试（独立 commit）
4. P0-4 categoryToSection 单一真源（独立 commit）
5. P1-1 cnbc-top 换频道
6. P1-3 SKIP_AI allow-list 语义 + 空板块告警
7. P1-2 变量名脱敏
8. P2 三项（可合并为一个 commit）
每步：npm test 全绿 + 三档时区（默认 / UTC / America/New_York）全绿 + 给出验证输出。
```

## 交付要求

修完后请提供：
1. 每条对应的 commit hash 与 diff 摘要；
2. `npm test` 全量输出（通过数）；
3. `TZ=UTC` 与 `TZ=America/New_York` 两档下的测试结果（P0-2 必交）；
4. P0-1 与 P0-3 的 grep / 回放验证输出。
