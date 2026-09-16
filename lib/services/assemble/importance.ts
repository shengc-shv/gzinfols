/**
 * A1b 重要度分级重标定（**装配期确定性规则，不动 LLM 提示词**，2026-09-16）。
 *
 * 问题（PRD 实测）：importance 由 LLM 逐条自评 → 2/3 级占 **91%**（09-16：3×3 + 2×27 + 1×3），
 * 「今日必知」既不稀缺也不可解释，分级实际失效。
 *
 * 为什么不改提示词：会连带影响摘要质量与 token 消耗，且 LLM 自评本身不稳定、不可复现。
 * 改法：**渲染前用确定性规则重新分布** —— 同一份报告任何时候重算结果完全一致，
 * 且每条的级别可由「分数排名」解释（Top N / 末段），不是随机。
 *
 * 口径：
 *   - 全板块条目统一按**分行相关性分数**降序排名（与漏斗同源 `scoreBranchRelevance`）；
 *   - Top `IMPORTANCE_TOP_N` 条 → 3 级（今日必知）；
 *   - 其余里**分数最低的 `IMPORTANCE_LOW_TAIL_RATIO`** → 1 级（折叠）；
 *   - 中间段 → 2 级（默认）。目标：2 级占比 ≤ 30%。
 *   - 先切 Top 再切末段，避免两段重叠（条目很少时尤其重要）。
 *
 * 幂等 & 无副作用：不 mutate 入参；无条目/单条时原样返回。
 */
import type { DailyReport, ReportItem, ReportSectionKey } from "../../contracts/report";
import { scoreBranchRelevance } from "../select/filters/relevance-score";

/** Top N 进 3 级（与音频侧「三件事」、A1a 首屏 Top3 同口径）。 */
export const IMPORTANCE_TOP_N = 3;

/**
 * 末段比例：Top 之后的剩余条目中，分数最低的这比例降为 1 级。
 * 取 0.7 是为满足验收「2 级占比 ≤ 30%」——中间段 ≈ 剩余的 30%。
 */
export const IMPORTANCE_LOW_TAIL_RATIO = 0.7;

/** 单条条目的分行相关性分数（与漏斗同源，保证「分级」与「筛选」同一把尺）。 */
export function relevanceScoreOf(it: ReportItem): number {
  return scoreBranchRelevance({
    title: it.title_cn || it.title_orig || "",
    summary: it.summary || "",
    ...(it.source ? { sourceId: it.source } : {}),
    ...(it.url ? { url: it.url } : {}),
  }).score;
}

/**
 * 重新标定整份报告的重要度分布。
 * @returns 新报告（未命中任何条目时原样返回）
 */
export function recalibrateImportance(report: DailyReport): DailyReport {
  const sections = report.sections ?? ({} as DailyReport["sections"]);
  type Slot = { key: ReportSectionKey; idx: number; score: number };
  const slots: Slot[] = [];
  for (const key of Object.keys(sections) as ReportSectionKey[]) {
    const list = sections[key] ?? [];
    for (let idx = 0; idx < list.length; idx++) {
      slots.push({ key, idx, score: relevanceScoreOf(list[idx]) });
    }
  }
  if (slots.length === 0) return report;

  // 分数降序；同分按原板块顺序 + 原 rank 稳定排序（保证结果可复现）
  slots.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ia = (sections[a.key] ?? [])[a.idx];
    const ib = (sections[b.key] ?? [])[b.idx];
    if ((ia?.rank ?? 0) !== (ib?.rank ?? 0)) return (ia?.rank ?? 0) - (ib?.rank ?? 0);
    return (ia?.title_cn ?? "").localeCompare(ib?.title_cn ?? "");
  });

  const slotKey = (s: Slot) => `${s.key}:${s.idx}`;
  const levelOf = new Map<string, 1 | 2 | 3>();
  const topN = Math.min(IMPORTANCE_TOP_N, slots.length);
  for (let i = 0; i < topN; i++) levelOf.set(slotKey(slots[i]), 3);
  const rest = slots.slice(topN);
  const tailCount = Math.ceil(rest.length * IMPORTANCE_LOW_TAIL_RATIO);
  const tailStart = rest.length - tailCount; // 末段（分数最低的一批）
  rest.forEach((s, i) => levelOf.set(slotKey(s), i >= tailStart ? 1 : 2));

  // 写回（只改 importance，其余字段原样）
  const next: Partial<Record<ReportSectionKey, ReportItem[]>> = {};
  for (const key of Object.keys(sections) as ReportSectionKey[]) {
    next[key] = (sections[key] ?? []).map((it, idx) => {
      const lv = levelOf.get(`${key}:${idx}`);
      return lv && it.importance !== lv ? { ...it, importance: lv } : it;
    });
  }
  return { ...report, sections: next as DailyReport["sections"] };
}
