/**
 * 采集服务 C1：把各源抓取结果汇合为 RawArticle[]。
 *
 * 职责边界：只做「采集 + 并发 + 源级错误隔离 + tier/isIpo/excerpt 透传」。
 * 红线 #1（丢弃无 publishedAt）不在此做 —— 留给 C2 归一化集中裁决，单一出口。
 * 服务内部允许调用 collect/providers（同服务子模块），但不得 import 其他服务。
 */
import type { CrawledArticle, RawArticle } from "../../contracts/article";
import type { SourceDef } from "../../contracts/source";
import type { HttpClient, IngestResult, PipelineContext } from "../../contracts/pipeline";
import { fetchOne, type CrawlerRegistry } from "./providers";

export interface CollectDeps {
  http: HttpClient;
  crawlers?: CrawlerRegistry;
}

/** 单源并发抓取：失败非致命（仅记录，不影响其他源）。 */
async function fetchAllSources(
  ctx: PipelineContext,
  deps: CollectDeps,
): Promise<RawArticle[]> {
  const enabled = ctx.sources.filter((s) => s.enabled !== false);
  if (enabled.length === 0) return [];

  const settled = await Promise.allSettled(
    enabled.map((s) => fetchOne(s, deps.http)),
  );

  const out: RawArticle[] = [];
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < enabled.length; i++) {
    const source = enabled[i];
    const r = settled[i];
    if (r.status === "fulfilled") {
      ok++;
      out.push(
        ...r.value.map((it) => ({
          ...it,
          source: source.name,
          tier: source.tier,
          isIpo: it.category === "gd-ipo" || it.category === "ipo",
          excerpt: it.excerpt?.trim() || it.title?.slice(0, 90) || "",
        })) as RawArticle[],
      );
    } else {
      fail++;
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      ctx.errors.push({ stage: "fetchAllSources", source: source.id, message: msg });
    }
  }
  ctx.log.info("collect", `并发抓取 ${ok}/${enabled.length} 源成功${fail ? `，${fail} 源失败` : ""}`);
  return out;
}

/** 爬虫产物：失败降级为空。 */
async function fetchCrawlers(deps: CollectDeps): Promise<{
  ipo: CrawledArticle[];
  gz: CrawledArticle[];
  stocks: CrawledArticle[];
}> {
  if (!deps.crawlers) return { ipo: [], gz: [], stocks: [] };
  try {
    return await deps.crawlers.fetchCrawledArticles();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ipo: [], gz: [], stocks: [] };
  }
}

function dedupeByUrl(articles: RawArticle[]): RawArticle[] {
  const seen = new Set<string>();
  const out: RawArticle[] = [];
  for (const a of articles) {
    if (seen.has(a.url)) continue;
    seen.add(a.url);
    out.push(a);
  }
  return out;
}

function backfillTier(articles: RawArticle[], ctx: PipelineContext): RawArticle[] {
  return articles.map((a) =>
    a.tier === undefined && ctx.tierBySource.has(a.sourceId)
      ? { ...a, tier: ctx.tierBySource.get(a.sourceId) }
      : a,
  );
}

/** 采集入口：fetchAll → 爬虫 → 合并 → tier 补齐。 */
export async function ingestAll(
  ctx: PipelineContext,
  deps: CollectDeps,
): Promise<IngestResult> {
  const fetched = await fetchAllSources(ctx, deps);
  const crawled = await fetchCrawlers(deps);

  let articles = dedupeByUrl(fetched);
  const crawledAll = [...crawled.ipo, ...crawled.gz, ...crawled.stocks].map((c) => ({
    sourceId: c.sourceId,
    title: c.title,
    url: c.url,
    excerpt: c.excerpt?.trim() || c.title?.slice(0, 90) || "",
    publishedAt: c.publishedAt,
    fetchedAt: c.fetchedAt,
    category: c.category,
    tier: c.tier,
    isIpo: c.category === "gd-ipo" || c.category === "ipo",
    ipoStage: c.ipoStage,
    listedDate: c.listedDate,
    gdBasis: c.gdBasis,
    subcategories: c.subcategories,
  })) as RawArticle[];
  articles = dedupeByUrl([...articles, ...crawledAll]);

  articles = backfillTier(articles, ctx);

  if (articles.length === 0) throw new Error("no articles fetched — aborting");
  ctx.log.info("collect", `采集合计 ${articles.length} 条`);
  return { articles, crawled };
}
