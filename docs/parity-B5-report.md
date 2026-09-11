# B5 交付核对报告：发布链路移植（2026-09-11）

> 基准：gzinfo @ /Users/shengc/ccworkstaion/gzinfo ｜ 验收口径见 `docs/parity-plan.md` §2.4 / §5 B5
> 结论：**功能对齐通过**；发布门控判据、先发后记因果序、history/记忆回流 main 三项核心行为与 gzinfo 一致；
> 差异项（.gitignore 调整、报告归档源目录）已列出并说明理由。

## 1. 范围

B5 聚焦「发布链路可核对移植」四项（parity-plan §2.4 的 P1 + 历史归档 + cleanup-history + workflow 门控）：

| # | 项 | gzinfo 模块 | 规模 | 2.0 落位 | 状态 |
|---|---|---|---|---|---|
| ① | 发布来源记账（状态机） | `lib/publish-state.ts` | 93 | `lib/services/publish/publish-state.ts` | ✅ 逐字 |
| ① | 发布来源记账（IO） | — | — | `lib/adapters/persistence.ts`（+load/persistPublishState） | ✅ 架构适配 |
| ① | 记账脚本 | `scripts/record-publish-state.ts` | 94 | `scripts/record-publish.ts` | ✅ 逐字逻辑 + 适配器 IO |
| ① | 记账测试 | `tests/publish-state.test.ts` | 102 | `tests/publish-state.test.ts`（+落盘用例） | ✅ 8 移植 + 4 新增 |
| ② | 历史裁剪脚本 | `scripts/cleanup-history.mjs` | 124 | `scripts/cleanup-history.mjs` | ✅ 逐字（import 路径适配） |
| ② | 目录裁剪纯函数 | `lib/history/retention.mjs` | 32 | `scripts/history-retention.mjs` | ✅ 逐字（IO 归属适配） |
| ③ | CI 门控 + 归档 + 记账 | `.github/workflows/daily.yml` | — | `.github/workflows/daily.yml` | ✅ 4 处改造 |
| ④ | 进度文档 | — | — | `parity-plan.md` / `HANDOFF.md` / 本报告 | ✅ |

不在本次范围（顺延 B6，见 §6）：`deliverySettlementGate`、`regen-trading`/`ipo-local` 等运维脚本、
`build-site`、render 全量对齐。

## 2. 逐项功能对照

### 2.1 发布来源状态机（`publish-state.ts`）
| 功能点 | gzinfo | 2.0 | 核对 |
|---|---|---|---|
| 来源枚举 | `schedule` / `manual` / `manual-final` / `manual-test` | 逐字 | ✅ |
| 同日覆盖 / 跨日新增 | `recordPublish` 以 date 为 key 覆盖 | 逐字 | ✅ |
| cron 跳过判据 | `isSchedulePublishedOn`：schedule 或 manual-final → true；manual-test/裸 manual/损坏 → false | 逐字 | ✅ 官方 8 用例移植通过 |
| 裁剪 | `prunePublishState` 保留最近 N 天（同日覆盖 → 按条数剪=按天数剪） | 逐字 | ✅ |
| 空库 | `emptyPublishState` | 逐字 | ✅ |

### 2.2 记账脚本（`scripts/record-publish.ts`）
| 功能点 | gzinfo | 2.0 | 核对 |
|---|---|---|---|
| 报告时区 | `REPORT_TZ` 默认 `Asia/Shanghai`，en-CA 格式化取「今天」 | 逐字（`reportDate`） | ✅ |
| SOURCE 校验 | 必填，非四来源之一 → `process.exit(1)` | 逐字（`parseSource` + main exit 1） | ✅ CLI 实测 exit=1 |
| 时刻 | `formatBroadcastAt(new Date(), memoryTimeZone())` | 逐字（同函数同源） | ✅ 实测 `…+08:00` |
| runId | `GITHUB_RUN_ID`（可空） | 逐字 | ✅ |
| 读改写 | 读 → `prune(record(...), 7, dateStr)` → 落盘 | 逐字（经适配器） | ✅ |
| 控制台文案 | `[record-publish] ✅ 已记录发布来源：…` + 三来源说明 | 逐字保留 | ✅ |
| 落盘格式 | `JSON.stringify(next, null, 2) + "\n"` | 逐字（persistPublishState 同格式） | ✅ 实测文件一致 |

### 2.3 历史裁剪（`cleanup-history.mjs` + `history-retention.mjs`）
| 功能点 | gzinfo | 2.0 | 核对 |
|---|---|---|---|
| 保留窗口 | `RETENTION_DAYS` 默认 7 | 逐字 | ✅ |
| 时间字段优先级 | publishedAt → lastSeenAt → firstSeenAt | 逐字 | ✅ |
| 移除不丢弃 | 累积写 `article-history-backup.json`（按 id/源+标题+时间 去重） | 逐字 | ✅ 实测备份 2 条 |
| 旧年份安全网 | 无 publishedAt 且标题含 ≤ 今年-2 年份 → 直接移除 | 逐字 | ✅ 实测移除「…1999」条目 |
| 数组/对象两形态 | 均支持 | 逐字 | ✅ |
| 根 history/ 目录裁剪 | `pruneHistoryDirs(root, N)` 删早于 cutoff 的 `YYYY-MM-DD` 目录 | 逐字 | ✅ 实测删 1 个过期目录 |
| 日志文案 | `[cleanup] 保留最近 N 天…` / `[cleanup] 根 history/ …` | 逐字 | ✅ |

### 2.4 daily.yml 改造（逐项）
| # | 改造 | gzinfo 对应 | 2.0 实现 | 核对 |
|---|---|---|---|---|
| 1 | gate 判据改为 publish-state | daily.yml 335-355 | 读 main `data/publish-state.json`，`node -e` 判「当天 in-effect」→ `should-run` | ✅ 语义一致 |
| 2 | `release_mode` input | daily.yml 53-59 | choice `final`(默认)/`test`，描述一致 | ✅ |
| 3 | `PUBLISH_RUN` env | daily.yml 371 | schedule 依赖 `needs.gate.outputs.should-run=='true'`；dispatch 用 `inputs.publish` | ✅ |
| 4a | Trim history | daily.yml 450-451 | `node scripts/cleanup-history.mjs` | ✅ |
| 4b | Archive + commit | daily.yml 453-483 | cp 报告到 history/ + git add + 有变化才 commit + 并发免疫 push | ✅ |
| 4c | Record publish source | daily.yml 513-540 | 独立 `record` job（needs: deploy）→ 先发后记 + 并发免疫 push | ✅ 因果序更强 |

## 3. 架构调整与理由

| # | 调整 | 理由 |
|---|---|---|
| 1 | `publish-state.ts` 从 gzinfo 根 `lib/` 归入 `lib/services/publish/` | parity-plan §3 映射：发布域服务；纯函数零 IO，符合服务层约束 |
| 2 | 状态机 IO 抽入 `lib/adapters/persistence.ts`（`loadPublishState`/`persistPublishState`，带 `baseDir` 覆盖） | gzinfo 脚本内联 fs；2.0 服务层禁 fs/node，IO 归适配器；`baseDir` 使记账逻辑可离线测 |
| 3 | `record-publish.ts` 用 `isDirectRun()` 守卫替代 gzinfo 的顶层 `main()` | 2.0 为 ESM（无 `__dirname`）；且需被测试 import（守卫避免 import 即执行/exit） |
| 4 | 记账脚本不再用 `__dirname`，改适配器 `process.cwd()` 基目录 | 2.0 ESM 无 `__dirname`；与 `loadHistoryStore` 等既有 IO 同口径 |
| 5 | `history-retention.mjs` 从 gzinfo `lib/history/` 移到 `scripts/` | 该模块是纯 IO（`fs.rmSync`），只被 plain-node 脚本 import；2.0 约束「IO 归 adapters 或 scripts/**」，置 scripts/ 最合规，且保证 `node scripts/cleanup-history.mjs` 可直跑 |
| 6 | 记账做成独立 `record` job（`needs: deploy`）而非塞进 build job | 2.0 用官方 `actions/deploy-pages`（部署在独立 job）；独立 job 天然保证「部署成功后才记账」，因果序比同 job 内 `if: outcome==success` 更清晰 |
| 7 | workflow `permissions` 增 `contents: write` | 归档/记账需 push main（gzinfo 同款） |
| 8 | `.gitignore`：`history/` → `data/history/` | gzinfo 提交根 `history/` 但忽略 `data/history/`；2.0 归档步骤 `git add history/` 要求根 history/ 可跟踪（原 `history/` 规则会令该步失败） |

## 4. 行为等价证据

1. **官方测试全量移植 + 通过**：`tests/publish-state.test.ts` 8 个纯函数用例（empty/record/判据/容错/prune）逐字移植，仅改 import 路径。
2. **落盘往返实测**（新增 4 用例）：
   - `runRecordPublish` 经 `baseDir` 隔离写入 → `loadPublishState` 读回断言 source/runId/publishedAt/updatedAt；
   - 连写 10 天 → 落盘受 `prunePublishState(7)` 约束（仅存最近 7 天）；
   - 非法 SOURCE → 返回 undefined 且**不写盘**、打印 SOURCE 错误。
3. **CLI 端到端实测**：
   - `SOURCE=schedule npm run record-publish` → 落盘结构正确、`✅ 已记录发布来源：2026-09-11 source=schedule @ …+08:00（run run-777）`、exit 0；
   - `SOURCE=bogus` → `SOURCE 缺失或非法…退出 1`、exit 1。
4. **cleanup-history 实测**（隔离 cwd，plain `node`）：保留近 7 天 1 条、移除 2 条（含旧年份条目）、备份累积 2 条、删除 1 个过期 `history/` 日期目录，日志文案一致。
5. **daily.yml YAML 解析通过**：4 job（gate/build/deploy/record）、cron 三行不变、`release_mode` choice、PUBLISH_RUN / SOURCE 表达式解析正确。
6. **全量回归**：`npx tsc --noEmit` **0 错误**；`npm run architecture:check` **通过**；`npm test` **192/192 全绿**（基线 180 + 12 新增）。

## 5. 自检：架构门禁三态

- `lib/services/publish/publish-state.ts`：纯函数、零 IO、零 `node:`/`adapters` 依赖 → 门禁通过；
- `lib/adapters/persistence.ts`：唯一新增 IO 出口（发布来源记账），与既有 history/event-memory/exec-store 同层；
- `scripts/record-publish.ts`、`scripts/cleanup-history.mjs`、`scripts/history-retention.mjs`：脚本层，允许直连 fs。

## 6. 差异与遗留

| # | 差异 | 说明 | 处置 |
|---|---|---|---|
| D1 | **gate 对 workflow_dispatch 永远放行** | 2.0 保留「手动触发永远跑」（用户选择最高优先级）；gzinfo 的 gate 在 `release_mode=final` 且当天已 in-effect 时会拦截手动重跑 | 按本批次任务要求「保留 dispatch 永远跑」；如需与 gzinfo 完全一致（手动 final 被 in-effect 拦截），B6 可再收紧 |
| D2 | **报告归档源目录（已按主理人拍板修正）** | 2.0 唯一存储=`daily_reports/<date>/`（`<date>.html/.json/.md` + `audio/`；gzinfo `data/history/reports/<date>/` 的对应物，parity-plan R3），exec store 由 `writeExecStore` 写 `history/<date>/store.json`。归档步骤源目录已从 gzinfo 的 `data/history/reports/20*/` 改为 **`daily_reports/20*/`**，`cp -r` 合并进已存在的 `history/<date>/` → 报告文件与 store.json **同目录**，结构同构 gzinfo 的 `history/<date>/`（实测见下） | ✅ 已修正（保留 `[ -d ]` 守卫，首次运行无产物不报错） |
| D2-证据 | 归档后 `history/<date>/` 实测内容 | `<date>.html` / `<date>.json` / `<date>.md` / `audio/briefing-<date>.mp3` / `store.json`（同一目录） | ✅ 对齐 gzinfo |
| D3 | **`.gitignore` 必要调整** | 将 `history/` 改为 `data/history/`（gzinfo 口径），否则归档步骤 `git add history/` 因路径被忽略而失败。副作用：本地既有 `history/2026-09-11/store.json`（此前被忽略）现暴露为未跟踪文件 | 已改；该本地文件是否随本批提交由主理人定 |
| D4 | **可选文件 add 的健壮化** | `git add … article-history-backup.json / event-memory.json` 改为「存在才 add」，避免首次运行（可选文件尚未生成，如 dispatch publish=false 不写 event-memory）导致步骤失败。gzinfo 因其仓库已提交这些文件而恒存在 | 语义等价（要提交的内容不变），仅规避首次运行边界 |
| D5 | `tests/history.test.ts` / `history-backfill.test.ts` 未移植 | 二者覆盖历史库滚动/回填，属 B3 历史库重构范畴（B3 已落地并通过回归）；与 B5 发布链路无直接关系 | 本批不移植，符合任务「可作取舍并说明」 |
| D6 | 状态机无“首次发布子进程”单测 | 落盘用例改为经适配器 `baseDir` 直接调用 `runRecordPublish`（比对子进程 spawn 更确定、无 tsx/npm 依赖）；CLI 端到端另经手工实测 | 覆盖率等价（含真 IO 往返），见 §4.2/4.3 |

## 7. 顺带修正

- `package.json` 增脚本 `"record-publish": "tsx scripts/record-publish.ts"`（gzinfo 同款命令名）。
- `docs/parity-plan.md`：进度行更新为 B1-B5 ✅；新增 B5 说明段；P1/P3 行标 ✅；§5 B5 行补核对点。
- `HANDOFF.md`：进度表 B5 标 ✅、下一步改 B6；§7 接手第一步同步。
