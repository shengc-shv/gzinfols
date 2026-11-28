/**
 * 条目元数据补齐（第一期规格工作包 2）——纯函数、幂等、不 mutate 入参。
 *
 * 补两类字段：
 *  1) published_at：完整 ISO 发布时间。只取 ArticleInput.publishedAt（真实发布时间），
 *     🔴 绝不 `?? fetchedAt` 兜底抓取时间（时间真实性红线）。取不到就留空。
 *     Pass1Input/Pass1Item 只传 MM/DD，ISO 在 toPass1Input 处不可逆丢失，
 *     故用 url→ArticleInput 映射在装配下游回填（仿 assignItemIds）。
 *  2) primary_domain / related_domains：六大经营领域归属，由内容词表判定，
 *     与五大内容分类正交，不写进 tags（degrade 会按 ALLOWED_TAGS 清除）。
 *
 * 挂载点：pipeline/index.ts annotateMaturity 之后、voice 之前——此处 articles 在作用域内，
 * 补丁能同时被口播、HTML、JSON 消费。
 */
import type { ArticleInput } from "../../contracts/article";
import type { DailyReport, ReportItem, ReportSectionKey } from "../../contracts/report";
import { classifyBusinessDomain } from "../vocab/business-domains";

/** url → ArticleInput（首个匹配优先，同 url 多源不覆盖）。 */
export function indexArticlesByUrl(articles: readonly ArticleInput[]): Map<string, ArticleInput> {
  const map = new Map<string, ArticleInput>();
  for (const a of articles) if (a.url && !map.has(a.url)) map.set(a.url, a);
  return map;
}

/** 给单条补 published_at + 领域（幂等：已有字段不覆盖）。 */
export function annotateItem(it: ReportItem, byUrl: ReadonlyMap<string, ArticleInput>): ReportItem {
  const a = byUrl.get(it.url);
  const patch: Partial<ReportItem> = {};

  // 真实 ISO 发布时间：只有 ArticleInput.publishedAt 是权威来源，不用 fetchedAt 兜底。
  if (!it.published_at && a?.publishedAt) {
    const iso = a.publishedAt.toISOString?.();
    if (iso && !Number.isNaN(Date.parse(iso))) patch.published_at = iso;
  }

  // 领域归属：已有则不覆盖（老报告重渲染口径稳定）；无可靠关联则留空，不硬凑。
  if (!it.primary_domain) {
    const domain = classifyBusinessDomain({ title: it.title_cn, summary: it.summary, tags: it.tags });
    if (domain) {
      patch.primary_domain = domain.primary_domain;
      if (domain.related_domains.length) patch.related_domains = domain.related_domains;
    }
  }

  return Object.keys(patch).length ? { ...it, ...patch } : it;
}

/** 给报告所有板块条目补齐元数据（幂等；不 mutate 入参）。 */
export function annotateItemMetadata(
  report: DailyReport,
  articles: readonly ArticleInput[],
): DailyReport {
  const byUrl = indexArticlesByUrl(articles);
  const sections = report.sections ?? ({} as DailyReport["sections"]);
  const next: Partial<Record<ReportSectionKey, ReportItem[]>> = {};
  let touched = false;
  for (const key of Object.keys(sections) as ReportSectionKey[]) {
    next[key] = (sections[key] ?? []).map((it) => {
      const annotated = annotateItem(it, byUrl);
      if (annotated !== it) touched = true;
      return annotated;
    });
  }
  return touched ? { ...report, sections: next as DailyReport["sections"] } : report;
}
