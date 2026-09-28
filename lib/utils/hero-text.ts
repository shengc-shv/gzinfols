/**
 * 今日定调文本的「补位前缀」处理（2026-09-27）。
 *
 * 背景：定调被判重后由池内补位（exec-guard）或走打分兜底（executive-summary）时，
 * 文本曾自带「今日分行焦点：」前缀；而各消费端又各自加标签 ——
 * 页面加「今日定调：」、企微推送加「【今日定调】」、口播加「先看今天的整体定调。」
 * → 出现「今日定调：今日分行焦点：河南省首笔取水权质押贷款落地信阳」这种双重标签
 * （2026-09-27 实证）。
 *
 * 现行约定：
 *  1. **生产者不再加前缀** —— exec-guard / executive-summary 写出的 hero_line 只含正文；
 *  2. 标签由各消费端自行添加（页面「今日定调：」/ 企微「【今日定调】」/ 口播「先看今天的整体定调。」）；
 *  3. 本函数供消费端**兼容历史数据**（旧 store.json、旧报告 JSON、旧 HTML 重渲染时仍带前缀）。
 */
export const HERO_FALLBACK_PREFIX = "今日分行焦点：";

/** 剥掉历史遗留的补位前缀（无前缀时原样返回；空值返回空串）。 */
export function stripHeroPrefix(heroLine: string | undefined): string {
  const s = (heroLine ?? "").trim();
  return s.startsWith(HERO_FALLBACK_PREFIX)
    ? s.slice(HERO_FALLBACK_PREFIX.length).trim()
    : s;
}
