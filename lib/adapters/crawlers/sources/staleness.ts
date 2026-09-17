/**
 * IPO 源「新鲜度哨兵」共享实现（2026-09-10 回检 P0-3）。
 *
 * 背景：IPO 各源都是「接口抓取成功 ≠ 数据新鲜」——北交所实测过 `pageSize` 漏传导致
 * 静默命中陈旧分桶、滞后 13 天无人察觉（2026-09-10 实锤）。此前只有 bse-audit 自带
 * 哨兵，其余 5 源（sse/szse/csrcfd/hk-filing/listed-check）静默变旧时**没有任何信号**，
 * CI 日志一律显示「完成，共 N 条」。
 *
 * 本模块把哨兵抽成公共实现，各源在 `run()` 末尾用「本次抓到的全部日期」调用
 * `warnIfStale(源名, dates)`：最新日期滞后今天超过阈值即打 `::warning::`，
 * 让 GitHub Actions 在日志与注解里都一眼可见（区分「源真没动态」与「源坏了」）。
 */

import { BaseCrawler } from "../base-crawler";
// 报告时区（北京时间）日期键：项目硬性规定「只认 Asia/Shanghai，不回落系统时区」。
import { todayKeyOf } from "../../../utils/time";

/**
 * 新鲜度阈值（天）：最新数据滞后今天超过该值即告警。
 *
 * ⚠️ 这是**新闻类（每日更新）**的默认值。IPO 类源请改用 `STALE_LAG_DAYS_IPO`——
 * 见下：同一阈值用在天然稀疏的源上，等于天天告警，反而淹没真故障。
 */
export const STALE_LAG_DAYS = 3;

/**
 * IPO 类源的新鲜度阈值（天）。
 *
 * 2026-09-17 用户拍板前的事实：三所审核动态 / 证监会辅导 / 港交所递表**都不是每日更新**
 * （实测：上交所审核动态最新 09-09 滞后 8 天、港交所递表最新 09-13 滞后 4 天，属源本身
 * 更新节奏，抓取链路完全正常）。用新闻类的 3 天阈值必然**天天告警** ——
 * 「天天响的告警等于没告警」，真故障（如接口 fetch failed、字段改版）反而被淹没。
 * 故放宽到 10 天：**仍能抓到「源坏了」（滞后 >10 天或 0 条日期），但不再对正常稀疏误报**。
 *
 * 注：「0 条有效日期」分支**不受本阈值影响**，一律告警 —— 那才是真正的故障信号。
 */
export const STALE_LAG_DAYS_IPO = 10;

/**
 * 报告时区（北京时间）日期串 YYYY-MM-DD，供哨兵比对。
 *
 * 原名 `localDay`，2026-09-17 **改名**：旧名暗示"运行环境本地时区"，而原实现确实用了
 * `getFullYear()/getMonth()/getDate()`（系统时区）—— CI runner 默认 **UTC**，于是同一份
 * 代码在本地（北京）与 CI 上得出**不同日期**（北京 00:00~08:00 差一天），违反项目硬性
 * 规定「时区只认北京时间、不回落系统时区」。现实现走 `todayKeyOf`（REPORT_TZ 单一真源），
 * 名字同步改为 `reportDay` 以消除歧义。
 *
 * 影响面：`checkStale` / `warnIfStale` → 三所审核 + 证监会辅导 + 港交所递表 + listed-check
 * 共 6 个 IPO 源的新鲜度告警阈值（STALE_LAG_DAYS=3），偏差 1 天足以造成误报/漏报。
 */
export function reportDay(d: Date = new Date()): string {
  return todayKeyOf(d);
}

/** 两个 YYYY-MM-DD 的自然日差（b - a，天）。 */
export function dayGap(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00`) - Date.parse(`${a}T00:00:00`)) / 86400000);
}

/**
 * 新鲜度检查：`dates` 为本次抓到的全部真实日期（YYYY-MM-DD，含被窗口过滤掉的）。
 * - 0 条日期 → 告警（接口改版/分桶异常/被反爬，都会表现成「抓成功但没数据」）；
 * - 最新日期滞后 > lagDays → 告警（数据老旧，大概率上游行为变化）。
 * 返回是否告警，便于单测断言。
 */
export function checkStale(
  name: string,
  dates: string[],
  opts: { lagDays?: number } = {},
): boolean {
  const lagDays = opts.lagDays ?? STALE_LAG_DAYS;
  if (dates.length === 0) {
    console.warn(`::warning:: [${name}] ⚠️ 新鲜度告警：本次 0 条有效日期，接口或分桶可能异常`);
    return true;
  }
  const newest = dates.reduce((a, b) => (b > a ? b : a));
  const lag = dayGap(newest, reportDay());
  if (lag > lagDays) {
    console.warn(
      `::warning:: [${name}] ⚠️ 新鲜度告警：最新日期 ${newest} 滞后 ${lag} 天（阈值 ${lagDays}），` +
        `数据可能已变旧，请核查接口行为`,
    );
    return true;
  }
  return false;
}

/** 便捷入口：给 BaseCrawler 子类在 run() 末尾调用（源名取 crawler.name）。 */
export function warnIfStale(crawler: BaseCrawler, dates: string[], lagDays?: number): boolean {
  return checkStale(crawler.name, dates, { lagDays });
}
