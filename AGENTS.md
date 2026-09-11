# AGENTS.md — gzinfols 2.0 代理协作指南

## 项目是什么

招行广州分行**每日资信简报生成器 2.0**：gzinfo 的独立升级版。每日从多源抓取资讯 →
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
lib/services/     # 每阶段一个目录；enrich/relevance.ts 为 AI 相关性回检
lib/adapters/     # 副作用实现；llm.ts 按 LLM_BACKEND 切后端
lib/orchestrator/ # 组合根（createContext / bootstrap）
lib/pipeline/     # runPipeline / runDryRun
scripts/          # daily / dry-run / render / architecture-check 入口
tests/            # node:test + MemFs/FakeHttp/FakeLlm 离线测试
sources.config.json / sources.keywords.json  # 源与关键词唯一真源
```

## 三条业务红线（不可回退）

1. **时间真实性**：无真实 `publishedAt` 一律丢弃。normalize（C2）是唯一裁决点，
   绝不用抓取时间 / fetchedAt 兜底。类型级保证：`NormalizedArticle.publishedAt` 必填。
2. **板块归属由内容判定**（assignSection 打分）：不读 sourceId/category 字符串做一般归属。
   category 仅可作为 IPO 内容态来源（ipo/gd-ipo）与参考区豁免判断（select/funnel）。
3. **业务相关性**：条目必须与 客群/财富/私人银行/信贷 相关，或是国家/省/市级商机政策。
   漏斗只做硬排除，准度由 enrich 的 AI 相关性回检（relevance.ts）终审；商机/风险追踪器
   命中与参考区条目豁免 AI。

## 命令表

| 命令 | 作用 |
|---|---|
| `npm run daily` | 完整管线：采集→…→发布（env：REPORT_TZ / REPORT_DATE / SKIP_AI=1 / LLM_BACKEND） |
| `npm run dry-run` | 仅采集+归一化+漏斗，不调 LLM、不落盘 |
| `npm run render` | 用已落盘的报告 JSON 重渲染产物 |
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
- **LLM 调用要批量 + 计数**：富集走批量（每批 20 条）+ 并发池（≤4 在飞）；
  `must_read.url` 必须校验 ∈ 今日条目集合；失败降级要写 ctx.errors 与 ctx.stats。
- **历史库单一写者**：只有 `lib/services/memory` 写 history；管线内先回放去重、尾部回写。
