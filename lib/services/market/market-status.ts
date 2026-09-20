/**
 * 股市数据「隔夜新鲜度」判定（2026-09-20 用户需求重构）。
 *
 * 旧口径缺陷：按**星期几**判休市（`dow===0/6/1`），不看节假日、三市场一刀切
 * （单一 `isMarketClosed`）→ 长假必然误报，也无法表达「部分开市」。
 *
 * 新口径（用户 2026-09-20 拍板）：**用各市场数据自带的日期判断，不做节假日日历**：
 *  1. 取该市场最新一笔行情的**数据自带日期**（A股 K线 `day` / 港股 `f[17]` / 美股 `f[3]`，
 *     见 `quotes.ts`，三处均实测可用）；
 *  2. `gap = reportDate − dataDate`（自然日，`dayGap`）；
 *  3. `gap ≤ MARKET_FRESH_MAX_GAP(1)`（隔夜）→ 该市场 `fresh=true`，**口播才播**；
 *     否则（无数据 / gap ≥ 2）→ `fresh=false`，口播不播，页面只展示日期。
 *
 * 「部分开市」**不需特判**：各市场各算 gap —— A股休市时其数据日期停在假期前（gap 大）、
 * 美股照常（gap 小），结果自然就是「A股未开市 + 美股正常」。
 *
 * 纯函数；文案由本文件单一产出（页面与口播共用，避免口径漂移）。
 */

import type { DailyReport } from "../../contracts/report";
import { dayGap } from "../../utils/time";

const CN_WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** 统一的「X月X日 周X」中文日期格式（页面 / 口播共用，避免口径漂移）。 */
export function formatCnDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getMonth() + 1}月${dt.getDate()}日 ${CN_WEEK[dt.getDay()]}`;
}

/** 简化的「X月X日」中文日期（口播「下面是X月X日股市收盘信息」专用，不带星期）。 */
export function formatCnDateShort(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}

export type MarketKey = "aShare" | "hk" | "us";
/** 市场中文名（文案统一取此处）。 */
export const MARKET_LABELS: Record<MarketKey, string> = { aShare: "A股", hk: "港股", us: "美股" };
export const MARKET_KEYS: MarketKey[] = ["aShare", "hk", "us"];

export type MarketStatus = NonNullable<NonNullable<DailyReport["stock_recap"]>["marketStatus"]>;
export type MarketFreshness = MarketStatus["markets"][MarketKey];

/**
 * 隔夜新鲜度阈值（自然日）：数据自带日期距今 ≤ 此值才判「新鲜」、口播才播。
 * 用户 2026-09-20 拍板取 **1**（只看隔夜）—— 周一/周日 A股港股数据是上周五（gap 2~3）
 * 会被判「无隔夜行情」而不播，长假同理自动拦住。
 */
export const MARKET_FRESH_MAX_GAP = 1;

/**
 * 计算各市场隔夜新鲜度。
 *
 * @param reportDate 报告日（YYYY-MM-DD，北京）
 * @param dates      各市场数据自带日期（来自 `QuoteResult.dates`；缺失=该市场本次无数据）
 */
export function computeMarketStatus(
  reportDate: string,
  dates?: { aShare?: string; hk?: string; us?: string },
): MarketStatus {
  const markets = {} as MarketStatus["markets"];
  for (const k of MARKET_KEYS) {
    const d = dates?.[k];
    if (!d) {
      markets[k] = { fresh: false, reason: "本次未取到该市场数据" };
      continue;
    }
    // 基准日 = **报告日（北京）**，三市场统一（用户 2026-09-20 口径）。
    // 美股日期已是**美东交易日**口径（quotes.ts 里 f[3] 北京戳已 −1 天），直接与北京报告日比：
    //  - 周六早 09-19 跑：美东 09-18(周五) → gap=1 → **播**（周五收盘的隔夜行情）；
    //  - 周日早 09-20 跑：同一份美东 09-18 → gap=2 → **不播**（周六已播过）。
    // ⚠️ 不要给美股换「美东当天」基准 —— 那会让周日把周五行情重播一遍。
    // CI 每早 07:30 跑，已覆盖每个交易日的隔夜行情。
    const gap = dayGap(d, reportDate);
    const fresh = gap >= 0 && gap <= MARKET_FRESH_MAX_GAP;
    markets[k] = fresh
      ? { fresh: true, dataDate: d }
      : { fresh: false, dataDate: d, reason: `数据为 ${formatCnDateShort(d)}（距今 ${gap} 天）` };
  }

  const staleKeys = MARKET_KEYS.filter((k) => !markets[k].fresh);
  const freshKeys = MARKET_KEYS.filter((k) => markets[k].fresh);
  const allStale = freshKeys.length === 0;

  // 页面文案：仅在有市场非新鲜时给橙字警示（全新鲜则空串）
  const note = allStale
    ? "三地股市均无隔夜行情（休市或数据未更新），以下为最近一次收盘数据"
    : staleKeys.length > 0
      ? `${staleKeys.map((k) => MARKET_LABELS[k]).join("、")}今日无隔夜行情，其余市场为最新收盘`
      : "";

  // 口播文案：明确「是否有隔夜行情」，供 voice 决定播 / 不播
  const spokenNote = allStale
    ? "三地股市今日均无隔夜行情"
    : [
        ...(staleKeys.length ? [`${staleKeys.map((k) => MARKET_LABELS[k]).join("、")}今日无隔夜行情`] : []),
        ...freshKeys.map((k) => `${MARKET_LABELS[k]}为 ${formatCnDate(markets[k].dataDate as string)} 收盘`),
      ].join("；");

  return { reportDate, markets, allStale, note, spokenNote };
}
