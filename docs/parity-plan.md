# gzinfo → gzinfols 全量功能移植与重构方案（核对基线 v1）

> 日期：2026-09-11 ｜ 基线：gzinfo @ /Users/shengc/ccworkstaion/gzinfo（main 最新）
> 进度：**B1 ✅、B2 ✅、B3 ✅、B4 ✅、B5 ✅（2026-09-11，见 docs/parity-B4-report.md / docs/parity-B5-report.md）**；B6 待执行。
> B2 说明：AI 相关性回检（2.0 自创）已按 gzinfo 对齐移除——PASS1 keep 判定即相关性闸门。
> B3 说明：executive-summary 旁路 + event-memory 全家 + history 重构 + gd-ipo 侧栏已落地；select-top/assets 经裁决不移植。
> B4 说明（用户拍板）：**按实测切分**——trading 交易面板/commentary/regen-trading 不在 gzinfo 主链（daily.ts 不产出 report.trading），
> 顺延 B6 运维批次；加密模块（coingecko/fear-greed，92 行）按 D4 裁决不移植（契约不引入 crypto_fear_greed、B6 渲染不做加密）。
> 主链股市链路（quote-api/stock-recap/anchor/news-analysis/stock-spoken + 两个 side-output + P5 健康度）已全部落地。
> B6-进度（2026-09-12）：交易面板（trading/* + commentary + regen-trading）已移植并剔除加密；
> 运维脚本 build-site / tts-fallback / tts-probe / seed-registry / regen-trading 已落地；
> cleanup-history.yml / weekly-registry.yml 定时工作流已建；**渲染全量对齐（R1）尚未开始**。
> B5 说明（发布链路移植）：publish-state 状态机（schedule/manual/manual-final/manual-test 四来源 + cron 跳过判据）
> 落地 `lib/services/publish/publish-state.ts`；IO 归 `lib/adapters/persistence.ts`；`scripts/record-publish.ts` 先发后记；
> `scripts/cleanup-history.mjs` + `scripts/history-retention.mjs` 历史裁剪（近 7 天 + backup）；daily.yml 门控改读
> publish-state、补 release_mode/PUBLISH_RUN、补「归档历史库回 main」与「记账」两步；详见 docs/parity-B5-report.md。
> 原则：**功能一致性优先**（业务规则/输入输出/边界/异常行为逐项对齐），架构重构只改「代码放哪、怎么组织」，不改「做什么」。
> 改进方案一律先报备确认（本文件 §4），确认后写入对应批次实施。

---

## 1. gzinfo 真实执行流（以 scripts/daily.ts 为权威）

```
①ingest(采集+归一化) → ②runFilterPipeline(7道过滤,今日新增) → ③runAiPipeline(AI管线)
→ ④mergeRollingAndSaveHistory(历史写盘+近7天滚动并入) → ⑤buildSideOutputs(必读商机/股市复盘/股市清单/gd-ipo/风险)
→ ⑥AI资产账本 → ⑦applyDisplayCaps(展示限额,全窗口价值取前) → ⑦.5 广东IPO健康度 → ⑧synthesizeAudioIfAny
→ ⑨renderAndWrite(唯一存储+sidecar+全量池导出) → 错误聚合汇总
```
三漏斗结构：漏斗一(相关性)=②的 single-institution/stock-single/keyword-funnel；漏斗二(时效去重)=pre-window/title-similarity/cross-day-dedup/per-source-cap；漏斗三(业务价值)=④滚动并入 + ⑤buildTwoDayExecPool + ⑦applyDisplayCaps。

## 2. 功能差分总表（gzinfo → 2.0 现状 → 批次）

图例：✅已移植对齐 ｜ ⚠️有但行为不等价 ｜ ❌缺失 ｜ 🚫用户已裁决不做

### 2.1 采集与过滤（漏斗一/二）
| # | gzinfo 模块 | 功能 | 规模 | 2.0 现状 | 批次 |
|---|---|---|---|---|---|
| F1 | sources/rss+api+通用抓取 | RSS/API/Scrape 拉取 | ~2k | ⚠️ providers 简版（缺 per-source 定制与 useCurl 细节）； sources.config 中 role:crawled-input 的 32 源不走 providers | B2 |
| F2 | pipeline/filter 7 道 | pre-window-2d | ~40 | ⚠️ select 内有窗口但口径需对齐（FETCH_WINDOW_DAYS=2, IPO 7 天例外） | B1 |
| F3 | filters/single-institution | 单家非白名单金融机构新闻过滤 | ~150 | ❌ | B1 |
| F4 | filters/stock-single | 股市单股新闻过滤（非巨头/非广州） | ~120 | ❌ | B1 |
| F5 | filters/keyword-filter | 关键词漏斗 v4 | ~500 | ✅ 逐字移植（funnel.ts） | — |
| F6 | ingest/dedup-similar | 标题相似度判重 + 跨天判重（与历史库合并） | ~300 | ⚠️ 2.0 用 URL 去重+URL 历史去重，**行为不等价**（gzinfo 是标题相似度） | B1 |
| F7 | filters/config | 漏斗开关/配置加载 | ~100 | ❌（2.0 恒开） | B1 |
| F8 | light-ai cap | 每源 ≤20 封顶 + 分行相关性排序 | ~200 | ⚠️ 2.0 是每源 4 + tier 权重，**口径不同** | B1 |

### 2.2 AI 管线（漏斗三前置）
| # | gzinfo 模块 | 功能 | 规模 | 2.0 现状 | 批次 |
|---|---|---|---|---|---|
| A1 | ai/pass1 + item-classifier | LLM 逐条标记（相关/分类/子标签） | ~1.5k | ⚠️ 2.0 是批富集+自创回检，**结构不等价** | B2 |
| A2 | ai/pass2 + prompts | LLM 摘要（title_cn/summary/tags/importance） | ~2k | ⚠️ 同上 | B2 |
| A3 | ai/exec-pool | LLM 并发池 + 重试退避 + 限额 | ~400 | ⚠️ 2.0 自写池（行为对齐需核对） | B2 |
| A4 | ai/select-top + relevance-score | 分行相关性确定性评分 + 取前 | ~400 | ⚠️ 2.0 scoreValue 口径不同 | B2 |
| A5 | ai/validator + metrics + log + json-util | 输出校验/指标/日志/JSON 修复 | ~800 | ❌（validator/metrics 缺） | B2 |
| A6 | ai/light-ai + mode + assets | 轻量路径/AI 模式/资产账本 | ~600 | ❌（assets 账本缺） | B2 |
| A7 | ai/executive-summary | 必读/商机/风险/口播分稿（LLM 同次产出+持久化复用） | ~300 | ⚠️ 2.0 报告级调用无 spoken_* 持久化 | B3 |
| A8 | ai/llm + backends | runLlm 调度（3 后端×重试退避） | ~300 | ✅ 等价（llm.ts 4 后端） | — |

### 2.3 旁路（side-outputs）
| # | gzinfo 模块 | 功能 | 规模 | 2.0 现状 | 批次 |
|---|---|---|---|---|---|
| S1 | pipeline/side-outputs/executive-summary | 必读/商机/风险产出（exec-pool 2 天窗口） | ~600 | ❌（2.0 无独立旁路） | B3 |
| S2 | pipeline/side-outputs/gd-ipo | 广东IPO side-output（粤标/横滑卡/口播拼装） | ~700 | ❌（2.0 仅 assignSection 判 ipo） | B3 |
| S3 | ai/stock-recap + stock-recap-anchor | 股市三卡（美股/A股/港股 spoken+板块要点+crossCheck） | ~600 | ❌（C10） | B4 |
| S4 | ai/stock-news-analysis + trading/* | 股市新闻挑选 + Yahoo 行情/指标/信号/watchlist | ~1.4k | ❌（C10） | B4 |
| S5 | pipeline/side-outputs/stock-news | 股市清单（三市场新闻条目） | ~150 | ❌ | B4 |
| S6 | audio/stock-spoken | 股市口播确定性拼装（整体行情—结构分化—重点板块） | 423 | ❌（voice 已留挂钩） | B4 |
| S7 | ai/trading-commentary | watchlist 信号解读（LLM） | 307 | ✅ `services/market/commentary.ts`（剥离加密输入） | B6 |

### 2.4 历史 / 记忆 / 渲染 / 发布
| # | gzinfo 模块 | 功能 | 规模 | 2.0 现状 | 批次 |
|---|---|---|---|---|---|
| H1 | output/history + pipeline/history-step | 历史库滚动合并（近7天并入 report + FETCH_WINDOW_DAYS 常量） | ~600 | ⚠️ 2.0 简版（无滚动并入 report） | B3 |
| H2 | memory/event-memory | 事件指纹去重（洞察/必读/风险/IPO口播 2 天去重）+ 交付信号 | ~2k | ❌ | B5 |
| H3 | memory/store + exec-guard + broadcast-time + publish-run-id | 记忆库读写闸门 | ~3k | ❌（部分随 H2） | B5 |
| R1 | output/render.ts + render/* | 完整版面（5 tab/股市三卡/横滑卡/播放器v2联动/主题） | ~4k | ⚠️ 2.0 简版版面 | B6 |
| R2 | output/report-from-articles + paths | 由全量池重渲染/路径 | ~500 | ⚠️ 简版 | B6 |
| R3 | pipeline/render-and-write | 唯一存储（daily_reports/<date>/ 全产物）+ sidecar + 全量池导出 | ~400 | ⚠️ publish 简版 | B6 |
| P1 | publish-state.ts + scripts/record-publish-state | 发布来源记账（schedule/manual-final/test） | ~200 | ✅ `services/publish/publish-state.ts` + `scripts/record-publish.ts` + persistence 适配器 | B5 ✅ |
| P2 | scripts/build-site.mjs | index.html + archive.html 站点聚合 | ~300 | ✅ `scripts/build-site.mjs`（按 2.0 唯一存储适配） | B6 |
| P3 | scripts/cleanup-history.mjs + workflow | 历史裁剪（近 N 天 + backup） | ~200 | ✅ `scripts/cleanup-history.mjs` + `scripts/history-retention.mjs`（随 B5 提前落地） | B5 ✅ |
| P4 | pipeline/bootstrap + context | 凭证校验/模式构建/tier 索引/aiAssets 装配 | ~500 | ⚠️ orchestrator 简版（缺凭证校验+aiAssets） | B2 |
| P5 | 广东IPO健康度检查（daily.ts ⑦.5） | 0 条/滞后告警 | ~40 | ❌ | B3 |

### 2.5 语音 / 运维 / 工作流
| # | gzinfo 模块 | 功能 | 2.0 现状 | 批次 |
|---|---|---|---|---|
| V1 | audio/tts + pronounce | 腾讯 TTS + SSML 发音 | ✅ 本轮移植 | — |
| V2 | audio/audio.ts 口播组装 | 章节预算/消毒/句界截断/段落时序 | ✅ 口径移植（内容源待 A7/S6 接入） | B3/B4 |
| V3 | scripts/tts-fallback + tts-probe | Piper 兜底链 + 探针 | ❌ | B6 |
| O1 | scripts/quota-report + ai/metrics | LLM 用量报表 | ❌（ctx.stats 简版） | B6 |
| O2 | regen-trading / regen-enrich / render / analyze-* / retag-* | 运维再生成脚本 | ❌（render 有） | B6 |
| O3 | notify/* + notify.yml | 微信推送 | 🚫 用户已裁决放弃 | — |
| O4 | feedback/* + render 反馈 UI | 点赞点踩 | 🚫 用户已裁决移除 | — |
| O5 | trading/coingecko + fear-greed | 加密恐惧贪婪指数 | 🚫 **永久剔除（2026-09-12 用户拍板）**：加密板块不合规，任何形式均不得出现——不移植、不渲染、不进契约；交易面板（trading/*）若日后移植，必须剥离加密段 | 已裁决 |
| O6 | cleanup-history.yml / weekly-registry.yml | 定时维护工作流 | ✅ 已建（B6） | B6 |
| O7 | deploy.mjs / run-daily.mjs / open-report.mjs | 本地调度/部署 | ❌（低优先） | B6 |

### 2.6 测试
| T1 | tests/（97 文件） | 行为回归基线 | ❌ 2.0 仅 53 测试 | 各批次随移植同步移植对应测试（e2e golden 对齐） |

## 3. 架构映射（gzinfo 位置 → 2.0 位置）

| gzinfo | 2.0 去处 | 理由 |
|---|---|---|
| lib/types.ts | lib/contracts/* | 契约层零逻辑（已建） |
| lib/utils.ts | lib/utils/time.ts（已建）+ 按需扩展 | 纯函数 |
| lib/filters/* | lib/services/select/filters/* | 漏斗一/二属筛选服务内部子模块 |
| lib/ai/pass1/pass2/exec-pool/select-top/relevance-score | lib/services/enrich/*（pass1.ts/pass2.ts/exec-pool.ts/…） | AI 富集归 C4 单服务 |
| lib/ai/executive-summary | lib/services/summary/*（新 C4.5 旁路服务） | 必读/商机/风险是独立产出阶段（对齐 daily.ts ⑤） |
| lib/pipeline/side-outputs/* | lib/services/side-outputs/*（新旁路服务群） | 同上，含 gd-ipo/stock-recap/stock-news |
| lib/trading/* | lib/services/market/*（C10） | 股市域服务 |
| lib/audio/audio.ts + stock-spoken.ts | lib/services/voice/*（组装）+ lib/adapters/tts.ts（合成） | 组装纯函数、合成副作用——2.0 分层更严格 |
| lib/memory/* | lib/services/memory/* | 记忆域（单一写者原则保留） |
| lib/output/render* | lib/services/render/* | 渲染纯函数 |
| lib/pipeline/render-and-write + output/paths | lib/services/publish/* | 落盘发布归 C9 |
| lib/publish-state | lib/services/publish/publish-state.ts | 发布域 |
| scripts/daily.ts 的 9 阶段 | lib/pipeline/index.ts runPipeline 扩为 9 阶段 | 编排对齐 gzinfo（含阶段错误聚合语义——2.0 已有） |

**2.0 保留的架构改进（不回退，均为纯结构优化不改行为）**：契约层/端口适配器门禁、组合根注入、e2e 内存适配器测试、架构门禁脚本。

## 4. 需你裁决的事项（确认后执行，不确认不动）

| # | 事项 | 说明 | 建议 |
|---|---|---|---|
| D1 | 「AI 相关性回检」去留 | 2.0 自创（gzinfo 无此独立 pass，相关性由 pass1 标记+relevance-score 承担）。功能一致性要求下应**回退**，改由 B2 的 pass1 结构覆盖 | 回退对齐 gzinfo |
| D2 | feedback 点赞点踩 | gzinfo 有；你此前拍板「B2 取消移除」 | 跳过不移植 |
| D3 | notify 微信推送 | gzinfo 有 notify.yml + lib/notify | 跳过（你已裁决放弃） |
| D4 | coingecko/fear-greed 加密指标 | gzinfo trading 段在用；用户红线：加密板块不合规 | ✅ **已裁决：永久剔除**。不移植、契约不引入 `crypto_fear_greed`、渲染不做加密段；内容侧由 `BANNED_WORDS` + PASS1 合规红线双重拦截 |
| D5 | 执行方式 | 全部 6 批连续做完再一次核对 vs 每批完成即报告待确认 | 分批交付（B1/B3/B4 体量大，逐批可核对） |

## 5. 批次划分与验收口径

| 批次 | 内容 | 行为等价验收点（抽样） |
|---|---|---|
| B1 过滤链 | F1-F8：7 道过滤 + 漏斗配置 + 相似度判重 | 同一输入文章集 → gzinfo 与 2.0 漏斗输出逐条 diff（通过/淘汰/排序一致） |
| B2 AI 管线 | A1-A6 + P4：pass1/pass2 结构、exec-pool、validator、aiAssets | 同一 prompt/输入 → 输出 JSON 结构一致；重试/失败降级行为一致 |
| B3 旁路+口播 | S1/S2/A7/H1/P5 + V2 收口 | 同一 report → 口播稿逐字 diff；必读/商机/风险结构与 gzinfo store.json 结构一致 |
| B4 股市 | S3-S7（D4 裁决后） | 三卡字段/时区口径/板块压缩(maxSectors=2)一致 |
| B5 记忆与发布 | H2/H3（B3 已覆盖）、P1、P3、daily.yml 发布链路 | publish-state 判据一致（schedule/manual-final 跳过，manual-test 不阻断）；gate 读 publish-state 而非 gh-pages；PUBLISH_RUN 注入；先发后记 |
| B6 渲染与运维 | R1-R3/P2/P3/V3/O1/O2/O6/O7 | HTML 版式对齐 gzinfo（golden diff）；index/archive 结构一致 |

每批交付：代码 + 移植测试（gzinfo 对应 tests 同步）+ 行为核对报告（逐项 ✅/差异说明）。
