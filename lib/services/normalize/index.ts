/**
 * 归一化服务 C2：红线 #1 的「唯一裁决点」。
 *
 * 在这里强制：无真实 publishedAt 的条目一律丢弃，绝不用 fetchedAt 兜底。
 * 同时补齐 isIpo 内容态、tier、非空 excerpt。输出 NormalizedArticle[]（publishedAt 必填）。
 */
import type { ArticleInput, NormalizedArticle, RawArticle } from "../../contracts/article";
import type { PipelineContext } from "../../contracts/pipeline";

/**
 * 归一化单条。返回 null 表示被红线 #1 丢弃（无发布时间）。
 * 这是「无发布时间 → 丢弃」的唯一实现点；下游类型 NormalizedArticle 据此保证 publishedAt 必填。
 */
export function normalizeOne(raw: RawArticle): NormalizedArticle | null {
  if (!raw.publishedAt || Number.isNaN(raw.publishedAt.getTime())) {
    return null; // 红线 #1：无真实发布时间，丢弃
  }
  return {
    ...raw,
    publishedAt: raw.publishedAt,
    isIpo: raw.isIpo ?? (raw.category === "gd-ipo" || raw.category === "ipo"),
    tier: raw.tier ?? "T2",
    excerpt: raw.excerpt?.trim() || raw.title?.slice(0, 90) || "",
  };
}

/**
 * 批量归一化：丢弃无发布时间条目，补 tier（ctx.tierBySource 兜底，C1 采集层不再加工），
 * 并透传 source 展示名。C1 → C2 的职责收敛点：source 名映射 / tier 兜底 / excerpt 兜底 /
 * isIpo 推导全部在此一次性完成。
 */
export function normalize(
  articles: RawArticle[],
  ctx: PipelineContext,
): { articles: ArticleInput[]; dropped: number } {
  const nameById = new Map(ctx.sources.map((s) => [s.id, s.name]));
  const out: ArticleInput[] = [];
  let dropped = 0;
  for (const a of articles) {
    // tier 兜底：采集层缺省时用 ctx.tierBySource（sources.config.json 唯一真源）
    const raw: RawArticle =
      a.tier === undefined && ctx.tierBySource.has(a.sourceId)
        ? { ...a, tier: ctx.tierBySource.get(a.sourceId) }
        : a;
    const n = normalizeOne(raw);
    if (!n) {
      dropped++;
      continue;
    }
    out.push({ ...n, source: nameById.get(a.sourceId) ?? a.sourceId });
  }
  if (dropped > 0) {
    ctx.log.info("normalize", `红线 #1 丢弃无发布时间 ${dropped} 条`);
  }
  return { articles: out, dropped };
}
