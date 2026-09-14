/**
 * 子标签排序与部门标签判定（2026-09-14 Phase 2b 自 `render/cards.ts` 下沉）。
 *
 * 单一真源：组装层（assemble/group.ts）与渲染层共用，避免各存一份。
 */
import type { ArticleInput } from "../../contracts/article";
import { SOURCE_TIER_ORDER } from "../../contracts/source";
import { getReportTz } from "../../utils/time";

/**
 * 部门中文 tag 映射（与 render.ts SUB_TO_TAG 同源，避免跨模块循环依赖）。
 * 4 大零售部门 = 财富 / 私行 / 客群 / 信贷（2026-08-22 用户口径）。
 */
const DEPT_SUB_TO_TAG: Record<string, string> = {
  "gz-wealth": "财富",
  "cn-wealth": "财富",
  "gz-credit": "信贷",
  "cn-credit": "信贷",
  "gz-private": "私行",
  "cn-private": "私行",
  "gz-customer": "客群",
  "cn-customer": "客群",
};

/** 是否命中 4 大零售部门标签（subcategory 映射）。 */
export function hasDeptTag(a: ArticleInput): boolean {
  const subs =
    a.subcategories && a.subcategories.length > 0
      ? a.subcategories
      : a.subcategory
        ? [a.subcategory]
        : [];
  return subs.some((s) => DEPT_SUB_TO_TAG[s] !== undefined);
}

/**
 * 该日期是否只到「日」精度（无真实时分）：
 * 爬虫/直抓源只有 URL 日期时存在两种存储形态——国内源存 UTC 零点
 * （T00:00:00.000Z = 北京 08:00）、ftchinese 存北京时间零点
 * （T16:00:00.000Z = 北京次日 00:00）。任一命中即视为「只有日期」，
 * 卡片时间只展示 YYYY-MM-DD；有真实时分的 RSS 源两者均不命中 → 展示时分。
 */
export function isDateOnly(d: Date | undefined): boolean {
  if (!d) return false;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) {
    return true; // UTC 零点存储形态
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: getReportTz(),
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return fmt.format(d) === "00:00"; // 报告时区零点存储形态（如 ftchinese 北京 0 点）
  } catch {
    return false;
  }
}

/**
 * 子标签内统一排序（2026-08-22 用户：无 4 部门标签的条目排最后，优先展示带标签的）：
 * ① 4 部门标签命中优先（带标签 > 无标签）；
 * ② 时间精度：有真实时分 > 只有日期 > 无发布时间（「只有日期的放最后」）；
 * ③ 同精度内按 信息源权威等级（T1 > T1.5 > T2）升序；
 * ④ 同等级内按发布时间倒序（最新在前）。
 */
export function sortByTierAndTime<T extends ArticleInput>(list: T[]): T[] {
  const precision = (a: ArticleInput): number => {
    if (!a.publishedAt) return 2; // 无发布时间 → 最沉底
    return isDateOnly(a.publishedAt) ? 1 : 0; // 只有日期 → 次沉底
  };
  return [...list].sort((a, b) => {
    const da = hasDeptTag(a) ? 0 : 1;
    const db = hasDeptTag(b) ? 0 : 1;
    if (da !== db) return da - db; // 带标签优先
    const pa = precision(a);
    const pb = precision(b);
    if (pa !== pb) return pa - pb;
    const ra = a.tier ? (SOURCE_TIER_ORDER[a.tier] ?? 0) : 0;
    const rb = b.tier ? (SOURCE_TIER_ORDER[b.tier] ?? 0) : 0;
    if (ra !== rb) return rb - ra;
    const ta = (a.publishedAt ?? a.fetchedAt)?.getTime() ?? 0;
    const tb = (b.publishedAt ?? b.fetchedAt)?.getTime() ?? 0;
    return tb - ta;
  });
}
