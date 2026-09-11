# HANDOFF — gzinfols 2.0 全量移植交接（2026-09-11）

> 给下一个接手模型/开发者的完整交接。先读完本文件再动手。
> 权威状态：本文档 + `docs/parity-plan.md`（核对基线与进度）+ `AGENTS.md`（项目协作规范）。

## 1. 项目是什么

`gzinfols` 是 `gzinfo`（/Users/shengc/ccworkstaion/gzinfo，招行广州分行每日资信简报生成器）的 **2.0 独立重写版**：功能与 gzinfo 完全一致（业务规则/输入输出/边界/异常行为），但技术架构按「契约层(contracts) / 服务层(services) / 适配器层(adapters) / 编排层(pipeline+orchestrator)」的端口-适配器架构重构。

- 仓库：`/Users/shengc/ccworkstaion/gzinfo` = **移植基准（只读参考，功能一致性唯一对照源）**
- 仓库：`/Users/shengc/ccworkstaion/gzinfols` = **工作仓库**（独立 git，远端 `shengc-shv/gzinfols`，main 已推送至 B4 收尾 commit）
- Node 22 + tsx + TypeScript strict ESM，无框架；`sources.config.json` / `sources.keywords.json` 两份业务数据从 gzinfo 逐字拷贝（不得改内容）

## 2. 用户已拍板的裁决（不要重新讨论）

1. **全量移植分 6 批（B1-B6）执行，分批交付、逐批确认**——每批完成后先汇报核对结果，等用户说「继续」再进下一批。
2. **D1**：2.0 优于 gzinfo 的改进项**保留**（LLM 批量化+并发池、架构门禁、DeepSeek CI 后端），最终交付报告中逐项说明解决了什么问题。
3. **D2-D4**：feedback 点赞点踩、notify 微信推送、加密货币指标——**暂不处理、维持未移植待定**（用户此前已有移除/放弃意向，但未最终拍板）。
4. **不移植项（已裁决）**：`lib/ai/assets.ts`（L2 账本，summary 回流后冗余）、`lib/ai/select-top.ts`（主链无消费）。
5. 口播基准 = gzinfo（不是 gzcmbdf3）；腾讯 TTS 已移植完成。

## 3. 当前进度（B1-B5 已完成，B6 待做）

| 批次 | 内容 | 状态 |
|---|---|---|
| B1 | 7 道过滤链 + 相似度判重 + 分行相关性评分（gzinfo 官方测试 530 行移植全过） | ✅ `16bacf2` |
| B2 | PASS1/PASS2 两阶段 AI 管线 + 13 条校验回炉 + 降级路径 + LLM 重试 | ✅ `5615b6d` |
| B3 | executive-summary 旁路 + event-memory 全家（~2500 行）+ 历史库 gzinfo 同构重构 + gd-ipo 侧栏 + 口播 exec 驱动 | ✅ `b093ac8` |
| B4 | 股市三卡主链：quote-api + stock-recap(+anchor) + stock-news(+analysis) + stock-spoken + 两个 side-output 接线 + P5 广东IPO健康度（详见 docs/parity-B4-report.md） | ✅ `本轮` |
| B5 | 发布链路：publish-state 状态机（schedule/manual/manual-final/manual-test 四来源）+ 先发后记脚本 + cleanup-history 历史裁剪 + daily.yml 门控改造（读 publish-state / release_mode / PUBLISH_RUN / 归档回 main）（详见 docs/parity-B5-report.md） | ✅ `本轮` |
| B5 | deliverySettlementGate（`extractReportRunId` 已就位）与 regen-trading/ipo-local 等运维脚本 | ⬜ 顺延 B6（本次 B5 未含，见 parity-B5-report §6） |
| B6 | 渲染对齐 + 运维：gzinfo render.ts（~2116 行）完整卡面/横滑卡/播放器段落联动高亮/徽章体系；build-site；**交易面板（trading/* + trading-commentary + regen-trading，B4 顺延项）**；deliverySettlementGate | ⬜ 下一步 |

## 4. 每次动手前/后的固定动作

```bash
cd /Users/shengc/ccworkstaion/gzinfols
npx tsc --noEmit              # 必须 0 错误
npm run architecture:check    # 必须通过：services 层不得 import node:/adapters；
                              # contracts 零逻辑；只有 pipeline/orchestrator 可装配适配器
npm test                      # 当前 105/105，任何批次完成后不得减少
```

**移植方法论**（B1-B3 验证有效，沿用）：
1. gzinfo 对应模块**逐字拷贝**进 2.0 对应目录（行为等价优先，不重写业务逻辑）；
2. 用 python 脚本批量做 import 路径映射（gzinfo 相对路径 → 2.0 contracts/services 路径）；
3. `runLlm` 直连改为 **LlmRunner 注入**（参考 `lib/services/enrich/pass1.ts` 的 `setDefaultPass1Runner` 模式或 `generateExecutiveSummary` 的 runner 参数）；
4. fs 直连拆两半：纯函数留 services，IO 进 `lib/adapters/persistence.ts`；
5. gzinfo 的官方测试直接移植（改 import 即可），加新行为的针对性用例；
6. tsc 循环修到 0 错误 → 全测试绿 → 本地 commit → **经用户授权后 push**。

## 5. 红线（违反=返工）

- **时间真实性**：无真实 `publishedAt` 的条目一律丢弃，绝不用抓取时间兜底（`NormalizedArticle.publishedAt` 必填是类型级保证）。
- **无状态源**：板块归属一律内容判定（`lib/services/enrich/heuristics.ts` 的词表），`sourceId`/`category` 仅作采集元数据；tech/ipo 是仅有的两个例外栏目。
- **业务相关性**：条目须与客群/财富/私行/信贷相关，或属国家/省/市级商机政策（keyword-funnel + PASS1 keep 双轨承担）。
- **架构门禁**：见上；持久化 IO 只进 adapters（现有 `lib/adapters/persistence.ts` 已收纳 history/event-memory/exec-store 三类落盘）。
- **两份业务数据文件**（sources.config.json / sources.keywords.json）不得修改。
- **测试隔离**：e2e/redline 类会触发真实落盘的测试，必须 `setPersistenceBaseDir(tmp)` 注入临时目录（见 tests/pipeline.e2e.test.ts 的写法）。
- **安全**：GitHub PAT 等凭据严禁写入任何仓库文件/提交（用户会单独提供）；推送前 `git status` 确认无 `.workbuddy/`、`data/` 测试残留。

## 6. 环境事实

- node_modules 已装好；包管理 npm；运行时 node 22（managed：`/Users/shengc/.workbuddy/binaries/node/versions/22.22.2-3/bin/node`，tsx 走 npx 即可）。
- CI（.github/workflows/daily.yml）已配置：LLM_BACKEND=deepseek、TENCENTCLOUD TTS 参数、ffmpeg、gh-pages 历史恢复、当日已发布 gate。**用户还需在 GitHub 网页配置 Secrets：`DEEPSEEK_API_KEY`、`TENCENTCLOUD_SECRET_ID/KEY`**（截至交接时未配置）。
- 推送方式：用户口头授权后用其提供的 PAT inline push（历史会话有先例）；无授权不推。

## 7. 接手第一步（建议）

1. 跑一遍三件套验证，确认 105/105 基线成立；
2. 读 `docs/parity-plan.md` 的 B4 行 + gzinfo 的 `lib/trading/`、`lib/pipeline/side-outputs/stock-*.ts`、`lib/audio/stock-spoken.ts`，评估后向用户确认 B4 方案再动手；
3. B5 已完成：发布链路（publish-state 状态机 / 历史归档回 main / cleanup-history / daily.yml 门控与记账）。
   B6 起：渲染对齐 + 交易面板（含加密剔除口径确认）+ deliverySettlementGate。
