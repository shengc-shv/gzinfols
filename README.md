# gzinfols — 招行广州分行每日资信简报生成器 2.0

> **gzinfols** 是 **gzinfo** 的 2.0 升级版本，与 gzinfo **并列同级**，是一个可**独立发布、独立部署、独立运行**的产品。
> 它不依赖 gzinfo 的代码或运行环境，拥有自己的 Git 仓库、自己的 CI、自己的发布通道。

---

## 定位与设计原则

- **独立产品**：自有仓库（`shengc-shv/gzinfols`）、自有 CI（`.github/workflows/daily.yml` → 自有 `gh-pages`）、自有发布通道。
- **逻辑微服务 + 物理可选拆分**：按业务能力划分为 9 个核心服务（C1–C9）与 1 个可选服务（C10），它们之间只通过**契约（contracts）**与**依赖注入（deps）**通信；默认单进程运行，但每个服务可在零改动契约的前提下独立进程化 / 独立部署。
- **端口 / 适配器（Ports & Adapters）**：所有副作用（文件系统、时钟、LLM、网络）一律收敛到 `lib/adapters/`，业务服务**只依赖接口（端口），不依赖具体实现**。
- **架构门禁棘轮（Architecture Gate Ratchet）**：`npm run architecture:check` 把「服务互不依赖、IO 唯一出口、无循环、行数上限」变成机器可拒绝的规则，区分「硬性 0（绝不放宽）」与「基线棘轮（逐阶段清零）」。
- **单一写者 + 组合根**：`lib/orchestrator/` 是唯一把各服务与适配器拼装起来的地方（组合根），其余模块不得自行 new 副作用实现。

---

## 业务设计（保留自 gzinfo 已验证口径）

### 数据链路：5 阶段管道
```
采集(C1 collect) → 归一化(C2 normalize) → 漏斗筛选(C3 select)
   → AI 富集(C4 enrich) → 组装(C6 assemble) → 渲染(C7 render)
   → [语音 C8 voice] → 发布(C9 publish)  +  [行情 C10 market]
```
记忆服务（C5 memory）贯穿全程，作为单一写者维护事件记忆库。

### 报告结构：5 个 Tab
1. **广州本地**（本地政务 / 商机 / 民生）
2. **业务启示**（须能挂上 客群 / 财富 / 私人银行 / 信贷）
3. **政策与市场**（国家级 / 省级 / 市级商机政策）
4. **科技前沿**
5. **IPO 动态**（全国参考）

### 三条业务红线（不可妥协）
1. **时间真实性**：抓取不到真实 `publishedAt` 的条目一律丢弃，绝不用抓取时间兜底。
2. **无状态源**：最终板块归属一律由内容判定（阶段词 + 城市锚 + 相关性评分），禁止用 `sourceId / category` 直接定义。
3. **业务相关性**：进「业务启示 / 政策与市场」的内容必须能挂上客群 / 财富 / 私行 / 信贷，宁缺毋滥。

---

## 项目结构

```
gzinfols/
├── lib/
│   ├── contracts/        # 零逻辑契约：Article / Source / Report / Pipeline 类型与接口
│   ├── adapters/         # 副作用端口：fs / clock / llm / http（唯一实现出口）
│   ├── services/         # 逻辑微服务 C1..C10（只依赖 contracts + 注入的 deps）
│   ├── orchestrator/     # 组合根：唯一拼装服务与适配器的地方
│   ├── pipeline/         # 5 阶段编排（调用 services）
│   └── architecture/     # 架构门禁棘轮实现
├── scripts/              # 入口：daily / dry-run / render / architecture-check
├── tests/                # 架构门禁 + 单元测试
├── sources.config.json   # 数据源唯一真源（SOURCE OF TRUTH）
├── .env.example          # REPORT_LOCALE / LLM_BACKEND / *API_KEY（时区固定 Asia/Shanghai）
├── AGENTS.md             # 给 AI 协作代理的操作知识
└── .github/workflows/    # 自有 CI
```

---

## 常用命令

| 任务 | 命令 | 说明 |
|---|---|---|
| 完整管道 | `npm run daily` | 采集→渲染→发布（含 LLM 调用） |
| 仅抓取校验 | `npm run dry-run` | 无 LLM，验证数据源可连通 |
| 重新渲染 | `npm run render [date]` | 用已抓取数据重渲染 |
| 架构门禁 | `npm run architecture:check` | 机器可拒绝的结构规则 |
| 类型检查 | `npm run typecheck` | `tsc --noEmit` |
| 测试 | `npm test` | node 内置 test runner + tsx |

---

## 与 gzinfo 的关系

- gzinfols **不是** gzinfo 的分支、submodule 或 worktree，二者是**两个独立仓库**。
- 业务口径（5 阶段、5 tab、3 红线）继承自 gzinfo 已验证的实现，但代码以**结构化重写**方式落地在 gzinfols 自有架构中。
- gzinfols 不 import gzinfo 的任何模块，也无共享运行环境。
