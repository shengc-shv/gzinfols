# 本地 IPO 补数同步 — 数据采集方案教程（纯净版）

> 用途：把「本地 IPO 补数同步」这套技能完整讲清楚，供其他智能体学习与复刻。
> 本文只描述**当前生效的抓取能力**（三个官方 IPO 源），不掺杂一次性运行日志。
> 事实以源码为准：`scripts/ipo-local.ts` · `lib/adapters/local-ipo.ts` ·
> `lib/adapters/crawlers/index.ts` · `lib/adapters/crawlers/sources/{csrcfd,szse-audit,sse-audit,ipo-shared,staleness}.ts` ·
> `lib/services/normalize/crawl.ts` · `lib/ipo-config.ts`。

---

## 0. 这套技能解决什么问题

三个**官方权威 IPO 源**被站点 CDN/WAF 拦截 **GitHub runner 的海外出口 IP**，在 CI 里**永远抓不到**：

| 源 | CI 表现 | 本地（国内网络）表现 |
|---|---|---|
| 证监会辅导备案（`csrcfd`） | 恒 **405**（云 WAF） | 200，稳定拿到深圳/广东辅导企业 |
| 深交所审核动态（`www.szse.cn`） | 恒 **`fetch failed`** | 200，正常 JSON |
| 上交所审核动态（`query.sse.com.cn`） | 全挂（多组合 × 多重重试均失败） | 200，秒级可达 |

对照：同环境下北交所、港交所**仍正常** → 这是**域级拦截**，不是代码 bug。

**后果**：CI 跑出来的广东 IPO 板块缺了深圳（深交所 = 广东）与上海（沪市主板/科创板）两半。

**方案**：本地每天跑一次本技能，把这三个源用**与远端完全相同**的处理逻辑归一化后写进
`data/local-ipo.json` 入库；远端 CI 读取该文件补数（**在线优先**：同 URL 在线抓到就用在线那条）。
数据照旧进日报，只是**抓取地换到本地**。

> 设计纪律：采集腿与远端管线的 IPO 批次是**同一份代码**（`crawler.run()` → `crawler.toCrawledFormat()`），
> 唯一差别是**源集合**；归一化**只有一份实现**（`normalizeLocalIpoItems()`），本地写入端与远端读取端共用，
> 两边逻辑不可能漂移。

---

## 1. 数据来源网站

| # | 源（sourceId） | 站点 / 接口 | 数据性质 |
|---|---|---|---|
| 1 | `gd-csrc-tutoring` | 证监会资本市场电子化信息披露平台 `http://eid.csrc.gov.cn/csrcfd/index.html`（分页 `index_2.html` …） | 辅导备案（拟上市最早信号） |
| 2 | `gd-szse-audit` | 深交所审核动态 API `https://www.szse.cn/api/ras/projectrends/query`（GET） | 在审企业全量 + 审核状态 |
| 3 | `gd-sse-audit` | 上交所审核动态 API `https://query.sse.com.cn/commonSoaQuery.do`（JSONP） | 沪市主板 + 科创板在审企业 |

补充细节：

- **csrcfd**
  - 列表页：`http://eid.csrc.gov.cn/csrcfd/index.html`、`index_2.html` …（每页约 211 条，按披露时间倒序；8 列表格）
  - PDF 直链：`http://eid.csrc.gov.cn` + 行内 `downloadPdf1('.../pre_ipo/YYYY/M/D/xxx.pdf')` 路径
    （注意：PDF 根域**不含** `/csrcfd` 路径段，拼接错了会 404）
- **深交所**
  - 接口：`GET .../projectrends/query?bizType=1&pageIndex=N&pageSize=50&random=…`
  - Referer：`https://www.szse.cn/listing/projectdynamic/ipo/index.html`
  - （POST 会报 9240000 系统异常，必须用 GET）
- **上交所**
  - 接口：`GET .../commonSoaQuery.do?jsonCallBack=cb&sqlId=SH_XM_LB&isPagination=true&issueMarketType=…&currStatus=…&pageHelp.*`
  - Referer/列表页：`https://www.sse.com.cn/listing/renewal/ipo/`
  - **必须显式传 `issueMarketType`**：`1`=科创板、`2`=沪市主板；不传只回科创板 → 主板整体缺失

---

## 2. 抓取规则

### 2.1 触发与源集合

- 触发：本地跑 `npm run ipo:local`（等价 `tsx scripts/ipo-local.ts`）。
- 源集合：`buildLocalOnlyIpoCrawlers()` = 上述三源，固定顺序 `csrcfd → 深交所 → 上交所`。
- 远端配套：CI 里 `selectIpoCrawlersForRun()` 会**跳过**这三个源（改由本文件补数）；
  逃生口 `IPO_LOCAL_ONLY_IN_REMOTE=1` 可让远端重新尝试。

### 2.2 请求头 / 超时 / 重试 / 节流

通用（基类 `BaseCrawler`）：

- **User-Agent**：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`
- **超时**：三源均 `timeout = 20000ms`（`AbortSignal.timeout`）
- **重试**：三源均 `retries = 3`（共 4 次尝试），退避 `1000 × attempt² + random × 1000 ms`
- **重试白名单**：仅对 `5xx` / `429` / `403` 重试；其他 `4xx` 直接放弃
- **Referer**：csrcfd → 列表页自身；深交所 → IPO 列表页；上交所 → `.../renewal/ipo/`

分页节流（各源差异）：

| 源 | 页间节流 |
|---|---|
| 深交所 | `800 + random × 800 ms` |
| 上交所 | `800 + random × 800 ms` |
| csrcfd | 无显式 sleep（仅靠重试退避） |

上交所特有：`currStatus` 3/6 偶发空 → 该状态**重试一次**再放弃。

### 2.3 翻页与早停（倒序早停）

各源列表都按**日期倒序**，故逐页抓、看**页内最早日期**是否越过窗口 → 越过即停：

| 源 | 翻页方式 | 兜底上限 | 早停条件 | 窗口下界 `floor` |
|---|---|---|---|---|
| csrcfd | 逐页 `index.html` / `index_N.html` | `MAX_PAGES = 10` | 页内最早披露 < floor；或**连续 2 页**无有效日期 | 今 − 7 天（`windowFloorStr`，**不回退周末**） |
| 深交所 | `pageIndex = 0..`，`pageSize = 50` | `MAX_PAGES = 5` | 页内最早 `updtdt` < floor；连续 2 页空 | `windowFloor()` = 今 − 7 天，**落周末回退到最近工作日** |
| 上交所 | **双板（1 科创板 + 2 主板）× currStatus 1~9**，`pageSize = 50` | 每状态 `MAX_PAGES = 3` | 页内最早 `updateDate` < floor | 同深交所（`windowFloor()`） |

说明：

- **为什么早停**：列表倒序，窗口外的都是旧闻，抓到窗口下界即可停（通常 1~3 个请求）。
- **上交所为什么按状态分批**：`currStatus` 直接全量翻页会因排序漂移丢主板块；按 `1~9` 逐状态抓，其中
  负面状态 `6/7/8/9` 直接跳过不抓（省请求）。
- **csrcfd 与另两源的 floor 差异**：csrcfd 用 `windowFloorStr()`（今 −7 天，不回退周末）；
  深交所/上交所用共享 `windowFloor()`（今 −7 天，落周末回退到最近工作日，因三所审核只在交易日更新）。

### 2.4 广东判定（内容判定，非源分类）

- **广东城市词（20 个）**：`广州 深圳 东莞 佛山 珠海 中山 惠州 江门 汕头 湛江 肇庆 梅州 汕尾 河源 阳江 清远 潮州 揭阳 云浮 顺德`
- csrcfd：派出机构 ∈ {广东证监局, 深圳证监局} **或** 企业名/备案时间含广东城市
- 深交所：官方 `regloc`（去「省/市」后缀）== 广东 **或** 企业名含广东城市
- 上交所：`s_province` == 广东 **或** `s_areaNameDesc` ∈ {广东, 深圳} **或** 企业名含广东城市

> 无状态源红线：数据源的 category/子类**不决定**最终渲染归属；这里也是靠**内容字段**判广东。

### 2.5 丢弃规则（各源）

| 源 | 丢弃条件 |
|---|---|
| csrcfd | `撤回辅导备案` 丢弃；无披露日且无备案时间丢弃 |
| 深交所 | `终止 / 中止 / 不予注册 / 撤回 / 终止注册` 丢弃；无 `updtdt` 丢弃 |
| 上交所 | 状态 `6 不予注册 / 7 中止 / 8 终止 / 9 已发行` 丢弃；无 `updateDate` 丢弃 |

时间取值：csrcfd = PDF 路径披露日**优先**、次选备案时间；深交所 = `updtdt`；上交所 = `updateDate`（紧凑格式解析）。

### 2.6 新鲜度哨兵

各源 `run()` 末尾调 `warnIfStale()`：

- 本次抓到的日期为 **0 条** → 告警（接口改版 / 分桶异常 / 被反爬）
- 最新日期滞后今天 **> 10 天**（`STALE_LAG_DAYS_IPO`）→ 打 `::warning::`

目的：区分「源真没动态」与「源坏了」。IPO 源天然稀疏，故阈值放宽到 10 天，避免天天误报淹没真故障。

### 2.7 归一化（写盘前，共享函数 `normalizeLocalIpoItems()`）

严格三步，纯函数（`now` 可注入）：

1. **丢无 `publishedAt`**（时间红线——无真实发布时间一律丢弃）
2. **窗口裁剪**：`isWithinCalendarDays(publishedAt, 7, now)` = **含今天共 7 个日历日**
3. **按 URL 去重**（无 URL 退化为 `sourceId|title` 内容键）

> ⚠️ **口径差（已知且接受）**：源层 floor 是「**日差 ≤ 7**」，渲染窗是「**含今天共 7 个日历日**」，
> 边界差 1 天。源层按「日差 ≤7」抓回的边界条目，可能不出现在渲染列表里。这是用户确认接受的现状。

### 2.8 快照合并（`buildLocalIpoSnapshot()`）

- 本轮新抓结果 + 文件里**仍在窗口内**的旧条目合并（**merge-preserve**：某天抓取失败不清空文件）
- 按 key（url，退化 `sourceId|title`）合并，**冲突取 `publishedAt` 较新者**
- **确定性排序**：`publishedAt 倒序 → sourceId → url`
  → 使每日 git commit 的 **diff 只含真实增量**（无变化时只差 `fetchedAt` 一行）

---

## 3. 抓取内容（字段）

每条产出（`CrawlerResult` → `CrawledArticle`）：

| 字段 | 说明 |
|---|---|
| `title` | 含官方状态词，如 `汉诺医疗：IPO问询中（拟科创板）`（供下游分栏） |
| `url` | csrcfd = PDF 直链；深交所 = `列表页#prj<id>`；上交所 = `列表页#<代码>@<状态>`（含状态锚点，同一企业状态升级**不被 URL 去重吞掉**） |
| `excerpt` | 注册地 / 保荐 / 受理日 / 状态 / 更新日 / 行业 等，用 `｜` 拼接 |
| `publishedAt` | **源站真实日期**（绝不抓取日兜底） |
| `source` | 爬虫名，如 `上交所IPO审核动态` |
| `sourceId` | 白名单三选一：`gd-csrc-tutoring` / `gd-szse-audit` / `gd-sse-audit` |
| `region` | 固定 `gd` |
| `registeredProvince` | 固定 `广东` |
| `ipoStage` | 官方状态 → 阶段（旁路关键词反推） |

`ipoStage` 取值：`stage-tutoring` / `stage-coach-done` / `stage-reviewing` / `stage-registered` / `stage-listed`。

映射口径（各源按官方状态给出，不靠标题关键词反推）：

- csrcfd 列4「辅导状态」：`辅导备案 → stage-tutoring`；`辅导验收 / 辅导工作完成 → stage-coach-done`；未知回退 `stage-tutoring`
- 深交所 `prjst`：`已受理 / 已问询 → stage-reviewing`；`上市委会议通过 / 提交注册 / 已收到注册申请材料 / 注册生效 → stage-registered`
- 上交所 `currStatus`：`1 已受理 / 2 问询中 → stage-reviewing`；`3 过会 / 4 提交注册 / 5 注册生效 → stage-registered`；`6~9` 丢弃

---

## 4. 数据格式

**JSON**，顶层 6 键 + `items[]`。

- 序列化：`JSON.stringify(file, null, 2)` + 尾随换行
- **原子写**：先写 `<file>.tmp` 再 `rename` → 避免 CI 读到半截文件

结构：

```
{
  "version": 1,                 // 格式版本；不符则读取端判为不可用
  "fetchedAt": "<ISO8601 +08:00>", // 本地抓取完成时刻
  "generator": "local-ipo-sync",
  "windowDays": 7,              // 写入时用的窗口口径（供读取端自证两边一致）
  "sourceCounts": { "<sourceId>": <n>, ... }, // 按 sourceId 计数，键名排序
  "items": [ CrawledArticle, ... ]
}
```

真实样例：

```json
{
  "version": 1,
  "fetchedAt": "2026-10-01T18:01:30+08:00",
  "generator": "local-ipo-sync",
  "windowDays": 7,
  "sourceCounts": { "gd-sse-audit": 2, "gd-szse-audit": 2 },
  "items": [
    {
      "title": "汉诺医疗：IPO问询中（拟科创板）",
      "url": "https://www.sse.com.cn/listing/renewal/ipo/#2148@2",
      "excerpt": "注册地：广东深圳市｜保荐：中信证券股份有限公司｜受理：2025-12-23｜状态：IPO问询中｜更新：2026-09-30｜行业：专用设备制造业",
      "publishedAt": "2026-09-30",
      "source": "上交所IPO审核动态",
      "sourceId": "gd-sse-audit",
      "region": "gd",
      "registeredProvince": "广东",
      "ipoStage": "stage-reviewing"
    }
  ]
}
```

读取端容错：不存在 / JSON 坏 / `version` 不符 / `items` 非数组 → 判为**不可用**（`file = null`），不硬用。

---

## 5. 写入项目与文件路径

- **项目/仓库**：`gzinfols`（远端 `shengc-shv/gzinfols`，分支 `main`）
- **写入文件（唯一）**：`data/local-ipo.json`（常量 `LOCAL_IPO_PATH`，相对仓库根，随代码提交）
- **git 动作（脚本内置）**：
  `git add -- data/local-ipo.json`（**只提交这一个文件**，工作区其他未提交改动仅告警不动）
  → `commit` → `git fetch origin main` → `git merge --no-edit origin/main`
  （冲突则 `abort` 并退出 1，**绝不强推**）→ `git push origin main`
  - 文件内容无变化 → 跳过提交推送
  - ⚠️ `push` 是**分支级**：会带上本地 main 上**所有**已提交未推送的提交

**下游消费（远端 CI）**：`fetchCrawledArticles()` → `selectLocalIpoItems()` 读该文件 →
**白名单校验**（sourceId 必须 ∈ 三源集合，否则丢弃告警）→ 再走一遍共享归一化 →
与在线条目**按 URL 去重（在线优先）** → 并入当日 IPO 批次 → 进日报「广东地区IPO」板块。

---

## 6. 运行方式

```bash
cd <repo>
npm run ipo:local                      # 抓取 → 写盘 → 提交推送
npm run ipo:local -- --dry-run         # 只抓取与打印，不写盘、不推送（推荐先跑）
npm run ipo:local -- --no-push         # 写盘但不提交推送
npm run ipo:local -- --sources=all     # 用全量 IPO 源跑（本地网络都到得了）
npm run ipo:local -- --window=<天>     # 覆盖窗口（默认 7）
npm run ipo:local -- --file=<路径>     # 覆盖产出文件（默认 data/local-ipo.json）
```

**起飞前 30 秒三查**：

1. `git log --oneline origin/main..main` 应为空（若有未推送提交，本命令的分支级 push 会一并送上）
2. `git status --short` 看未提交改动（未 `git add` 的不会被推，安全）
3. 查 GitHub Actions 最近 run 无 `in_progress`（`created_at` 是 UTC，读出来要 **+8**）

---

## 7. 汇报与判读纪律

- 汇报必报：各源条数（`gd-csrc-tutoring` / `gd-szse-audit` / `gd-sse-audit`）+ 沿用旧条目数 + 最终文件条目数
- 汇报必报：归一化裁剪情况（丢无日期 / 超窗 / 重复）
- 汇报必报：commit 与 push 结果（若「文件无变化 → 跳过提交」也要说明）
- ⚠️ **判断「有没有新数据」要看 diff 行数，不看 `fetchedAt`**：
  新抓条目与旧文件窗口内条目**完全重合**时，merge 后条数不变，commit 只有 `fetchedAt` 一行 diff
  （`1 insertion / 1 deletion`）→ 必须显式写明「同步成功，但**本次无新增条目**」，
  否则会被误读成「今天来了新 IPO」。
- 失败要显式报出：`--dry-run` 下新抓 0 条且总量 0 → 退出码 1；正式模式全部源 0 条只 warn
  （沿用旧文件窗口内条目后写盘）；合并冲突 → abort 退出 1 并提示人工处理。

---

## 8. 纪律与红线（勿违反）

1. **只动 `data/local-ipo.json`**，不顺手改别的文件（避免和 CI 的归档提交冲突）。
2. **不自己写过滤/去重逻辑**：一律调 `normalizeLocalIpoItems()`（本地写入与远端读取**同一份实现**）。
3. **sourceId 必须 ∈ 白名单**（`LOCAL_ONLY_IPO_SOURCE_IDS`），写错会被远端丢弃并告警。
4. **时间真实性红线**：只用源站真实日期，抓不到就丢弃，**绝不用抓取日兜底**。
5. **建议每工作日至少跑一次**（文件中 `fetchedAt` 超 2 天 `LOCAL_IPO_STALE_DAYS`，远端会打「本地同步可能已中断」告警）。
6. **频率克制**：页间 0.8~1.6s 节流、单源最多 3~10 页、失败指数退避 —— 避免触发反爬。
7. **推送前若 CI 正在跑**：不要在 CI 运行期间手工再推 main（归档收尾虽内置并发免疫，但仍应避开）。
8. **远程 push 前先授权**：按项目红线，推送远端须先获明确同意（自动化场景除外）。

---

## 9. 排障速查

| 症状 | 判断与处理 |
|---|---|
| `git commit` 报 `Author identity unknown` | 仓库无 local/global `user.name/email`。设**仓库局部**（值对齐历史作者）后**重跑**（抓取+写盘幂等） |
| `github.com:443` 不可达（`curl github.com`=000，`curl api.github.com`=200） | 环境网络策略/代理故障（非瞬时抖动）。重试 2~3 次仍 000 即停止空转，等网络恢复后**手工补推**（勿重跑 `npm run ipo:local`，否则生成重复 commit） |
| `git fetch` 长时间无输出 | 先 `curl` 探活确认是网络问题；用 `git -c credential.helper= fetch` + `GIT_TERMINAL_PROMPT=0` 复测，几秒内成功即瞬时抖动，重跑即可 |
| 手工 push | 用 `git -c credential.helper=osxkeychain push`（保留 keychain 助手；空值助手只能读、推不上去） |
| 校验推送结果 | 用 `git log -1 origin/main` 的 commit 号 + push 回显；沙箱内 `raw.githubusercontent.com` 常不可达，别拿 raw 抓取当判据 |
| 归一化报「丢无日期」偏多 | 源站字段改版或接口换分桶 → 查 `warnIfStale` 的告警与源站页面 |

---

## 10. 相关文件索引

| 文件 | 职责 |
|---|---|
| `scripts/ipo-local.ts` | 本技能执行体（`npm run ipo:local`） |
| `lib/adapters/local-ipo.ts` | 文件读写 + 快照合并（`buildLocalIpoSnapshot`）+ 远端接入端 `selectLocalIpoItems`（白名单/新鲜度/在线优先去重）+ 白名单常量 |
| `lib/services/normalize/crawl.ts` → `normalizeLocalIpoItems()` | **共享归一化实现**（时间红线 / 窗口 / URL 去重） |
| `lib/adapters/crawlers/index.ts` | `buildLocalOnlyIpoCrawlers()` / `buildOnlineIpoCrawlers()` / `selectIpoCrawlersForRun()` |
| `lib/adapters/crawlers/base-crawler.ts` | 基类（超时 / 重试 / 退避 / `toCrawledFormat()`） |
| `lib/adapters/crawlers/sources/csrcfd.ts` | 证监会辅导爬虫 |
| `lib/adapters/crawlers/sources/szse-audit.ts` | 深交所审核动态爬虫 |
| `lib/adapters/crawlers/sources/sse-audit.ts` | 上交所审核动态爬虫 |
| `lib/adapters/crawlers/sources/ipo-shared.ts` | 共享工具（`windowFloor` / `shortName` / `GD_CITIES`） |
| `lib/adapters/crawlers/sources/staleness.ts` | 新鲜度哨兵（`warnIfStale` / `STALE_LAG_DAYS_IPO`） |
| `lib/ipo-config.ts` | 窗口常量唯一真源（`IPO_SOURCE_WINDOW_DAYS = 7`） |
| `lib/utils/time.ts` | `isWithinCalendarDays` / `todayKeyOf` / `extractDateFromUrl`（报告时区 Asia/Shanghai） |
| `data/local-ipo.json` | **产出文件**（随代码提交，供远端补数） |
