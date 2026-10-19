/**
 * 主题跟踪 · 主题质量分（2026-10-19，零 LLM）。
 *
 * 为什么需要它：旧版按「节点数降序」排序，导致 7 个主题并列 12 节点（撞 maxNodes 上限）
 * 时退化为按标签字典序 —— 最噪的「市场」「客群」稳居前列（实测 2026-10-19）。
 * 行长的问题不是「哪个主题节点多」，而是「**我盯的事后来怎么样了**」→ 排序必须服务「进展」。
 *
 * 四因子（全部可从现有字段算出，无一处需要自然语言生成 —— 这是零 LLM 的前提）：
 *  - 连续性 40%：跨期数 / 跨度天数。跟了 10 期的事比跟了 2 期的有价值；
 *  - 新近度 25%：最新节点距今天数。3 天内有进展 = 热（**替代天数窗口**：老主题沉底但不消失）；
 *  - 重要性 25%：节点最高 importance（复用渲染层口径，单一真源）；
 *  - 密度   10%：去重后节点数 / 原始节点数。越高说明水分越少。
 *
 * 时间纪律：`now` 一律由调用方注入（ISO 日期串），本模块不读时钟 —— 过架构门禁且可单测。
 */
import type { Topic } from "./cluster";

export interface QualityBreakdown {
  /** 连续性 0~1（跨期密度：dates/spanDays，封顶 1） */
  continuity: number;
  /** 新近度 0~1（线性衰减：当天 1.0，90 天 0） */
  recency: number;
  /** 重要性 0~1（节点最高 importance 归一：3 → 1.0） */
  importance: number;
  /** 密度 0~1（去重后节点 / 原始节点） */
  density: number;
}

export const QUALITY_WEIGHTS = { continuity: 0.4, recency: 0.25, importance: 0.25, density: 0.1 } as const;

/** 新近度衰减天数：超过该天数 → 0 分（同时是「沉底区」阈值，与设计文档 §四 对齐）。 */
export const RECENCY_HORIZON_DAYS = 90;

/** 连续性饱和期数：跨 12 期以上算「跟得住」（绝对期数为主，防小主题刷分）。 */
export const CONTINUITY_SATURATION = 12;

/** 重要性因子里的「规模饱和节点数」：12 个节点以上算大体量。 */
export const IMPORTANCE_SIZE_SATURATION = 12;

/** 两个 YYYY-MM-DD 的自然日差（纯字符串运算，不涉时区）。 */
export function dayGap(a: string, b: string): number {
  const pa = Date.parse(`${a}T00:00:00Z`);
  const pb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return 0;
  return Math.max(0, Math.round((pb - pa) / 86_400_000));
}

/** 计算某主题的四因子（输入：主题 + 全语料的原始节点数 + 今天）。 */
export function qualityOf(
  topic: Pick<Topic, "dates" | "spanDays" | "nodes">,
  rawNodeCount: number,
  today: string,
): QualityBreakdown {
  const dates = topic.dates ?? [];
  const spanDays = topic.spanDays || dates.length || 1;
  // 连续性：**绝对期数为主**（6 期以上饱和），密度为辅 —— 防止 3 期小主题
  // 靠「dates/(span*0.5)」刷满连续性（实测：信用卡 3 节点/4 天曾拿 1.00 排到 99 分第一）
  const byCount = Math.min(1, dates.length / CONTINUITY_SATURATION);
  const byRate = Math.min(1, dates.length / Math.max(1, spanDays * 0.5));
  const continuity = 0.7 * byCount + 0.3 * byRate;
  // 新近度：最新一期距今天数 → 线性衰减到 RECENCY_HORIZON_DAYS
  const lastDate = dates.length ? dates[dates.length - 1] : today;
  const age = dayGap(lastDate, today);
  const recency = Math.max(0, 1 - age / RECENCY_HORIZON_DAYS);
  // 重要性：**重要度 + 规模**（0.6/0.4）—— 规模本身就是重要性的一部分：
  // 「25 条进展」比「2 条进展」更值得行长看（实测：纯按 maxM 时 12 节点的竞对
  // 会压过 25 节点的 IPO，与读者直觉相反）。
  const maxM = topic.nodes.reduce((mx, n) => Math.max(mx, (n as { m?: number }).m ?? 1), 1);
  const byTier = Math.min(1, maxM / 3);
  const bySize = Math.min(1, topic.nodes.length / IMPORTANCE_SIZE_SATURATION);
  const importance = 0.6 * byTier + 0.4 * bySize;
  // 密度：去重后 / 原始（防「一个主题塞 200 条重复」刷分）
  const deduped = topic.nodes.length;
  const density = rawNodeCount > 0 ? Math.min(1, deduped / rawNodeCount) : 1;
  return { continuity, recency, importance, density };
}

/** 加权总分 0~100。 */
export function qualityScore(q: QualityBreakdown): number {
  return Math.round(
    100 *
      (q.continuity * QUALITY_WEIGHTS.continuity +
        q.recency * QUALITY_WEIGHTS.recency +
        q.importance * QUALITY_WEIGHTS.importance +
        q.density * QUALITY_WEIGHTS.density),
  );
}

/** 是否沉底（近 RECENCY_HORIZON_DAYS 无新节点 → 页面默认折叠）。 */
export function isDormant(topic: Pick<Topic, "dates">, today: string): boolean {
  const dates = topic.dates ?? [];
  if (!dates.length) return true;
  return dayGap(dates[dates.length - 1], today) >= RECENCY_HORIZON_DAYS;
}

/** 「本周是否有新进展」（默认视图判据：近 7 天有新节点）。 */
export function isActiveThisWeek(topic: Pick<Topic, "dates">, today: string): boolean {
  const dates = topic.dates ?? [];
  if (!dates.length) return false;
  return dayGap(dates[dates.length - 1], today) <= 7;
}
