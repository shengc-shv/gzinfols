# gzinfols 2.0 全面复盘与优化建议

> 审计时间：2026-09-14（北京时间）｜审计对象：`/Users/shengc/ccworkstaion/gzinfols` @ `27fdf92`
> 方法：静态阅读 + 仓库真实源码核对 + 对归档产物（`history/2026-09-14/`）做数据级回溯。
> 原则：所有结论均给出**可复核的证据**（文件:行号 / 产物字段），不采信计划表或注释中的自我声明。
>
> 规模基线：195 个 TS/MTS/MJS 文件、35,356 行；52 个测试文件 / 366 个 `test(` 用例；
> `npx tsc --noEmit` ✅ 通过；`npm run architecture:check` ✅ 通过。

---

## 0. 总体结论

架构骨架（契约/服务/适配器/编排四层 + 机器门禁）是本项目最扎实的部分：分层清晰、
门禁可执行、服务层基本做到了"零 `node:`、零适配器直连"。**问题不在设计，而在三处**：

1. **门禁存在盲区 + 已被绕过**：门禁只拦 `node:` 与 `/adapters`，`process.env`、隐式时钟、
   以及"用 `category` 字符串定板块"这三类红线它都看不见，且这三类**当前真实存在**。
2. **"单一真源"的自我声明与代码不符**：至少 2 组关键枚举存在**未导入的私有副本**，
   声明写了"唯一真源"，代码却有两份。
3. **内容链路存在一个直接面向用户的错误**：美国创投新闻被渲染进「广东IPO动态」并打「粤」标。

第 3 条建议**优先于一切重构**处理——它每天在给用户错误商机。

---

## P0 · 必须立即处理（面向用户的错误 / 红线回归）

### P0-1 美国创投新闻被当成「广东IPO商机」渲染 ⚠️ 最严重

**现象（产物实证）**：`history/2026-09-14/2026-09-14.json` 的 `sections.ipo` 共 13 条，
其中 **前 8 条全部来自 `Crunchbase News`**，且每条都被打上 `tags: ["粤"]`、`ipoCity: "广东"`：

```
tags=['粤'] city=广东 src=Crunchbase News  The Week's 10 Biggest Funding Rounds: The Boring Co., ...
tags=['粤'] city=广东 src=Crunchbase News  The Crunchbase Tech Layoffs Tracker
tags=['粤'] city=广东 src=Crunchbase News  Mistral AI Raises $3.5B At $24B Valuation ...
tags=['粤'] city=广东 src=Crunchbase News  How To Measure An Innovation Economy: South Korea
```

这 8 条同时出现在「今日必读/股市播报」的**广东IPO 横滑卡**（`renderGdIpoStrip`）候选池里——
即用户在**广东IPO 商机位**看到的是美国 AI 创投新闻。

**根因链（三处叠加，缺一不可）**：

| # | 位置 | 问题 |
|---|---|---|
| 1 | `sources.config.json` | `crunchbase-news` 的 `category` 被配成 **`gd-ipo`**。它实际是 `https://news.crunchbase.com/feed/`（美国创投通用 RSS），与广东 IPO 无关 |
| 2 | `lib/services/render/full.ts:1524-1534`（`sectionOf`） | `if (a.category === "ipo" \|\| a.category === "gd-ipo") return "ipo"` —— **用 category 字符串直接决定板块**，跳过全部内容判定 |
| 3 | `lib/pipeline/side-outputs/side-gd-ipo.ts:45-48`（`isGdIpoArticle`） | `if (a.category === "gd-ipo") return true` —— 直接打「粤」标 |

第 2、3 条**正面违反**项目的「无状态源架构红线（2026-08-29 用户明令）」：
> "绝不允许用数据源的分类（sourceId / category / subcategory）来定义最终渲染归属"

讽刺的是，`full.ts:1520-1522` 的注释恰好写着"最终板块归属一律由**内容判定**…不得决定渲染分类"，
紧接着第 1524 行就用 `category` 短路了。

**修复建议**：
1. **立即**：把 `crunchbase-news` 的 `category` 从 `gd-ipo` 改为 `tech`（或新增 `overseas` 类目），
   使其不再命中 IPO 快路径。
2. **根治**：`sectionOf` / `isGdIpoArticle` 去掉 `category === "gd-ipo"` 直通分支，
   统一走 `isGdIpoCandidate(title, excerpt)` 内容判定（该函数已存在且是"单一口径"的正解，
   `side-gd-ipo.ts:36-42` 的 `isIpoArticle` 已经是正确写法，应作为唯一范式）。
3. **加锁**：新增单测——「一条 `category=gd-ipo` 但标题/摘要无任何广东锚与美国创投特征的条目，
   必须**不**进入 `sections.ipo`、**不**带「粤」标」。回归即红。

---

### P0-2 四个主板块当日全部 0 条 —— 日报主体是空白的

**现象（产物实证）**：`history/2026-09-14/2026-09-14.json`

```
sections.gz_local       0
sections.biz_insight    0
sections.policy_market  0
sections.tech           0
sections.ipo           13
```

渲染后 `history/2026-09-14/2026-09-14.html:1348` 的 tab 只剩 3 个：
`广州本地(0) / 股市动态(10) / 广东IPO动态(10)`。**「业务启示」「政策与市场」「科技前沿」三个 tab 完全消失。**

**而滚动池并不空**：`2026-09-14-articles.json` 有 **114 条**（`gz` 21 / `finance` 38 / `stocks` 54 / `gd-ipo` 1），
且其中包含明显应进主板块的条目（「多地房地产市场成交迎来修复」「算力贷、算力保……科技金融产品上新服贸会」
「人民币跨境支付，新消息」）。

**根因（2026-09-14 实测重构，**初版判断被推翻**）**

初版怀疑「`scoreBranchRelevance` 阈值过严把 114 条全判 drop」。实测直接调用
`mergeRollingIntoReport(emptyReport, rolling114, tierBySource)` 并逐道守卫计数，结果是：

| 守卫 | 通过量 |
|---|---|
| ① 有 url | 114 |
| ② 过相关性闸门（`tier !== "drop"`） | **64**（不是 0！初版猜测错误） |
| ③ `sectionOf` 有归属 | 64 |
| ④ 有摘要 | 64 |
| ⑤ **过「摘要 ≠ 标题复读」守卫** | **1** ← **63 条卡在这里** |

→ 真正让兜底并入失效的是 **`full.ts` 的退化卡片守卫**：历史库里没有 AI 摘要的条目，
其 `excerpt` 回退值就是**标题前 90 字**（`lib/ingest/merge.ts` 的既有行为），
于是 `summary === titleText` 成立 → 被判为「标题复读卡」丢弃。
即：**没有 AI 摘要的历史条目，兜底一律并进不来**（本次 64 → 1）。

而 AI 段为何 0 条，实测定位到**一处真实逻辑缺陷**（见下）。

**根因·真正缺陷：SKIP_AI 的 PASS1 allow-list 空集被当作「全部无关」**

`lib/services/enrich/pipeline.ts` 的 `makeSkipAiRunner`：

```ts
const keepAll = !relevantUrls;                      // 旧实现
.filter((it) => keepAll || relevantUrls.has(it.url))
```

`relevantUrls` 来自历史库 `ai_relevant === true` 的条目集合。实测
`data/article-history.json` **126 条无一 `ai_relevant`**（字段全库缺失）→ 传入的是
**空 Set**（非 `undefined`）→ `keepAll = false` → 「只保留空集里的条目」= **一条不留**
→ `generateDaily` 走 `kept.length === 0` 分支直接返回**合法空报告**
→ **四个主板块恒空**，且不报错、不告警。

**已修复**（本轮）：① 空 allow-list 语义改为「尚无已判定相关条目」→ 退化为全量保留 +
内容判定归栏，仅**非空** allow-list 才按其过滤（保留 2026-08-22 防垃圾行为）；
② 补 `checkSectionCoverage` 观测：四主板块合计为 0 时输出 `::warning::`（此前静默）。

**遗留（需单独决策）**：退化卡片守卫把「无 AI 摘要的历史条目」全部挡在兜底并入之外。
这是 **2026-08-29「信息密度」与「宁缺毋滥」原则的既定口径**，不是缺陷 ——
但它意味着**兜底并入只能覆盖有 AI 摘要的条目**。是否放宽（例如允许标题卡但要标注
「无摘要」）属业务口径取舍，**需用户拍板**，本轮未动。

---

### P0-3 `IPO_STAGE_ORDER` / `GD_IPO_STAGE_LABEL` 存在双份定义（"单一真源"声明失效）

`lib/services/classify/gd-ipo.ts:185-209` 明确声明：
> "与 GdStage/GD_STAGES/GD_IPO_STAGE_LABEL 收在同一文件，供「枚举四处同步」**单一真源**
> （防止 gzinfo 那样新增阶段漏改某一处）"

但实测：

| 常量 | 声明位置 1（声称真源） | 声明位置 2（**未导入的私有副本**） |
|---|---|---|
| `IPO_STAGE_ORDER` | `lib/services/classify/gd-ipo.ts:193` | `lib/services/render/full.ts:1064` |
| `GD_IPO_STAGE_LABEL` | `lib/services/classify/gd-ipo.ts:202` | `lib/services/render/full.ts:1422`（**无 export，且注释自称"唯一来源"**） |

`full.ts` 的 `renderIpoFilterBar` / `renderIpoPanelHtml` / `renderIpoProgress` / `renderGdIpoStrip`
消费者全部是**本地副本**，`gd-ipo.ts` 的那份在渲染侧完全没被引用。

**为什么现有测试没发现**：`tests/gd-ipo-stage.test.ts:23-35` 只断言
`IPO_STAGE_ORDER.length === GD_STAGES.size`，而它 import 的 `IPO_STAGE_ORDER` 来自
`../lib/services/render`（即 **full.ts 副本**），`GD_STAGES` 来自 `classify`。
于是两处副本**只要长度相等就能同时漂移而不报警**——保护是假的。

**修复**：`full.ts` 删除两份本地副本，改为从 `../classify/gd-ipo` 导入；
并把测试改为断言"引用同一对象"（`assert.strictEqual`）而非仅长度相等。

**范围比初判更大（2026-09-14 追查所得）**：同一类"复制而不 import"的问题不止枚举。
用脚本逐声明比对 `lib/services/render/cards.ts` 与 `lib/services/enrich/heuristics.ts`，
发现 **8 个导出正则（GZ_ANCHOR_RE / GZ_BUSINESS_RE / FOREIGN_REGION_RE / POLICY_ACTION_RE /
MARKET_SIGNAL_RE / IPO_PROGRESS_RE / IPO_CAPITAL_ACT_RE / IPO_FLOW_RE）逐字相同**，
外加 `isGzLocalCandidate` / `isPolicyMarketCandidate` / `isGdIpoCandidate` 三个函数同为副本
（共 11 个声明）。而 `heuristics.ts` 的文档注释还自称是
「SKIP_AI 降级分类与（B6 渲染期）卡面判定的**共用**词表」——
实际是两份独立副本，改一处不生效。
`side-gd-ipo.ts` 的注释也写着「复用**渲染侧**广东IPO 内容判定（单一口径，避免两套正则漂移）」，
但它 import 的是 `enrich/heuristics` —— 注释与实现相互矛盾。

→ 已统一为 `cards.ts` 从 `heuristics.ts` re-export（单次改动消除 11 处重复）。

**⚠️ 本轮自查补漏（首版审计漏报，实施 B-1 时才发现）**：还有**第 3 处同类重复**，且**在生产路径上**——

| 函数 | 位置 A（**生产走这条**） | 位置 B（**测试走这条**） |
|---|---|---|
| `mergeRollingIntoReport` | `lib/services/assemble/merge-rolling.ts:32` | `lib/services/render/full.ts`（同名同体） |
| `GD_ENTERPRISE_RE` | `assemble/merge-rolling.ts:29` | `render/full.ts:1477` |

影响比前两处更严重：
- `lib/pipeline/history-step.ts` import 的是 **assemble 那份**（生产），
  `tests/merge-rolling.test.ts` import 的是 **render 那份**（测试）→ **测试测的不是生产代码**；
- 两份当时**逐字相同**（`GD_ENTERPRISE_RE` 亦相同），所以此前没暴露行为差异；
- 但凡只改一处（例如我本轮先给 render 那份加了 IPO 结构化信号），
  就会出现"测试通过、生产没生效"的假绿。

→ 已收敛：删除 `render/full.ts` 的副本（−249 行），唯一实现归 `assemble/merge-rolling.ts`；
测试 import 改指向 assemble；并新增断言 `render` 侧**不得再导出**该函数的测试，防副本复活。

**教训**：查重复不能只靠"看代码像不像"，要用**逐声明比对**（本轮即是写脚本比对才发现的）；
且必须确认「生产 import 的是哪一份」——同名函数在不同目录各有一份时，
测试与生产分叉是最危险的情形。

---

### P0-4 服务层残留 `process.env` 与隐式时钟（架构红线回归）

既定红线：**服务层零 `process.env`、零 `Date.now()`**（env 由 orchestrator 读进 `ctx.config`，
时间由 `ctx.startTime` 注入）。现状：

| 位置 | 代码 | 问题 |
|---|---|---|
| `lib/services/render/full.ts:1867` | `process.env.REPORT_BASE_URL \|\| "..."` | env 直读 |
| `lib/services/render/full.ts:1914` | `process.env.WEB_MODE === "true"` | env 直读 |
| `lib/services/render/full.ts:1945` | `process.env.WEB_MODE === "true"` | env 直读 |
| `lib/services/render/full.ts:1861` | `...format(new Date())` | 隐式时钟：渲染"数据截至 HH:mm"取**系统当前时刻**，同一天两次渲染结果不同，破坏可复现性 |
| `lib/services/market/commentary.ts:223` | `new Date().toISOString()...` | 隐式时钟（用于文件名时间戳） |
| `lib/services/collect/providers.ts:25,68,87` | `fetchedAt: new Date()` | 隐式时钟；`fetchedAt` 本身允许，但应透传注入时钟 |

*注：`full.ts:1856` 已正确指定 `timeZone: "Asia/Shanghai"`，因此**不会错日**，
问题在"非确定性"与"绕过注入"两点。*

**为什么门禁没拦住**：`lib/architecture/check.ts` 只检查 import 说明符是否以 `node:` 开头
或指向 `/adapters`。`process.env` / `new Date()` 不是 import，门禁天然看不见。

**修复建议**：
1. 把 `reportBaseUrl` / `webMode` / `nowIso` 收进 `ctx.config`，服务层只读 ctx。
2. **扩展门禁**：在 `check.ts` 增加文本级正则检查——服务层出现 `process.env`、
   `Date.now()`、裸 `new Date()`（允许 `new Date(x)` 带参与 `?? new Date()` 注入型）即告警。
3. 补齐 `commentary.ts:223`、`providers.ts` 的时钟注入。

---

## P1 · 应尽快处理（正确性风险 / 显著可维护性债）

### P1-1 `cnbc-top` 是通用新闻 RSS，正在污染数据池

`sources.config.json` 中 `cnbc-top` → `https://www.cnbc.com/id/100003114/device/rss/rss.html`（CNBC 头条总feed）。
滚动池实测 14 条，标题包括：

```
I'm a psychologist who studies couples: Emotionally intelligent ...
NFL and midterm elections set up prediction markets for ...
Washington scrambles to meet calls for AI guardrails ...
Conversations that AIs are having in the office that may ...
```

这些与股市/银行业务完全无关。**当前它们没有渲染出来，只因为 P0-2 里那个"过严的兜底闸门"顺手挡住了**——
闸门一旦放宽（而 P0-2 正要求放宽），它们会立刻灌满「政策与市场 / 业务启示」，
直接违反"业务相关性红线（永久生效）"。

**修复**：给 `cnbc-top` 换股市专用频道（如 `/id/20910258` markets），或在源级加白名单过滤。
`investing-news`、`sina-a-stock`（`finance.sina.com.cn/stock/` 频道根页）同属"频道根页"抓取，建议一并复核。

### P1-2 `og:image` 指向旧仓库且资源 404

`lib/services/render/full.ts:1867` fallback = `https://shengc-shv.github.io/gzinfo`（**旧仓库的 Pages 域**），
且**全仓库不存在 `og-image.png`**（`find` 实测为空，`site/` 下也没有）。
结果：所有转发卡片（微信/QQ/Twitter）缩略图必然 404，只剩标题+描述文字。

**修复**：在发布目录（`site/`）放置一份 `og-image.png`，并把默认 base 改成本仓 Pages 地址；
更稳的做法是让 `REPORT_BASE_URL` 成为**必填**（缺失时告警而非静默回落到别的仓库）。

### P1-3 `--accent-cmb` 命名把银行英文缩写输出到公开 HTML

`lib/services/render/theme.ts:27,63` 定义 `--accent-cmb` / `--cmb`，并在 theme 内被引用 30 余次，
**最终原样出现在每个发布页面的 `<style>` 里**（实证：`history/2026-09-14/2026-09-14.html:29` 有 `--accent-cmb: #e60012`）。

虽然只是 CSS 变量名，但页面是公开静态站，"cmb" 是可反查主体的英文缩写，触碰
"不得出现可定位到具体银行主体的信息"红线。同类残留：`tests/retention.test.ts:20,41,54`
的临时目录前缀 `gzcmbdf3-ret-`。

**修复**：全局重命名为语义名（`--accent-brand` / `--brand`），一次性 sed 替换 + 全量测试兜底。

### P1-4 `history/` 归档保留 —— **本条为误判，已核实无问题**（2026-09-14 复查更正）

初次结论称「`cleanup-history.yml` 只裁 `data/article-history.json`，完全不管 `history/`」。
**复查后推翻**：`scripts/cleanup-history.mjs:122` 确实调用了
`pruneHistoryDirs(HISTORY_ROOT, RETENTION_DAYS)`（`scripts/history-retention.mjs`，7 天窗口，
按日期目录名删除整日目录），且该脚本同时挂在 `cleanup-history.yml`（每周）与
`daily.yml`（归档前的 *Trim history to recent N days* 步）。执行顺序正确：
先裁旧目录 → 再 `cp` 当天产物，故 `history/` 稳定在约 7–8 天。

→ **无需改动**。教训：`grep -r "A\|B"` 组合式检索在本机曾多次假阴性/假阳性，
本条即因只搜 `cleanup-history.yml` 的工作流文件、未读 `cleanup-history.mjs` 正文而误判。

### P1-4b（新增，2026-09-14 实测发现）`build-site.mjs` 与发布布局互不兼容，且从未在 CI 执行 —— ✅ 已按用户裁决（B-3 选 b）修复

- **修复前**：`daily.yml` 直接 `upload-pages-artifact path: site`，全仓无任何地方跑
  `npm run build-site`（AGENTS.md 命令表却写「跑在 daily 之后」）；且 `publishReport` 产出**扁平**
  `site/index.html` + `site/<date>.html`，与脚本假设的 `<date>/<date>.html` 子目录结构互不兼容，
  脚本还把产物写进 `daily_reports/`。
- **修复后（B-3 选 b：统一到子目录模型）**：
  - 发布根 = `site/`，每期位于 `site/<date>/<date>.html` + `site/<date>/audio/`；
  - `publishReport` 改写子目录（`site/<date>/<date>.html`），不再写扁平页；
  - `build-site.mjs` 重写为**发布根唯一写者**：从 `daily_reports/`（当日）+ `history/`（CI 每期归档回 main 的历史）
    **汇集各期**到 `site/<date>/`，生成 `index.html`（最新一期，链接改写）/ `archive.html`（全部期）/
    `.nojekyll` / `og-image.png`；音频滚动清理仍只作用于 `daily_reports/`；
  - `tts.ts` 站点音频路径由 `site/audio/` 改为 `site/<date>/audio/`（与报告页相对引用一致）；
  - `daily.yml` 在**归档之后**接入 `npm run build-site`，再上传 `site/`；
  - `.gitignore` 补 `site/`（构建产物，此前未被忽略 → 本地跑 daily 会留下未跟踪文件）。
- **收益**：归档页有多期（不再只有当天 1 期）、`.nojekyll` 生效（Pages 不跑 Jekyll）、
  og-image 落在发布根、报告页的相对链接（audio / archive）全部自洽。
- **验证**：本地用归档数据实跑 `node scripts/build-site.mjs` → 产出
  `site/2026-09-14/2026-09-14.html` + `index.html` + `archive.html`（链接 `./2026-09-14/2026-09-14.html`）
  + `.nojekyll` + `og-image.png`；并单测了 index.html 的两条改写规则（`../archive.html`→`./archive.html`、
  `src="audio/`→`src="<date>/audio/`）。

### P1-5 三个 god file 阻碍后续演进

| 文件 | 行数 / 体积 | 承载职责 | 建议拆分 |
|---|---|---|---|
| `lib/services/render/full.ts` | 2117 行 / 100KB | 分组算法 + 限额常量表 + 筛选条 + IPO 面板 + 横滑卡 + 滚动合并 + 执行摘要合并 + HTML 主模板 + Markdown 渲染 | `render/grouping.ts`（`groupRaw` ≈ 500 行）、`render/limits.ts`、`render/rolling-merge.ts` |
| `lib/services/memory/event-memory.ts` | 1614 行 | 事件记忆全部逻辑 | 按"口播去重 / 滚动窗口 / 落盘适配"三段拆 |
| `lib/services/render/theme.ts` | 1255 行 / 52KB | 单一巨型 `THEME_CSS` 模板串 | 按页面区块拆多个 CSS 片段再拼装 |

**渲染与业务规则混杂**是 `full.ts` 最深层的问题：`groupRaw`（分组）、`mergeRollingIntoReport`
（相关性打分 + 板块归属）本质是**业务规则**，却住在渲染服务里，导致
"改渲染要动业务判定"、单测无法独立覆盖。

### P1-6 测试面缺三类关键保护

52 个测试文件覆盖了主干逻辑，但缺：
1. **渲染层快照测试**：本次 P0-1（美国新闻进广东IPO）与 P0-2（主板块全空）都是**产物级**问题，
   任何单元测试都测不到。
2. **"单一真源"一致性断言**：只断言长度相等 → 见 P0-3。
3. **管线级 smoke 断言**：如"4 个主板块合计不得为 0"、"`sections.ipo` 中每条必须通过内容判定"。

建议引入一个 `tests/pipeline-smoke.test.ts`：用固定 fixture 跑完整管线，断言产物结构不变量。

---

## P2 · 卫生项（低成本，可随手清）

| # | 项 | 位置 | 说明 |
|---|---|---|---|
| P2-1 | 运维脚本缺本地入口 | `scripts/cleanup-history.mjs`、`scripts/history-retention.mjs` | 仅被 workflow 直接调用，`package.json` 里没有对应 npm script，本地无法一键复现 CI 行为 |
| P2-2 | 唯一的类型逃逸 | `lib/services/collect/providers.ts:81` `(items as any[])` | `fetchApi` 对未知 JSON 形状的窄化，可用 `unknown[]` + 类型守卫替代 |
| P2-3 | 注释与实现不一致 | `lib/services/classify/gd-ipo.ts:87-90` vs `:109,115` | 注释称"已移除 sourceId 前缀判定"，但 `OVERSEAS_SOURCE_RE.test(a.sourceId)` / `HK_SOURCE_RE.test(a.sourceId)` 仍在按 sourceId 决定市场子标签。当前只影响**子标签**不影响板块，属灰区，但会误导后来者 |
| P2-4 | 历史库体积 | `data/article-history.json` | 已 82KB / 126 条，随 `cleanup-history.yml` 保留 7 天滚动，需持续监控 |
| P2-5 | 契约与运行时 tab 的关系需明确 | `lib/contracts/report.ts:21` `SECTION_ORDER` 5 板块 | 运行时 tab 由 `count > 0 \|\| alwaysShow` 过滤，为空即隐藏（本次因 P0-2 隐藏了 3 个）。属设计而非缺陷，但**契约里应写明"空板块自动隐藏"**，避免再次被误读为渲染退化 |

---

## 本轮（2026-09-14）处置结果

| 项 | 状态 | 落地内容 |
|---|---|---|
| P0-1 美国创投新闻进广东IPO | ✅ 已修 | `crunchbase-news` category `gd-ipo`→`finance`；`side-gd-ipo` 的 `isIpoArticle`/`isGdIpoArticle` 去掉 category 直通，改「结构化信号（`ipoStage`/`gdBasis`/`registeredProvince`）或内容判定」；新增 `tests/source-category-invariant.test.ts`（含源配置不变量 + 事故回归 + 防过度收紧四条）。**实测归档 13 条 → 5 条**：8 条美国创投全部剔除，同时补上真粤企「深圳市海柔創新」此前漏掉的「粤」标 |
| P0-2 四主板块全空 | ✅ 已修 | 真因是 SKIP_AI 的 `keepAll = !relevantUrls` 把**空 allow-list** 当作「全部无关」→ 一条不留。改为空集退化为全量保留（仅非空才过滤）+ 新增 `checkSectionCoverage` 空板块告警；`tests/skip-ai.test.ts` 补 2 例 |
| P0-3 枚举/词表双份定义 | ✅ 已修（范围比初判更大） | `full.ts` 删除 `IPO_STAGE_ORDER`/`GD_IPO_STAGE_LABEL` 私有副本改 import；**并发现 `cards.ts` 逐字复制了 `heuristics.ts` 的 8 个词表 + 3 个函数**，改为 re-export（cards.ts −61 行）。测试改断言**同一引用**（`strictEqual`），副本再出现即红 |
| P0-4 服务层 env/隐式时钟 | ✅ 已修 | 新增 `contracts/report.ts#RenderInjection`；渲染所需 `baseUrl`/`webMode`/`now` 全部注入（管线取自 `ctx.config` / `ctx.startTime`，脚本经 `renderInjectionFromEnv()`）；**架构门禁补盲区**：服务层 `process.env`、`Date.now()` 直接判违规，裸 `new Date()` 用棘轮基线（11）只挡增长；`tests/architecture-gate.test.ts` 补 4 例 |
| P1-1 cnbc-top 通用头条污染 | ✅ 已修 | URL 由 `id/100003114`（Top News）改为 `id/15839069`（Investing，实测全为股市投资内容）；历史库人工判定清除 10 条政治/地缘/生活类噪音（126→116，保留 4 条股市相关） |
| P1-2 og:image 指向旧仓库 + 404 | ✅ 已修 | 渲染层不再硬编码回落他仓地址（`baseUrl` 为空则不输出 og:image 并 warn）；新增 `assets/og-image.png`（可复现生成器 `npm run og:image`）；`daily.yml` 注入 `REPORT_BASE_URL` 并补「站点根静态资源」步（拷 og-image + `.nojekyll`） |
| P1-3 `--accent-cmb` 缩写外泄 | ✅ 已修 | 全仓重命名 `--accent-cmb`→`--accent-brand`、`--cmb`→`--brand`（92 处，**配色值不变**）；同时清掉 `tests/` 里的 `gzcmbdf3` 前缀 |
| P1-4 history/ 无上限增长 | ⚪ **误判，无问题** | 复查发现 `cleanup-history.mjs:122` 已调用 `pruneHistoryDirs`（7 天），且 daily.yml 与 cleanup-history.yml 双处接线。已在正文更正 |
| P1-4b build-site 布局不兼容 | 🟡 已记录未接线 | `build-site.mjs` 假设子目录布局且输出到 `daily_reports/`，与 `publishReport` 的扁平 `site/` 不兼容，且从未在 CI 执行。本次不接线（避风险），改在 workflow 直接补静态资源 |
| P1-5 god file 拆分 | ⏸️ **建议延后** | 见下 |
| P1-6 测试保护缺口 | ✅ 部分已补 | P0 相关的不变量均已加锁（源配置不变量、单源同引用、空 allow-list、门禁新规则）。**仍缺**：渲染层快照测试、`pipeline-smoke` 产物级断言 |
| P2-1/P2-2/P2-3/P2-5 | ⏸️ 未动 | 见 P2 表 |

### 关于 P1-5（god file 拆分）—— 建议单独一批做，不与本次混提

理由：本轮已同时改动 7 个行为面（板块归属、SKIP_AI 保留策略、渲染注入、源配置、门禁、词表真源、工作流）。
在此之上再做 `full.ts` 的千行搬移，一旦出现回归将**无法二分定位**是哪一类改动引起。
更稳的顺序是：先让本轮修复独立成 commit 并验证，再把 `groupRaw` / 限额表 / `mergeRollingIntoReport`
拆到 `render/grouping.ts`、`render/limits.ts`、`render/rolling-merge.ts`（纯搬移 + re-export，行为不变）。

本轮已顺手做掉其中一小步：`cards.ts` 去掉 11 处重复声明（−61 行）。

### 尚未处置（下一批候选）

```
P1-4b  build-site 与发布布局统一（二选一：改脚本对齐扁平 site/，或把 site/ 改成子目录布局并接线）
P1-5   拆 full.ts / event-memory.ts（纯搬移 + re-export，行为不变，单独 commit）
P1-6   渲染层快照测试 + pipeline-smoke 产物级不变量断言
P2-*   卫生项：补 npm 入口(cleanup:history)、collect 的 as any、gd-ipo 注释口径、
       契约注明「空板块自动隐藏」、历史库体积监控
待决策  退化卡片守卫是否放宽（P0-2 遗留）—— 属「信息密度 vs 空板块」业务口径取舍
待决策  品牌红字面色值 #e60012 是否一并替换（本轮只改了变量**命名**，未动色值）
```

**两条重要提醒**（沿用既有教训）：
1. `docs/parity-plan.md` 的进度单元格**不可信**，本轮所有结论均以仓库真实源码与产物字段为准；
   上文每一条都给了可复核的行号/字段路径。
2. 本机 shell 的 `grep -r "A\|B"` 组合式检索**反复出现假阴性/假阳性**（本轮 P1-4 误判即由此产生，
   另有 P0-1/P0-3 的重复定义被首轮 grep 漏掉）。关键结论必须用专门检索工具读正文二次确认。

## 附：本轮验证结果

- `npx tsc --noEmit` ✅ 0 错误
- `npm run architecture:check` ✅ 通过（含新增 env/时钟规则；服务层裸 `new Date()` 存量 11 = 棘轮基线）
- 受影响测试全绿（source-category-invariant / gd-ipo-side-output / ipo-stage-render /
  merge-rolling / render / exec-pool / gd-ipo-stage / groupRaw / skip-ai / pipeline.e2e /
  pipeline-stock / light-ai / assemble / assignSection / gd-ipo-candidate /
  report-from-articles / architecture-gate / retention / trading / exec-fallback）
- 端到端实测（用归档真实数据）：IPO 板块 13 条 → 5 条，8 条美国创投剔除、1 条真粤企补标；
  `mergeRollingIntoReport(114 条)` 由 1 条并入恢复到正常行为（根因修复后由 `generateDaily` 侧解决）
- **未推送**：所有改动仅本地，等用户授权后再 push。
