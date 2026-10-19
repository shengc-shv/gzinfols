/**
 * 研报标题「时效窗口」判定（2026-10-19 sc 口径，两源共用）。
 *
 * sc 原话：「如果是写了时间的就要季度（级），有一些专题类的可以继续放着。」
 *
 * 规则（按顺序）：
 *  1. 标题写了**小时间窗**（周报/日评/月报/第 N 期/本周/上周…）→ 必须同时到达**季度级**
 *     （季度/半年/半年度/年度/全年/中期）才收，否则排（周报、月度跟踪这类对决策无增量）；
 *  2. 标题写了**季度级**时间窗 → 直接收；
 *  3. 标题**没写时间窗**、但属专题/深度/展望/点评/解读类 → 收（单点分析，不涉时效衰减）；
 *  4. 其余（既无时间窗也无专题属性）→ 不收（防标题党/碎片快讯）。
 *
 * 为什么不用裸词「日/月/周」：会误伤日期（「9月金融数据点评」的 9 月是月份，不是月度报告）。
 */
export const PERIOD_FINE_RE =
  /周报|周度|周评|周观察|周思考|周聚焦|周观点|周跟踪|每周|本周|上周|一周|日报|日评|每日|今日|当日|月报|月度|月评|本月|上月|第\d+期/;

/** 季度级及以上时间窗。 */
export const PERIOD_BIG_RE = /季度|半年|半年度|年度|全年|中期/;

/** 无时间窗时的专题属性词（单点深度分析）。 */
export const THEME_HIT = [
  "专题",
  "深度",
  "展望",
  "白皮书",
  "大类资产配置",
  "策略",
  "点评",
  "简评",
  "分析",
  "解读",
  "观察",
  "思考",
];

export function isResearchTitleWorthy(title: string): boolean {
  if (!title) return false;
  const hasFine = PERIOD_FINE_RE.test(title);
  const hasBig = PERIOD_BIG_RE.test(title);
  // 1) 写了小时间窗但没到季度级 → 排（「周报」「第 40 期」）
  if (hasFine && !hasBig) return false;
  // 2) 季度级时间窗 → 收
  if (hasBig) return true;
  // 3) 无时间窗 → 看是否专题属性
  return THEME_HIT.some((k) => title.includes(k));
}
