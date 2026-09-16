/**
 * IPO 窗口常量——**全链路唯一来源**（P2-3 收敛，2026-09-10 回检收尾）。
 *
 * 收敛前散落 4 处、且语义重复：
 *   - `IPO_VOICE_WINDOW_DAYS` 重复定义于 `pipeline/side-outputs/gd-ipo.ts` 与 `memory/event-memory.ts`
 *     （改一处不生效 → 真隐患）；
 *   - `IPO_SOURCE_WINDOW_DAYS` 定义在 `sources/crawlers/sources/szse-audit.ts`，却被
 *     `hk-filing.ts` 跨模块 import（sse/bse 亦从该文件取 windowFloor）；
 *   - `CSRC_WINDOW_DAYS` 私有于 `csrcfd.ts`，值同为 7。
 *
 * 本文件零 import（纯数据），可被 lib/ 任意层引用而不引入循环依赖。
 *
 * ⚠️ 口径（2026-09-16 校正）：本文件的常量**分两种语义**，用前务必看清——
 *   - **源层抓取窗**（`IPO_SOURCE_WINDOW_DAYS`，供 szse/bse/csrcfd/hk-filing 等爬虫）
 *     ＝ **日差 ≤ N**（今天-N ~ 今天，共 **N+1** 个日历日），实现见各源的 `dayGap`；
 *   - **渲染 / 口播窗**（`IPO_VOICE_WINDOW_DAYS` / `IPO_LIST_WINDOW_DAYS`，供
 *     `gdIpoCandidates` 与 exec 的 guangdong_ipo 池）＝ **含今天共 N 个日历日**
 *     （今天 ~ 今天-(N-1)），实现见 `utils/time.ts` 的 `recentMmddSet`。
 *     例：`IPO_LIST_WINDOW_DAYS=7` → 09-10 的报告列表含 09/04，**不含 09/03**。
 *
 * 已知差异（2026-09-16 用户确认：**承认现状，不改代码**）：源层按「日差 ≤ 7」抓回的
 * 边界条目（日差恰为 7，如 09-10 报告里的 09-03）会被抓到，但渲染列表只有 7 个日历日
 * → **该条目不出现在列表**。
 * 历史背景：用户 2026-09-10 曾以「上交所主板广东龙行天下（updateDate 09-03，相对 09-10
 * 日差恰为 7）必须在列表内」为实锤，彼时据此把**源层**定为「日差 ≤ N」；渲染列表沿用
 * 现役实现（N 个日历日）。若日后要让边界条目也显示，把 `render/full.ts` 调用
 * `topGdIpo(..., IPO_LIST_WINDOW_DAYS)` 改为 `IPO_LIST_WINDOW_DAYS + 1` 即可（1 行）。
 */

/** 口播 + 今日必读横滑窗口（天，**含今天共 N 个日历日**；2 = 今天+昨天）：只播最新动向。 */
export const IPO_VOICE_WINDOW_DAYS = 2;

/**
 * 底部「广东IPO动态」完整列表窗口（天，**含今天共 N 个日历日**；7 = 今天起 7 天）。
 * 与源层抓取窗（`IPO_SOURCE_WINDOW_DAYS`，日差 ≤ 7）**口径不同、边界差 1 天**，
 * 详见文件头口径说明；用户 2026-09-16 确认接受现状。
 */
export const IPO_LIST_WINDOW_DAYS = 7;

/** 源层抓取窗口（天，**日差 ≤ N**）：三所审核动态 / 证监会辅导 / 港交所递表的统一回溯下限。 */
export const IPO_SOURCE_WINDOW_DAYS = 7;

// ---------- 红筹线索（2026-09-15 · plan-redchip-crawl-push §2.4）----------
// 已拍板：**独立起名**（不与上面的 IPO 常量共用标识符），数值默认与 IPO 一致
// —— 保留差异化调参能力；但**必须与 IPO 常量同文件单点定义**
// （历史教训：IPO_VOICE_WINDOW_DAYS 曾在两处重复定义 → 改一处不生效）。

/** 红筹口播窗口（天，**日差 ≤ N**）——默认与 IPO 口播窗一致。 */
export const REDCHIP_VOICE_WINDOW_DAYS = 2;

/** 红筹卡片 / 会前报告展示窗口（天，日差 ≤ N）——默认与 IPO 列表窗一致。 */
export const REDCHIP_LIST_WINDOW_DAYS = 7;

/**
 * 红筹播报优先权重（加到 `BIZ_VALUE_RANK` 上的提权值）。
 *
 * 已拍板：红筹**不额外占名额**，但在同一候选池内**排序提权**（优先播报）。
 *   0 = 不提权（与普通 IPO 同序）
 *   2 = 稳健提权（默认）：红筹「在审」可越过非红筹「注册生效」
 *   ≥5 = 绝对优先（红筹排到所有非红筹之前）
 */
export const REDCHIP_VOICE_BOOST = 2;
