# AGENTS.md — gzinfols 2.0 代理协作指南

## 项目是什么

某股分行**每日资信简报生成器 2.0**：gzinfo 的独立升级版。每日从多源抓取资讯 →
归一化 → 关键词漏斗 → AI 富集 → 组装定档 → 渲染单页 HTML / Markdown / 口播稿 → 发布，
并维护 30 天滚动历史库。

架构：**端口 / 适配器（Ports & Adapters）**。
- `lib/contracts/` 契约层：类型、端口接口、常量。**零逻辑、零副作用**，不依赖 services/adapters。
- `lib/services/` 服务层：业务逻辑（C1采集 → C2归一化 → C3筛选 → C4富集 → C5记忆 → C6组装 → C7渲染 → C8语音 → C9发布）。只依赖契约端口，**禁止** import `node:` 内置模块或 `lib/adapters`。
- `lib/adapters/` 适配器层：唯一副作用出口（fs / clock / llm / http / logger）。
- `lib/orchestrator/` 组合根：唯一 new 具体实现的地方，装配 deps + ctx。
- `lib/pipeline/` 编排：按阶段串服务，不含业务规则。
- `lib/architecture/check.ts` 架构门禁：机器可查上述分层约束。

## 目录速览

```
lib/contracts/    # 契约：article / report / source / pipeline（端口+上下文）
lib/services/     # 每阶段一个目录（enrich AI 两阶段管线 / market 股市 / voice 口播 / memory 记忆）
lib/adapters/     # 副作用实现；llm.ts 按 LLM_BACKEND 切后端
lib/orchestrator/ # 组合根（createContext / bootstrap）
lib/pipeline/     # runPipeline / runDryRun
scripts/          # daily / dry-run / render / architecture-check 入口
tests/            # node:test + MemFs/FakeHttp/FakeLlm 离线测试
sources.config.json / sources.keywords.json  # 源与关键词唯一真源
```

## 硬性规定

- **时区只认北京时间**：全项目统一 `Asia/Shanghai`（常量 `REPORT_TZ`，见 `lib/utils/time.ts`），
  **不接受 env 覆盖、不回落系统时区**。任何日期键、窗口、交易日计算都必须走该常量，
  禁止 `process.env.REPORT_TZ`、`Intl` 无 `timeZone` 的隐式系统时区、`new Date()` 直接取日历日。
- **加密板块零容忍（2026-09-12 用户拍板，永久）**：加密资产内容**不合规**，任何形态都不得出现——
  不移植 `trading/coingecko`、`fear-greed`；契约不引入 `crypto_fear_greed`；渲染不做加密段。
  内容侧双重拦截：`lib/services/enrich/validator.ts` 的 `BANNED_WORDS`（R6 违禁词）+ `prompts.ts` 的
  PASS1 合规红线（涉虚拟货币一律 `keep=false`）。**两处防线不得削弱，新增加密变体词须同步补进 `BANNED_WORDS`**。
  注：`sources.config.json` 里的「Token贷/词元贷」是银行信贷产品，与加密资产无关，属正常业务词。
- **不得出现可定位到具体银行的信息（2026-09-12 用户明令）**：全项目（代码注释、文档、产出物标题、
  README、package.json、记忆文件）禁止出现可反查具体银行主体的字样（行名全称 / 简称 / 英文缩写 / 内部项目代号），
  一律改写为「某股分行」或「本行」。业务词表与代码标识符中的历史遗留另行登记，见交付报告待确认项。

## 三条业务红线（不可回退）

1. **时间真实性**：无真实 `publishedAt` 一律丢弃。normalize（C2）是唯一裁决点，
   绝不用抓取时间 / fetchedAt 兜底。类型级保证：`NormalizedArticle.publishedAt` 必填。
2. **板块归属由内容判定**（assignSection 打分）：不读 sourceId/category 字符串做一般归属。
   category 仅可作为 IPO 内容态来源（ipo/gd-ipo）与参考区豁免判断（select/funnel）。
3. **业务相关性**：条目必须与 客群/财富/私人银行/信贷 相关，或是国家/省/市级商机政策。
   漏斗只做硬排除（keyword-funnel L0 + 维度匹配），准度由 enrich 的两阶段 AI 管线终审：
   PASS1 的 keep 判定即相关性闸门（gzinfo 语义）；商机/风险追踪器命中与参考区条目豁免。

## 命令表

| 命令 | 作用 |
|---|---|
| `npm run daily` | 完整管线：采集→…→发布（env：REPORT_DATE / SKIP_AI=1 / LLM_BACKEND） |
| `npm run dry-run` | 仅采集+归一化+漏斗，不调 LLM、不落盘 |
| `npm run render` | 用已落盘的报告 JSON 重渲染产物 |
| `npm run ipo:local` | 本地抓两个 WAF 拦源的 IPO 数据并提交 `data/local-ipo.json`（`--dry-run`/`--no-push`） |
| `npm run build-site` | 站点聚合：生成 index.html / archive.html（跑在 daily 之后） |
| `npm run regen:trading` | 只重跑交易面板并打补丁回当日报告 JSON |
| `npm run quota-report` | LLM 用量报表（读 logs/llm-calls.jsonl；claude-cli 看 5h 窗口，API 后端看 24h） |
| `npm run architecture:check` | 架构门禁（服务层/契约层依赖约束） |
| `npm run typecheck` | tsc --noEmit |
| `npm test` | node --test 全量离线测试 |

## What NOT to do

- **不硬编码源**：源一律来自 `sources.config.json`；关键词来自 `sources.keywords.json`。
  这两个文件是唯一真源，不要在代码里复制源定义或词表。
- **不直连 LLM 后端**：业务代码只调 `LlmPort.complete()`；换后端只改 `lib/adapters/llm.ts`
  （LLM_BACKEND 环境变量），禁止在服务层 import openai/anthropic SDK。
- **不绕过 per-source try/catch**：采集层每源独立隔离，单源失败只记 ctx.errors，不许中断整轮。
- **不 push 未经授权**：本地 commit 可以，严禁 push 到任何远端（用户红线）。
- **服务层不碰 node: 与 adapters**：副作用全走契约端口；时间用 `ctx.startTime`，
  配置用 `ctx.config`，禁止服务层直读 `process.env`（组合根 orchestrator 负责读）。
- **契约层零逻辑**：`lib/contracts/**` 只放类型 / 端口 / 常量，不写函数逻辑与副作用。
- **LLM 调用要埋点**：每次 `LlmPort.complete()` 出口由 `lib/adapters/llm.ts` 写一条明细到
  `logs/llm-calls.jsonl`（backend / model / 耗时 / 字符数 / 错误归类），旁路开关 `LLM_TELEMETRY=off`；
  纯聚合在 `lib/services/metrics`，报表看 `npm run quota-report`。埋点失败绝不影响主流程。
- **LLM 调用要批量 + 计数**：富集走批量（每批 20 条）+ 并发池（≤4 在飞）；
  `must_read.url` 必须校验 ∈ 今日条目集合；失败降级要写 ctx.errors 与 ctx.stats。
- **历史库单一写者**：只有 `lib/services/memory` 负责 merge（纯函数），落盘统一走
  `lib/adapters/persistence`；管线下载入历史供 select 的 stage6 跨天判重与 PASS2 prefill 复用，
  在 history-step（PASS2 摘要回流 → merge+persist → buildRolling → 近 7 天并入）中回写。
