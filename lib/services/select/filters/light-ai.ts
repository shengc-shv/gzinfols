/**
 * 漏斗三工具 + 每源限额（自 gzinfo lib/ai/light-ai.ts 逐字移植）。
 *
 *   - takeTopByValue：漏斗三主路径——全局按分行相关性评分取前 + 每源多样性封顶 + 写回 valueTag。
 *     ⚠️ gzinfo 红线：takeTopByValue **不接入管线**（曾把下游整合池饿死，commit③ 已回退），
 *     保留仅供单测/未来「全窗口整合池」阶段使用。B1 阶段同样不接入。
 *   - capLightAiSources：每源限额（per-source-cap-20 stage 使用，源内按相关性评分降序）。
 */
import type { ArticleInput } from "../../../contracts/article";
import type { ValueTag } from "../../../contracts/report";
import { scoreBranchRelevance, type BranchRelevance, type ScorableArticle } from "./relevance-score";

/** 漏斗三默认参数（gzinfo 常量；当前不接入管线，见文件头红线）。 */
export const VALUE_TOP_N = 60;
export const VALUE_MAX_PER_SOURCE = 8;

/** ArticleInput → ScorableArticle（scoreBranchRelevance 入参）。 */
function toScorable(a: ArticleInput): ScorableArticle {
  return {
    title: a.title,
    category: a.category,
    subcategory: a.subcategory,
    sourceId: a.sourceId,
    summary: a.summary,
    url: a.url,
  };
}

/** BranchRelevance → ValueTag（漏斗三写回，供 exec 口播消费）。 */
function toValueTag(r: BranchRelevance): ValueTag {
  return {
    tier: r.tier,
    score: r.score,
    businessLines: r.businessLines,
    vertical: r.vertical,
    risk: r.risk,
  };
}

/**
 * 漏斗三（业务价值取前，零 AI）：⚠️ 不接入 B1 管线（gzinfo 红线：只吃今日新增会饿死
 * 下游整合池）。保留待 B3「滚动并入后的全窗口整合」阶段评估是否启用。
 */
export function takeTopByValue<T extends ArticleInput>(
  articles: T[],
  opts: { topN?: number; maxPerSource?: number } = {},
): T[] {
  const topN = opts.topN ?? VALUE_TOP_N;
  const maxPerSource = opts.maxPerSource ?? VALUE_MAX_PER_SOURCE;

  const scored = articles.map((a) => ({
    a,
    score: scoreBranchRelevance(toScorable(a)).score,
    time: a.publishedAt?.getTime() ?? 0,
  }));
  // 全局按价值降序；同分取更新者
  scored.sort((x, y) => (y.score !== x.score ? y.score - x.score : y.time - x.time));
  const top = scored.slice(0, topN).map((s) => s.a);

  // 每源多样性封顶
  const perSource = new Map<string, number>();
  const kept: T[] = [];
  for (const a of top) {
    const sid = a.sourceId ?? "";
    const used = perSource.get(sid) ?? 0;
    if (used >= maxPerSource) continue;
    perSource.set(sid, used + 1);
    kept.push({ ...a, valueTag: toValueTag(scoreBranchRelevance(toScorable(a))) });
  }
  return kept;
}

// --- 每源限额（per-source-cap-20 stage 使用） -------------------------------
// 2026-09-01 gzinfo 用户指令：PASS1 过滤精准，每源限额 ≤20 条进 LLM。
export const LIGHT_AI_SOURCES = new Set<string>([
  "cnfin",
  "stcn",
  "dayoo-gz",
  "southcn",
  "cnr-gd",
]);
export const LIGHT_AI_MAX_PER_SOURCE = 20;
export const LIGHT_AI_RAW_CAP = 200;

export interface LightAiArticle {
  sourceId?: string;
  publishedAt?: Date;
}

/**
 * 对 lightAi 源按 sourceId 分组、每源保留 maxPer 条；其余源原样保留。
 * 排序键：传入 scorer 时按「分行相关性评分」降序取（gzinfo 2026-08-29 价值预筛），
 * 无 scorer 时退化为「最新优先」；同分按发布时间倒序。
 */
export function capLightAiSources<T extends LightAiArticle>(
  articles: T[],
  lightSet: Set<string>,
  maxPer: number,
  scorer?: (a: T) => number,
): T[] {
  const lightGroups = new Map<string, T[]>();
  const others: T[] = [];
  for (const a of articles) {
    const sid = a.sourceId ?? "";
    if (lightSet.has(sid)) {
      if (!lightGroups.has(sid)) lightGroups.set(sid, []);
      lightGroups.get(sid)!.push(a);
    } else {
      others.push(a);
    }
  }
  const capped: T[] = [];
  for (const items of lightGroups.values()) {
    items.sort((x, y) => {
      const sx = scorer ? scorer(x) : (x.publishedAt?.getTime() ?? 0);
      const sy = scorer ? scorer(y) : (y.publishedAt?.getTime() ?? 0);
      if (sy !== sx) return sy - sx;
      return (y.publishedAt?.getTime() ?? 0) - (x.publishedAt?.getTime() ?? 0);
    });
    capped.push(...items.slice(0, maxPer));
  }
  return [...others, ...capped];
}
